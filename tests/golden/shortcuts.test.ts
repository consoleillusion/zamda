// The JS backend's evaluation shortcuts must not change any answer
// (docs/DECISIONS.md, D-045). Each case states the expected rows by hand and
// runs at several chunk sizes, with parameters, so the shortcut paths are taken.

import { describe, expect, test } from 'bun:test';
import { count, lit, list, pipe, schema, t, table } from '../../src';

const S = schema({ k: t.dictionary, n: t.uint8, b: t.bool });
const rows = [
  { k: 'Alpha', n: 0, b: true },
  { k: 'beta', n: 255, b: null },
  { k: null, n: null, b: false },
  { k: 'ALPHA', n: 7, b: null },
  { k: 'gamma', n: 200, b: true },
];
const input = table(S, rows);
const P = { on: t.bool, maybe: t.bool, lo: t.uint8, hi: t.uint8, s: t.utf8, ks: list(t.dictionary) };

async function flags(
  predicate: Parameters<ReturnType<typeof pipe<typeof S.fields, typeof P>>['select']>[0],
  params: Record<string, unknown>,
): Promise<(boolean | null)[]> {
  // Purpose: one boolean per input row, identical at every chunk size
  const plan = pipe(S, P).select(predicate).compile();
  const results: (boolean | null)[][] = [];
  for (const chunkRows of [1, 2, 3, 5]) {
    const out = (await plan.execute(input, { params: params as never, chunkRows })).toArray() as { v: boolean | null }[];
    results.push(out.map(r => r.v));
  }
  for (const r of results) expect(r).toEqual(results[0]!);
  return results[0]!;
}

const base = { on: true, maybe: false, lo: 0, hi: 255, s: '', ks: [] as string[] };

describe('and/or with a constant side (C-NULL-LOGIC)', () => {
  test('x or true is true, even for null x; x or false is x', async () => {
    expect(await flags((c, p) => ({ v: c.b.or(p.on) }), base)).toEqual([true, true, true, true, true]);
    expect(await flags((c, p) => ({ v: p.maybe.or(c.b) }), base)).toEqual([true, null, false, null, true]);
  });

  test('x and false is false, even for null x; x and true is x', async () => {
    expect(await flags((c, p) => ({ v: c.b.and(p.maybe) }), base)).toEqual([false, false, false, false, false]);
    expect(await flags((c, p) => ({ v: p.on.and(c.b) }), base)).toEqual([true, null, false, null, true]);
  });
});

describe('comparisons against a constant', () => {
  test('a range covering the whole type keeps nulls null', async () => {
    expect(await flags((c, p) => ({ v: c.n.between(p.lo, p.hi) }), base)).toEqual([true, true, null, true, true]);
  });

  test('ordinary bounds, either side constant', async () => {
    expect(await flags((c, p) => ({ v: c.n.between(p.lo, p.hi) }), { ...base, lo: 7, hi: 200 })).toEqual([false, false, null, true, true]);
    expect(await flags((c, p) => ({ v: c.n.gt(p.hi) }), base)).toEqual([false, false, null, false, false]);
    expect(await flags((c, p) => ({ v: c.n.lt(p.lo) }), base)).toEqual([false, false, null, false, false]);
    expect(await flags(c => ({ v: lit(7, t.uint8).lte(c.n) }), base)).toEqual([false, true, null, true, true]);
  });
});

describe('expressions over one dictionary column, computed per distinct value', () => {
  test('case-insensitive search', async () => {
    expect(await flags((c, p) => ({ v: c.k.lower().contains(p.s) }), { ...base, s: 'alp' })).toEqual([true, false, null, true, false]);
    // A new parameter value gives a new answer, not a cached one.
    expect(await flags((c, p) => ({ v: c.k.lower().contains(p.s) }), { ...base, s: 'ta' })).toEqual([false, true, null, false, false]);
  });

  test('null rows get the expression evaluated on null', async () => {
    expect(await flags(c => ({ v: c.k.isNull() }), base)).toEqual([false, false, true, false, false]);
    expect(await flags(c => ({ v: c.k.upper().eq('ALPHA').or(c.k.isNull()) }), base)).toEqual([true, false, true, true, false]);
  });

  test('filters and counts agree with the row-by-row answer', async () => {
    const plan = pipe(S, P)
      .filter((c, p) => p.on.and(c.k.lower().eq('alpha')))
      .agg(() => ({ n: count() }))
      .compile();
    for (const chunkRows of [1, 2, 5]) {
      expect((await plan.execute(input, { params: base as never, chunkRows })).toArray()).toEqual([{ n: 2 }]);
    }
  });
});

// Constants that come out of a comparison, not only literals and parameters
// (docs/DECISIONS.md, D-052): a range test that covers a column's whole integer
// type is the same for every row, so and/or and filter can skip the column.
const T = schema({ n: t.uint8, i: t.int8, b: t.bool });
const trows = [
  { n: 0, i: -128, b: true },
  { n: 255, i: 127, b: null },
  { n: 7, i: 0, b: false },
  { n: 200, i: -1, b: null },
  { n: 3, i: 5, b: true },
];
const tinput = table(T, trows);
const TP = { lo: t.uint8, hi: t.uint8, ilo: t.int8 };

async function tflags(
  predicate: Parameters<ReturnType<typeof pipe<typeof T.fields, typeof TP>>['select']>[0],
  params: Record<string, unknown>,
  data: typeof tinput = tinput,
): Promise<(boolean | null)[]> {
  // Purpose: one boolean per row of T, identical at every chunk size
  const plan = pipe(T, TP).select(predicate).compile();
  const results: (boolean | null)[][] = [];
  for (const chunkRows of [1, 2, 3, 5, 100]) {
    const out = (await plan.execute(data, { params: params as never, chunkRows })).toArray() as { v: boolean | null }[];
    results.push(out.map(r => r.v));
  }
  for (const r of results) expect(r).toEqual(results[0]!);
  return results[0]!;
}

