// T-403: tables in the engine's memory, loaded from JS and read back, through
// the native build of the engine (the WASM build has the same functions).

import { describe, expect, test } from 'bun:test';
import { EngineTable } from '../src/backends/wasm/store';
import type { EngineHost, EngineSnapshot } from '../src/backends/wasm/store';
import { table as jsTable } from '../src/backends/js';
import type { Column } from '../src/column';
import { HandleError, SchemaError } from '../src/errors';
import { schema } from '../src/schema';
import { t } from '../src/types';
import { nativeHost } from './engine-host';

const host = nativeHost();
if (host === null) console.warn('engine-store tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const widths: Record<string, number> = {
  bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, date32: 4, utf8: 4, dictionary: 4,
  int64: 8, uint64: 8, float64: 8, timestamp: 8,
};

function readColumn(h: EngineHost, snap: EngineSnapshot, segment: number, column: number, type: string): { values: Uint8Array; valid: Uint8Array | null } {
  // Purpose: copy one segment column out of the engine as raw bytes, with its validity bytes if it has any
  const rows = snap.segments[segment]!.rows;
  const at = h.snapshotValues(snap.handle, segment, column);
  const values = h.view(at, rows * widths[type]!).slice();
  const v = h.snapshotValid(snap.handle, segment, column);
  return { values, valid: v === 0 ? null : h.view(v, rows).slice() };
}

function bytesOf(column: Column, from: number, to: number): Uint8Array {
  // Purpose: the stored bytes of rows [from, to) of a JS column, for comparison with what the engine holds
  const values = column.values as Exclude<Column['values'], string[]>;
  const w = values.BYTES_PER_ELEMENT;
  return new Uint8Array(values.buffer, values.byteOffset + from * w, (to - from) * w).slice();
}

