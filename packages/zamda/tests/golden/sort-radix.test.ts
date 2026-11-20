// The radix sort for integer keys must give exactly the order the comparison
// sort gives (C-SORT-STABLE, C-NULL-SORT, C-NAN-ORDER), including ties, nulls in
// either position, descending keys, extreme values and limits. Each case is
// checked against a plain reference comparator over the same columns.

import { describe, expect, test } from 'bun:test';
import { makeColumn } from '../../src/column';
import type { Column } from '../../src/column';
import { sortSteps } from '../../src/backends/js/sort';
import type { SortColumn } from '../../src/backends/js/sort';
import { t } from '../../src/types';

function random(seed: number): () => number {
  // Purpose: deterministic pseudo-random number in [0, 1)
  let state = seed;
  return function () {
    // Purpose: next number (mulberry32)
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'int8' | 'int16' | 'int32' | 'uint8' | 'uint16' | 'uint32' | 'bool' | 'float64';

const EDGES: Record<Kind, number[]> = {
  int8: [-128, -1, 0, 1, 127],
  int16: [-32768, -1, 0, 1, 32767],
  int32: [-2147483648, -1, 0, 1, 2147483647],
  uint8: [0, 1, 255],
  uint16: [0, 1, 65535],
  uint32: [0, 1, 4294967295],
  bool: [0, 1],
  float64: [-Infinity, -0, 0, 1.5, Infinity, NaN],
};

function makeKeyColumn(kind: Kind, n: number, nullRate: number, rand: () => number, spread: number): Column {
  // Purpose: a column of `kind` with edge values, a few distinct small values (many ties) and some nulls
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.3) values.push(EDGES[kind][Math.floor(rand() * EDGES[kind].length)]!);
    else {
      const [lo, hi] = kind === 'bool' ? [0, 1] : [EDGES[kind][0]!, EDGES[kind][EDGES[kind].length - 1]!];
      const pick = Math.floor(rand() * spread);
      values.push(kind === 'float64' ? pick - spread / 2 : Math.max(lo, Math.min(hi, lo + Math.floor(((hi - lo) / spread) * pick))));
    }
  }
  const storage = { int8: Int8Array, int16: Int16Array, int32: Int32Array, uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array, bool: Uint8Array, float64: Float64Array }[kind];
  const valid = nullRate > 0 ? Uint8Array.from({ length: n }, () => (rand() < nullRate ? 0 : 1)) : null;
  return makeColumn(t[kind], new storage(values) as never, valid);
}

function referenceOrder(keys: readonly SortColumn[], n: number): number[] {
  // Purpose: row indexes sorted by the contract's rules with a plain comparator and a row-index tie-break
  const order = Array.from({ length: n }, (_, i) => i);
  const nan = (v: number): boolean => v !== v;
  const cmp = function (a: number, b: number): number {
    // Purpose: compare two rows key by key
    for (const key of keys) {
      const values = key.column.values as ArrayLike<number>;
      const valid = key.column.valid;
      const va = valid ? valid[a] === 1 : true;
      const vb = valid ? valid[b] === 1 : true;
      if (va && vb) {
        const x = values[a]!;
        const y = values[b]!;
        let c = nan(x) || nan(y) ? (nan(x) ? (nan(y) ? 0 : 1) : -1) : x < y ? -1 : x > y ? 1 : 0;
        if (key.descending) c = -c;
        if (c !== 0) return c;
      } else if (va !== vb) {
        const nullRank = key.nullsFirst ? -1 : 1;
        return va ? -nullRank : nullRank;
      }
    }
    return a - b;
  };
  return order.sort(cmp);
}

function run(keys: readonly SortColumn[], n: number, limit: number | null): number[] {
  // Purpose: run the sort generator to completion
  const gen = sortSteps(keys, n, limit);
  for (;;) {
    const step = gen.next();
    if (step.done) return Array.from(step.value);
  }
}

describe('radix sort matches the comparison order', () => {
  const kinds: Kind[] = ['int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32', 'bool'];
  for (let seed = 1; seed <= 40; seed++) {
    test(`random multi-key sort, seed ${seed}`, () => {
      const rand = random(seed);
      const n = [0, 1, 2, 7, 300, 3000][seed % 6]!;
      const keyCount = 1 + Math.floor(rand() * 3);
      const keys: SortColumn[] = [];
      for (let k = 0; k < keyCount; k++) {
        keys.push({
          column: makeKeyColumn(kinds[Math.floor(rand() * kinds.length)]!, n, rand() < 0.5 ? 0 : 0.2, rand, [2, 5, 1000][Math.floor(rand() * 3)]!),
          descending: rand() < 0.5,
          nullsFirst: rand() < 0.5,
        });
      }
      expect(run(keys, n, null)).toEqual(referenceOrder(keys, n));
    });
  }

  test('limits: a small limit, one above the heap cutoff, and one past the end', () => {
    const rand = random(99);
    const n = 20000;
    const keys: SortColumn[] = [
      { column: makeKeyColumn('uint8', n, 0.1, rand, 20), descending: true, nullsFirst: false },
      { column: makeKeyColumn('int32', n, 0, rand, 1000), descending: false, nullsFirst: true },
    ];
    const full = referenceOrder(keys, n);
    for (const limit of [0, 1, 20, 8192, 8193, 15000, n, n + 5]) {
      expect(run(keys, n, limit)).toEqual(full.slice(0, limit));
    }
  });

  test('a key set that includes a float column falls back to the comparison sort and agrees', () => {
    const rand = random(5);
    const n = 2000;
    const keys: SortColumn[] = [
      { column: makeKeyColumn('uint8', n, 0, rand, 4), descending: false, nullsFirst: false },
      { column: makeKeyColumn('float64', n, 0.1, rand, 30), descending: true, nullsFirst: true },
    ];
    expect(run(keys, n, null)).toEqual(referenceOrder(keys, n));
  });

  test('more rows than one block, so the passes yield part-way through', () => {
    const rand = random(7);
    const n = 300_000;
    const keys: SortColumn[] = [
      { column: makeKeyColumn('uint8', n, 0, rand, 30), descending: false, nullsFirst: false },
      { column: makeKeyColumn('uint32', n, 0.05, rand, 100000), descending: true, nullsFirst: false },
    ];
    const gen = sortSteps(keys, n, null);
    let yields = 0;
    let result: number[] | undefined;
    for (;;) {
      const step = gen.next();
      if (step.done) {
        result = Array.from(step.value);
        break;
      }
      yields++;
    }
    // The generator always produces a value here; this narrows the type for the assertion.
    if (result === undefined) throw new Error('the generator finished without producing a permutation');
    expect(yields).toBeGreaterThan(2);
    expect(result).toEqual(referenceOrder(keys, n));
  });

  test('every row equal: input order is kept', () => {
    const n = 5000;
    const keys: SortColumn[] = [{ column: makeColumn(t.int32, new Int32Array(n).fill(7), null), descending: true, nullsFirst: false }];
    expect(run(keys, n, null)).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});
