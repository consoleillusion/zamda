// Golden tests: C-LIVE-KEY, keyed live tables. Each case runs on the JS backend
// and on the WASM backend when the native engine is available. The golden `run`
// helper is used for the equivalence rule; mutation itself uses the backend
// factories directly, because `run` alone cannot change a table mid-test.

import { describe, expect, test } from 'bun:test';
import { SchemaError, keyedTable, pipe, schema, t } from '../../src';
import type { Fields, KeyedTable, Schema, TableInput } from '../../src';
import { createWasmBackend } from '../../src/backends/wasm';
import { nativeHost } from '../engine-host';
import { run } from './helpers';

const Keyed = schema({ id: t.int32, tag: t.utf8, n: t.int32 });
const all = pipe(Keyed)
  .select(c => ({ id: c.id, tag: c.tag, n: c.n }))
  .compile();

interface Maker {
  readonly name: string;
  make<F extends Fields>(
    schema: Schema<F>,
    keyFields: readonly (keyof F & string)[],
    data: TableInput<F>,
  ): KeyedTable<F>;
}

const host = nativeHost();
const wasm = host === null ? null : createWasmBackend(host);
const makers: readonly Maker[] =
  wasm === null ? [{ name: 'js', make: keyedTable }] : [{ name: 'js', make: keyedTable }, { name: 'wasm', make: wasm.keyedTable }];

function messageOf(error: unknown): string {
  // Purpose: read the structured message of a rejected mutation
  return error instanceof Error ? error.message : String(error);
}

