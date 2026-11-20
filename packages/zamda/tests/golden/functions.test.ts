// Golden tests for scalar functions. Named by rule ID in docs/CONTRACT.md.

import { describe, expect, test } from 'bun:test';
import { ExecutionError, ExpressionError, SchemaError, TypeCheckError, ifElse, list, pipe, schema, t, table } from '../../src';
import { run } from './helpers';

describe('C-PROMOTION: numeric promotion', () => {
  const S = schema({ i8: t.int8, i16: t.int16, i32: t.int32, u32: t.uint32, f32: t.float32, i64: t.int64, u64: t.uint64 });
  const rows = [{ i8: 100, i16: 100, i32: 2147483647, u32: 4294967295, f32: 0.5, i64: 1n, u64: 1n }];

  test('two expressions widen to the smallest type that holds both', async () => {
    const out = await run(S, rows, p =>
      p.select(c => ({
        small: c.i8.add(c.i16),
        mixed: c.i32.add(c.u32),
        float: c.i8.add(c.f32),
        wide: c.i8.add(c.i64),
      })),
    );
    expect(out).toEqual([{ small: 200, mixed: 6442450942n, float: 100.5, wide: 101n }]);
  });

  test('the promoted type is in the plan', () => {
    const plan = pipe(S).select(c => ({ a: c.i8.add(c.i16), b: c.i32.mul(c.u32), d: c.i8.div(c.i16) })).compile();
    expect(plan.ir.output.map(f => f.type.name)).toEqual(['int16', 'int64', 'float64']);
  });

  test('same-typed operands are not widened, so they can overflow', async () => {
    await expect(run(S, rows, p => p.select(c => ({ r: c.i8.add(c.i8) })))).rejects.toBeInstanceOf(ExecutionError);
  });

  test('a JS literal takes the column type and must fit it', () => {
    expect(() => pipe(S).select(c => ({ r: c.i8.add(1000) }))).toThrow(TypeCheckError);
  });

  test('comparisons promote too', async () => {
    const out = await run(S, rows, p => p.select(c => ({ lt: c.i8.lt(c.i32), eq: c.i8.eq(c.i16), big: c.u32.gt(c.i64) })));
    expect(out).toEqual([{ lt: true, eq: true, big: true }]);
  });

  test('int64 with uint64 requires a cast', async () => {
    // @ts-expect-error no common type
    expect(() => pipe(S).select(c => ({ r: c.i64.add(c.u64) }))).toThrow(TypeCheckError);
    const out = await run(S, rows, p => p.select(c => ({ r: c.i64.add(c.u64.cast(t.int64)) })));
    expect(out).toEqual([{ r: 2n }]);
  });
});

