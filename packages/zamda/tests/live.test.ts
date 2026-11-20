// Tests for append-only live tables (docs/TASKS.md, T-204; contract rule C-LIVE).

import { describe, expect, test } from 'bun:test';
import { AbortError, SchemaError, count, latest, pipe, schema, t, table } from '../src';

const Updates = schema({ seq: t.int32, network: t.uint32, kind: t.dictionary });

function batch(from: number, n: number) {
  // Purpose: n update rows numbered from `from`, cycling through a few networks and both kinds
  return Array.from({ length: n }, (_, i) => ({
    seq: from + i,
    network: (from + i) % 7,
    kind: (from + i) % 3 === 0 ? 'withdraw' : 'announce',
  }));
}

const all = pipe(Updates).select(c => ({ seq: c.seq })).compile();
const perNetwork = pipe(Updates)
  .groupBy(c => ({ network: c.network, kind: c.kind }))
  .agg(c => ({ n: count(), last: c.seq.max() }))
  .sort(c => [c.network.asc(), c.kind.asc()])
  .compile();

describe('append', () => {
  test('appended rows are visible to the next run', async () => {
    const live = table(Updates, batch(0, 5));
    live.append(batch(5, 3));
    live.append({ columns: { seq: new Int32Array([8, 9]), network: new Uint32Array([1, 2]), kind: ['announce', null] } });
    expect(live.rowCount).toBe(10);
    const out = (await all.execute(live)).toArray();
    expect(out.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('a table built by appends gives the same answers as one built at once', async () => {
    const once = table(Updates, batch(0, 1000));
    const pieces = table(Updates, []);
    for (let from = 0; from < 1000; from += 137) pieces.append(batch(from, Math.min(137, 1000 - from)));
    for (const chunkRows of [undefined, 1, 50]) {
      expect((await perNetwork.execute(pieces, { chunkRows })).toArray()).toEqual(
        (await perNetwork.execute(once)).toArray(),
      );
    }
  });

  test('appending nothing changes nothing', async () => {
    const live = table(Updates, batch(0, 3));
    live.append([]);
    expect(live.rowCount).toBe(3);
  });

  test('a bad row is rejected and the table is unchanged', async () => {
    const live = table(Updates, batch(0, 3));
    expect(() => live.append([{ seq: 3, network: -1, kind: 'announce' }])).toThrow(SchemaError);
    expect(live.rowCount).toBe(3);
    expect((await all.execute(live)).rowCount).toBe(3);
  });

  test('dictionary values from different appends group together', async () => {
    const live = table(Updates, [{ seq: 0, network: 1, kind: 'withdraw' }]);
    live.append([{ seq: 1, network: 1, kind: 'announce' }, { seq: 2, network: 1, kind: 'withdraw' }]);
    const kinds = pipe(Updates).groupBy(c => ({ kind: c.kind })).agg(() => ({ n: count() })).compile();
    expect((await kinds.execute(live)).toArray()).toEqual([
      { kind: 'withdraw', n: 2 },
      { kind: 'announce', n: 1 },
    ]);
  });
});

describe('retain window', () => {
  test('keeps exactly the most recent rows', async () => {
    const live = table(Updates, batch(0, 4), { retain: { rows: 5 } });
    live.append(batch(4, 3));
    expect(live.rowCount).toBe(5);
    expect(live.rowsDropped).toBe(2);
    expect((await all.execute(live)).toArray().map(r => r.seq)).toEqual([2, 3, 4, 5, 6]);
    live.append(batch(7, 12));
    expect(live.rowCount).toBe(5);
    expect(live.rowsDropped).toBe(14);
    expect((await all.execute(live)).toArray().map(r => r.seq)).toEqual([14, 15, 16, 17, 18]);
  });

  test('applies to the initial rows too', async () => {
    const live = table(Updates, batch(0, 10), { retain: { rows: 3 } });
    expect((await all.execute(live)).toArray().map(r => r.seq)).toEqual([7, 8, 9]);
  });

  test('aggregates over the window match a table of just those rows', async () => {
    const live = table(Updates, [], { retain: { rows: 300 } });
    for (let from = 0; from < 2000; from += 97) live.append(batch(from, 97));
    const window = table(Updates, batch(2037 - 300, 300));
    expect((await perNetwork.execute(live)).toArray()).toEqual((await perNetwork.execute(window)).toArray());
  });

  test('an invalid window is rejected', () => {
    expect(() => table(Updates, [], { retain: { rows: 0 } })).toThrow(SchemaError);
    expect(() => table(Updates, [], { retain: { rows: 2.5 } })).toThrow(SchemaError);
  });
});

describe('snapshots', () => {
  test('a run sees the table as it was when the run started', async () => {
    const live = table(Updates, batch(0, 50_000));
    const run = all.execute(live, { chunkRows: 1000, sliceMs: 0 });
    // These land while the run is still scanning.
    live.append(batch(50_000, 10));
    const out = await run;
    expect(out.rowCount).toBe(50_000);
    expect((await all.execute(live)).rowCount).toBe(50_010);
  });

  test('rows dropped by the window during a run are still seen by that run', async () => {
    const live = table(Updates, batch(0, 50_000), { retain: { rows: 50_000 } });
    const run = all.execute(live, { chunkRows: 1000, sliceMs: 0 });
    live.append(batch(50_000, 20_000));
    const out = (await run).toArray();
    expect(out[0]!.seq).toBe(0);
    expect(out.length).toBe(50_000);
  });
});

describe('a live feed', () => {
  test('append then re-run with latest(): only the newest run completes', async () => {
    const live = table(Updates, [], { retain: { rows: 10_000 } });
    const run = latest(perNetwork);
    const runs: Promise<unknown>[] = [];
    for (let from = 0; from < 50_000; from += 5_000) {
      live.append(batch(from, 5_000));
      runs.push(run(live, { chunkRows: 500, sliceMs: 0 }));
    }
    const settled = await Promise.allSettled(runs);
    const last = settled.pop()!;
    expect(last.status).toBe('fulfilled');
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(AbortError);
    }
    expect(settled.some(s => s.status === 'rejected')).toBe(true);
  });
});
