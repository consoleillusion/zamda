// Date and time kernels (C-TIME). All calendar arithmetic is in UTC.
// date32 is stored as whole days, timestamp as whole milliseconds, since the Unix epoch.
// The first argument of each kernel is the unit, as a utf8 literal column.

import type { Column, NumCells } from '../../column';
import { allocate, makeColumn, nums, texts } from '../../column';
import { PlanError } from '../../errors';
import type { DataType } from '../../types';
import { MS_PER_DAY, t } from '../../types';
import type { Kernel } from './kernel-util';

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

function unitOf(column: Column, n: number): string {
  // Purpose: read the unit from the literal column; any row holds the same value
  return n === 0 ? 'day' : texts(column)[0]!;
}

function daysFromCivil(year: number, month: number, day: number): number {
  // Purpose: the day number (days since 1970-01-01) of a proleptic Gregorian date, by exact integer arithmetic
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  // Purpose: the year, month (1 to 12) and day (1 to 31) of a day number, by exact integer arithmetic
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function truncateDays(days: number, unit: string): number {
  // Purpose: round a day number down to the first day of its year or month (a day stays as it is)
  if (unit === 'day') return days;
  const [year, month] = civilFromDays(days);
  if (unit === 'year') return daysFromCivil(year, 1, 1);
  if (unit === 'month') return daysFromCivil(year, month, 1);
  throw new PlanError(`date_trunc: unknown unit "${unit}"`);
}

function truncateMs(ms: number, unit: string): number {
  // Purpose: round a millisecond timestamp down to the start of a unit
  const size = unit === 'hour' ? MS_PER_HOUR : unit === 'minute' ? MS_PER_MINUTE : unit === 'second' ? 1_000 : 0;
  if (size !== 0) return Math.floor(ms / size) * size;
  return truncateDays(Math.floor(ms / MS_PER_DAY), unit) * MS_PER_DAY;
}

function fieldOfDays(days: number, unit: string): number {
  // Purpose: the year, month or day of a day number; month and day start at 1
  const [year, month, day] = civilFromDays(days);
  if (unit === 'year') return year;
  if (unit === 'month') return month;
  if (unit === 'day') return day;
  throw new PlanError(`extract: unknown unit "${unit}"`);
}

function fieldOfMs(ms: number, unit: string): number {
  // Purpose: one UTC calendar field of a millisecond timestamp; month and day start at 1
  const days = Math.floor(ms / MS_PER_DAY);
  const inDay = ms - days * MS_PER_DAY;
  switch (unit) {
    case 'hour':
      return Math.floor(inDay / MS_PER_HOUR);
    case 'minute':
      return Math.floor((inDay % MS_PER_HOUR) / MS_PER_MINUTE);
    case 'second':
      return Math.floor((inDay % MS_PER_MINUTE) / 1_000);
    default:
      return fieldOfDays(days, unit);
  }
}

function dateTrunc(args: readonly Column[], type: DataType, n: number): Column {
  // Purpose: C-TIME: round each value down to the start of its year, month, day, hour, minute or second
  const unit = unitOf(args[0]!, n);
  const x = args[1]!;
  const a = nums(x);
  const values = allocate(type, n);
  const out = values as unknown as NumCells;
  const days = type.name === 'date32';
  for (let i = 0; i < n; i++) {
    if (x.valid && !x.valid[i]) continue;
    out[i] = days ? truncateDays(a[i]!, unit) : truncateMs(a[i]!, unit);
  }
  return makeColumn(type, values, x.valid);
}

function extract(args: readonly Column[], _type: DataType, n: number): Column {
  // Purpose: C-TIME: one calendar field per value, as int32
  const unit = unitOf(args[0]!, n);
  const x = args[1]!;
  const a = nums(x);
  const out = new Int32Array(n);
  const days = x.type.name === 'date32';
  for (let i = 0; i < n; i++) {
    if (x.valid && !x.valid[i]) continue;
    out[i] = days ? fieldOfDays(a[i]!, unit) : fieldOfMs(a[i]!, unit);
  }
  return makeColumn(t.int32, out, x.valid);
}

export const TIME_KERNELS: readonly (readonly [string, Kernel])[] = [
  ['date_trunc', dateTrunc],
  ['extract', extract],
];
