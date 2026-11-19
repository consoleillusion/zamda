// Tests for chunked, resumable execution (docs/TASKS.md, T-201 and T-202):
// yielding, cancellation, progress, early termination, and latest().

import { describe, expect, test } from 'bun:test';
import { AbortError, PlanError, count, latest, pipe, schema, t, table } from '../src';

const S = schema({ k: t.int32, v: t.int32, d: t.dictionary });
const N = 200_000;
const rows = Array.from({ length: N }, (_, i) => ({ k: i % 97, v: i, d: i % 5 === 0 ? null : `g${i % 11}` }));
const big = table(S, rows);

const grouped = pipe(S)
  .filter(c => c.v.gte(1000))
  .groupBy(c => ({ k: c.k }))
  .agg(c => ({ n: count(), total: c.v.sum() }))
  .sort(c => c.total.desc())
  .compile();

describe('yielding', () => {
  test('a long run returns to the event loop between time slices', async () => {
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);
    let sawTimerDuringRun = false;
    await grouped.execute(big, {
      chunkRows: 1000,
      sliceMs: 0,
      onProgress: () => {
        if (timerFired) sawTimerDuringRun = true;
      },
    });
    expect(sawTimerDuringRun).toBe(true);
  });

  test('results do not depend on chunk size or slice length', async () => {
    const reference = (await grouped.execute(big)).toArray();
    for (const options of [{ chunkRows: 1 << 20 }, { chunkRows: 999 }, { chunkRows: 4096, sliceMs: 0 }]) {
      expect((await grouped.execute(big, options)).toArray()).toEqual(reference);
    }
  });

  test('invalid run options are rejected', async () => {
    await expect(grouped.execute(big, { chunkRows: 0 })).rejects.toBeInstanceOf(PlanError);
    await expect(grouped.execute(big, { chunkRows: 1.5 })).rejects.toBeInstanceOf(PlanError);
    await expect(grouped.execute(big, { sliceMs: -1 })).rejects.toBeInstanceOf(PlanError);
  });
});

