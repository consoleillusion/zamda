// Compile-time tests for TypeScript inference. This file is checked by
// `bun run typecheck` (tsc --noEmit); it is never executed.
//
// Add a case here whenever the DSL's types change. A wrong inference must fail
// the typecheck, and a call that should be rejected is marked @ts-expect-error.

import { count, ifElse, keyedTable, list, pipe, schema, t, table } from '../../src';
import type { KeyedTable, Plan, RowOf, Table } from '../../src';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function assertType<_T extends true>(): void {
  // Purpose: compile-time assertion; the type argument must be `true`
}

type RowsOf<P> = P extends Plan<infer _In, infer Out, infer _Params> ? RowOf<Out> : never;

const Users = schema({
  name: t.utf8,
  country: t.dictionary,
  age: t.int32,
  small: t.int8,
  big: t.int64,
  ubig: t.uint64,
  score: t.float32,
  active: t.bool,
  born: t.date32,
  seen: t.timestamp,
});

// select: output row type is inferred from the returned expressions.
const projected = pipe(Users)
  .filter(c => c.active.eq(true).and(c.age.gte(18)))
  .select(c => ({ name: c.name, next: c.age.add(1), id: c.big, adult: c.age.gte(18), born: c.born }))
  .compile();
assertType<
  Same<
    RowsOf<typeof projected>,
    { name: string | null; next: number | null; id: bigint | null; adult: boolean | null; born: Date | null }
  >
>();

// filter, sort, limit and distinct keep the row type.
const same = pipe(Users).select(c => ({ age: c.age, name: c.name })).filter(c => c.age.gt(1)).sort(c => c.age.desc()).limit(5).distinct().compile();
assertType<Same<RowsOf<typeof same>, { age: number | null; name: string | null }>>();

// groupBy().agg(): keys followed by aggregates, with aggregate result types.
const grouped = pipe(Users)
  .groupBy(c => ({ country: c.country }))
  .agg(c => ({ n: count(), total: c.age.sum(), mean: c.age.avg(), oldest: c.age.max(), d: c.name.countDistinct() }))
  .compile();
assertType<
  Same<
    RowsOf<typeof grouped>,
    { country: string | null; n: number | null; total: bigint | null; mean: number | null; oldest: number | null; d: number | null }
  >
>();

// Keyless agg: aggregates only.
const totals = pipe(Users).agg(c => ({ n: count(), last: c.seen.max() })).compile();
assertType<Same<RowsOf<typeof totals>, { n: number | null; last: Date | null }>>();

// C-PROMOTION and C-DIV at the type level.
const math = pipe(Users)
  .select(c => ({
    widened: c.small.add(c.age),
    toBig: c.age.add(c.big),
    toFloat: c.age.mul(c.score),
    quotient: c.age.div(2),
    floatQuotient: c.score.div(c.score),
    whole: c.age.intDiv(2),
    casted: c.age.cast(t.int64),
    length: c.name.length(),
    year: c.born.extract('year'),
    month: c.seen.dateTrunc('month'),
    picked: ifElse(c.active, c.age, 0),
    filled: c.name.coalesce('?'),
    member: c.country.isIn(['NZ', 'AU']),
  }))
  .compile();
assertType<
  Same<
    RowsOf<typeof math>,
    {
      widened: number | null;
      toBig: bigint | null;
      toFloat: number | null;
      quotient: number | null;
      floatQuotient: number | null;
      whole: number | null;
      casted: bigint | null;
      length: number | null;
      year: number | null;
      month: Date | null;
      picked: number | null;
      filled: string | null;
      member: boolean | null;
    }
  >
>();

// T-211 / C-STR-MIX: the two string storage types mix in one operation.
const mixedStrings = pipe(Users)
  .select(c => ({
    eq: c.name.eq(c.country),
    lt: c.name.lt(c.country),
    starts: c.name.startsWith(c.country),
    filled: c.name.coalesce(c.country),
    revFilled: c.country.coalesce(c.name),
    picked: ifElse(c.name.eq(c.country), c.name, c.country),
  }))
  .compile();
assertType<
  Same<
    RowsOf<typeof mixedStrings>,
    {
      eq: boolean | null;
      lt: boolean | null;
      starts: boolean | null;
      filled: string | null;
      revFilled: string | null;
      picked: string | null;
    }
  >
>();
const mixedList = pipe(Users, { names: list(t.utf8) })
  .filter((c, p) => c.country.isIn(p.names))
  .compile();
void mixedList;
// @ts-expect-error a string expression cannot be compared with a number
pipe(Users).filter(c => c.name.eq(c.age));

// withColumns replaces and adds; rename changes keys.
const reshaped = pipe(Users)
  .select(c => ({ name: c.name, age: c.age }))
  .withColumns(c => ({ age: c.age.cast(t.int64), initial: c.name.lower() }))
  .rename({ name: 'who' })
  .compile();
assertType<Same<RowsOf<typeof reshaped>, { who: string | null; age: bigint | null; initial: string | null }>>();

// Parameters: declared, typed in the callback, and required at execute().
const withParams = pipe(Users, { minAge: t.int32, countries: list(t.dictionary) })
  .filter((c, p) => c.age.gte(p.minAge).and(c.country.isIn(p.countries)))
  .compile();
const users = table(Users, []);
void withParams.execute(users, { params: { minAge: 18, countries: ['NZ'] } });
void projected.execute(users);
void projected.execute(users, { signal: new AbortController().signal });
// @ts-expect-error params are required
void withParams.execute(users);
// @ts-expect-error countries is missing
void withParams.execute(users, { params: { minAge: 18 } });
// @ts-expect-error minAge must be a number
void withParams.execute(users, { params: { minAge: '18', countries: [] } });

