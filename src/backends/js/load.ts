// Loading JS rows into columns, checking every value against the schema.

import type { AnyCells, Column } from '../../column';
import { allocate, makeColumn } from '../../column';
import { SchemaError } from '../../errors';
import type { Schema } from '../../schema';
import type { DataType } from '../../types';
import { BIGINT_RANGES, INT_RANGES, isBigInt, isFloat, isInt, isString } from '../../types';

function convert(value: unknown, type: DataType): number | bigint | string | undefined {
  // Purpose: check one value against its column type; undefined means "not acceptable"
  if (type.name === 'bool') return typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
  if (isInt(type)) {
    const [lo, hi] = INT_RANGES[type.name];
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
    return ok ? value : undefined;
  }
  if (isBigInt(type)) {
    const [lo, hi] = BIGINT_RANGES[type.name];
    let big: bigint;
    if (typeof value === 'bigint') big = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) big = BigInt(value);
    else return undefined;
    return big >= lo && big <= hi ? big : undefined;
  }
  if (isFloat(type)) return typeof value === 'number' ? value : undefined;
  if (isString(type)) return typeof value === 'string' ? value : undefined;
  return undefined;
}

export function loadRows(schema: Schema, rows: readonly Readonly<Record<string, unknown>>[]): Column[] {
  // Purpose: turn row objects into one checked column per schema field
  const n = rows.length;
  return schema.list.map(function (field) {
    const values = allocate(field.type, n);
    const out = values as unknown as AnyCells;
    const valid = new Uint8Array(n);
    for (let r = 0; r < n; r++) {
      const raw = rows[r]![field.name];
      // A missing or null property is a null value.
      if (raw === null || raw === undefined) continue;
      const value = convert(raw, field.type);
      if (value === undefined) {
        throw new SchemaError(
          `Row ${r}, column "${field.name}": expected ${field.type.name}, got ${typeof raw} (${String(raw)})`,
        );
      }
      out[r] = value;
      valid[r] = 1;
    }
    return makeColumn(field.type, values, valid);
  });
}
