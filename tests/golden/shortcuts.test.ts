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