// Rejected at compile time.
pipe(Users).filter(c => {
  // @ts-expect-error arithmetic is not defined on strings
  c.name.add(1);
  // @ts-expect-error a string is not a valid operand for an int32 column
  c.age.eq('x');
  // @ts-expect-error unknown column
  c.nope;
  // @ts-expect-error and() needs a boolean expression
  c.active.and(c.age);
  // @ts-expect-error int64 and uint64 have no common type
  c.big.add(c.ubig);
  // @ts-expect-error floor is defined for floats only
  c.age.floor();
  // @ts-expect-error intDiv is defined for integers only
  c.score.intDiv(2);
  // @ts-expect-error hour is not a date32 unit
  c.born.extract('hour');
  // @ts-expect-error isIn values must match the column type
  c.age.isIn(['x']);
  return c.active;
});

// @ts-expect-error filter must return a boolean expression
pipe(Users).filter(c => c.age);

// @ts-expect-error aggregates are not allowed in select
pipe(Users).select(c => ({ total: c.age.sum() }));

// @ts-expect-error rename accepts existing column names only
pipe(Users).rename({ nope: 'x' });

// Sessions: an opaque RunSession reference; the backend decides what it does with it (T-416).
void projected.execute(users, { session: { kind: 'zamda/wasm-session' } });
// @ts-expect-error a session is a RunSession (an object with a kind), not a number
void projected.execute(users, { session: 42 });

// Keyed live tables (C-LIVE-KEY): the factory, its methods and their types.
const keyed = keyedTable(Users, ['name', 'age'], []);
assertType<Same<typeof keyed, KeyedTable<typeof Users.fields>>>();
const current: Table<typeof Users.fields> = keyed.current();
void current;
const found: RowOf<typeof Users.fields> | undefined = keyed.get(['nobody', 0]);
void found;
assertType<Same<ReturnType<typeof keyed.has>, boolean>>();
assertType<Same<ReturnType<typeof keyed.delete>, number>>();
keyed.upsert([{ name: 'new', age: 20 }]);
keyed.delete([['new', 20]]);
keyed.dispose();
// @ts-expect-error key fields must be columns of the schema
keyedTable(Users, ['nope'], []);
// @ts-expect-error a key is an array of components, not a bare value
keyed.get('nobody');
// @ts-expect-error delete takes a list of keys, not one key component
keyed.delete([1]);
// @ts-expect-error rows must match the schema
keyed.upsert([{ nope: 1 }]);

// T-503 / C-JOIN: a second table is bound and its columns appended after the current ones.
const Orders = schema({ orderId: t.int32, customer: t.int32, total: t.float64 });
const Customers = schema({ cid: t.int32, name: t.utf8 });
const joined = pipe(Orders)
  .join(table(Customers, []), { left: ['customer'], right: ['cid'] }, 'left')
  .compile();
assertType<
  Same<
    RowsOf<typeof joined>,
    { orderId: number | null; customer: number | null; total: number | null; cid: number | null; name: string | null }
  >
>();
void joined;

// @ts-expect-error left keys must be columns of the current schema
pipe(Orders).join(table(Customers, []), { left: ['nope'], right: ['cid'] });
// @ts-expect-error right keys must be columns of the bound table
pipe(Orders).join(table(Customers, []), { left: ['customer'], right: ['nope'] });
// @ts-expect-error join needs a table, not a schema
pipe(Orders).join(Customers, { left: ['customer'], right: ['cid'] });
const Wrong = schema({ nope: t.int32 });
// @ts-expect-error the right key must exist in the bound table's schema
pipe(Orders).join(table(Wrong, []), { left: ['customer'], right: ['cid'] });
// @ts-expect-error only the four contract join kinds are allowed
pipe(Orders).join(table(Customers, []), { left: ['customer'], right: ['cid'] }, 'cross');

// T-503 / C-WINDOW: one int64 column per named function, after the input columns.
const windowed = pipe(Orders)
  .window({
    partitionBy: ['customer'],
    orderBy: c => [c.total.desc(), c.orderId.asc()],
    functions: { rn: 'row_number', rk: 'rank', drk: 'dense_rank' },
  })
  .compile();
assertType<
  Same<
    RowsOf<typeof windowed>,
    {
      orderId: number | null;
      customer: number | null;
      total: number | null;
      rn: bigint | null;
      rk: bigint | null;
      drk: bigint | null;
    }
  >
>();
void windowed;

// @ts-expect-error ntile is not a supported window function
pipe(Orders).window({ partitionBy: ['customer'], orderBy: c => c.total.asc(), functions: { n: 'ntile' } });
// @ts-expect-error partitionBy must name current columns
pipe(Orders).window({ partitionBy: ['nope'], orderBy: c => c.total.asc(), functions: { rn: 'row_number' } });
// @ts-expect-error order keys must reference current columns
pipe(Orders).window({ partitionBy: ['customer'], orderBy: c => c.nope.asc(), functions: { rn: 'row_number' } });

// A join followed by a window keeps both sets of added columns.
const joinedWindowed = pipe(Orders)
  .join(table(Customers, []), { left: ['customer'], right: ['cid'] })
  .window({ partitionBy: ['name'], orderBy: c => c.total.desc(), functions: { rn: 'row_number' } })
  .compile();
assertType<
  Same<
    RowsOf<typeof joinedWindowed>,
    {
      orderId: number | null;
      customer: number | null;
      total: number | null;
      cid: number | null;
      name: string | null;
      rn: bigint | null;
    }
  >
>();
void joinedWindowed;
