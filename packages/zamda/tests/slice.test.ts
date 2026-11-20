// End-to-end tests for the working slice: schema -> pipe -> compile -> execute.

import { describe, expect, test } from 'bun:test';
import {
  AbortError,
  ExpressionError,
  PlanError,
  SchemaError,
  TypeCheckError,
  count,
  list,
  pipe,
  schema,
  t,
  table,
} from '../src';
import { validate } from '../src/validate';

const Users = schema({ name: t.utf8, country: t.utf8, age: t.int32, active: t.bool });

const rows = [
  { name: 'Ana', country: 'NZ', age: 34, active: true },
  { name: 'Ben', country: 'AU', age: 17, active: true },
  { name: 'Cal', country: 'NZ', age: 51, active: false },
  { name: 'Dee', country: 'US', age: null, active: true },
  { name: 'Eli', country: 'NZ', age: 22, active: true },
];

describe('slice: filter, select, limit', () => {
  test('runs end to end with typed rows', async () => {
    const plan = pipe(Users)
      .filter(c => c.active.eq(true).and(c.age.gte(18)))
      .select(c => ({ name: c.name, next: c.age.add(1) }))
      .limit(2)
      .compile();
    const out = await plan.execute(table(Users, rows));
    expect(out.rowCount).toBe(2);
    expect(out.toArray()).toEqual([
      { name: 'Ana', next: 35 },
      { name: 'Eli', next: 23 },
    ]);
  });

  test('a compiled plan is reusable across tables', async () => {
    const plan = pipe(Users).filter(c => c.country.eq('NZ')).compile();
    const a = await plan.execute(table(Users, rows));
    const b = await plan.execute(table(Users, rows.slice(0, 1)));
    expect(a.rowCount).toBe(3);
    expect(b.rowCount).toBe(1);
  });

  test('columns() returns typed arrays for numbers', async () => {
    const plan = pipe(Users).select(c => ({ age: c.age })).compile();
    const out = await plan.execute(table(Users, rows));
    expect(out.columns().age).toBeInstanceOf(Int32Array);
    expect(out.column('age').valid).toEqual(new Uint8Array([1, 1, 1, 0, 1]));
  });

  test('parameters are declared, typed and bound at execute time', async () => {
    const plan = pipe(Users, { minAge: t.int32, countries: list(t.utf8) })
      .filter((c, p) => c.age.gte(p.minAge).and(c.country.isIn(p.countries)))
      .compile();
    const users = table(Users, rows);
    expect((await plan.execute(users, { params: { minAge: 20, countries: ['NZ'] } })).rowCount).toBe(3);
    expect((await plan.execute(users, { params: { minAge: 50, countries: ['NZ', 'AU'] } })).rowCount).toBe(1);
    expect((await plan.execute(users, { params: { minAge: 0, countries: [] } })).rowCount).toBe(0);
    // @ts-expect-error params are required when the plan declares any
    await expect(plan.execute(users)).rejects.toBeInstanceOf(PlanError);
    await expect(
      // @ts-expect-error minAge must be a number
      plan.execute(users, { params: { minAge: 'x', countries: [] } }),
    ).rejects.toBeInstanceOf(TypeCheckError);
    await expect(
      // @ts-expect-error extra is not a declared parameter
      plan.execute(users, { params: { minAge: 1, countries: [], extra: 1 } }),
    ).rejects.toBeInstanceOf(PlanError);
  });

  test('explain() lists the nodes', () => {
    const plan = pipe(Users).filter(c => c.age.gt(1)).limit(3).compile();
    expect(plan.explain()).toBe(
      [
        '#0 scan -> [name:utf8, country:utf8, age:int32, active:bool]',
        '#1 filter gt($2, 1) -> [name:utf8, country:utf8, age:int32, active:bool]',
        '#2 limit 3 -> [name:utf8, country:utf8, age:int32, active:bool]',
      ].join('\n'),
    );
  });
});

