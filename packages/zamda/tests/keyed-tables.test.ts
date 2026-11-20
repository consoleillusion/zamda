// Unit tests for the keyed table API beyond the golden rules: the retain window,
// rowsDropped, disposal, and the WASM backend's ownership of replaced tables.

import { describe, expect, test } from 'bun:test';
import { HandleError, keyedTable, pipe, schema, t } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const K = schema({ id: t.int32, tag: t.utf8, n: t.int32 });
// The same with a dictionary column, whose codes must be remapped when blocks are rewritten.
const KD = schema({ id: t.int32, tag: t.dictionary, n: t.int32 });
const ids = pipe(K)
  .select(c => ({ id: c.id }))
  .compile();

describe('keyed table bookkeeping', () => {
  test('rowsDropped counts deletes, replacements and retained rows', async () => {
    const kt = keyedTable(K, ['id'], [
      { id: 1, tag: 'a', n: 1 },
      { id: 2, tag: 'b', n: 2 },
      { id: 3, tag: 'c', n: 3 },
    ]);
    expect(kt.rowCount).toBe(3);
    expect(kt.rowsDropped).toBe(0);
    kt.upsert([{ id: 1, tag: 'A', n: 11 }]);
    expect(kt.rowsDropped).toBe(1);
    expect(kt.delete([[2]])).toBe(1);
    expect(kt.rowsDropped).toBe(2);
    expect((await ids.execute(kt)).toArray().map(r => r.id)).toEqual([1, 3]);
  });

  test('retain keeps the newest rows and drops the rest', async () => {
    const kt = keyedTable(K, ['id'], [{ id: 1, tag: 'a', n: 1 }, { id: 2, tag: 'b', n: 2 }], { retain: { rows: 2 } });
    kt.upsert([{ id: 3, tag: 'c', n: 3 }]);
    expect(kt.rowCount).toBe(2);
    expect(kt.rowsDropped).toBe(1);
    expect(kt.has([1])).toBe(false);
    expect((await ids.execute(kt)).toArray().map(r => r.id)).toEqual([2, 3]);
    // A key dropped by retain is new again when re-inserted.
    kt.upsert([{ id: 1, tag: 'again', n: 1 }]);
    expect((await ids.execute(kt)).toArray().map(r => r.id)).toEqual([3, 1]);
  });

  test('dispose is idempotent and rejects later mutations', () => {
    const kt = keyedTable(K, ['id'], [{ id: 1, tag: 'a', n: 1 }]);
    const current = kt.current();
    kt.dispose();
    kt.dispose();
    void current;
    expect(() => kt.upsert([{ id: 2, tag: 'b', n: 2 }])).toThrow(HandleError);
    expect(() => kt.delete([[1]])).toThrow(HandleError);
  });

  test('duplicate keys in the initial data collapse to one row', () => {
    const kt = keyedTable(K, ['id'], [
      { id: 1, tag: 'first', n: 1 },
      { id: 2, tag: 'other', n: 2 },
      { id: 1, tag: 'last', n: 11 },
    ]);
    expect(kt.rowCount).toBe(2);
    expect(kt.get([1])).toEqual({ id: 1, tag: 'last', n: 11 });
    expect(kt.current().rowCount).toBe(2);
  });
});

