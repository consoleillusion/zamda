// Golden tests: one describe block per contract rule, named by its ID in
// docs/CONTRACT.md. `test.todo` entries are rules whose implementation is a
// work package in docs/TASKS.md; turn each into a real test when it lands.

import { describe, expect, test } from 'bun:test';
import { ExecutionError, schema, t } from '../../src';
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

describe('C-DIV: division', () => {
  test.todo('/ on integers yields float64 (T-106)');
  test.todo('intDiv by zero raises ExecutionError; float division follows IEEE 754 (T-106)');
});

describe('C-PROMOTION: numeric promotion', () => {
  test.todo('int32 + int8 widens to int32 (T-102)');
  test.todo('integer + float gives float64 (T-102)');
  test.todo('int64 with uint64 requires a cast (T-102)');
});

describe('C-NULL-SORT: nulls in sorts', () => {
  test.todo('nulls sort last in both directions (T-104)');
  test.todo('nullsFirst() places nulls first (T-104)');
});

describe('C-SORT-STABLE: sort is stable', () => {
  test.todo('rows with equal keys keep input order (T-104)');
});

describe('C-NAN-ORDER: NaN in grouping and sorting', () => {
  test.todo('NaN sorts after all numbers (T-104)');
  test.todo('NaN values form one group; -0.0 and 0.0 are one group (T-103)');
});

describe('C-GROUP-ORDER: groups come out in order of first occurrence', () => {
  test.todo('group order matches first appearance in the input (T-103)');
  test.todo('null keys form one group (T-103)');
});

describe('C-AGG-TYPES: aggregate result types', () => {
  test.todo('sum(int32) is int64, sum(uint8) is uint64, sum(float32) is float64 (T-103)');
  test.todo('count() counts rows; c.x.count() skips nulls (T-103)');
  test.todo('sum(int64) overflow raises ExecutionError (T-103)');
});

describe('C-FLOAT-SUM: Neumaier summation in row order', () => {
  test.todo('sum([1e100, 1, -1e100]) is 1 (T-103)');
});

describe('C-EMPTY-AGG: aggregates over no rows', () => {
  test.todo('count is 0; sum, min, max and avg are null (T-103)');
});

describe('C-STR-LENGTH and C-STR-CASE: string functions', () => {
  test.todo('length counts code points, not UTF-16 units (T-105)');
  test.todo('lower and upper use locale-independent Unicode case mapping (T-105)');
});
