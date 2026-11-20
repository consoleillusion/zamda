// Conversion of one JS value to its stored form, with every check the schema
// implies. Used for literals and parameters. Row loading has its own
// type-specialized loops (backends/js/load.ts) that must apply the same rules.

import type { DataType } from './types';
import { BIGINT_RANGES, INT_RANGES, MS_PER_DAY, isBigInt, isFloat, isInt, isString } from './types';

export type Stored = number | bigint | string;

export function toStorage(value: unknown, type: DataType): Stored | undefined {
  // Purpose: the stored form of a value, or undefined if the type cannot hold it
  if (type.name === 'bool') return typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
  if (isInt(type)) {
    const [lo, hi] = INT_RANGES[type.name];
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
    return ok ? (value as number) : undefined;
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
  if (!(value instanceof Date)) return undefined;
  const ms = value.getTime();
  if (ms !== ms) return undefined;
  // C-TIME: timestamp is whole milliseconds since the Unix epoch, UTC.
  if (type.name === 'timestamp') return ms;
  // C-TIME: date32 is whole days since the Unix epoch; a time of day is rejected.
  return ms % MS_PER_DAY === 0 ? ms / MS_PER_DAY : undefined;
}
