// Arithmetic kernels. Operands of a binary kernel always have the same type:
// the DSL inserts casts for promotion (C-PROMOTION).

import type { BigCells, Column, NumCells } from '../../column';
import { allocate, bigs, makeColumn, nums } from '../../column';
import type { DataType } from '../../types';
import { BIGINT_RANGES, INT_RANGES, isBigInt, isFloat, isInt, isUnsigned, t } from '../../types';
import type { Kernel } from './kernel-util';
import { divideByZero, mergeValid, overflow } from './kernel-util';

type Op = 'add' | 'sub' | 'mul';

function arithmetic(op: Op, wrapping: boolean): Kernel {
  // Purpose: C-OVERFLOW: add, sub, mul; checked, or wrapping for the explicit wrapping forms
  return function (args, type, n) {
    const x = args[0]!;
    const y = args[1]!;
    const valid = mergeValid(x.valid, y.valid, n);
    const values = allocate(type, n);

    if (isBigInt(type)) {
      const [lo, hi] = BIGINT_RANGES[type.name];
      const unsigned = isUnsigned(type);
      const a = bigs(x);
      const b = bigs(y);
      const out = values as unknown as BigCells;
      for (let i = 0; i < n; i++) {
        if (valid && !valid[i]) continue;
        let r = op === 'add' ? a[i]! + b[i]! : op === 'sub' ? a[i]! - b[i]! : a[i]! * b[i]!;
        if (wrapping) r = unsigned ? BigInt.asUintN(64, r) : BigInt.asIntN(64, r);
        else if (r < lo || r > hi) overflow(op, type, `at row ${i}`);
        out[i] = r;
      }
      return makeColumn(type, values, valid);
    }

    const a = nums(x);
    const b = nums(y);
    const out = values as unknown as NumCells;
    if (wrapping) {
      // Storing into an integer typed array wraps modulo 2^width. Sums and
      // differences are exact in a double; 32-bit products need Math.imul.
      const wide = type.name === 'int32' || type.name === 'uint32';
      for (let i = 0; i < n; i++) {
        if (op === 'add') out[i] = a[i]! + b[i]!;
        else if (op === 'sub') out[i] = a[i]! - b[i]!;
        else out[i] = wide ? Math.imul(a[i]!, b[i]!) : a[i]! * b[i]!;
      }
      return makeColumn(type, values, valid);
    }
    // Floats follow IEEE 754 and never raise; the typed array rounds float32.
    const range = isInt(type) ? INT_RANGES[type.name] : null;
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      // Products of two in-range integers stay exact enough to detect overflow.
      const r = op === 'add' ? a[i]! + b[i]! : op === 'sub' ? a[i]! - b[i]! : a[i]! * b[i]!;
      if (range && (r < range[0] || r > range[1])) overflow(op, type, `at row ${i}`);
      out[i] = r;
    }
    return makeColumn(type, values, valid);
  };
}

function div(args: readonly Column[], type: DataType, n: number): Column {
  // Purpose: C-DIV: integers divide to float64 and raise on a zero divisor; floats follow IEEE 754
  const x = args[0]!;
  const y = args[1]!;
  const valid = mergeValid(x.valid, y.valid, n);
  const values = allocate(type, n);
  const out = values as unknown as NumCells;
  if (isBigInt(x.type)) {
    const a = bigs(x);
    const b = bigs(y);
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      if (b[i] === 0n) divideByZero('div', i);
      out[i] = Number(a[i]) / Number(b[i]);
    }
    return makeColumn(type, values, valid);
  }
  const a = nums(x);
  const b = nums(y);
  const integers = isInt(x.type);
  for (let i = 0; i < n; i++) {
    if (valid && !valid[i]) continue;
    if (integers && b[i] === 0) divideByZero('div', i);
    out[i] = a[i]! / b[i]!;
  }
  return makeColumn(type, values, valid);
}

function intDivOrMod(isMod: boolean): Kernel {
  // Purpose: C-DIV: intDiv truncates toward zero; mod takes the dividend's sign; integer zero divisors raise
  const what = isMod ? 'mod' : 'intDiv';
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
        if (b[i] === 0n) divideByZero(what, i);
        const r = isMod ? a[i]! % b[i]! : a[i]! / b[i]!;
        if (r < lo || r > hi) overflow(what, type, `at row ${i}`);
        out[i] = r;
      }
      return makeColumn(type, values, valid);
    }
    const a = nums(x);
    const b = nums(y);
    const out = values as unknown as NumCells;
    const range = isInt(type) ? INT_RANGES[type.name] : null;
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      if (range && b[i] === 0) divideByZero(what, i);
      // Float mod is the IEEE remainder with the dividend's sign, which is JS's %.
      const r = isMod ? a[i]! % b[i]! : Math.trunc(a[i]! / b[i]!);
      if (range && (r < range[0] || r > range[1])) overflow(what, type, `at row ${i}`);
      out[i] = r;
    }
    return makeColumn(type, values, valid);
  };
}

