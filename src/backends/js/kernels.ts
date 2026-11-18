// Scalar kernels for the JS reference executor: one function per registry
// entry, operating on whole columns. This backend defines correct behaviour for
// every other backend, so clarity beats speed here. Each kernel cites the
// contract rule it implements (docs/CONTRACT.md).
//
// This file holds comparison and logic, and assembles the full kernel table.
// To add a function: add it to src/registry.ts, add its DSL method in
// src/expr.ts, add a kernel in a kernels-<group>.ts file, register that group
// below, and add golden tests under tests/golden/.

import type { Column, NumCells } from '../../column';
import { bigs, makeColumn, nums, texts } from '../../column';
import type { DataType } from '../../types';
import { INT_RANGES, isBigInt, isInt, isString, t } from '../../types';
import type { Kernel } from './kernel-util';
import { compareStrings, constantBool, isConstant, markConstant, mergeValid } from './kernel-util';
import { ARITHMETIC_KERNELS } from './kernels-arith';
import { MISC_KERNELS } from './kernels-misc';
import { STRING_KERNELS } from './kernels-string';
import { TIME_KERNELS } from './kernels-time';

type CompareOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';

const COMPARE_TESTS: Readonly<Record<CompareOp, (order: number) => boolean>> = {
  eq: function (o) { return o === 0; },
  neq: function (o) { return o !== 0; },
  lt: function (o) { return o < 0; },
  lte: function (o) { return o <= 0; },
  gt: function (o) { return o > 0; },
  gte: function (o) { return o >= 0; },
};

function compareNumbers(op: CompareOp, a: NumCells, b: NumCells, out: Uint8Array, n: number): void {
  // Purpose: fast path for number columns; JS operators already give C-NAN-PREDICATE.
  // Null rows are computed too: their result is hidden by the validity array.
  switch (op) {
    case 'eq':
      for (let i = 0; i < n; i++) out[i] = a[i]! === b[i]! ? 1 : 0;
      break;
    case 'neq':
      for (let i = 0; i < n; i++) out[i] = a[i]! !== b[i]! ? 1 : 0;
      break;
    case 'lt':
      for (let i = 0; i < n; i++) out[i] = a[i]! < b[i]! ? 1 : 0;
      break;
    case 'lte':
      for (let i = 0; i < n; i++) out[i] = a[i]! <= b[i]! ? 1 : 0;
      break;
    case 'gt':
      for (let i = 0; i < n; i++) out[i] = a[i]! > b[i]! ? 1 : 0;
      break;
    case 'gte':
      for (let i = 0; i < n; i++) out[i] = a[i]! >= b[i]! ? 1 : 0;
      break;
  }
}

// The operator that gives the same answer with its operands swapped.
const FLIPPED: Record<CompareOp, CompareOp> = { eq: 'eq', neq: 'neq', lt: 'gt', lte: 'gte', gt: 'lt', gte: 'lte' };

function coversType(op: CompareOp, type: DataType, b: number): boolean | null {
  // Purpose: true or false when every value of an integer type gives the same answer against b, else null
  // A range filter that is switched off (0..255 on a uint8 column) then costs one fill.
  if (!isInt(type)) return null;
  const [min, max] = INT_RANGES[type.name];
  if (op === 'gte') return b <= min ? true : b > max ? false : null;
  if (op === 'lte') return b >= max ? true : b < min ? false : null;
  if (op === 'gt') return b < min ? true : b >= max ? false : null;
  if (op === 'lt') return b > max ? true : b <= min ? false : null;
  return null;
}

function compareScalar(op: CompareOp, a: NumCells, b: number, out: Uint8Array, n: number, type: DataType): boolean {
  // Purpose: a number column against one value, read once instead of from a broadcast array.
  // True when every row got the same answer without reading the column (see coversType).
  const fixed = coversType(op, type, b);
  if (fixed !== null) {
    if (fixed) out.fill(1);
    return true;
  }
  switch (op) {
    case 'eq':
      for (let i = 0; i < n; i++) out[i] = a[i]! === b ? 1 : 0;
      break;
    case 'neq':
      for (let i = 0; i < n; i++) out[i] = a[i]! !== b ? 1 : 0;
      break;
    case 'lt':
      for (let i = 0; i < n; i++) out[i] = a[i]! < b ? 1 : 0;
      break;
    case 'lte':
      for (let i = 0; i < n; i++) out[i] = a[i]! <= b ? 1 : 0;
      break;
    case 'gt':
      for (let i = 0; i < n; i++) out[i] = a[i]! > b ? 1 : 0;
      break;
    case 'gte':
      for (let i = 0; i < n; i++) out[i] = a[i]! >= b ? 1 : 0;
      break;
  }
  return false;
}

