// Golden tests: one describe block per contract rule, named by its ID in
// docs/CONTRACT.md. This file covers filtering, logic, overflow, grouping and
// aggregates; sort.test.ts, functions.test.ts and strings.test.ts cover the rest.

import { describe, expect, test } from 'bun:test';
import { ExecutionError, count, schema, t } from '../../src';
import { run } from './helpers';

describe('C-FILTER: filter keeps only rows where the predicate is true', () => {
  test('null and false predicates are both dropped', async () => {
    const S = schema({ x: t.int32 });
    const out = await run(S, [{ x: 1 }, { x: null }, { x: 5 }], p => p.filter(c => c.x.gt(2)));
    expect(out).toEqual([{ x: 5 }]);
  });
});

describe('C-NULL-LOGIC: three-valued logic', () => {
  const S = schema({ a: t.bool, b: t.bool });
  const rows = [
    { a: true, b: true },
    { a: true, b: false },
    { a: true, b: null },
    { a: false, b: null },
    { a: null, b: null },
  ];

  test('and', async () => {
    const out = await run(S, rows, p => p.select(c => ({ r: c.a.and(c.b) })));
    expect(out.map(r => r.r)).toEqual([true, false, null, false, null]);
  });

  test('or', async () => {
    const out = await run(S, rows, p => p.select(c => ({ r: c.a.or(c.b) })));
    expect(out.map(r => r.r)).toEqual([true, true, true, null, null]);
  });

  test('not keeps null', async () => {
    const out = await run(S, rows, p => p.select(c => ({ r: c.b.not() })));
    expect(out.map(r => r.r)).toEqual([false, true, null, null, null]);
  });

  test('comparison with null is null; isNull is never null', async () => {
    const N = schema({ x: t.int32 });
    const out = await run(N, [{ x: 1 }, { x: null }], p =>
      p.select(c => ({ eq: c.x.eq(1), missing: c.x.isNull() })),
    );
    expect(out).toEqual([
      { eq: true, missing: false },
      { eq: null, missing: true },
    ]);
  });
});

describe('C-OVERFLOW: integer arithmetic is checked', () => {
  test('int32 add past the maximum raises ExecutionError', async () => {
    const S = schema({ x: t.int32 });
    await expect(run(S, [{ x: 2147483647 }], p => p.select(c => ({ r: c.x.add(1) })))).rejects.toBeInstanceOf(
      ExecutionError,
    );
  });

  test('uint8 sub below zero raises ExecutionError', async () => {
    const S = schema({ x: t.uint8 });
    await expect(run(S, [{ x: 0 }], p => p.select(c => ({ r: c.x.sub(1) })))).rejects.toBeInstanceOf(ExecutionError);
  });

  test('int64 mul past the maximum raises ExecutionError', async () => {
    const S = schema({ x: t.int64 });
    await expect(run(S, [{ x: 2n ** 62n }], p => p.select(c => ({ r: c.x.mul(2n) })))).rejects.toBeInstanceOf(
      ExecutionError,
    );
  });

  test('a null row never raises', async () => {
    const S = schema({ x: t.int32 });
    const out = await run(S, [{ x: null }, { x: 1 }], p => p.select(c => ({ r: c.x.add(2147483646) })));
    expect(out).toEqual([{ r: null }, { r: 2147483647 }]);
  });

  test('floats follow IEEE 754 and do not raise', async () => {
    const S = schema({ x: t.float64 });
    const out = await run(S, [{ x: Number.MAX_VALUE }], p => p.select(c => ({ r: c.x.mul(2) })));
    expect(out).toEqual([{ r: Infinity }]);
  });
});

describe('C-NAN-PREDICATE: IEEE comparison in predicates', () => {
  test('NaN is not equal to, less than or greater than anything', async () => {
    const S = schema({ x: t.float64 });
    const out = await run(S, [{ x: NaN }], p =>
      p.select(c => ({ eq: c.x.eq(NaN), neq: c.x.neq(NaN), lt: c.x.lt(1), gte: c.x.gte(1) })),
    );
    expect(out).toEqual([{ eq: false, neq: true, lt: false, gte: false }]);
  });
});

