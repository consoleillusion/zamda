// Loading JS data into columns, checking every value against the schema.
//
// The hot types (integers, floats, strings) have their own loops so the checks
// are inlined; the others go through toStorage(). Both apply the same rules.

import type { AnyCells, Column, ColumnValues, NumCells } from '../../column';
import { allocate, makeColumn } from '../../column';
import { toStorage } from '../../convert';
import { SchemaError } from '../../errors';
import type { Field, Schema } from '../../schema';
import type { DataType } from '../../types';
import { INT_RANGES, isBigInt, isFloat, isInt } from '../../types';

type Row = Readonly<Record<string, unknown>>;

function reject(row: number, field: Field, raw: unknown): never {
  // Purpose: raise the loading error for one bad value
  const kind = raw instanceof Date ? 'Date' : typeof raw;
  throw new SchemaError(
    `Row ${row}, column "${field.name}": expected ${field.type.name}, got ${kind} (${String(raw)})`,
  );
}

function loadIntegers(rows: readonly Row[], field: Field, lo: number, hi: number): Column {
  // Purpose: load an integer column that fits a JS number, checking integrality and range
  const n = rows.length;
  const name = field.name;
  const values = allocate(field.type, n);
  const out = values as unknown as NumCells;
  const valid = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    const raw = rows[r]![name];
    if (raw === null || raw === undefined) continue;
    // `raw !== Math.floor(raw)` is also true for NaN.
    if (typeof raw !== 'number' || raw < lo || raw > hi || raw !== Math.floor(raw)) reject(r, field, raw);
    out[r] = raw;
    valid[r] = 1;
  }
  return makeColumn(field.type, values, valid);
}

function loadFloats(rows: readonly Row[], field: Field): Column {
  // Purpose: load a float column
  const n = rows.length;
  const name = field.name;
  const values = allocate(field.type, n);
  const out = values as unknown as NumCells;
  const valid = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    const raw = rows[r]![name];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'number') reject(r, field, raw);
    out[r] = raw;
    valid[r] = 1;
  }
  return makeColumn(field.type, values, valid);
}

function loadStrings(rows: readonly Row[], field: Field): Column {
  // Purpose: load a utf8 column
  const n = rows.length;
  const name = field.name;
  const out: string[] = new Array(n);
  const valid = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    const raw = rows[r]![name];
    if (raw === null || raw === undefined) {
      out[r] = '';
      continue;
    }
    if (typeof raw !== 'string') reject(r, field, raw);
    out[r] = raw;
    valid[r] = 1;
  }
  return makeColumn(field.type, out, valid);
}

function loadDictionary(rows: readonly Row[], field: Field): Column {
  // Purpose: load a dictionary column: one code per row, one dictionary entry per distinct string
  const n = rows.length;
  const name = field.name;
  const codes = new Int32Array(n);
  const valid = new Uint8Array(n);
  const dictionary: string[] = [];
  const seen = new Map<string, number>();
  for (let r = 0; r < n; r++) {
    const raw = rows[r]![name];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') reject(r, field, raw);
    let code = seen.get(raw);
    if (code === undefined) {
      code = dictionary.length;
      seen.set(raw, code);
      dictionary.push(raw);
    }
    codes[r] = code;
    valid[r] = 1;
  }
  return makeColumn(field.type, codes, valid, dictionary);
}

function loadGeneric(count: number, field: Field, get: (r: number) => unknown): Column {
  // Purpose: load any column type through toStorage(); used for the less common types
  if (field.type.name === 'dictionary') {
    const rows: Row[] = new Array(count);
    for (let r = 0; r < count; r++) rows[r] = { [field.name]: get(r) };
    return loadDictionary(rows, field);
  }
  const values = allocate(field.type, count);
  const out = values as unknown as AnyCells;
  const valid = new Uint8Array(count);
  for (let r = 0; r < count; r++) {
    const raw = get(r);
    if (raw === null || raw === undefined) continue;
    const stored = toStorage(raw, field.type);
    if (stored === undefined) reject(r, field, raw);
    out[r] = stored;
    valid[r] = 1;
  }
  return makeColumn(field.type, values, valid);
}

export function loadRows(schema: Schema, rows: readonly Row[]): Column[] {
  // Purpose: turn row objects into one checked column per schema field
  return schema.list.map(function (field) {
    const type = field.type;
    if (isInt(type)) {
      const [lo, hi] = INT_RANGES[type.name];
      return loadIntegers(rows, field, lo, hi);
    }
    if (isFloat(type)) return loadFloats(rows, field);
    if (type.name === 'utf8') return loadStrings(rows, field);
    if (type.name === 'dictionary') return loadDictionary(rows, field);
    return loadGeneric(rows.length, field, function (r) {
      return rows[r]![field.name];
    });
  });
}