const tbase = { lo: 0, hi: 255, ilo: -128 };

describe('constant comparisons (every row answers the same)', () => {
  test('a covering test is true for all rows and drops out of and/or', async () => {
    // n >= 0 on a uint8 is always true: "true and b" is b, "true or b" is true.
    expect(await tflags((c, p) => ({ v: c.n.gte(p.lo).and(c.b) }), tbase)).toEqual([true, null, false, null, true]);
    expect(await tflags((c, p) => ({ v: c.b.and(c.n.gte(p.lo)) }), tbase)).toEqual([true, null, false, null, true]);
    expect(await tflags((c, p) => ({ v: c.n.gte(p.lo).or(c.b) }), tbase)).toEqual([true, true, true, true, true]);
    expect(await tflags((c, p) => ({ v: c.n.lte(p.hi).and(c.i.gte(p.ilo)) }), tbase)).toEqual([true, true, true, true, true]);
  });

  test('an impossible test is false for all rows, null in the other operand included', async () => {
    // n < 0 on a uint8 is never true: "false and b" is false even for null b, "false or b" is b.
    expect(await tflags((c, p) => ({ v: c.n.lt(p.lo).and(c.b) }), tbase)).toEqual([false, false, false, false, false]);
    expect(await tflags((c, p) => ({ v: c.n.lt(p.lo).or(c.b) }), tbase)).toEqual([true, null, false, null, true]);
    expect(await tflags((c, p) => ({ v: c.n.gt(p.hi) }), tbase)).toEqual([false, false, false, false, false]);
  });

  test('bounds that cut part of the range still compare row by row', async () => {
    expect(await tflags((c, p) => ({ v: c.n.between(p.lo, p.hi) }), { ...tbase, lo: 1, hi: 254 })).toEqual([false, false, true, true, true]);
    expect(await tflags((c, p) => ({ v: c.i.gte(p.ilo) }), { ...tbase, ilo: -1 })).toEqual([false, true, true, true, true]);
    expect(await tflags((c, p) => ({ v: c.n.gte(p.lo).and(c.i.lt(0)) }), tbase)).toEqual([true, false, false, true, false]);
  });

  test('strict tests at the very edge of the range are not mistaken for constants', async () => {
    // n > 0 is false only for 0; n < 255 is false only for 255; n >= 255 and n <= 0 are true for one value each.
    expect(await tflags((c, p) => ({ v: c.n.gt(p.lo) }), tbase)).toEqual([false, true, true, true, true]);
    expect(await tflags((c, p) => ({ v: c.n.lt(p.hi) }), tbase)).toEqual([true, false, true, true, true]);
    expect(await tflags((c, p) => ({ v: c.n.gte(p.hi) }), tbase)).toEqual([false, true, false, false, false]);
    expect(await tflags((c, p) => ({ v: c.n.lte(p.lo) }), tbase)).toEqual([true, false, false, false, false]);
    // And a swapped operand: 0 < n.
    expect(await tflags((c, p) => ({ v: lit(0, t.uint8).lt(c.n) }), tbase)).toEqual([false, true, true, true, true]);
  });

  test('two literals compare to a constant', async () => {
    expect(await tflags(c => ({ v: lit(3, t.uint8).lt(5).and(c.b) }), tbase)).toEqual([true, null, false, null, true]);
    expect(await tflags(c => ({ v: lit(9, t.uint8).lt(5).or(c.b) }), tbase)).toEqual([true, null, false, null, true]);
  });

  test('filter keeps every row, or none, when its predicate is constant', async () => {
    const all = pipe(T, TP).filter((c, p) => c.n.gte(p.lo)).agg(() => ({ n: count() })).compile();
    const none = pipe(T, TP).filter((c, p) => c.n.lt(p.lo)).agg(() => ({ n: count() })).compile();
    const rowsOf = pipe(T, TP).filter((c, p) => c.n.gte(p.lo)).compile();
    for (const chunkRows of [1, 2, 5, 100]) {
      expect((await all.execute(tinput, { params: tbase as never, chunkRows })).toArray()).toEqual([{ n: 5 }]);
      expect((await none.execute(tinput, { params: tbase as never, chunkRows })).toArray()).toEqual([{ n: 0 }]);
      expect((await rowsOf.execute(tinput, { params: tbase as never, chunkRows })).toArray()).toEqual(trows);
    }
  });

  test('an empty table gives the right empty answers', async () => {
    const empty = table(T, []);
    expect(await tflags((c, p) => ({ v: c.n.gte(p.lo).and(c.b) }), tbase, empty)).toEqual([]);
    const count0 = pipe(T, TP).filter((c, p) => c.n.gte(p.lo)).agg(() => ({ n: count() })).compile();
    expect((await count0.execute(empty, { params: tbase as never })).toArray()).toEqual([{ n: 0 }]);
  });

  test('a nullable column is never treated as constant', async () => {
    // S.n can be null: a covering range must still give null for the null row.
    expect(await flags((c, p) => ({ v: c.n.gte(p.lo) }), base)).toEqual([true, true, null, true, true]);
    const keep = pipe(S, P).filter((c, p) => c.n.gte(p.lo)).agg(() => ({ n: count() })).compile();
    for (const chunkRows of [1, 2, 5]) {
      expect((await keep.execute(input, { params: base as never, chunkRows })).toArray()).toEqual([{ n: 4 }]);
    }
  });
});