describe('cancellation', () => {
  test('aborting mid-run rejects with AbortError before the scan completes', async () => {
    const controller = new AbortController();
    let lastScanned = 0;
    const run = grouped.execute(big, {
      chunkRows: 1000,
      sliceMs: 0,
      signal: controller.signal,
      onProgress: p => {
        lastScanned = p.rowsScanned;
        if (p.rowsScanned >= 5000) controller.abort();
      },
    });
    await expect(run).rejects.toBeInstanceOf(AbortError);
    expect(lastScanned).toBeGreaterThanOrEqual(5000);
    expect(lastScanned).toBeLessThan(N);
  });

  test('the table is intact after an aborted run', async () => {
    const controller = new AbortController();
    const aborted = grouped.execute(big, {
      chunkRows: 1000,
      sliceMs: 0,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(aborted).rejects.toBeInstanceOf(AbortError);
    const out = (await pipe(S).agg(c => ({ n: count(), total: c.v.sum() })).compile().execute(big)).toArray();
    expect(out).toEqual([{ n: N, total: BigInt((N * (N - 1)) / 2) }]);
  });

  test('an abort during a long sort is seen too', async () => {
    const sorted = pipe(S).sort(c => [c.k.desc(), c.v.asc()]).compile();
    const controller = new AbortController();
    let calls = 0;
    const run = sorted.execute(big, {
      sliceMs: 0,
      signal: controller.signal,
      onProgress: p => {
        // The scan is finished; abort once the run is inside the sort.
        if (p.rowsScanned === N && ++calls === 2) controller.abort();
      },
    });
    await expect(run).rejects.toBeInstanceOf(AbortError);
  });
});

describe('progress', () => {
  test('rowsScanned never goes down and ends at the table size for a full scan', async () => {
    const seen: number[] = [];
    await grouped.execute(big, { chunkRows: 10_000, sliceMs: 0, onProgress: p => seen.push(p.rowsScanned) });
    expect(seen.length).toBeGreaterThan(10);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(N);
  });

  test('a fast run still reports once, at the end', async () => {
    const seen: { rowsScanned: number; rowsTotal: number }[] = [];
    await pipe(S).limit(3).compile().execute(table(S, rows.slice(0, 10)), { onProgress: p => seen.push(p) });
    expect(seen.at(-1)).toEqual({ rowsScanned: 10, rowsTotal: 10 });
  });
});

describe('early termination', () => {
  test('limit stops reading the table once it is satisfied', async () => {
    let scanned = 0;
    const out = await pipe(S).limit(5).compile().execute(big, { chunkRows: 1000, onProgress: p => (scanned = p.rowsScanned) });
    expect(out.rowCount).toBe(5);
    expect(scanned).toBe(1000);
  });

  test('filter then limit reads only as far as it needs to', async () => {
    let scanned = 0;
    const plan = pipe(S).filter(c => c.v.gte(2500)).limit(10).select(c => ({ v: c.v })).compile();
    const out = await plan.execute(big, { chunkRows: 1000, onProgress: p => (scanned = p.rowsScanned) });
    expect(out.toArray().map(r => r.v)).toEqual([2500, 2501, 2502, 2503, 2504, 2505, 2506, 2507, 2508, 2509]);
    expect(scanned).toBe(3000);
  });

  test('a limit of zero reads at most one chunk', async () => {
    let scanned = 0;
    const out = await pipe(S).limit(0).compile().execute(big, { chunkRows: 1000, onProgress: p => (scanned = p.rowsScanned) });
    expect(out.rowCount).toBe(0);
    expect(scanned).toBeLessThanOrEqual(1000);
  });
});

describe('dictionaries across chunks', () => {
  // coalesce builds a new dictionary for every chunk, so codes differ between chunks.
  const small = table(S, rows.slice(0, 500));

  test('group-by and countDistinct on a computed dictionary column', async () => {
    const plan = pipe(S)
      .select(c => ({ g: c.d.coalesce('none'), k: c.k }))
      .groupBy(c => ({ k: c.k }))
      .agg(c => ({ groups: c.g.countDistinct(), lo: c.g.min(), hi: c.g.max() }))
      .compile();
    const byKey = pipe(S)
      .select(c => ({ g: c.d.coalesce('none') }))
      .groupBy(c => ({ g: c.g }))
      .agg(() => ({ n: count() }))
      .compile();
    for (const chunkRows of [1, 7, 64]) {
      expect((await plan.execute(small, { chunkRows })).toArray()).toEqual((await plan.execute(small)).toArray());
      expect((await byKey.execute(small, { chunkRows })).toArray()).toEqual((await byKey.execute(small)).toArray());
    }
    expect((await byKey.execute(small)).toArray()[0]).toEqual({ g: 'none', n: 100 });
  });

  test('sort and plain output of a computed dictionary column', async () => {
    const plan = pipe(S).select(c => ({ g: c.d.coalesce('none'), v: c.v })).sort(c => [c.g.desc(), c.v.asc()]).limit(40).compile();
    const plain = pipe(S).select(c => ({ g: c.d.coalesce('none') })).compile();
    for (const chunkRows of [1, 7, 64]) {
      expect((await plan.execute(small, { chunkRows })).toArray()).toEqual((await plan.execute(small)).toArray());
      expect((await plain.execute(small, { chunkRows })).toArray()).toEqual((await plain.execute(small)).toArray());
    }
  });
});

describe('latest()', () => {
  test('starting a new run aborts the one in flight', async () => {
    const run = latest(grouped);
    const first = run(big, { chunkRows: 1000, sliceMs: 0 });
    const second = run(big, { chunkRows: 1000, sliceMs: 0 });
    await expect(first).rejects.toBeInstanceOf(AbortError);
    expect((await second).rowCount).toBe(97);
  });

  test('the caller can still abort through its own signal', async () => {
    const run = latest(grouped);
    const controller = new AbortController();
    const pending = run(big, { chunkRows: 1000, sliceMs: 0, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  test('parameters still type-check and pass through', async () => {
    const plan = pipe(S, { min: t.int32 }).filter((c, p) => c.v.gte(p.min)).agg(() => ({ n: count() })).compile();
    const run = latest(plan);
    expect((await run(big, { params: { min: N - 10 } })).toArray()).toEqual([{ n: 10 }]);
  });
});

describe('grouping by small integer keys', () => {
  test('every uint16 and int16 value is its own group, including values of 32768 and above', async () => {
    // Found by the engine cross-check (T-406): uint16 keys of 32768 or more used to land in group 0.
    for (const type of [t.uint16, t.int16] as const) {
      const values = type === t.uint16 ? [0, 1, 32767, 32768, 40000, 65535] : [-32768, -1, 0, 1, 32767];
      const s = schema({ k: type });
      const data = table(s, [...values, ...values].map(k => ({ k })));
      const plan = pipe(s)
        .groupBy(c => ({ k: c.k }))
        .agg(() => ({ n: count() }))
        .compile();
      const rows = (await plan.execute(data)).toArray();
      expect(rows as unknown).toEqual(values.map(k => ({ k, n: 2 })));
    }
  });
});