function isTypedArray(value: unknown): value is ColumnValues {
  // Purpose: true for any typed array (not a plain Array, not a DataView)
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function numericStorage(type: DataType): boolean {
  // Purpose: types whose typed-array storage can be adopted without checking each value
  return isInt(type) || isBigInt(type) || isFloat(type);
}

// A dictionary column that is already encoded: one code per row and the list of
// distinct strings the codes point into. A negative code is null, or `nullCode`
// when given (a file may store null as 255 in a uint8 column, say).
export interface DictionaryInput {
  readonly codes: Int32Array | Uint32Array | Uint16Array | Uint8Array;
  readonly dictionary: readonly string[];
  readonly nullCode?: number;
}

function isDictionaryInput(value: unknown): value is DictionaryInput {
  // Purpose: true for an object holding codes and a dictionary (a plain object, not an array)
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isTypedArray((value as { codes?: unknown }).codes) &&
    Array.isArray((value as { dictionary?: unknown }).dictionary)
  );
}

function loadEncoded(field: Field, input: DictionaryInput): Column {
  // Purpose: check an already encoded dictionary column and adopt it; an Int32Array without nulls is not copied
  const { codes, dictionary } = input;
  if (field.type.name !== 'dictionary') {
    throw new SchemaError(`Column "${field.name}" (${field.type.name}) cannot be loaded from { codes, dictionary }`);
  }
  const unique = new Set<string>();
  for (let d = 0; d < dictionary.length; d++) {
    const entry = dictionary[d];
    if (typeof entry !== 'string') throw new SchemaError(`Column "${field.name}": dictionary entry ${d} is not a string`);
    unique.add(entry);
  }
  if (unique.size !== dictionary.length) {
    throw new SchemaError(`Column "${field.name}": dictionary entries must be unique`);
  }
  const n = codes.length;
  const nullCode = input.nullCode;
  const size = dictionary.length;
  let nulls = 0;
  for (let r = 0; r < n; r++) {
    const code = codes[r]!;
    if (nullCode !== undefined ? code === nullCode : code < 0) nulls++;
    else if (code < 0 || code >= size) {
      throw new SchemaError(`Row ${r}, column "${field.name}": code ${code} is outside the dictionary of ${size} entries`);
    }
  }
  if (nulls === 0 && codes instanceof Int32Array) return makeColumn(field.type, codes, null, dictionary);
  const out = new Int32Array(n);
  const valid = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    const code = codes[r]!;
    if (nullCode !== undefined ? code === nullCode : code < 0) continue;
    out[r] = code;
    valid[r] = 1;
  }
  return makeColumn(field.type, out, valid, dictionary);
}

export function loadColumns(
  schema: Schema,
  columns: Readonly<Record<string, ArrayLike<unknown> | DictionaryInput>>,
): { columns: Column[]; rowCount: number } {
  // Purpose: build a table from one array per column; a matching typed array is used without copying
  let rowCount = -1;
  const out = schema.list.map(function (field) {
    const raw = columns[field.name];
    if (isDictionaryInput(raw)) {
      if (rowCount === -1) rowCount = raw.codes.length;
      if (raw.codes.length !== rowCount) {
        throw new SchemaError(
          `Column "${field.name}" has ${raw.codes.length} values but "${schema.list[0]!.name}" has ${rowCount}`,
        );
      }
      return loadEncoded(field, raw);
    }
    const input = raw as ArrayLike<unknown> | undefined;
    if (input === undefined || input === null || typeof input.length !== 'number') {
      throw new SchemaError(`Column "${field.name}" is missing or is not an array`);
    }
    if (rowCount === -1) rowCount = input.length;
    if (input.length !== rowCount) {
      throw new SchemaError(
        `Column "${field.name}" has ${input.length} values but "${schema.list[0]!.name}" has ${rowCount}`,
      );
    }
    if (isTypedArray(input)) {
      const expected = allocate(field.type, 0).constructor;
      if (!numericStorage(field.type) || input.constructor !== expected) {
        throw new SchemaError(
          `Column "${field.name}" (${field.type.name}) cannot be loaded from a ${input.constructor.name}` +
            (numericStorage(field.type) ? `; pass a ${expected.name}` : '; pass a plain array'),
        );
      }
      // Any bit pattern is a valid value for these types, so the array is adopted as is.
      return makeColumn(field.type, input, null);
    }
    return loadGeneric(input.length, field, function (r) {
      return input[r];
    });
  });
  return { columns: out, rowCount: Math.max(rowCount, 0) };
}

export function loadSegment(
  schema: Schema,
  data: readonly Row[] | { readonly columns: unknown },
): { readonly columns: readonly Column[]; readonly rowCount: number } {
  // Purpose: check and convert row objects or column arrays into one segment
  if (Array.isArray(data)) return { columns: loadRows(schema, data as readonly Row[]), rowCount: data.length };
  const input = data as { readonly columns?: unknown };
  if (input === null || typeof input !== 'object' || typeof input.columns !== 'object' || input.columns === null) {
    throw new SchemaError('Expected an array of rows or { columns: { name: array } }');
  }
  return loadColumns(schema, input.columns as Parameters<typeof loadColumns>[1]);
}
