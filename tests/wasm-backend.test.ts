// T-408: the WASM backend behaves as the JS backend does for everything the
// golden suite does not cover: time slices, cancellation, progress, early
// termination, live tables, string results and the fallback to JS.

import { describe, expect, test } from 'bun:test';
import { AbortError, PlanError, count, latest, lit, pipe, schema, t, table } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const host = nativeHost();
if (host === null) console.warn('wasm backend tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32, d: t.dictionary, u: t.utf8 });
const N = 200_000;
const rows = Array.from({ length: N }, (_, i) => ({ k: i % 97, v: i, d: i % 5 === 0 ? null : `g${i % 11}`, u: i % 7 === 0 ? null : `w${i % 13}` }));

maybe('wasm backend', () => {
  const { backend, table: wasmTable } = createWasmBackend(host!);
  const big = wasmTable(S, rows);
  const jsBig = table(S, rows);
  const grouped = pipe(S)
    .filter(c => c.v.gte(1000))
    .groupBy(c => ({ k: c.k }))
    .agg(c => ({ n: count(), total: c.v.sum() }))
    .sort(c => c.total.desc())
    .compile();

  test('answers equal the JS backend at any chunk size', async () => {
    const reference = (await grouped.execute(jsBig)).toArray();
    for (const options of [{}, { chunkRows: 1 << 20 }, { chunkRows: 999 }, { chunkRows: 4096, sliceMs: 0 }]) {
      expect((await grouped.execute(big, options)).toArray()).toEqual(reference);
    }
  });

  test('a long run returns to the event loop between time slices', async () => {
    let timerFired = false;
    setTimeout(() => (timerFired = true), 0);
    let sawTimerDuringRun = false;
    await grouped.execute(big, { chunkRows: 1000, sliceMs: 0, onProgress: () => void (timerFired && (sawTimerDuringRun = true)) });
    expect(sawTimerDuringRun).toBe(true);
  });

  test('aborting mid-run rejects with AbortError and leaves the table intact', async () => {
    const controller = new AbortController();
    let last = 0;
    const run = grouped.execute(big, {
      chunkRows: 1000,
      sliceMs: 0,
      signal: controller.signal,
      onProgress: p => {
        last = p.rowsScanned;
        if (p.rowsScanned >= 5000) controller.abort();
      },
    });
    await expect(run).rejects.toBeInstanceOf(AbortError);
    expect(last).toBeGreaterThanOrEqual(5000);
    expect(last).toBeLessThan(N);
    const out = (await pipe(S).agg(c => ({ n: count(), total: c.v.sum() })).compile().execute(big)).toArray();
    expect(out).toEqual([{ n: N, total: BigInt((N * (N - 1)) / 2) }]);
    // An already aborted signal never starts.
    const stopped = new AbortController();
    stopped.abort();
    await expect(grouped.execute(big, { signal: stopped.signal })).rejects.toBeInstanceOf(AbortError);
  });

  test('progress never goes down and ends at the table size', async () => {
    const seen: number[] = [];
    await grouped.execute(big, { chunkRows: 10_000, sliceMs: 0, onProgress: p => seen.push(p.rowsScanned) });
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(N);
  });

  test('limit stops reading once satisfied, at the same row count as JS', async () => {
    for (const make of [
      pipe(S).limit(5).compile(),
      pipe(S).filter(c => c.v.gte(2500)).limit(10).compile(),
      pipe(S).limit(0).compile(),
    ]) {
      let a = -1;
      let b = -1;
      const js = await make.execute(jsBig, { chunkRows: 1000, onProgress: p => (a = p.rowsScanned) });
      const wasm = await make.execute(big, { chunkRows: 1000, onProgress: p => (b = p.rowsScanned) });
      expect(wasm.toArray()).toEqual(js.toArray());
      expect(b).toBe(a);
    }
  });

  test('a run sees the table as it was when it started (C-LIVE)', async () => {
    const live = wasmTable(S, rows.slice(0, 5000));
    const total = pipe(S).agg(c => ({ n: count() })).compile();
    let appended = false;
    const out = await total.execute(live, {
      chunkRows: 500,
      sliceMs: 0,
      onProgress: () => {
        if (!appended) {
          appended = true;
          live.append(rows.slice(5000, 6000));
        }
      },
    });
    expect(out.toArray()).toEqual([{ n: 5000 }]);
    expect((await total.execute(live)).toArray()).toEqual([{ n: 6000 }]);
    live.dispose();
  });

  test('a retain window drops old rows for later runs', async () => {
    const live = wasmTable(S, rows.slice(0, 100), { retain: { rows: 150 } });
    live.append(rows.slice(100, 200));
    expect(live.rowCount).toBe(150);
    expect(live.rowsDropped).toBe(50);
    const first = (await pipe(S).limit(1).compile().execute(live)).toArray();
    expect(first[0]!.v).toBe(50);
    live.dispose();
  });

  test('latest() cancels the superseded run', async () => {
    const run = latest(grouped);
    const first = run(big, { chunkRows: 1000, sliceMs: 0 });
    const second = run(big, { chunkRows: 1000, sliceMs: 0 });
    await expect(first).rejects.toBeInstanceOf(AbortError);
    expect((await second).rowCount).toBeGreaterThan(0);
  });

  test('string results come back as strings, with nulls', async () => {
    const small = rows.slice(0, 300);
    const plan = pipe(S).groupBy(c => ({ d: c.d, u: c.u })).agg(c => ({ n: count(), lo: c.d.min() })).sort(c => [c.d.asc(), c.u.asc()]).compile();
    expect((await plan.execute(wasmTable(S, small))).toArray()).toEqual((await plan.execute(table(S, small))).toArray());
  });

  test('a string column that is all null comes back as nulls', async () => {
    const empty = Array.from({ length: 20 }, (_, i) => ({ k: i, v: i }));
    const plan = pipe(S).select(c => ({ d: c.d, u: c.u })).compile();
    const out = (await plan.execute(wasmTable(S, empty))).toArray();
    expect(out).toEqual((await plan.execute(table(S, empty))).toArray());
    expect(out.every(r => r.d === null && r.u === null)).toBe(true);
  });

  test('a constant that only appears after folding does not skip an operand that raises', async () => {
    // Purpose: and(x, and(true, and(false, y))) evaluates x on every backend, as the contract's shortcut names only direct constants
    const P = schema({ a: t.int32, z: t.int32, b: t.bool });
    const plan = pipe(P, { flag: t.bool })
      .filter((c, p) => c.a.intDiv(c.z).gte(0).and(lit(true, t.bool).and(p.flag.and(c.b))))
      .compile();
    const data = [{ a: 6, z: 0, b: true }, { a: 7, z: 1, b: false }];
    const outcome = async (tb: Parameters<typeof plan.execute>[0]) => {
      // Purpose: the error class a run raises, or its rows
      try {
        return (await plan.execute(tb, { params: { flag: false } })).toArray();
      } catch (e) {
        return (e as Error).constructor.name;
      }
    };
    expect(await outcome(table(P, data))).toBe('ExecutionError');
    expect(await outcome(wasmTable(P, data))).toBe('ExecutionError');
  });

  test('a plan the engine lacks runs on JS and says so in the stats', async () => {
    const before = { ...backend.stats };
    const small = rows.slice(0, 300);
    const plan = pipe(S).select(c => ({ low: c.u.lower() })).compile();
    expect((await plan.execute(wasmTable(S, small))).toArray()).toEqual((await plan.execute(table(S, small))).toArray());
    expect(backend.stats.fallback).toBe(before.fallback + 1);
    await grouped.execute(big);
    expect(backend.stats.engine).toBeGreaterThan(before.engine);
  });

  test('a table of another backend is refused', async () => {
    await expect(grouped.execute(table(S, rows.slice(0, 3)), {})).resolves.toBeDefined();
    const other = createWasmBackend(host!);
    await expect(backend.execute(grouped.ir, other.table(S, rows.slice(0, 3)), { params: new Map() })).rejects.toBeInstanceOf(PlanError);
  });
});

describe('the WebAssembly loader', () => {
  test('every export it asks for exists in the engine, and every host method is wired', async () => {
    // Purpose: the loader cannot run here without a wasm32 toolchain, so check its names against the engine's source
    const { readdirSync, readFileSync } = await import('node:fs');
    const exported = new Set<string>();
    for (const file of readdirSync('engine/src')) {
      for (const m of readFileSync(`engine/src/${file}`, 'utf8').matchAll(/pub extern "C" fn (zs_[a-z_0-9]+)/g)) exported.add(m[1]!);
    }
    const loader = readFileSync('src/backends/wasm/load.ts', 'utf8');
    const asked = [...loader.matchAll(/fn\('(zs_[a-z_0-9]+)'\)/g)].map(m => m[1]!);
    expect(asked.length).toBeGreaterThan(40);
    for (const name of asked) expect(exported.has(name), name).toBe(true);
    // The native host in the tests implements the same interface; every method the loader returns is there too.
    const host = nativeHost()!;
    const returned = [...loader.slice(loader.indexOf('  return {\n    alloc')).matchAll(/^ {4}([a-zA-Z]+):/gm)].map(m => m[1]!);
    for (const method of returned) expect(typeof (host as unknown as Record<string, unknown>)[method], method).toBe('function');
  });
});