function negOrAbs(isAbs: boolean): Kernel {
  // Purpose: C-OVERFLOW: neg and abs raise for the minimum signed value
  const what = isAbs ? 'abs' : 'neg';
  return function (args, type, n) {
    const x = args[0]!;
    const values = allocate(type, n);
    if (isBigInt(type)) {
      const [lo, hi] = BIGINT_RANGES[type.name];
      const a = bigs(x);
      const out = values as unknown as BigCells;
      for (let i = 0; i < n; i++) {
        if (x.valid && !x.valid[i]) continue;
        const r = isAbs ? (a[i]! < 0n ? -a[i]! : a[i]!) : -a[i]!;
        if (r < lo || r > hi) overflow(what, type, `at row ${i}`);
        out[i] = r;
      }
      return makeColumn(type, values, x.valid);
    }
    const a = nums(x);
    const out = values as unknown as NumCells;
    const range = isInt(type) ? INT_RANGES[type.name] : null;
    for (let i = 0; i < n; i++) {
      if (x.valid && !x.valid[i]) continue;
      const r = isAbs ? Math.abs(a[i]!) : -a[i]!;
      if (range && (r < range[0] || r > range[1])) overflow(what, type, `at row ${i}`);
      out[i] = r;
    }
    return makeColumn(type, values, x.valid);
  };
}

export function roundTiesEven(x: number): number {
  // Purpose: C-ROUND: nearest integer, ties to even; NaN and infinities pass through
  if (!Number.isFinite(x)) return x;
  const floor = Math.floor(x);
  const diff = x - floor;
  let r: number;
  if (diff < 0.5) r = floor;
  else if (diff > 0.5) r = floor + 1;
  else r = floor % 2 === 0 ? floor : floor + 1;
  // Keep the sign of zero, as IEEE 754 does: round(-0.4) is -0.
  return r === 0 && (x < 0 || Object.is(x, -0)) ? -0 : r;
}

function rounding(fn: (x: number) => number): Kernel {
  // Purpose: floor, ceil and round on float columns
  return function (args, type, n) {
    const x = args[0]!;
    const a = nums(x);
    const values = allocate(type, n);
    const out = values as unknown as NumCells;
    for (let i = 0; i < n; i++) out[i] = fn(a[i]!);
    return makeColumn(type, values, x.valid);
  };
}

function isNaNKernel(args: readonly Column[], _type: DataType, n: number): Column {
  // Purpose: 1 where a float value is NaN; null stays null
  const x = args[0]!;
  const a = nums(x);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i]! !== a[i]! ? 1 : 0;
  return makeColumn(t.bool, out, x.valid);
}

function castNumber(v: number, to: DataType, row: number): number {
  // Purpose: C-CAST: a JS number to a number-backed type, truncating toward zero and checking range
  if (isFloat(to)) return v;
  const r = Math.trunc(v);
  const [lo, hi] = INT_RANGES[(to as DataType<keyof typeof INT_RANGES>).name];
  // The comparison is false for NaN, so NaN and infinities are rejected here too.
  if (!(r >= lo && r <= hi)) overflow('cast', to, `at row ${row}: ${v} does not fit`);
  return r;
}

export function castColumn(x: Column, to: DataType, n: number): Column {
  // Purpose: C-CAST: checked conversion between numeric types
  const values = allocate(to, n);
  const valid = x.valid;
  if (isBigInt(to)) {
    const [lo, hi] = BIGINT_RANGES[to.name];
    const out = values as unknown as BigCells;
    const fromBig = isBigInt(x.type);
    const a = nums(x);
    const b = bigs(x);
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      let r: bigint;
      if (fromBig) r = b[i]!;
      else {
        const v = Math.trunc(a[i]!);
        if (!Number.isFinite(v)) overflow('cast', to, `at row ${i}: ${a[i]} does not fit`);
        r = BigInt(v);
      }
      if (r < lo || r > hi) overflow('cast', to, `at row ${i}: ${r} does not fit`);
      out[i] = r;
    }
    return makeColumn(to, values, valid);
  }
  const out = values as unknown as NumCells;
  if (isBigInt(x.type)) {
    const b = bigs(x);
    const range = isInt(to) ? INT_RANGES[to.name] : null;
    for (let i = 0; i < n; i++) {
      if (valid && !valid[i]) continue;
      const v = b[i]!;
      if (range && (v < BigInt(range[0]) || v > BigInt(range[1]))) {
        overflow('cast', to, `at row ${i}: ${v} does not fit`);
      }
      out[i] = Number(v);
    }
    return makeColumn(to, values, valid);
  }
  const a = nums(x);
  for (let i = 0; i < n; i++) {
    if (valid && !valid[i]) continue;
    out[i] = castNumber(a[i]!, to, i);
  }
  return makeColumn(to, values, valid);
}

export const ARITHMETIC_KERNELS: readonly (readonly [string, Kernel])[] = [
  ['add', arithmetic('add', false)],
  ['sub', arithmetic('sub', false)],
  ['mul', arithmetic('mul', false)],
  ['wrapping_add', arithmetic('add', true)],
  ['wrapping_sub', arithmetic('sub', true)],
  ['wrapping_mul', arithmetic('mul', true)],
  ['div', div],
  ['int_div', intDivOrMod(false)],
  ['mod', intDivOrMod(true)],
  ['neg', negOrAbs(false)],
  ['abs', negOrAbs(true)],
  ['floor', rounding(Math.floor)],
  ['ceil', rounding(Math.ceil)],
  ['round', rounding(roundTiesEven)],
  ['is_nan', isNaNKernel],
];
