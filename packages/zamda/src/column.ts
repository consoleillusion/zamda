// In-memory column storage on the JS side: used by the JS backend and by every
// backend's results. Validity is one byte per row (1 = present), which is
// simpler and faster in JS than a bit-packed bitmap (docs/DECISIONS.md, D-004).
//
// Storage by type:
//   bool                 Uint8Array of 0 or 1
//   intN, uintN, floatN  the matching typed array (64-bit integers as BigInt arrays)
//   utf8                 string[]
//   dictionary           Int32Array of codes + `dictionary`, a list of UNIQUE strings
//   date32               Int32Array of days since the Unix epoch
//   timestamp            Float64Array of whole milliseconds since the Unix epoch, UTC

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
  readonly values: ColumnValues;
  // null when no value is null.
  readonly valid: Uint8Array | null;
  // Present exactly when type is `dictionary`. Entries are unique, so two rows
  // of one column hold equal strings if and only if their codes are equal.
  readonly dictionary?: readonly string[];
}

// Loose views used inside kernels, where the element type is known from the DataType.
export type NumCells = { [i: number]: number; readonly length: number };
export type BigCells = { [i: number]: bigint; readonly length: number };
export type AnyCells = { [i: number]: number | bigint | string; readonly length: number };

export function nums(column: Column): NumCells {
  // Purpose: view a column's values as numbers (for a dictionary column: its codes)
  return column.values as unknown as NumCells;
}

export function bigs(column: Column): BigCells {
  // Purpose: view a column's values as bigints
  return column.values as unknown as BigCells;
}

export function cells(column: Column): AnyCells {
  // Purpose: view a column's stored values without knowing the element type
  return column.values as unknown as AnyCells;
}

const decoded = new WeakMap<Column, readonly string[]>();

export function texts(column: Column): readonly string[] {
  // Purpose: a string column's values as strings, decoding a dictionary column once
  if (!column.dictionary) return column.values as string[];
  let out = decoded.get(column);
  if (!out) {
    const codes = nums(column);
    const dictionary = column.dictionary;
    const strings: string[] = new Array(codes.length);
    for (let i = 0; i < codes.length; i++) strings[i] = dictionary[codes[i]!] ?? '';
    out = strings;
    decoded.set(column, out);
  }
  return out;
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
    case 'date32':
    case 'dictionary':
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
    case 'timestamp':
      return new Float64Array(length);
    case 'utf8':
      return new Array<string>(length).fill('');
  }
}

export function makeColumn(
  type: DataType,
  values: ColumnValues,
  valid: Uint8Array | null,
  dictionary?: readonly string[],
): Column {
  // Purpose: build a column, dropping the validity array when nothing is null
  const keep = valid && valid.indexOf(0) !== -1 ? valid : null;
  return dictionary ? { type, values, valid: keep, dictionary } : { type, values, valid: keep };
}

export function stringColumn(type: DataType, strings: readonly string[], valid: Uint8Array | null): Column {
  // Purpose: build a utf8 or dictionary column from strings, encoding a dictionary if needed
  if (type.name !== 'dictionary') return makeColumn(type, strings as string[], valid);
  const codes = new Int32Array(strings.length);
  const dictionary: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < strings.length; i++) {
    if (valid && !valid[i]) continue;
    const s = strings[i]!;
    let code = seen.get(s);
    if (code === undefined) {
      code = dictionary.length;
      seen.set(s, code);
      dictionary.push(s);
    }
    codes[i] = code;
  }
  return makeColumn(type, codes, valid, dictionary);
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
  return makeColumn(column.type, out, valid, column.dictionary);
}

export function head(column: Column, count: number): Column {
  // Purpose: the first `count` rows of a column
  const values = column.values.slice(0, count) as ColumnValues;
  const valid = column.valid ? column.valid.slice(0, count) : null;
  return makeColumn(column.type, values, valid, column.dictionary);
}

export function slice(column: Column, start: number, end: number): Column {
  // Purpose: rows [start, end) of a column; typed arrays are views, not copies
  const values = Array.isArray(column.values)
    ? column.values.slice(start, end)
    : (column.values.subarray(start, end) as ColumnValues);
  const valid = column.valid ? column.valid.subarray(start, end) : null;
  return makeColumn(column.type, values, valid, column.dictionary);
}

export function emptyColumn(type: DataType): Column {
  // Purpose: a column of the given type with no rows
  return makeColumn(type, allocate(type, 0), null, type.name === 'dictionary' ? [] : undefined);
}

export function concat(type: DataType, pieces: readonly Column[]): Column {
  // Purpose: join columns of one type end to end
  if (pieces.length === 0) return emptyColumn(type);
  if (pieces.length === 1) return pieces[0]!;
  let total = 0;
  let anyNull = false;
  for (const piece of pieces) {
    total += piece.values.length;
    if (piece.valid) anyNull = true;
  }
  let valid: Uint8Array | null = null;
  if (anyNull) {
    valid = new Uint8Array(total).fill(1);
    let at = 0;
    for (const piece of pieces) {
      if (piece.valid) valid.set(piece.valid, at);
      at += piece.values.length;
    }
  }
  if (type.name === 'utf8') {
    const out: string[] = [];
    for (const piece of pieces) for (const s of piece.values as string[]) out.push(s);
    return makeColumn(type, out, valid);
  }
  if (type.name === 'dictionary') {
    const shared = pieces[0]!.dictionary;
    const same = pieces.every(function (piece) {
      return piece.dictionary === shared;
    });
    if (!same) {
      // Pieces computed separately have separate dictionaries: re-encode through strings.
      const out: string[] = [];
      for (const piece of pieces) for (const s of texts(piece)) out.push(s);
      return stringColumn(type, out, valid);
    }
  }
  const values = allocate(type, total);
  let at = 0;
  for (const piece of pieces) {
    (values as unknown as { set(source: unknown, offset: number): void }).set(piece.values, at);
    at += piece.values.length;
  }
  return makeColumn(type, values, valid, pieces[0]!.dictionary);
}

type Growable = Exclude<ColumnValues, string[]>;

export function grow<A extends Growable>(array: A, size: number): A {
  // Purpose: the same typed array, or a copy at least `size` long with doubled capacity
  if (array.length >= size) return array;
  const make = array.constructor as new (length: number) => A;
  const next = new make(Math.max(size, array.length * 2, 16));
  (next as unknown as { set(source: unknown): void }).set(array);
  return next;
}

export function storageMatches(column: Column, rows: number): boolean {
  // Purpose: true when a column has exactly the storage its type uses (see the table above) for `rows` rows
  const values: unknown = column.values;
  if (column.valid !== null && !(column.valid instanceof Uint8Array && column.valid.length === rows)) return false;
  if (column.type.name === 'utf8') {
    return Array.isArray(values) && values.length === rows && values.every(v => typeof v === 'string');
  }
  const expected = allocate(column.type, 0) as Exclude<ColumnValues, string[]>;
  if (!(values instanceof (expected.constructor as typeof Uint8Array)) || (values as Uint8Array).length !== rows) return false;
  if (column.type.name === 'dictionary') {
    return Array.isArray(column.dictionary) && column.dictionary.every(v => typeof v === 'string');
  }
  return column.dictionary === undefined;
}
