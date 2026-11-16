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

export function loadColumns(
  schema: Schema,
  columns: Readonly<Record<string, ArrayLike<unknown>>>,
): { columns: Column[]; rowCount: number } {
  // Purpose: build a table from one array per column; a matching typed array is used without copying
  let rowCount = -1;
  const out = schema.list.map(function (field) {
    const input = columns[field.name];
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