for (const maker of makers) {
  describe(`C-LIVE-KEY (${maker.name}): one row per key`, () => {
    test('upsert inserts new keys and replaces whole rows without moving them', async () => {
      const kt = maker.make(Keyed, ['id'], [
        { id: 1, tag: 'a', n: 10 },
        { id: 2, tag: 'b', n: 20 },
      ]);
      try {
        expect(kt.rowCount).toBe(2);
        kt.upsert([{ id: 3, tag: 'c', n: 30 }, { id: 1, tag: 'A', n: 11 }]);
        expect(kt.rowCount).toBe(3);
        expect(kt.current().rowCount).toBe(3);
        expect((await all.execute(kt)).toArray()).toEqual([
          { id: 1, tag: 'A', n: 11 },
          { id: 2, tag: 'b', n: 20 },
          { id: 3, tag: 'c', n: 30 },
        ]);
        expect(kt.get([1])).toEqual({ id: 1, tag: 'A', n: 11 });
        expect(kt.has([4])).toBe(false);
      } finally {
        kt.dispose();
      }
    });

    test('column input is normalised and checked like row input', async () => {
      const kt = maker.make(Keyed, ['id'], {
        columns: { id: new Int32Array([1, 2]), tag: ['a', 'b'], n: new Int32Array([10, 20]) },
      });
      try {
        expect((await all.execute(kt)).toArray()).toEqual([
          { id: 1, tag: 'a', n: 10 },
          { id: 2, tag: 'b', n: 20 },
        ]);
      } finally {
        kt.dispose();
      }
    });

    test('delete returns the removed count, and deleting then re-inserting moves the key to the end', async () => {
      const kt = maker.make(
        Keyed,
        ['id'],
        [1, 2, 3].map(id => ({ id, tag: `t${id}`, n: id })),
      );
      try {
        expect(kt.delete([[2], [99]])).toBe(1);
        expect(kt.delete([[99]])).toBe(0);
        expect(kt.rowCount).toBe(2);
        kt.upsert([{ id: 2, tag: 'new', n: 99 }]);
        expect((await all.execute(kt)).toArray().map(r => r.id)).toEqual([1, 3, 2]);
      } finally {
        kt.dispose();
      }
    });

    test('a null or missing key component is rejected', async () => {
      expect(() => maker.make(Keyed, ['id'], [{ id: 1, tag: 'a', n: 1 }, { id: null, tag: 'b', n: 2 }])).toThrow(
        SchemaError,
      );
      const kt = maker.make(Keyed, ['id'], [{ id: 1, tag: 'a', n: 1 }]);
      try {
        expect(() => kt.delete([[null as never]])).toThrow(SchemaError);
        expect(() => kt.get([undefined as never])).toThrow(SchemaError);
        expect(kt.rowCount).toBe(1);
      } finally {
        kt.dispose();
      }
    });

    test('invalid input is rejected whole and changes nothing', async () => {
      const kt = maker.make(Keyed, ['id'], [{ id: 1, tag: 'a', n: 1 }]);
      try {
        const before = (await all.execute(kt)).toArray();
        expect(() =>
          kt.upsert([
            { id: 2, tag: 'good', n: 2 },
            { tag: 'no key', n: 3 },
          ]),
        ).toThrow(SchemaError);
        expect(() => kt.upsert({ columns: { id: new Int32Array([2, 3]), tag: ['x'], n: new Int32Array([2, 3]) } })).toThrow(
          SchemaError,
        );
        expect(() => kt.upsert([{ id: 4, tag: 7 as never, n: 4 }])).toThrow(SchemaError);
        expect(() => kt.delete([[] as never])).toThrow(SchemaError);
        expect(kt.rowCount).toBe(1);
        expect((await all.execute(kt)).toArray()).toEqual(before);
      } finally {
        kt.dispose();
      }
    });

    test('the rejection says what was expected, what was found and where', () => {
      const kt = maker.make(Keyed, ['id'], [{ id: 1, tag: 'a', n: 1 }]);
      try {
        let found = '';
        try {
          kt.upsert([{ id: 1, tag: 'a', n: 1 }, { tag: 'bad', n: 2 }]);
        } catch (error) {
          found = messageOf(error);
        }
        expect(found.toLowerCase()).toContain('expected');
        expect(found).toContain('found');
        expect(found).toContain('upsert row 1');
        expect(found).toContain('id');
      } finally {
        kt.dispose();
      }
    });

    test('key components are compared by typed value', () => {
      const S = schema({ k: t.int64, when: t.timestamp, label: t.utf8, flag: t.bool, v: t.int32 });
      const kt = maker.make(S, ['k', 'when', 'label', 'flag'], [
        { k: 1n, when: new Date(0), label: '1', flag: true, v: 1 },
      ]);
      try {
        expect(kt.has([1n, new Date(0), '1', true])).toBe(true);
        // The same written value of another JS type is a different key.
        expect(kt.has([1, new Date(0), '1', true])).toBe(false);
        expect(kt.has([1n, 0, '1', true])).toBe(false);
        expect(kt.has([1n, new Date(0), 1, true])).toBe(false);
        expect(kt.has([1n, new Date(0), '1', 1])).toBe(false);
        expect(kt.delete([[1, new Date(0), '1', true]])).toBe(0);
        expect(kt.delete([[1n, new Date(0), '1', true]])).toBe(1);
      } finally {
        kt.dispose();
      }
    });

    test('a run sees the table exactly as it stood when it started', async () => {
      const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: i, tag: 'x', n: i }));
      const kt = maker.make(Keyed, ['id'], rows);
      try {
        const started = all.execute(kt, { chunkRows: 1000, sliceMs: 0 });
        // These land while the run is still scanning.
        kt.upsert([{ id: 0, tag: 'changed', n: -1 }]);
        kt.upsert([{ id: 50_000, tag: 'new', n: 50_000 }]);
        kt.delete([[10], [11]]);
        const out = (await started).toArray();
        expect(out.length).toBe(50_000);
        expect(out[0]).toEqual({ id: 0, tag: 'x', n: 0 });
        expect(out[10]).toEqual({ id: 10, tag: 'x', n: 10 });
        const after = (await all.execute(kt)).toArray();
        expect(after.length).toBe(49_999);
        expect(after[0]).toEqual({ id: 0, tag: 'changed', n: -1 });
        expect(after.some(r => r.id === 10)).toBe(false);
      } finally {
        kt.dispose();
      }
    });
  });
}

describe('C-LIVE-KEY equivalence: a keyed table matches a table built from its final rows', () => {
  test('the golden run helper and both keyed backends agree', async () => {
    const finalRows = [
      { id: 1, tag: 'A', n: 11 },
      { id: 2, tag: 'b', n: 20 },
      { id: 3, tag: 'c', n: 30 },
    ];
    const expected = await run(Keyed, finalRows, p =>
      p.select(c => ({ id: c.id, tag: c.tag, n: c.n })),
    );
    for (const maker of makers) {
      const kt = maker.make(Keyed, ['id'], [
        { id: 1, tag: 'a', n: 10 },
        { id: 2, tag: 'b', n: 20 },
      ]);
      try {
        kt.upsert([{ id: 3, tag: 'c', n: 30 }, { id: 1, tag: 'A', n: 11 }]);
        expect((await all.execute(kt)).toArray()).toEqual(expected);
      } finally {
        kt.dispose();
      }
    }
  });
});
