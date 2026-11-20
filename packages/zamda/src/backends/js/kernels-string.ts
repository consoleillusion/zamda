// String kernels. They read strings through texts(), so utf8 and dictionary
// columns behave identically.
//
// A dictionary column has far fewer distinct strings than rows (a million
// routes, 78,000 network names), so where the answer depends only on the
// string, it is computed once per dictionary entry and then looked up by code.
// Results for a dictionary are cached for as long as the dictionary lives.

import type { Column } from '../../column';
import { makeColumn, nums, stringColumn, texts } from '../../column';
import type { DataType } from '../../types';
import { t } from '../../types';
import type { Kernel } from './kernel-util';
import { mergeValid } from './kernel-util';

const mappedEntries = new WeakMap<readonly string[], Map<string, readonly string[]>>();

function perEntry(dictionary: readonly string[], key: string, fn: (s: string) => string): readonly string[] {
  // Purpose: fn applied to every dictionary entry, cached by dictionary and function name
  let byFn = mappedEntries.get(dictionary);
  if (!byFn) {
    byFn = new Map();
    mappedEntries.set(dictionary, byFn);
  }
  let out = byFn.get(key);
  if (!out) {
    out = dictionary.map(fn);
    byFn.set(key, out);
  }
  return out;
}

function mapStrings(key: string, fn: (s: string) => string): Kernel {
  // Purpose: C-STR-CASE: apply a string-to-string function, keeping the input storage type (T-219)
  return function (args, type, n) {
    const x = args[0]!;
    const out: string[] = new Array(n);
    if (x.dictionary) {
      const mapped = perEntry(x.dictionary, key, fn);
      const codes = nums(x);
      for (let i = 0; i < n; i++) out[i] = mapped[codes[i]!] ?? '';
    } else {
      const a = texts(x);
      for (let i = 0; i < n; i++) out[i] = fn(a[i]!);
    }
    return stringColumn(type, out, x.valid);
  };
}

export function codePointLength(s: string): number {
  // Purpose: C-STR-LENGTH: count Unicode code points; a surrogate pair counts once
  let count = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        count--;
        i++;
      }
    }
  }
  return count;
}

function length(args: readonly Column[], _type: DataType, n: number): Column {
  // Purpose: C-STR-LENGTH: string length in code points, as int32
  const x = args[0]!;
  const out = new Int32Array(n);
  if (x.dictionary) {
    const lengths = x.dictionary.map(codePointLength);
    const codes = nums(x);
    for (let i = 0; i < n; i++) out[i] = lengths[codes[i]!] ?? 0;
  } else {
    const a = texts(x);
    for (let i = 0; i < n; i++) out[i] = codePointLength(a[i]!);
  }
  return makeColumn(t.int32, out, x.valid);
}

function literalOf(column: Column): string | null {
  // Purpose: the single value of a broadcast literal column, or null if it is not one
  if (column.dictionary) return column.dictionary.length === 1 && !column.valid ? column.dictionary[0]! : null;
  return null;
}

function matcher(test: (s: string, part: string) => boolean): Kernel {
  // Purpose: starts_with, ends_with and contains: literal matching, no patterns
  return function (args, _type, n) {
    const x = args[0]!;
    const y = args[1]!;
    const valid = mergeValid(x.valid, y.valid, n);
    const out = new Uint8Array(n);
    const part = literalOf(y);
    if (x.dictionary && part !== null) {
      // Test each distinct string once, then look rows up by code.
      const dictionary = x.dictionary;
      const hits = new Uint8Array(dictionary.length);
      for (let d = 0; d < dictionary.length; d++) hits[d] = test(dictionary[d]!, part) ? 1 : 0;
      const codes = nums(x);
      for (let i = 0; i < n; i++) out[i] = hits[codes[i]!] ?? 0;
      return makeColumn(t.bool, out, valid);
    }
    const a = texts(x);
    if (part !== null) {
      for (let i = 0; i < n; i++) out[i] = test(a[i]!, part) ? 1 : 0;
    } else {
      const b = texts(y);
      for (let i = 0; i < n; i++) out[i] = test(a[i]!, b[i]!) ? 1 : 0;
    }
    return makeColumn(t.bool, out, valid);
  };
}

export const STRING_KERNELS: readonly (readonly [string, Kernel])[] = [
  // toLowerCase and toUpperCase are locale-independent in JS.
  ['lower', mapStrings('lower', function (s) { return s.toLowerCase(); })],
  ['upper', mapStrings('upper', function (s) { return s.toUpperCase(); })],
  ['length', length],
  ['starts_with', matcher(function (s, part) { return s.startsWith(part); })],
  ['ends_with', matcher(function (s, part) { return s.endsWith(part); })],
  ['contains', matcher(function (s, part) { return s.includes(part); })],
];
