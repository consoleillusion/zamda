// Unit tests for the keyed table API beyond the golden rules: the retain window,
// rowsDropped, disposal, and the WASM backend's ownership of replaced tables.

import { describe, expect, test } from 'bun:test';
import { HandleError, keyedTable, pipe, schema, t } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const K = schema({ id: t.int32, tag: t.utf8, n: t.int32 });
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

describe('WASM keyed table ownership', () => {
  test('a replaced table is disposed only after runs referring to it finish', async () => {
    const host = nativeHost();
    if (host === null) return;
    const wasm = createWasmBackend(host);
    const kt = wasm.keyedTable(K, ['id'], [{ id: 1, tag: 'a', n: 1 }]);
    const first = kt.current();
    try {
      const started = ids.execute(kt, { chunkRows: 1, sliceMs: 0 });
      kt.upsert([{ id: 2, tag: 'b', n: 2 }]);
      // The old table is still alive while the run that started on it is in flight.
      expect((await ids.execute(first as never)).toArray()).toEqual([{ id: 1 }]);
      expect((await started).toArray()).toEqual([{ id: 1 }]);
      // Once that run has finished, the replaced table has been disposed.
      await expect(ids.execute(first as never)).rejects.toBeInstanceOf(HandleError);
      expect((await ids.execute(kt)).toArray().map(r => r.id)).toEqual([1, 2]);
    } finally {
      kt.dispose();
    }
  });

  test('runs that finish out of order keep every replaced table alive', async () => {
    const host = nativeHost();
    if (host === null) return;
    const wasm = createWasmBackend(host);
    const kt = wasm.keyedTable(K, ['id'], [{ id: 1, tag: 'a', n: 1 }]);
    const first = kt.current();
    try {
      const runA = ids.execute(kt, { chunkRows: 1, sliceMs: 0 });
      kt.upsert([{ id: 2, tag: 'b', n: 2 }]);
      const second = kt.current();
      const runB = ids.execute(kt, { chunkRows: 1, sliceMs: 0 });
      kt.upsert([{ id: 3, tag: 'c', n: 3 }]);
      // A finishes first; neither replaced table may be freed while B is still running.
      expect((await runA).toArray()).toEqual([{ id: 1 }]);
      expect((await ids.execute(first as never)).toArray()).toEqual([{ id: 1 }]);
      expect((await ids.execute(second as never)).toArray()).toEqual([{ id: 1 }, { id: 2 }]);
      expect((await runB).toArray()).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(ids.execute(first as never)).rejects.toBeInstanceOf(HandleError);
      await expect(ids.execute(second as never)).rejects.toBeInstanceOf(HandleError);
    } finally {
      kt.dispose();
    }
  });
});
