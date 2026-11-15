// In-memory column storage on the JS side: used by the JS backend and by every
// backend's results. Validity is one byte per row (1 = present), which is
// simpler and faster in JS than a bit-packed bitmap (docs/DECISIONS.md, D-004).

import { SchemaError } from './errors';
import type { DataType } from './types';

export type ColumnValues =
  | Uint8Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint16Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array
  | string[];

export interface Column {
  readonly type: DataType;
  // bool is stored as 0 or 1 in a Uint8Array.
  readonly values: ColumnValues;
  // null when no value is null.
  readonly valid: Uint8Array | null;
}

// Loose views used inside kernels, where the element type is known from the DataType.
export type NumCells = { [i: number]: number; readonly length: number };
export type BigCells = { [i: number]: bigint; readonly length: number };
export type AnyCells = { [i: number]: number | bigint | string; readonly length: number };

export function nums(column: Column): NumCells {
  // Purpose: view a column's values as numbers
  return column.values as unknown as NumCells;
}

export function bigs(column: Column): BigCells {
  // Purpose: view a column's values as bigints
  return column.values as unknown as BigCells;
}

export function cells(column: Column): AnyCells {
  // Purpose: view a column's values without knowing the element type
  return column.values as unknown as AnyCells;
}

export function allocate(type: DataType, length: number): ColumnValues {
  // Purpose: allocate zeroed storage for `length` values of a type
  switch (type.name) {
    case 'bool':
    case 'uint8':
      return new Uint8Array(length);
    case 'int8':
      return new Int8Array(length);
    case 'int16':
      return new Int16Array(length);
    case 'int32':
      return new Int32Array(length);
    case 'uint16':
      return new Uint16Array(length);
    case 'uint32':
      return new Uint32Array(length);
    case 'int64':
      return new BigInt64Array(length);
    case 'uint64':
      return new BigUint64Array(length);
    case 'float32':
      return new Float32Array(length);
    case 'float64':
      return new Float64Array(length);
    case 'utf8':
    case 'dictionary':
      // Dictionary encoding is a storage optimization added in docs/TASKS.md, T-107.
      return new Array<string>(length).fill('');
    case 'date32':
    case 'timestamp':
      throw new SchemaError(`Columns of type ${type.name} are not supported yet (T-108)`);
  }
}

export function makeColumn(type: DataType, values: ColumnValues, valid: Uint8Array | null): Column {
  // Purpose: build a column, dropping the validity array when nothing is null
  if (valid && valid.indexOf(0) === -1) return { type, values, valid: null };
  return { type, values, valid };
}

export function take(column: Column, indices: Uint32Array): Column {
  // Purpose: gather the rows at `indices` into a new column
  const out = allocate(column.type, indices.length);
  const src = cells(column);
  const dst = out as unknown as AnyCells;
  for (let i = 0; i < indices.length; i++) dst[i] = src[indices[i]!]!;
  let valid: Uint8Array | null = null;
  if (column.valid) {
    valid = new Uint8Array(indices.length);
    for (let i = 0; i < indices.length; i++) valid[i] = column.valid[indices[i]!]!;
  }
  return makeColumn(column.type, out, valid);
}

export function head(column: Column, count: number): Column {
  // Purpose: the first `count` rows of a column
  const values = column.values.slice(0, count) as ColumnValues;
  const valid = column.valid ? column.valid.slice(0, count) : null;
  return makeColumn(column.type, values, valid);
}