describe('C-CAST: checked numeric casts', () => {
  test('float to integer truncates toward zero', async () => {
    const S = schema({ x: t.float64 });
    const out = await run(S, [{ x: 2.9 }, { x: -2.9 }, { x: null }], p => p.select(c => ({ r: c.x.cast(t.int32) })));
    expect(out.map(r => r.r)).toEqual([2, -2, null]);
  });

  test('a value that does not fit raises ExecutionError', async () => {
    const F = schema({ x: t.float64 });
    const I = schema({ x: t.int32 });
    const B = schema({ x: t.int64 });
    await expect(run(F, [{ x: 300 }], p => p.select(c => ({ r: c.x.cast(t.uint8) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(F, [{ x: NaN }], p => p.select(c => ({ r: c.x.cast(t.int32) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(F, [{ x: Infinity }], p => p.select(c => ({ r: c.x.cast(t.int64) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(I, [{ x: -1 }], p => p.select(c => ({ r: c.x.cast(t.uint32) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(I, [{ x: -1 }], p => p.select(c => ({ r: c.x.cast(t.uint64) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(B, [{ x: 2n ** 40n }], p => p.select(c => ({ r: c.x.cast(t.int32) })))).rejects.toBeInstanceOf(ExecutionError);
  });

  test('widening and float conversions', async () => {
    const S = schema({ i: t.int32, b: t.int64, f: t.float64 });
    const out = await run(S, [{ i: -7, b: 9007199254740993n, f: 0.1 }], p =>
      p.select(c => ({ wide: c.i.cast(t.int64), toFloat: c.b.cast(t.float64), single: c.f.cast(t.float32), same: c.i.cast(t.int32) })),
    );
    expect(out).toEqual([{ wide: -7n, toFloat: 9007199254740992, single: Math.fround(0.1), same: -7 }]);
  });
});

describe('C-DIV: division', () => {
  const I = schema({ a: t.int32, b: t.int32 });

  test('/ on integers yields float64', async () => {
    const out = await run(I, [{ a: 7, b: 2 }, { a: -7, b: 2 }, { a: 7, b: null }], p => p.select(c => ({ r: c.a.div(c.b) })));
    expect(out.map(r => r.r)).toEqual([3.5, -3.5, null]);
  });

  test('integer divide by zero raises for div, intDiv and mod', async () => {
    const rows = [{ a: 1, b: 0 }];
    await expect(run(I, rows, p => p.select(c => ({ r: c.a.div(c.b) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(I, rows, p => p.select(c => ({ r: c.a.intDiv(c.b) })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(I, rows, p => p.select(c => ({ r: c.a.mod(c.b) })))).rejects.toBeInstanceOf(ExecutionError);
  });

  test('a null divisor never raises', async () => {
    const out = await run(I, [{ a: 1, b: null }], p => p.select(c => ({ r: c.a.intDiv(c.b) })));
    expect(out).toEqual([{ r: null }]);
  });

  test('float division follows IEEE 754', async () => {
    const F = schema({ a: t.float64, b: t.float64 });
    const out = await run(F, [{ a: 1, b: 0 }, { a: -1, b: 0 }, { a: 0, b: 0 }], p => p.select(c => ({ r: c.a.div(c.b) })));
    expect(out.map(r => r.r)).toEqual([Infinity, -Infinity, NaN]);
  });

  test('intDiv truncates toward zero and mod takes the sign of the dividend', async () => {
    const rows = [{ a: 7, b: 2 }, { a: -7, b: 2 }, { a: 7, b: -2 }, { a: -7, b: -2 }];
    const out = await run(I, rows, p => p.select(c => ({ q: c.a.intDiv(c.b), m: c.a.mod(c.b) })));
    expect(out).toEqual([{ q: 3, m: 1 }, { q: -3, m: -1 }, { q: -3, m: 1 }, { q: 3, m: -1 }]);
  });

  test('the one intDiv that overflows raises', async () => {
    await expect(run(I, [{ a: -2147483648, b: -1 }], p => p.select(c => ({ r: c.a.intDiv(c.b) })))).rejects.toBeInstanceOf(ExecutionError);
  });

  test('64-bit intDiv and mod', async () => {
    const B = schema({ a: t.int64, b: t.int64 });
    const out = await run(B, [{ a: -(2n ** 62n) - 1n, b: 2n }], p => p.select(c => ({ q: c.a.intDiv(c.b), m: c.a.mod(c.b) })));
    expect(out).toEqual([{ q: -(2n ** 61n), m: -1n }]);
  });
});

describe('C-OVERFLOW: neg, abs and the wrapping forms', () => {
  test('neg and abs of the minimum signed value raise', async () => {
    const S = schema({ x: t.int32 });
    const B = schema({ x: t.int64 });
    await expect(run(S, [{ x: -2147483648 }], p => p.select(c => ({ r: c.x.neg() })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(S, [{ x: -2147483648 }], p => p.select(c => ({ r: c.x.abs() })))).rejects.toBeInstanceOf(ExecutionError);
    await expect(run(B, [{ x: -(2n ** 63n) }], p => p.select(c => ({ r: c.x.abs() })))).rejects.toBeInstanceOf(ExecutionError);
  });

  test('neg and abs otherwise', async () => {
    const S = schema({ i: t.int32, f: t.float64, b: t.int64 });
    const out = await run(S, [{ i: -5, f: -2.5, b: -9n }], p =>
      p.select(c => ({ ni: c.i.neg(), ai: c.i.abs(), nf: c.f.neg(), af: c.f.abs(), ab: c.b.abs() })),
    );
    expect(out).toEqual([{ ni: 5, ai: 5, nf: 2.5, af: 2.5, ab: 9n }]);
  });

  test('neg is not defined for unsigned types', () => {
    const S = schema({ u: t.uint8 });
    expect(() => pipe(S).select(c => ({ r: c.u.neg() }))).toThrow(TypeCheckError);
  });

  test('wrapping forms wrap instead of raising', async () => {
    const S = schema({ a: t.int8, u: t.uint32, i: t.int32, b: t.int64 });
    const rows = [{ a: 127, u: 4294967295, i: 65536, b: 2n ** 63n - 1n }];
    const out = await run(S, rows, p =>
      p.select(c => ({
        add8: c.a.wrappingAdd(1),
        sub8: c.a.wrappingSub(-1),
        mulU: c.u.wrappingMul(2),
        mulI: c.i.wrappingMul(65536),
        add64: c.b.wrappingAdd(1n),
      })),
    );
    expect(out).toEqual([{ add8: -128, sub8: -128, mulU: 4294967294, mulI: 0, add64: -(2n ** 63n) }]);
  });
});

describe('C-ROUND: floor, ceil, round and isNaN', () => {
  const S = schema({ x: t.float64 });

  test('round goes to the nearest integer, ties to even', async () => {
    const xs = [0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6, -2.6, NaN, Infinity];
    const out = await run(S, xs.map(x => ({ x })), p => p.select(c => ({ r: c.x.round() })));
    expect(out.map(r => r.r)).toEqual([0, 2, 2, -0, -2, 2, 3, -3, NaN, Infinity]);
  });

  test('floor, ceil and isNaN', async () => {
    const out = await run(S, [{ x: 1.5 }, { x: -1.5 }, { x: NaN }, { x: null }], p =>
      p.select(c => ({ lo: c.x.floor(), hi: c.x.ceil(), nan: c.x.isNaN() })),
    );
    expect(out).toEqual([
      { lo: 1, hi: 2, nan: false },
      { lo: -2, hi: -1, nan: false },
      { lo: NaN, hi: NaN, nan: true },
      { lo: null, hi: null, nan: null },
    ]);
  });
});

describe('C-BIN: binning', () => {
  test('integers, including negatives and an origin', async () => {
    const S = schema({ x: t.int32 });
    const rows = [-5, -1, 0, 1, 7, 10].map(x => ({ x }));
    const out = await run(S, rows, p => p.select(c => ({ plain: c.x.bin(5), shifted: c.x.bin(5, 2) })));
    expect(out.map(r => r.plain)).toEqual([-5, -5, 0, 0, 5, 10]);
    expect(out.map(r => r.shifted)).toEqual([-8, -3, -3, -3, 7, 7]);
  });

  test('floats', async () => {
    const S = schema({ x: t.float64 });
    const out = await run(S, [{ x: 0.75 }, { x: -0.25 }, { x: 2.0 }], p => p.select(c => ({ b: c.x.bin(0.5) })));
    expect(out.map(r => r.b)).toEqual([0.5, -0.5, 2.0]);
  });

  test('a non-positive width is rejected', () => {
    const S = schema({ x: t.int32 });
    expect(() => pipe(S).select(c => ({ b: c.x.bin(0) }))).toThrow(ExpressionError);
  });
});

describe('C-IN: list membership', () => {
  test('numbers: null stays null, an empty list matches nothing', async () => {
    const S = schema({ x: t.int32 });
    const rows = [{ x: 1 }, { x: 2 }, { x: 3 }, { x: null }];
    const some = await run(S, rows, p => p.select(c => ({ r: c.x.isIn([1, 3]) })));
    const none = await run(S, rows, p => p.select(c => ({ r: c.x.isIn([]) })));
    expect(some.map(r => r.r)).toEqual([true, false, true, null]);
    expect(none.map(r => r.r)).toEqual([false, false, false, null]);
  });

  test('NaN never matches; -0.0 matches 0.0', async () => {
    const S = schema({ x: t.float64 });
    const out = await run(S, [{ x: NaN }, { x: 1 }, { x: -0 }], p => p.select(c => ({ r: c.x.isIn([NaN, 1, 0]) })));
    expect(out.map(r => r.r)).toEqual([false, true, true]);
  });

  test('strings, dictionary strings, 64-bit integers and booleans', async () => {
    const S = schema({ s: t.utf8, d: t.dictionary, b: t.int64, f: t.bool });
    const rows = [
      { s: 'a', d: 'a', b: 1n, f: true },
      { s: 'b', d: 'b', b: 2n ** 60n, f: false },
      { s: null, d: null, b: null, f: null },
    ];
    const out = await run(S, rows, p =>
      p.select(c => ({ s: c.s.isIn(['b', 'z']), d: c.d.isIn(['b', 'z']), b: c.b.isIn([2n ** 60n]), f: c.f.isIn([true]) })),
    );
    expect(out).toEqual([
      { s: false, d: false, b: false, f: true },
      { s: true, d: true, b: true, f: false },
      { s: null, d: null, b: null, f: null },
    ]);
  });

  test('a list parameter', async () => {
    const S = schema({ rir: t.dictionary });
    const plan = pipe(S, { rirs: list(t.dictionary) }).filter((c, p) => c.rir.isIn(p.rirs)).compile();
    const tb = table(S, [{ rir: 'APNIC' }, { rir: 'ARIN' }, { rir: 'APNIC' }]);
    expect((await plan.execute(tb, { params: { rirs: ['APNIC'] } })).rowCount).toBe(2);
    expect((await plan.execute(tb, { params: { rirs: ['ARIN', 'RIPE NCC'] } })).rowCount).toBe(1);
    expect((await plan.execute(tb, { params: { rirs: [] } })).rowCount).toBe(0);
  });
});

describe('C-IF: ifElse and coalesce', () => {
  test('a null condition takes the else branch', async () => {
    const S = schema({ ok: t.bool, a: t.int32, b: t.int32 });
    const rows = [
      { ok: true, a: 1, b: 2 },
      { ok: false, a: 1, b: 2 },
      { ok: null, a: 1, b: 2 },
      { ok: true, a: null, b: 2 },
    ];
    const out = await run(S, rows, p => p.select(c => ({ r: ifElse(c.ok, c.a, c.b), k: ifElse(c.ok, c.a, 0) })));
    expect(out).toEqual([{ r: 1, k: 1 }, { r: 2, k: 0 }, { r: 2, k: 0 }, { r: null, k: null }]);
  });

  test('coalesce replaces nulls, for numbers and strings', async () => {
    const S = schema({ x: t.int32, y: t.int32, d: t.dictionary });
    const rows = [{ x: 1, y: 9, d: 'a' }, { x: null, y: 9, d: null }, { x: null, y: null, d: 'b' }];
    const out = await run(S, rows, p => p.select(c => ({ x: c.x.coalesce(c.y), z: c.x.coalesce(0), d: c.d.coalesce('?') })));
    expect(out).toEqual([{ x: 1, z: 1, d: 'a' }, { x: 9, z: 0, d: '?' }, { x: null, z: 0, d: 'b' }]);
  });
});

describe('C-TIME: dates and timestamps', () => {
  const D = schema({ d: t.date32 });
  const T = schema({ ts: t.timestamp });

  test('date32 round-trips as a UTC-midnight Date and rejects a time of day', async () => {
    const day = new Date(Date.UTC(2024, 1, 29));
    const out = await run(D, [{ d: day }, { d: null }], p => p.select(c => ({ d: c.d })));
    expect(out).toEqual([{ d: day }, { d: null }]);
    expect(() => table(D, [{ d: new Date('2024-02-29T10:00:00Z') }])).toThrow(SchemaError);
    expect(() => table(D, [{ d: new Date(NaN) }])).toThrow(SchemaError);
  });

  test('date32 extract and dateTrunc', async () => {
    const out = await run(D, [{ d: new Date(Date.UTC(2024, 1, 29)) }], p =>
      p.select(c => ({ y: c.d.extract('year'), m: c.d.extract('month'), day: c.d.extract('day'), month: c.d.dateTrunc('month'), year: c.d.dateTrunc('year') })),
    );
    expect(out).toEqual([
      { y: 2024, m: 2, day: 29, month: new Date(Date.UTC(2024, 1, 1)), year: new Date(Date.UTC(2024, 0, 1)) },
    ]);
  });

  test('timestamp extract and dateTrunc, in UTC', async () => {
    const out = await run(T, [{ ts: new Date('2024-02-29T13:45:10.500Z') }], p =>
      p.select(c => ({
        h: c.ts.extract('hour'),
        min: c.ts.extract('minute'),
        s: c.ts.extract('second'),
        hour: c.ts.dateTrunc('hour'),
        day: c.ts.dateTrunc('day'),
        month: c.ts.dateTrunc('month'),
      })),
    );
    expect(out).toEqual([
      {
        h: 13,
        min: 45,
        s: 10,
        hour: new Date('2024-02-29T13:00:00Z'),
        day: new Date('2024-02-29T00:00:00Z'),
        month: new Date('2024-02-01T00:00:00Z'),
      },
    ]);
  });

  test('truncation rounds down before the epoch too', async () => {
    const out = await run(T, [{ ts: new Date('1969-12-31T23:30:00Z') }], p =>
      p.select(c => ({ day: c.ts.dateTrunc('day'), year: c.ts.dateTrunc('year'), y: c.ts.extract('year') })),
    );
    expect(out).toEqual([{ day: new Date('1969-12-31T00:00:00Z'), year: new Date('1969-01-01T00:00:00Z'), y: 1969 }]);
  });

  test('dates compare, group and aggregate', async () => {
    const rows = ['2024-01-05', '2024-01-20', '2024-02-03'].map(s => ({ d: new Date(s) }));
    const after = await run(D, rows, p => p.filter(c => c.d.gte(new Date('2024-01-20'))));
    const perMonth = await run(D, rows, p =>
      p.select(c => ({ month: c.d.dateTrunc('month'), d: c.d }))
        .groupBy(c => ({ month: c.month }))
        .agg(c => ({ last: c.d.max() })),
    );
    expect(after.length).toBe(2);
    expect(perMonth).toEqual([
      { month: new Date('2024-01-01'), last: new Date('2024-01-20') },
      { month: new Date('2024-02-01'), last: new Date('2024-02-03') },
    ]);
  });

  test('a unit that does not apply is rejected', () => {
    // @ts-expect-error hour is not a date32 unit
    expect(() => pipe(D).select(c => ({ h: c.d.extract('hour') }))).toThrow(ExpressionError);
  });
});

describe('C-BETWEEN: inclusive range', () => {
  test('both ends are included; null stays null', async () => {
    const S = schema({ x: t.int32 });
    const rows = [2, 3, 4, 6, 7].map(x => ({ x }));
    const out = await run(S, [...rows, { x: null }], p => p.select(c => ({ r: c.x.between(3, 6) })));
    expect(out.map(r => r.r)).toEqual([false, true, true, true, false, null]);
  });
});

describe('C-INT64-JS: numbers are accepted for 64-bit columns when safe', () => {
  test('a safe integer loads and compares as a bigint; an unsafe one is rejected', async () => {
    const S = schema({ x: t.int64 });
    const out = await run(S, [{ x: 5 as never }, { x: 6n }], p => p.filter(c => c.x.gte(6 as never)));
    expect(out).toEqual([{ x: 6n }]);
    expect(() => table(S, [{ x: 2 ** 60 as never }])).toThrow(SchemaError);
  });
});