describe('C-STR-ORDER: strings compare by Unicode code point', () => {
  test('differs from JavaScript UTF-16 order above the BMP', async () => {
    // U+FF5E sorts before U+1F600 by code point, but after it in UTF-16.
    const S = schema({ a: t.utf8, b: t.utf8 });
    const out = await run(S, [{ a: '～', b: '\u{1F600}' }], p => p.select(c => ({ lt: c.a.lt(c.b) })));
    expect('～' < '\u{1F600}').toBe(false);
    expect(out).toEqual([{ lt: true }]);
  });

  test('a prefix sorts before a longer string', async () => {
    const S = schema({ a: t.utf8, b: t.utf8 });
    const out = await run(S, [{ a: 'ab', b: 'abc' }], p => p.select(c => ({ lt: c.a.lt(c.b) })));
    expect(out).toEqual([{ lt: true }]);
  });
});

describe('C-ROW-ORDER: filter, select and limit preserve input order', () => {
  test('rows come out in input order', async () => {
    const S = schema({ x: t.int32 });
    const rows = [5, 3, 9, 1, 7].map(x => ({ x }));
    const out = await run(S, rows, p => p.filter(c => c.x.gt(2)).select(c => ({ x: c.x })).limit(3));
    expect(out.map(r => r.x)).toEqual([5, 3, 9]);
  });
});

describe('C-INT64-JS: 64-bit integers are bigint', () => {
  test('int64 values round-trip as bigint', async () => {
    const S = schema({ x: t.int64 });
    const out = await run(S, [{ x: 9007199254740993n }], p => p.select(c => ({ x: c.x.add(1n) })));
    expect(out).toEqual([{ x: 9007199254740994n }]);
  });
});

describe('C-NAN-ORDER: NaN in grouping and sorting', () => {
  test('NaN values form one group; -0.0 and 0.0 are one group, reported as 0.0', async () => {
    const S = schema({ x: t.float64 });
    const rows = [{ x: NaN }, { x: -0 }, { x: NaN }, { x: 0 }, { x: 1 }];
    const out = await run(S, rows, p => p.groupBy(c => ({ x: c.x })).agg(() => ({ n: count() })));
    expect(out).toEqual([
      { x: NaN, n: 2 },
      { x: 0, n: 2 },
      { x: 1, n: 1 },
    ]);
    expect(Object.is(out[1]!.x, 0)).toBe(true);
  });

  test('max treats NaN as greatest; min ignores it unless every value is NaN', async () => {
    const S = schema({ k: t.int8, x: t.float64 });
    const rows = [
      { k: 1, x: 2 },
      { k: 1, x: NaN },
      { k: 1, x: 1 },
      { k: 2, x: NaN },
    ];
    const out = await run(S, rows, p =>
      p.groupBy(c => ({ k: c.k })).agg(c => ({ lo: c.x.min(), hi: c.x.max() })),
    );
    expect(out).toEqual([
      { k: 1, lo: 1, hi: NaN },
      { k: 2, lo: NaN, hi: NaN },
    ]);
  });
});

describe('C-GROUP-ORDER: groups come out in order of first occurrence', () => {
  test('group order matches first appearance in the input, for every key strategy', async () => {
    const S = schema({ small: t.uint8, wide: t.int32, name: t.utf8, big: t.int64 });
    const rows = [
      { small: 9, wide: 900000, name: 'z', big: 9n },
      { small: 3, wide: -5, name: 'a', big: 3n },
      { small: 9, wide: 900000, name: 'z', big: 9n },
      { small: 1, wide: 7, name: 'm', big: 1n },
    ];
    const bySmall = await run(S, rows, p => p.groupBy(c => ({ k: c.small })).agg(() => ({ n: count() })));
    const byWide = await run(S, rows, p => p.groupBy(c => ({ k: c.wide })).agg(() => ({ n: count() })));
    const byName = await run(S, rows, p => p.groupBy(c => ({ k: c.name })).agg(() => ({ n: count() })));
    const byBig = await run(S, rows, p => p.groupBy(c => ({ k: c.big })).agg(() => ({ n: count() })));
    const byTwo = await run(S, rows, p =>
      p.groupBy(c => ({ a: c.name, b: c.small })).agg(() => ({ n: count() })),
    );
    expect(bySmall).toEqual([{ k: 9, n: 2 }, { k: 3, n: 1 }, { k: 1, n: 1 }]);
    expect(byWide).toEqual([{ k: 900000, n: 2 }, { k: -5, n: 1 }, { k: 7, n: 1 }]);
    expect(byName).toEqual([{ k: 'z', n: 2 }, { k: 'a', n: 1 }, { k: 'm', n: 1 }]);
    expect(byBig).toEqual([{ k: 9n, n: 2 }, { k: 3n, n: 1 }, { k: 1n, n: 1 }]);
    expect(byTwo).toEqual([{ a: 'z', b: 9, n: 2 }, { a: 'a', b: 3, n: 1 }, { a: 'm', b: 1, n: 1 }]);
  });

  test('null keys form one group', async () => {
    const S = schema({ k: t.utf8, j: t.int8 });
    const rows = [{ k: null, j: null }, { k: 'a', j: 1 }, { k: null, j: null }];
    const one = await run(S, rows, p => p.groupBy(c => ({ k: c.k })).agg(() => ({ n: count() })));
    const small = await run(S, rows, p => p.groupBy(c => ({ j: c.j })).agg(() => ({ n: count() })));
    const two = await run(S, rows, p => p.groupBy(c => ({ k: c.k, j: c.j })).agg(() => ({ n: count() })));
    expect(one).toEqual([{ k: null, n: 2 }, { k: 'a', n: 1 }]);
    expect(small).toEqual([{ j: null, n: 2 }, { j: 1, n: 1 }]);
    expect(two).toEqual([{ k: null, j: null, n: 2 }, { k: 'a', j: 1, n: 1 }]);
  });

  test('multi-key tuples do not collide on separator characters', async () => {
    const S = schema({ a: t.utf8, b: t.utf8 });
    const rows = [{ a: 'x|', b: 'y' }, { a: 'x', b: '|y' }];
    const out = await run(S, rows, p => p.groupBy(c => ({ a: c.a, b: c.b })).agg(() => ({ n: count() })));
    expect(out.length).toBe(2);
  });
});