function compareBigInts(x: Column, y: Column, test: (order: number) => boolean, out: Uint8Array, n: number): void {
  // Purpose: comparison of 64-bit integer columns
  const a = bigs(x);
  const b = bigs(y);
  for (let i = 0; i < n; i++) {
    const p = a[i]!;
    const q = b[i]!;
    out[i] = test(p < q ? -1 : p > q ? 1 : 0) ? 1 : 0;
  }
}

function comparison(op: CompareOp): Kernel {
  // Purpose: build the kernel for one comparison operator
  const test = COMPARE_TESTS[op];
  return function (args, _type, n) {
    const x = args[0]!;
    const y = args[1]!;
    if (n > 0 && !isBigInt(x.type) && !isString(x.type) && !x.valid && !y.valid) {
      // A range test that covers the column's whole integer type is the same for every row.
      let fixed: boolean | null = null;
      if (isConstant(y)) fixed = coversType(op, x.type, nums(y)[0]!);
      else if (isConstant(x)) fixed = coversType(FLIPPED[op], y.type, nums(x)[0]!);
      if (fixed !== null) return constantBool(n, fixed);
    }
    const valid = mergeValid(x.valid, y.valid, n);
    const out = new Uint8Array(n);
    // Set when every row has the same answer, so later operators can skip the whole column.
    let constant = isConstant(x) && isConstant(y);
    if (isBigInt(x.type)) {
      compareBigInts(x, y, test, out, n);
    } else if (!isString(x.type) && isConstant(y)) {
      if (compareScalar(op, nums(x), nums(y)[0]!, out, n, x.type)) constant = true;
    } else if (!isString(x.type) && isConstant(x)) {
      if (compareScalar(FLIPPED[op], nums(y), nums(x)[0]!, out, n, y.type)) constant = true;
    } else if (!isString(x.type)) {
      compareNumbers(op, nums(x), nums(y), out, n);
    } else if ((op === 'eq' || op === 'neq') && x.dictionary && y.dictionary && y.dictionary.length === 1) {
      // Dictionary column against a literal: compare codes, not strings.
      const code = x.dictionary.indexOf(y.dictionary[0]!);
      const codes = nums(x);
      const hit = op === 'eq' ? 1 : 0;
      for (let i = 0; i < n; i++) out[i] = codes[i] === code ? hit : 1 - hit;
    } else {
      const a = texts(x);
      const b = texts(y);
      for (let i = 0; i < n; i++) {
        if (valid && !valid[i]) continue;
        out[i] = test(compareStrings(a[i]!, b[i]!)) ? 1 : 0;
      }
    }
    const result = makeColumn(t.bool, out, valid);
    // A null row is neither true nor false, so only a column without nulls can be constant.
    return constant && !valid ? markConstant(result) : result;
  };
}

function kleene(isAnd: boolean): Kernel {
  // Purpose: C-NULL-LOGIC: three-valued AND / OR
  return function (args, _type, n) {
    const x = args[0]!;
    const y = args[1]!;
    if (n > 0) {
      // A side that is the same in every row (and never null) decides the result or is neutral:
      // true and y = y, false and y = false, true or y = true, false or y = y.
      for (const [side, other] of [[x, y], [y, x]] as const) {
        if (!isConstant(side) || side.valid) continue;
        const value = nums(side)[0]!;
        if (value === (isAnd ? 0 : 1)) return side;
        return other;
      }
    }
    const a = nums(x);
    const b = nums(y);
    const out = new Uint8Array(n);
    if (!x.valid && !y.valid) {
      // No nulls: plain two-valued logic.
      if (isAnd) for (let i = 0; i < n; i++) out[i] = a[i]! & b[i]!;
      else for (let i = 0; i < n; i++) out[i] = a[i]! | b[i]!;
      return makeColumn(t.bool, out, null);
    }
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

export const KERNELS: ReadonlyMap<string, Kernel> = new Map<string, Kernel>([
  ['eq', comparison('eq')],
  ['neq', comparison('neq')],
  ['lt', comparison('lt')],
  ['lte', comparison('lte')],
  ['gt', comparison('gt')],
  ['gte', comparison('gte')],
  ['and', kleene(true)],
  ['or', kleene(false)],
  ['not', not],
  ['is_null', isNull],
  ...ARITHMETIC_KERNELS,
  ...STRING_KERNELS,
  ...TIME_KERNELS,
  ...MISC_KERNELS,
]);
