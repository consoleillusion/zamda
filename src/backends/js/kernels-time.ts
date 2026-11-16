// Date and time kernels (C-TIME). All calendar arithmetic is in UTC.
// date32 is stored as whole days, timestamp as whole milliseconds, since the Unix epoch.
// The first argument of each kernel is the unit, as a utf8 literal column.

import type { Column, NumCells } from '../../column';
import { allocate, makeColumn, nums, texts } from '../../column';
import { PlanError } from '../../errors';
import type { DataType } from '../../types';
import { MS_PER_DAY, t } from '../../types';
import type { Kernel } from './kernel-util';

const FIXED_UNIT_MS: Readonly<Record<string, number>> = {
  day: MS_PER_DAY,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
};

function unitOf(column: Column, n: number): string {
  // Purpose: read the unit from the literal column; any row holds the same value
  return n === 0 ? 'day' : texts(column)[0]!;
}

function startOf(ms: number, unit: string): number {
  // Purpose: the first millisecond of the UTC year or month containing `ms`
  const date = new Date(ms);
  const start = new Date(0);
  // setUTCFullYear avoids Date.UTC's remapping of years 0 to 99.
  start.setUTCFullYear(date.getUTCFullYear(), unit === 'year' ? 0 : date.getUTCMonth(), 1);
  return start.getTime();
}

function truncate(ms: number, unit: string): number {
  // Purpose: round a millisecond timestamp down to the start of a unit
  const size = FIXED_UNIT_MS[unit];
  if (size !== undefined) return Math.floor(ms / size) * size;
  if (unit === 'year' || unit === 'month') return startOf(ms, unit);
  throw new PlanError(`date_trunc: unknown unit "${unit}"`);
}

function field(ms: number, unit: string): number {
  // Purpose: one UTC calendar field of a millisecond timestamp; month and day start at 1
  const date = new Date(ms);
  switch (unit) {
    case 'year':
      return date.getUTCFullYear();
    case 'month':
      return date.getUTCMonth() + 1;
    case 'day':
      return date.getUTCDate();
    case 'hour':
      return date.getUTCHours();
    case 'minute':
      return date.getUTCMinutes();
    case 'second':
      return date.getUTCSeconds();
    default:
      throw new PlanError(`extract: unknown unit "${unit}"`);
  }
}

function dateTrunc(args: readonly Column[], type: DataType, n: number): Column {
  // Purpose: C-TIME: round each value down to the start of its year, month, day, hour, minute or second
  const unit = unitOf(args[0]!, n);
  const x = args[1]!;
  const a = nums(x);
  const values = allocate(type, n);
  const out = values as unknown as NumCells;
  const scale = type.name === 'date32' ? MS_PER_DAY : 1;
  for (let i = 0; i < n; i++) {
    if (x.valid && !x.valid[i]) continue;
    out[i] = truncate(a[i]! * scale, unit) / scale;
  }
  return makeColumn(type, values, x.valid);
}

function extract(args: readonly Column[], _type: DataType, n: number): Column {
  // Purpose: C-TIME: one calendar field per value, as int32
  const unit = unitOf(args[0]!, n);
  const x = args[1]!;
  const a = nums(x);
  const out = new Int32Array(n);
  const scale = x.type.name === 'date32' ? MS_PER_DAY : 1;
  for (let i = 0; i < n; i++) {
    if (x.valid && !x.valid[i]) continue;
    out[i] = field(a[i]! * scale, unit);
  }
  return makeColumn(t.int32, out, x.valid);
}

export const TIME_KERNELS: readonly (readonly [string, Kernel])[] = [
  ['date_trunc', dateTrunc],
  ['extract', extract],
];
