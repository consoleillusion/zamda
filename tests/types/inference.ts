// Compile-time tests for TypeScript inference. This file is checked by
// `bun run typecheck` (tsc --noEmit); it is never executed.
//
// Add a case here whenever the DSL's types change. A wrong inference must fail
// the typecheck, and a call that should be rejected is marked @ts-expect-error.

import { count, pipe, schema, t } from '../../src';
import type { Plan, RowOf } from '../../src';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function assertType<_T extends true>(): void {
  // Purpose: compile-time assertion; the type argument must be `true`
}

type RowsOf<P> = P extends Plan<infer _In, infer Out> ? RowOf<Out> : never;

const Users = schema({ name: t.utf8, country: t.dictionary, age: t.int32, active: t.bool, id: t.int64 });

// select: output row type is inferred from the returned expressions.
const projected = pipe(Users)
  .filter(c => c.active.eq(true).and(c.age.gte(18)))
  .select(c => ({ name: c.name, next: c.age.add(1), id: c.id, adult: c.age.gte(18) }))
  .compile();
assertType<
  Same<
    RowsOf<typeof projected>,
    { name: string | null; next: number | null; id: bigint | null; adult: boolean | null }
  >
>();

// filter, sort and limit keep the row type.
const same = pipe(Users).filter(c => c.age.gt(1)).sort(c => c.age.desc()).limit(5).compile();
assertType<
  Same<
    RowsOf<typeof same>,
    { name: string | null; country: string | null; age: number | null; active: boolean | null; id: bigint | null }
  >
>();

// groupBy().agg(): keys followed by aggregates, with aggregate result types.
const grouped = pipe(Users)
  .groupBy(c => ({ country: c.country }))
  .agg(c => ({ n: count(), total: c.age.sum(), mean: c.age.avg(), oldest: c.age.max() }))
  .compile();
assertType<
  Same<
    RowsOf<typeof grouped>,
    { country: string | null; n: number | null; total: bigint | null; mean: number | null; oldest: number | null }
  >
>();

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
  return c.active;
});

// @ts-expect-error filter must return a boolean expression
pipe(Users).filter(c => c.age);

// @ts-expect-error aggregates are not allowed in select
pipe(Users).select(c => ({ total: c.age.sum() }));
