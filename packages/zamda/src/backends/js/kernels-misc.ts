// coalesce, if_else and the in-list test.

import type { AnyCells, Column } from '../../column';
import { allocate, bigs, cells, makeColumn, nums, stringColumn, texts } from '../../column';
import type { LiteralValue } from '../../ir';
import type { DataType } from '../../types';
import { isBigInt, isString, t } from '../../types';
import type { Kernel } from './kernel-util';

function choose(first: Uint8Array, a: Column, b: Column, type: DataType, n: number): Column {
  // Purpose: take row i from `a` where first[i] is 1, else from `b`, with that side's validity
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const side = first[i] ? a : b;
    valid[i] = side.valid ? side.valid[i]! : 1;
  }
  if (isString(type)) {
    // The two sides may use different dictionaries, so go through strings.
    const x = texts(a);
    const y = texts(b);
    const out: string[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = first[i] ? x[i]! : y[i]!;
    return stringColumn(type, out, valid);
  }
  const values = allocate(type, n);
  const out = values as unknown as AnyCells;
  const x = cells(a);
  const y = cells(b);
  for (let i = 0; i < n; i++) out[i] = first[i] ? x[i]! : y[i]!;
  return makeColumn(type, values, valid);
}

function coalesce(args: readonly Column[], type: DataType, n: number): Column {
  // Purpose: the first argument where it is not null, else the second
  const a = args[0]!;
  if (!a.valid) return a;
  return choose(a.valid, a, args[1]!, type, n);
}

function ifElse(args: readonly Column[], type: DataType, n: number): Column {
  // Purpose: C-IF: the second argument where the condition is true, else the third (also for a null condition)
  const condition = args[0]!;
  const flags = nums(condition);
  const first = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    first[i] = flags[i] && (!condition.valid || condition.valid[i]) ? 1 : 0;
  }
  return choose(first, args[1]!, args[2]!, type, n);
}

export function inList(x: Column, values: readonly LiteralValue[], n: number): Column {
  // Purpose: C-IN: 1 where the value equals a list entry; null stays null; NaN never matches
  const out = new Uint8Array(n);
  if (x.dictionary) {
    // Test each dictionary entry once, then look codes up.
    const wanted = new Set<LiteralValue>(values);
    const hits = new Uint8Array(x.dictionary.length);
    for (let d = 0; d < hits.length; d++) hits[d] = wanted.has(x.dictionary[d]!) ? 1 : 0;
    const codes = nums(x);
    for (let i = 0; i < n; i++) out[i] = hits[codes[i]!] ?? 0;
  } else if (isString(x.type)) {
    const wanted = new Set<LiteralValue>(values);
    const a = texts(x);
    for (let i = 0; i < n; i++) out[i] = wanted.has(a[i]!) ? 1 : 0;
  } else if (isBigInt(x.type)) {
    const wanted = new Set<LiteralValue>(values);
    const a = bigs(x);
    for (let i = 0; i < n; i++) out[i] = wanted.has(a[i]!) ? 1 : 0;
  } else {
    // Numbers, booleans (stored as 0 or 1) and dates. Set equality treats -0 and 0 as equal.
    const wanted = new Set<number>();
    for (const v of values) {
      const stored = typeof v === 'boolean' ? (v ? 1 : 0) : (v as number);
      if (stored === stored) wanted.add(stored);
    }
    const a = nums(x);
    for (let i = 0; i < n; i++) out[i] = wanted.has(a[i]!) ? 1 : 0;
  }
  return makeColumn(t.bool, out, x.valid);
}

export const MISC_KERNELS: readonly (readonly [string, Kernel])[] = [
  ['coalesce', coalesce],
  ['if_else', ifElse],
];
