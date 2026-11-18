// Helpers shared by the JS backend's kernels, aggregates and sort.

import type { Column } from '../../column';
import { makeColumn } from '../../column';
import { ExecutionError } from '../../errors';
import type { DataType } from '../../types';
import { t } from '../../types';

export type Kernel = (args: readonly Column[], type: DataType, rowCount: number) => Column;

// Columns that hold one value in every row (a literal or parameter broadcast to
// the batch). Kernels may read row 0 instead of the whole array.
const constants = new WeakSet<Column>();

export function markConstant(column: Column): Column {
  // Purpose: record that a column holds the same value in every row
  constants.add(column);
  return column;
}

// Read-only arrays of ones and zeros that constant boolean columns share, so a
// comparison that is true (or false) for every row costs no allocation. Nothing
// may write to a column's values after a kernel returns it, which holds throughout.
const sharedBools = new Map<string, Uint8Array>();

export function constantBool(rowCount: number, value: boolean): Column {
  // Purpose: a boolean column with the same value in every row, no nulls, marked constant
  const key = `${value ? 1 : 0}:${rowCount}`;
  let values = sharedBools.get(key);
  if (!values) {
    // Keep a handful of sizes (the chunk size, the table size, the last short chunk).
    if (sharedBools.size >= 8) sharedBools.clear();
    values = new Uint8Array(rowCount);
    if (value) values.fill(1);
    sharedBools.set(key, values);
  }
  return markConstant(makeColumn(t.bool, values, null));
}

export function isConstant(column: Column): boolean {
  // Purpose: true if the column is known to hold the same value in every row
  return constants.has(column);
}

export function mergeValid(a: Uint8Array | null, b: Uint8Array | null, n: number): Uint8Array | null {
  // Purpose: validity of a result that is null when either input is null
  if (!a && !b) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (a ? a[i]! : 1) & (b ? b[i]! : 1);
  return out;
}

function fixUnit(unit: number): number {
  // Purpose: remap a UTF-16 code unit so unit order equals code point order
  if (unit < 0xd800) return unit;
  return unit <= 0xdfff ? unit + 0x2000 : unit - 0x800;
}

export function compareStrings(a: string, b: string): number {
  // Purpose: C-STR-ORDER: compare by Unicode code point, not JS's UTF-16 order
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return fixUnit(x) < fixUnit(y) ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function orderNumbers(a: number | bigint, b: number | bigint): number {
  // Purpose: C-NAN-ORDER: total order for numbers in which NaN is greater than everything
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) return 0;
  const aNaN = a !== a;
  const bNaN = b !== b;
  return aNaN === bNaN ? 0 : aNaN ? 1 : -1;
}

export function overflow(what: string, type: DataType, detail = ''): never {
  // Purpose: raise the C-OVERFLOW error. Row numbers are not reported: execution is
  // chunked and rows may have been filtered, so a position would mislead.
  throw new ExecutionError(`Integer overflow in ${what} (${type.name})${detail ? `: ${detail}` : ''}`);
}

export function divideByZero(what: string): never {
  // Purpose: raise the C-DIV error for an integer division by zero
  throw new ExecutionError(`Integer divide by zero in ${what}`);
}