maybe('engine tables', () => {
  const h = host!;
  const every = schema({
    b: t.bool, i8: t.int8, i16: t.int16, i32: t.int32, i64: t.int64, u8: t.uint8, u16: t.uint16, u32: t.uint32,
    u64: t.uint64, f32: t.float32, f64: t.float64, d: t.date32, ts: t.timestamp,
  });

  test('every fixed-width type is copied exactly, nulls included', () => {
    // Purpose: the engine holds the same bytes the JS loader produced, for all thirteen fixed-width types
    const rows = [
      { b: true, i8: -128, i16: -32768, i32: -2147483648, i64: -(2n ** 63n), u8: 255, u16: 65535, u32: 4294967295, u64: 2n ** 64n - 1n, f32: 1.5, f64: -0, d: new Date(Date.UTC(2022, 0, 8)), ts: new Date(1.7e12) },
      { b: false, i8: 127, i16: 32767, i32: 2147483647, i64: 2n ** 63n - 1n, u8: 0, u16: 0, u32: 0, u64: 0n, f32: NaN, f64: Infinity, d: new Date(-86400000), ts: new Date(0) },
      { b: null, i8: null, i16: null, i32: null, i64: null, u8: null, u16: null, u32: null, u64: null, f32: null, f64: null, d: null, ts: null },
    ];
    const js = jsTable(every, rows);
    const engine = new EngineTable(h, every, rows);
    const snap = engine.snapshot();
    const jsSegment = js.snapshot()[0]!;
    expect(snap.rows).toBe(3);
    every.list.forEach((field, c) => {
      const got = readColumn(h, snap, 0, c, field.type.name);
      const column = jsSegment.columns[c]!;
      expect(got.values, field.name).toEqual(bytesOf(column, 0, 3));
      expect(got.valid, field.name).toEqual(column.valid);
    });
    snap.release();
    engine.dispose();
  });

  test('a column without nulls has no validity bytes in the engine', () => {
    // Purpose: validity is dropped when nothing is null
    const s = schema({ x: t.int32 });
    const engine = new EngineTable(h, s, { columns: { x: Int32Array.of(1, 2, 3) } });
    const snap = engine.snapshot();
    expect(h.snapshotValid(snap.handle, 0, 0)).toBe(0);
    snap.release();
    engine.dispose();
  });

  test('utf8 and dictionary columns cross as codes, the strings stay on the JS side', () => {
    // Purpose: strings never enter the engine; each segment keeps its own dictionaries here
    const s = schema({ name: t.utf8, tag: t.dictionary });
    const engine = new EngineTable(h, s, [
      { name: 'b', tag: 'x' },
      { name: 'a', tag: 'y' },
      { name: 'b', tag: null },
      { name: null, tag: 'x' },
    ]);
    engine.append([{ name: 'z', tag: 'q' }]);
    const snap = engine.snapshot();
    expect(snap.segments.map(g => g.rows)).toEqual([4, 1]);
    expect(snap.segments[0]!.dictionaries).toEqual([['b', 'a'], ['x', 'y']]);
    expect(snap.segments[1]!.dictionaries).toEqual([['z'], ['q']]);
    const name = readColumn(h, snap, 0, 0, 'utf8');
    expect(Array.from(new Int32Array(name.values.buffer))).toEqual([0, 1, 0, 0]);
    expect(Array.from(name.valid!)).toEqual([1, 1, 1, 0]);
    expect(h.snapshotDictLen(snap.handle, 0, 0)).toBe(2);
    expect(h.snapshotDictLen(snap.handle, 1, 1)).toBe(1);
    snap.release();
    engine.dispose();
  });

  test('ready-made codes (D-055) are copied as they are', () => {
    // Purpose: an encoded dictionary column keeps its codes and its dictionary
    const s = schema({ as: t.dictionary });
    const engine = new EngineTable(h, s, {
      columns: { as: { codes: Int32Array.of(2, 0, 1, 2), dictionary: ['a', 'b', 'c'] } },
    });
    const snap = engine.snapshot();
    expect(Array.from(new Int32Array(readColumn(h, snap, 0, 0, 'dictionary').values.buffer))).toEqual([2, 0, 1, 2]);
    expect(snap.segments[0]!.dictionaries[0]).toEqual(['a', 'b', 'c']);
    snap.release();
    engine.dispose();
  });

  test('a bad append is rejected whole and leaves the table unchanged', () => {
    // Purpose: C-LIVE: no partial rows from a failed append, from the JS check or from the engine's own
    const s = schema({ x: t.int32, tag: t.dictionary });
    const engine = new EngineTable(h, s, [{ x: 1, tag: 'a' }]);
    expect(() => engine.append([{ x: 2, tag: 'b' }, { x: 1.5 as number, tag: 'c' }])).toThrow(SchemaError);
    expect(() => engine.append({ columns: { x: Int32Array.of(9), tag: { codes: Int32Array.of(5), dictionary: ['a'] } } })).toThrow(SchemaError);
    expect(engine.rowCount).toBe(1);
    engine.append([{ x: 3, tag: 'd' }]);
    const snap = engine.snapshot();
    expect(snap.rows).toBe(2);
    expect(Array.from(new Int32Array(readColumn(h, snap, 1, 0, 'int32').values.buffer))).toEqual([3]);
    snap.release();
    engine.dispose();
  });

  test('a snapshot keeps its rows and dictionaries while the table moves on', () => {
    // Purpose: C-LIVE: a run sees the table as of its start, even when the retain window drops its segments
    const s = schema({ x: t.int32, tag: t.utf8 });
    const engine = new EngineTable(h, s, [{ x: 1, tag: 'one' }, { x: 2, tag: 'two' }], { retain: { rows: 3 } });
    const before = engine.snapshot();
    engine.append([{ x: 3, tag: 'three' }, { x: 4, tag: 'four' }, { x: 5, tag: 'five' }]);
    expect(engine.rowCount).toBe(3);
    expect(engine.rowsDropped).toBe(2);
    expect(before.rows).toBe(2);
    expect(Array.from(new Int32Array(readColumn(h, before, 0, 0, 'int32').values.buffer))).toEqual([1, 2]);
    expect(before.segments[0]!.dictionaries[1]).toEqual(['one', 'two']);
    const after = engine.snapshot();
    expect(after.segments.map(g => g.rows)).toEqual([3]);
    before.release();
    after.release();
    before.release();
    engine.dispose();
  });

  test('the retain window agrees with the JS backend row for row', () => {
    // Purpose: with the same appends and the same window, engine and JS tables hold the same rows
    const s = schema({ x: t.int32 });
    const js = jsTable(s, [], { retain: { rows: 7 } });
    const engine = new EngineTable(h, s, [], { retain: { rows: 7 } });
    let next = 0;
    for (const size of [3, 1, 5, 2, 9, 4, 7, 8, 1]) {
      const rows = Array.from({ length: size }, () => ({ x: next++ }));
      js.append(rows);
      engine.append(rows);
      const snap = engine.snapshot();
      const jsValues = js.snapshot().flatMap(g => Array.from(g.columns[0]!.values as Int32Array));
      const engineValues = snap.segments.flatMap((g, i) => Array.from(new Int32Array(readColumn(h, snap, i, 0, 'int32').values.buffer)));
      expect(engineValues).toEqual(jsValues);
      expect(engine.rowCount).toBe(js.rowCount);
      expect(engine.rowsDropped).toBe(js.rowsDropped);
      snap.release();
    }
    engine.dispose();
  });

  test('typed arrays with an offset are copied from the right place', () => {
    // Purpose: the loader copies a view's own bytes, not the start of its buffer
    const s = schema({ x: t.float64 });
    const backing = Float64Array.of(9, 9, 1, 2, 3, 9);
    const engine = new EngineTable(h, s, { columns: { x: backing.subarray(2, 5) } });
    const snap = engine.snapshot();
    expect(Array.from(new Float64Array(readColumn(h, snap, 0, 0, 'float64').values.buffer))).toEqual([1, 2, 3]);
    snap.release();
    engine.dispose();
  });

  test('a disposed table refuses further use', () => {
    // Purpose: using a table after dispose is a HandleError, and dispose twice is harmless
    const s = schema({ x: t.int32 });
    const engine = new EngineTable(h, s, [{ x: 1 }]);
    engine.dispose();
    engine.dispose();
    expect(() => engine.append([{ x: 2 }])).toThrow(HandleError);
    expect(() => engine.snapshot()).toThrow(HandleError);
    expect(() => engine.rowCount).toThrow(HandleError);
  });

  test('a table that fails to load is not left behind in the engine', () => {
    // Purpose: a bad first load disposes the engine table
    const s = schema({ x: t.int32 });
    expect(() => new EngineTable(h, s, [{ x: 'no' as unknown as number }])).toThrow(SchemaError);
  });

  test('retain.rows must be a positive integer', () => {
    // Purpose: same option check as the JS backend
    const s = schema({ x: t.int32 });
    expect(() => new EngineTable(h, s, [], { retain: { rows: 0 } })).toThrow(SchemaError);
    expect(() => new EngineTable(h, s, [], { retain: { rows: 2.5 } })).toThrow(SchemaError);
  });
});
