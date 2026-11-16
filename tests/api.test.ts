// Tests for the rest of the pipeline API: withColumns, rename, distinct, and
// loading tables from columns.

import { describe, expect, test } from 'bun:test';
import { ExpressionError, SchemaError, count, pipe, schema, t, table } from '../src';

const S = schema({ name: t.utf8, age: t.int32, city: t.dictionary });
const rows = [
  { name: 'Ana', age: 34, city: 'Auckland' },
  { name: 'Ben', age: 17, city: 'Sydney' },
  { name: 'Ana', age: 34, city: 'Auckland' },
  { name: 'Cal', age: null, city: 'Auckland' },
];

describe('withColumns', () => {
  test('keeps every column, adds new ones and replaces same-named ones', async () => {
    const plan = pipe(S)
      .withColumns(c => ({ next: c.age.add(1), age: c.age.cast(t.float64) }))
      .compile();
    expect(plan.ir.output.map(f => `${f.name}:${f.type.name}`)).toEqual([
      'name:utf8',
      'age:float64',
      'city:dictionary',
      'next:int32',
    ]);
    const out = (await plan.execute(table(S, rows))).toArray();
    expect(out[0]).toEqual({ name: 'Ana', age: 34, city: 'Auckland', next: 35 });
    expect(out[3]).toEqual({ name: 'Cal', age: null, city: 'Auckland', next: null });
  });
});

describe('rename', () => {
  test('renames the listed columns and keeps the others', async () => {
    const plan = pipe(S).rename({ name: 'who', city: 'where' }).compile();
    const out = (await plan.execute(table(S, rows))).toArray();
    expect(out[1]).toEqual({ who: 'Ben', age: 17, where: 'Sydney' });
  });

  test('an unknown column is rejected', () => {
    expect(() => pipe(S).rename({ nope: 'x' } as never)).toThrow(ExpressionError);
  });
});

describe('distinct', () => {
  test('unique rows in order of first occurrence', async () => {
    const out = (await pipe(S).distinct().compile().execute(table(S, rows))).toArray();
    expect(out).toEqual([
      { name: 'Ana', age: 34, city: 'Auckland' },
      { name: 'Ben', age: 17, city: 'Sydney' },
      { name: 'Cal', age: null, city: 'Auckland' },
    ]);
  });

  test('on one projected column', async () => {
    const out = (await pipe(S).select(c => ({ city: c.city })).distinct().compile().execute(table(S, rows))).toArray();
    expect(out).toEqual([{ city: 'Auckland' }, { city: 'Sydney' }]);
  });
});

describe('a full dashboard-style query', () => {
  test('filter, group, sort and limit together', async () => {
    const plan = pipe(S, { minAge: t.int32 })
      .filter((c, p) => c.age.gte(p.minAge))
      .groupBy(c => ({ city: c.city }))
      .agg(c => ({ n: count(), oldest: c.age.max() }))
      .sort(c => [c.n.desc(), c.city.asc()])
      .limit(5)
      .compile();
    const out = (await plan.execute(table(S, rows), { params: { minAge: 10 } })).toArray();
    expect(out).toEqual([
      { city: 'Auckland', n: 2, oldest: 34 },
      { city: 'Sydney', n: 1, oldest: 17 },
    ]);
  });
});

describe('table() from columns', () => {
  const N = schema({ id: t.uint32, score: t.float64, tag: t.utf8 });

  test('a matching typed array is used without copying', async () => {
    const id = new Uint32Array([1, 2, 3]);
    const score = new Float64Array([0.5, 1.5, 2.5]);
    const tb = table(N, { columns: { id, score, tag: ['a', null, 'c'] } });
    expect(tb.rowCount).toBe(3);
    const out = await pipe(N).select(c => ({ id: c.id, score: c.score, tag: c.tag })).compile().execute(tb);
    expect(out.columns().id).toBe(id);
    expect(out.columns().score).toBe(score);
    expect(out.toArray()[1]).toEqual({ id: 2, score: 1.5, tag: null });
  });

  test('plain arrays are checked value by value and may hold nulls', () => {
    const tb = table(N, { columns: { id: [1, null, 3], score: [1, 2, 3], tag: ['a', 'b', 'c'] } });
    expect(tb.rowCount).toBe(3);
    expect(() => table(N, { columns: { id: [1, -1, 3], score: [1, 2, 3], tag: ['a', 'b', 'c'] } })).toThrow(SchemaError);
  });

  test('the wrong typed array, a missing column and unequal lengths are rejected', () => {
    const tag = ['a', 'b'];
    expect(() => table(N, { columns: { id: new Float64Array(2), score: new Float64Array(2), tag } })).toThrow(SchemaError);
    expect(() => table(N, { columns: { id: new Uint32Array(2), tag } as never })).toThrow(SchemaError);
    expect(() => table(N, { columns: { id: new Uint32Array(3), score: new Float64Array(2), tag } })).toThrow(SchemaError);
  });

  test('zero columns of data give an empty table', () => {
    const tb = table(N, { columns: { id: new Uint32Array(0), score: new Float64Array(0), tag: [] } });
    expect(tb.rowCount).toBe(0);
  });
});
