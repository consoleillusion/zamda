// Helpers shared by the JS backend's kernels, aggregates and sort.

import type { Column } from '../../column';
import { ExecutionError } from '../../errors';
import type { DataType } from '../../types';

export type Kernel = (args: readonly Column[], type: DataType, rowCount: number) => Column;

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

export function overflow(what: string, type: DataType, where: string): never {
  // Purpose: raise the C-OVERFLOW error
  throw new ExecutionError(`Integer overflow in ${what} (${type.name}) ${where}`);
}

export function divideByZero(what: string, row: number): never {
  // Purpose: raise the C-DIV error for an integer division by zero
  throw new ExecutionError(`Integer divide by zero in ${what} at row ${row}`);
}
