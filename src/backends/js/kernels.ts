// Scalar kernels for the JS reference executor: one function per registry
// entry, operating on whole columns. This backend defines correct behaviour for
// every other backend, so clarity beats speed here. Each kernel cites the
// contract rule it implements (docs/CONTRACT.md).
//
// To add a function: add it to src/registry.ts, add its DSL method in
// src/expr.ts, add a kernel here, and add golden tests under tests/golden/.

import type { BigCells, Column, NumCells } from '../../column';
import { allocate, bigs, cells, makeColumn, nums } from '../../column';
import { ExecutionError } from '../../errors';
import type { DataType } from '../../types';
import { BIGINT_RANGES, INT_RANGES, isBigInt, isInt, isString, t } from '../../types';

export type Kernel = (args: readonly Column[], type: DataType, rowCount: number) => Column;

function mergeValid(a: Uint8Array | null, b: Uint8Array | null, n: number): Uint8Array | null {
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

function compareValues(a: number | bigint | string, b: number | bigint | string): number {
  // Purpose: three-way compare that yields NaN when either side is NaN (C-NAN-PREDICATE)
  if (a < b) return -1;
  if (a > b) return 1;
  return a === b ? 0 : NaN;
}

function comparison(test: (order: number) => boolean): Kernel {
  // Purpose: build a comparison kernel from a test on the three-way result
  return function (args, _type, n) {
    const x = args[0]!;
    const y = args[1]!;
    const valid = mergeValid(x.valid, y.valid, n);
    const out = new Uint8Array(n);
    const a = cells(x);
    const b = cells(y);
    const strings = isString(x.type);
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      const order = strings
        ? compareStrings(a[i] as string, b[i] as string)
        : compareValues(a[i]!, b[i]!);
      out[i] = test(order) ? 1 : 0;
    }
    return makeColumn(t.bool, out, valid);
  };
}

function kleene(isAnd: boolean): Kernel {
  // Purpose: C-NULL-LOGIC: three-valued AND / OR
  return function (args, _type, n) {
    const x = args[0]!;
    const y = args[1]!;
    const a = nums(x);
    const b = nums(y);
    const out = new Uint8Array(n);
    const valid = new Uint8Array(n);
    // The value that decides the result on its own: false for AND, true for OR.
    const decisive = isAnd ? 0 : 1;
    for (let i = 0; i < n; i++) {
      const av = x.valid ? x.valid[i]! : 1;
      const bv = y.valid ? y.valid[i]! : 1;
      if (av && bv) {
        out[i] = isAnd ? a[i]! & b[i]! : a[i]! | b[i]!;
        valid[i] = 1;
      } else if ((av && a[i] === decisive) || (bv && b[i] === decisive)) {
        out[i] = decisive;
        valid[i] = 1;
      }
    }
    return makeColumn(t.bool, out, valid);
  };
}

function not(args: readonly Column[], _type: DataType, n: number): Column {
  // Purpose: logical NOT; null stays null
  const x = args[0]!;
  const a = nums(x);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] ? 0 : 1;
  return makeColumn(t.bool, out, x.valid);
}

function isNull(args: readonly Column[], _type: DataType, n: number): Column {
  // Purpose: 1 where the input is null; the result itself is never null
  const x = args[0]!;
  const out = new Uint8Array(n);
  if (x.valid) for (let i = 0; i < n; i++) out[i] = x.valid[i] ? 0 : 1;
  return makeColumn(t.bool, out, null);
}

type Op = 'add' | 'sub' | 'mul';

function arithmetic(op: Op): Kernel {
  // Purpose: C-OVERFLOW: integer arithmetic raises ExecutionError when out of range
  return function (args, type, n) {
    const x = args[0]!;
    const y = args[1]!;
    const valid = mergeValid(x.valid, y.valid, n);
    const values = allocate(type, n);

    if (isBigInt(type)) {
      const [lo, hi] = BIGINT_RANGES[type.name];
      const a = bigs(x);
      const b = bigs(y);
      const out = values as unknown as BigCells;
      for (let i = 0; i < n; i++) {
        if (valid && !valid[i]) continue;
        const r = op === 'add' ? a[i]! + b[i]! : op === 'sub' ? a[i]! - b[i]! : a[i]! * b[i]!;
        if (r < lo || r > hi) throw new ExecutionError(`Integer overflow in ${op} (${type.name}) at row ${i}`);
        out[i] = r;
      }
      return makeColumn(type, values, valid);
    }

    const a = nums(x);
    const b = nums(y);
    const out = values as unknown as NumCells;
    // Floats follow IEEE 754 and never raise; the typed array rounds float32.
    const range = isInt(type) ? INT_RANGES[type.name] : null;
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      // Products of two in-range integers stay exact enough to detect overflow.
      const r = op === 'add' ? a[i]! + b[i]! : op === 'sub' ? a[i]! - b[i]! : a[i]! * b[i]!;
      if (range && (r < range[0] || r > range[1])) {
        throw new ExecutionError(`Integer overflow in ${op} (${type.name}) at row ${i}`);
      }
      out[i] = r;
    }
    return makeColumn(type, values, valid);
  };
}

export const KERNELS: ReadonlyMap<string, Kernel> = new Map<string, Kernel>([
  ['eq', comparison(function (o) { return o === 0; })],
  ['neq', comparison(function (o) { return o !== 0; })],
  ['lt', comparison(function (o) { return o < 0; })],
  ['lte', comparison(function (o) { return o <= 0; })],
  ['gt', comparison(function (o) { return o > 0; })],
  ['gte', comparison(function (o) { return o >= 0; })],
  ['and', kleene(true)],
  ['or', kleene(false)],
  ['not', not],
  ['is_null', isNull],
  ['add', arithmetic('add')],
  ['sub', arithmetic('sub')],
  ['mul', arithmetic('mul')],
]);