describe('errors', () => {
  test('loading rejects values that do not fit the schema', () => {
    expect(() => table(Users, [{ name: 'X', country: 'NZ', age: 1.5, active: true }])).toThrow(SchemaError);
    expect(() => table(Users, [{ name: 'X', country: 'NZ', age: 2 ** 31, active: true }])).toThrow(SchemaError);
  });

  test('execute rejects a table with a different schema', async () => {
    const Other = schema({ name: t.utf8 });
    const plan = pipe(Users).limit(1).compile();
    await expect(plan.execute(table(Other, [{ name: 'x' }]) as never)).rejects.toBeInstanceOf(SchemaError);
  });

  test('mismatched operand types are rejected when the expression is built', () => {
    expect(() => pipe(Users).filter(c => c.age.eq('x' as never))).toThrow(TypeCheckError);
  });

  test('an aborted signal rejects with AbortError', async () => {
    const plan = pipe(Users).limit(1).compile();
    const controller = new AbortController();
    controller.abort();
    await expect(plan.execute(table(Users, rows), { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
  });

  test('the validator rejects a corrupted plan', () => {
    const plan = pipe(Users).filter(c => c.age.gt(1)).compile();
    const bad = {
      ...plan.ir,
      nodes: [plan.ir.nodes[0]!, { ...plan.ir.nodes[1]!, input: 5 }],
    };
    expect(() => validate(bad as typeof plan.ir)).toThrow(PlanError);
  });
});

describe('guards against JavaScript operators', () => {
  test('using > on an expression throws', () => {
    // @ts-expect-error operators are not defined on expressions
    expect(() => pipe(Users).filter(c => c.age > 18)).toThrow(ExpressionError);
  });

  test('using && drops a column and is caught', () => {
    // The DSL must reject this at runtime; the linter rejects it at build time too.
    // eslint-disable-next-line zamda/no-js-boolean-ops-in-accessor-callbacks
    expect(() => pipe(Users).filter(c => c.active && c.age.gte(18))).toThrow(ExpressionError);
  });

  test('an unknown column throws', () => {
    expect(() => pipe(Users).filter(c => (c as never as { nope: never }).nope)).toThrow(ExpressionError);
  });

  test('a bare literal in select throws', () => {
    expect(() => pipe(Users).select(() => ({ one: 1 as never }))).toThrow(ExpressionError);
  });
});

describe('aggregate and sort', () => {
  test('groupBy().agg() compiles to an aggregate node', () => {
    const plan = pipe(Users)
      .groupBy(c => ({ country: c.country }))
      .agg(c => ({ n: count(), avg_age: c.age.avg() }))
      .compile();
    expect(plan.explain()).toContain('aggregate keys=[$1] aggs=[count(), avg($2)]');
    expect(plan.ir.output.map(f => `${f.name}:${f.type.name}`)).toEqual([
      'country:utf8',
      'n:uint32',
      'avg_age:float64',
    ]);
  });

  test('groupBy().agg() runs on the JS backend', async () => {
    const plan = pipe(Users)
      .filter(c => c.active.eq(true))
      .groupBy(c => ({ country: c.country }))
      .agg(c => ({ n: count(), oldest: c.age.max(), mean: c.age.avg() }))
      .compile();
    const out = await plan.execute(table(Users, rows));
    expect(out.toArray()).toEqual([
      { country: 'NZ', n: 2, oldest: 34, mean: 28 },
      { country: 'AU', n: 1, oldest: 17, mean: 17 },
      { country: 'US', n: 1, oldest: null, mean: null },
    ]);
  });

  test('top-k: the oldest two active users', async () => {
    const plan = pipe(Users)
      .filter(c => c.active.eq(true))
      .sort(c => c.age.desc())
      .limit(2)
      .select(c => ({ name: c.name, age: c.age }))
      .compile();
    const out = await plan.execute(table(Users, rows));
    expect(out.toArray()).toEqual([
      { name: 'Ana', age: 34 },
      { name: 'Eli', age: 22 },
    ]);
  });
});