describe('C-AGG-TYPES: aggregate result types', () => {
  test('sum(int32) is int64, sum(uint8) is uint64, sum(float32) is float64', async () => {
    const S = schema({ k: t.int8, i: t.int32, u: t.uint8, f: t.float32 });
    const rows = [
      { k: 1, i: 2147483647, u: 255, f: 0.5 },
      { k: 1, i: 2147483647, u: 255, f: 0.25 },
    ];
    const out = await run(S, rows, p =>
      p.groupBy(c => ({ k: c.k })).agg(c => ({ i: c.i.sum(), u: c.u.sum(), f: c.f.sum() })),
    );
    expect(out).toEqual([{ k: 1, i: 4294967294n, u: 510n, f: 0.75 }]);
  });

  test('count() counts rows; c.x.count() skips nulls; countDistinct is exact', async () => {
    const S = schema({ k: t.utf8, x: t.int32 });
    const rows = [
      { k: 'a', x: 1 },
      { k: 'a', x: null },
      { k: 'a', x: 1 },
      { k: 'b', x: null },
    ];
    const out = await run(S, rows, p =>
      p.groupBy(c => ({ k: c.k })).agg(c => ({ rows: count(), xs: c.x.count(), d: c.x.countDistinct() })),
    );
    expect(out).toEqual([
      { k: 'a', rows: 3, xs: 2, d: 1 },
      { k: 'b', rows: 1, xs: 0, d: 0 },
    ]);
  });

  test('avg is float64 and min/max keep the input type', async () => {
    const S = schema({ k: t.bool, x: t.int64, s: t.utf8 });
    const rows = [
      { k: true, x: 1n, s: 'b' },
      { k: true, x: 4n, s: '\u{1F600}' },
      { k: true, x: null, s: '～' },
    ];
    const out = await run(S, rows, p =>
      p.groupBy(c => ({ k: c.k })).agg(c => ({ mean: c.x.avg(), lo: c.x.min(), hi: c.x.max(), last: c.s.max() })),
    );
    expect(out).toEqual([{ k: true, mean: 2.5, lo: 1n, hi: 4n, last: '\u{1F600}' }]);
  });

  test('sum(int64) overflow raises ExecutionError, checked on every partial sum', async () => {
    const S = schema({ k: t.int8, x: t.int64 });
    const max = 2n ** 63n - 1n;
    const rows = [{ k: 1, x: max }, { k: 1, x: 1n }, { k: 1, x: -1n }];
    await expect(
      run(S, rows, p => p.groupBy(c => ({ k: c.k })).agg(c => ({ s: c.x.sum() }))),
    ).rejects.toBeInstanceOf(ExecutionError);
  });

  test('integer sums stay exact past 2^53', async () => {
    const S = schema({ k: t.int8, x: t.uint32 });
    // 2,105,000 x (2^32 - 1) is about 9.04e15, just past 2^53 (about 9.007e15).
    const rows = Array.from({ length: 2105000 }, () => ({ k: 1, x: 4294967295 }));
    const out = await run(S, rows, p => p.groupBy(c => ({ k: c.k })).agg(c => ({ s: c.x.sum() })));
    expect(out).toEqual([{ k: 1, s: 4294967295n * 2105000n }]);
  });
});

