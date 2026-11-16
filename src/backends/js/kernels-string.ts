// String kernels. They read strings through texts(), so utf8 and dictionary
// columns behave identically.

import type { Column } from '../../column';
import { makeColumn, texts } from '../../column';
import type { DataType } from '../../types';
import { t } from '../../types';
import type { Kernel } from './kernel-util';
import { mergeValid } from './kernel-util';

function mapStrings(fn: (s: string) => string): Kernel {
  // Purpose: C-STR-CASE: apply a string-to-string function; the result is always utf8
  return function (args, _type, n) {
    const x = args[0]!;
    const a = texts(x);
    const out: string[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = fn(a[i]!);
    return makeColumn(t.utf8, out, x.valid);
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
  const a = texts(x);
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = codePointLength(a[i]!);
  return makeColumn(t.int32, out, x.valid);
}

function matcher(test: (s: string, part: string) => boolean): Kernel {
  // Purpose: starts_with, ends_with and contains: literal matching, no patterns
  return function (args, _type, n) {
    const x = args[0]!;
    const y = args[1]!;
    const a = texts(x);
    const b = texts(y);
    const valid = mergeValid(x.valid, y.valid, n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = test(a[i]!, b[i]!) ? 1 : 0;
    return makeColumn(t.bool, out, valid);
  };
}

export const STRING_KERNELS: readonly (readonly [string, Kernel])[] = [
  // toLowerCase and toUpperCase are locale-independent in JS.
  ['lower', mapStrings(function (s) { return s.toLowerCase(); })],
  ['upper', mapStrings(function (s) { return s.toUpperCase(); })],
  ['length', length],
  ['starts_with', matcher(function (s, part) { return s.startsWith(part); })],
  ['ends_with', matcher(function (s, part) { return s.endsWith(part); })],
  ['contains', matcher(function (s, part) { return s.includes(part); })],
];