describe('WASM keyed tables edit one engine table in place', () => {
  test('mutations keep the same engine table; a run in flight keeps its snapshot', async () => {
    const host = nativeHost();
    if (host === null) return;
    const wasm = createWasmBackend(host);
    const kt = wasm.keyedTable(K, ['id'], [{ id: 1, tag: 'a', n: 1 }], { blockRows: 2 });
    const first = kt.current();
    try {
      const started = ids.execute(kt, { chunkRows: 1, sliceMs: 0 });
      kt.upsert([{ id: 2, tag: 'b', n: 2 }, { id: 3, tag: 'c', n: 3 }]);
      kt.delete([[1]]);
      expect(kt.current()).toBe(first);
      expect((await started).toArray()).toEqual([{ id: 1 }]);
      expect((await ids.execute(kt)).toArray().map(r => r.id)).toEqual([2, 3]);
    } finally {
      kt.dispose();
    }
  });

  test('disposing frees the engine memory the keyed table used', async () => {
    const host = nativeHost();
    if (host === null) return;
    const wasm = createWasmBackend(host);
    const before = host.memoryLive();
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, tag: `t${i % 7}`, n: i }));
    const kt = wasm.keyedTable(K, ['id'], rows, { blockRows: 1000 });
    for (let i = 0; i < 20; i++) kt.upsert([{ id: i * 997, tag: 'u', n: -i }, { id: 30_000 + i, tag: 'v', n: i }]);
    kt.delete([[5], [6], [7]]);
    expect((await ids.execute(kt)).rowCount).toBe(20_017);
    kt.dispose();
    expect(host.memoryLive()).toBe(before);
  });
});

describe('keyed tables at scale', () => {
  test('a mutation copies only the blocks it touches', () => {
    const n = 200_000;
    const kt = keyedTable(K, ['id'], { columns: { id: Int32Array.from({ length: n }, (_, i) => i), tag: Array.from({ length: n }, () => 'x'), n: new Int32Array(n) } }, { blockRows: 4096 });
    const before = (kt.current() as unknown as { snapshot(): readonly unknown[] }).snapshot();
    kt.upsert([{ id: 5, tag: 'y', n: 1 }]);
    const after = (kt.current() as unknown as { snapshot(): readonly unknown[] }).snapshot();
    expect(after.length).toBe(before.length);
    // Only block 0 was rewritten; every other block is the same object.
    expect(after.filter((segment, i) => segment !== before[i]).length).toBe(1);
    expect(kt.get([5])).toEqual({ id: 5, tag: 'y', n: 1 });
  });

  test('random upserts and deletes match a plain model, on both backends and any block size', async () => {
    const host = nativeHost();
    for (const schema of [K, KD as unknown as typeof K]) {
    const makers = [(rows: { id: number; tag: string; n: number }[], blockRows: number) => keyedTable(schema, ['id'], rows, { blockRows })];
    if (host !== null) {
      const wasm = createWasmBackend(host);
      makers.push((rows, blockRows) => wasm.keyedTable(schema, ['id'], rows, { blockRows }));
    }
    let seed = 7;
    const rand = (m: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);
    const all = pipe(schema).select(c => ({ id: c.id, tag: c.tag, n: c.n })).compile();
    for (const make of makers) {
      for (const blockRows of [1, 3, 64]) {
        const model = new Map<number, { id: number; tag: string; n: number }>();
        const initial = Array.from({ length: 50 }, (_, i) => ({ id: rand(80), tag: `t${rand(5)}`, n: i }));
        for (const row of initial) {
          if (model.has(row.id)) model.set(row.id, row);
          else model.set(row.id, row);
        }
        const kt = make(initial, blockRows);
        for (let step = 0; step < 60; step++) {
          if (rand(3) === 0) {
            const keys = Array.from({ length: 1 + rand(5) }, () => [rand(100)] as [number]);
            let expected = 0;
            for (const [id] of keys) if (model.delete(id)) expected++;
            // A key listed twice is removed once.
            expect(kt.delete(keys)).toBe(new Set(keys.map(k => k[0])).size - (new Set(keys.map(k => k[0])).size - expected));
          } else {
            const batch = Array.from({ length: 1 + rand(6) }, () => ({ id: rand(100), tag: `s${rand(9)}`, n: step }));
            kt.upsert(batch);
            for (const row of batch) {
              if (model.has(row.id)) model.set(row.id, row);
              else model.set(row.id, row);
            }
          }
          const got = (await all.execute(kt)).toArray();
          expect(got).toEqual([...model.values()]);
          expect(kt.rowCount).toBe(model.size);
        }
        kt.dispose();
      }
    }
    }
  });
});