describe('C-FLOAT-SUM: Neumaier summation in row order', () => {
  test('sum([1e100, 1, -1e100]) is 1', async () => {
    const S = schema({ k: t.int8, x: t.float64 });
    const rows = [1e100, 1, -1e100].map(x => ({ k: 1, x }));
    const out = await run(S, rows, p => p.groupBy(c => ({ k: c.k })).agg(c => ({ s: c.x.sum() })));
    expect(out).toEqual([{ k: 1, s: 1 }]);
  });

  test('infinities and NaN follow IEEE 754', async () => {
    const S = schema({ k: t.int8, x: t.float64 });
    const rows = [
      { k: 1, x: Infinity },
      { k: 1, x: 1 },
      { k: 2, x: Infinity },
      { k: 2, x: -Infinity },
      { k: 3, x: Number.MAX_VALUE },
      { k: 3, x: Number.MAX_VALUE },
    ];
    const out = await run(S, rows, p => p.groupBy(c => ({ k: c.k })).agg(c => ({ s: c.x.sum() })));
    expect(out).toEqual([
      { k: 1, s: Infinity },
      { k: 2, s: NaN },
      { k: 3, s: Infinity },
    ]);
  });
});

describe('C-EMPTY-AGG: aggregates over no values', () => {
  test('a group whose values are all null: count is 0; sum, min, max and avg are null', async () => {
    const S = schema({ k: t.int8, x: t.int32, f: t.float64 });
    const out = await run(S, [{ k: 1, x: null, f: null }], p =>
      p.groupBy(c => ({ k: c.k })).agg(c => ({
        n: c.x.count(),
        s: c.x.sum(),
        fs: c.f.sum(),
        lo: c.x.min(),
        hi: c.x.max(),
        mean: c.x.avg(),
      })),
    );
    expect(out).toEqual([{ k: 1, n: 0, s: null, fs: null, lo: null, hi: null, mean: null }]);
  });

  test('grouping zero rows yields zero groups', async () => {
    const S = schema({ k: t.int8 });
    const out = await run(S, [], p => p.groupBy(c => ({ k: c.k })).agg(() => ({ n: count() })));
    expect(out).toEqual([]);
  });

  test('aggregating without keys yields exactly one row, even over zero rows', async () => {
    const S = schema({ x: t.int32 });
    const some = await run(S, [{ x: 2 }, { x: 3 }, { x: null }], p =>
      p.agg(c => ({ n: count(), xs: c.x.count(), s: c.x.sum(), hi: c.x.max() })),
    );
    const none = await run(S, [], p => p.agg(c => ({ n: count(), s: c.x.sum(), hi: c.x.max() })));
    const filtered = await run(S, [{ x: 2 }], p => p.filter(c => c.x.gt(5)).agg(c => ({ n: count(), s: c.x.sum() })));
    expect(some).toEqual([{ n: 3, xs: 2, s: 5n, hi: 3 }]);
    expect(none).toEqual([{ n: 0, s: null, hi: null }]);
    expect(filtered).toEqual([{ n: 0, s: null }]);
  });
});

describe('hash paths agree with the simple paths', () => {
  test('int32 group-by and integer countDistinct match a Map and Set reference at scale', async () => {
    const S = schema({ k: t.int32, v: t.int32, w: t.float64 });
    const rows = Array.from({ length: 50000 }, (_, i) => ({
      k: i % 7 === 0 ? null : ((i * 2654435761) % 3001) - 1500,
      v: i % 11 === 0 ? null : ((i * 40503) % 977) - 400,
      w: (i * 40503) % 977,
    }));
    const expected = new Map<number | null, { n: number; d: Set<number>; dw: Set<number> }>();
    for (const row of rows) {
      let g = expected.get(row.k);
      if (!g) expected.set(row.k, (g = { n: 0, d: new Set(), dw: new Set() }));
      g.n++;
      if (row.v !== null) g.d.add(row.v);
      g.dw.add(row.w);
    }
    const out = await run(S, rows, p =>
      p.groupBy(c => ({ k: c.k })).agg(c => ({ n: count(), d: c.v.countDistinct(), dw: c.w.countDistinct() })),
    );
    expect(out.map(r => r.k)).toEqual([...expected.keys()]);
    for (const r of out) {
      const g = expected.get(r.k)!;
      expect([r.n, r.d, r.dw]).toEqual([g.n, g.d.size, g.dw.size]);
    }
  });
});
