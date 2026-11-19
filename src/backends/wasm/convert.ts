// Moving columns out of engine memory into the JS shapes of src/column.ts: for
// results, and for the JS fallback, which needs a table's rows as JS columns.

import { makeColumn } from '../../column';
import type { Column, ColumnValues } from '../../column';
import type { Schema } from '../../schema';
import type { DataType } from '../../types';
import type { Segment } from '../js/exec';
import type { EngineHost } from './store';
import type { EngineSnapshot } from './store';

export function byteWidth(name: string): number {
  // Purpose: bytes per value of a type in engine memory
  return (({ bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, date32: 4, utf8: 4, dictionary: 4 }) as Record<string, number>)[name] ?? 8;
}

export function typedValues(type: DataType, bytes: Uint8Array): ColumnValues {
  // Purpose: the values of a non-string column as the typed array src/column.ts uses for the type (a copy, so engine memory can change)
  const copy = bytes.slice().buffer;
  switch (type.name) {
    case 'bool':
    case 'uint8':
      return new Uint8Array(copy);
    case 'int8':
      return new Int8Array(copy);
    case 'int16':
      return new Int16Array(copy);
    case 'int32':
    case 'date32':
    case 'dictionary':
    case 'utf8':
      return new Int32Array(copy);
    case 'uint16':
      return new Uint16Array(copy);
    case 'uint32':
      return new Uint32Array(copy);
    case 'int64':
      return new BigInt64Array(copy);
    case 'uint64':
      return new BigUint64Array(copy);
    case 'float32':
      return new Float32Array(copy);
    case 'float64':
    case 'timestamp':
      return new Float64Array(copy);
  }
}

export function stringColumn(type: DataType, ids: Int32Array, valid: Uint8Array | null, strings: readonly string[]): Column {
  // Purpose: a utf8 or dictionary column from string ids: utf8 holds the strings, a dictionary column a compact dictionary of the strings used
  const n = ids.length;
  if (type.name === 'utf8') {
    const values = new Array<string>(n);
    for (let i = 0; i < n; i++) values[i] = valid !== null && valid[i] === 0 ? '' : strings[ids[i]!]!;
    return makeColumn(type, values, valid);
  }
  const remap = new Map<number, number>();
  const dictionary: string[] = [];
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (valid !== null && valid[i] === 0) continue;
    let code = remap.get(ids[i]!);
    if (code === undefined) {
      code = dictionary.length;
      remap.set(ids[i]!, code);
      dictionary.push(strings[ids[i]!]!);
    }
    codes[i] = code;
  }
  return makeColumn(type, codes, valid, dictionary);
}

export function segmentsOf(host: EngineHost, snapshot: EngineSnapshot, schema: Schema): Segment[] {
  // Purpose: a snapshot's rows as JS columns, one segment per engine segment, for running a plan the engine cannot
  return snapshot.segments.map(function (segment, s) {
    const rows = segment.rows;
    const columns = schema.list.map(function (field, c): Column {
      const type = field.type;
      const at = host.snapshotValues(snapshot.handle, s, c);
      const bytes = rows === 0 ? new Uint8Array(0) : host.view(at, rows * byteWidth(type.name));
      const values = typedValues(type, bytes);
      const v = host.snapshotValid(snapshot.handle, s, c);
      const valid = v === 0 || rows === 0 ? null : host.view(v, rows).slice();
      const dictionary = segment.dictionaries[c];
      if (type.name === 'utf8') return stringColumn(type, values as Int32Array, valid, dictionary ?? []);
      if (type.name === 'dictionary') return makeColumn(type, values, valid, dictionary ?? []);
      return makeColumn(type, values, valid);
    });
    return { columns, rowCount: rows };
  });
}
