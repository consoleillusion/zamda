// Intentional violations of zamda/no-js-boolean-ops-in-accessor-callbacks, for the test
// in tests/lint/no-js-boolean-ops.test.ts. This file is excluded from `bun run lint`;
// it only exists to be linted there. The @ts-expect-error comments are exact:
// every one of them errors, none of them besides those does.

import { count, pipe, schema, t, table } from '../../src';

const S = schema({ active: t.bool, age: t.int32, name: t.utf8, country: t.dictionary });
const rows = [{ active: true, age: 30, name: 'a', country: 'GB' }];
const tab = table(S, rows);

// 1. `&&` in a filter callback: flagged, and typechecks (JS semantics: always truthy left side)
void pipe(S).filter(c => c.active && c.age.gte(18)).compile().execute(tab);
// 2. `||` in a filter callback: flagged, and typechecks
void pipe(S).filter(c => c.active || c.age.gte(18)).compile().execute(tab);
// 3. `!` in a filter callback: flagged; the callback returns a JS boolean, which fails the DSL type
// @ts-expect-error accessor callback expecting BoolExpr, gets boolean
void pipe(S).filter(c => !c.active).compile().execute(tab);
// 4. `===` in a filter callback: flagged; the callback returns a JS boolean
// @ts-expect-error accessor callback expecting BoolExpr, gets boolean
void pipe(S).filter(c => c.age.gte(18) === true).compile().execute(tab);
// 5. a nested plain function is still inside the accessor callback: flagged
void pipe(S)
  .filter(c => {
    const helper = () => c.active && c.age.gte(18);
    return helper();
  })
  .compile()
  .execute(tab);
// 6. `||` in a sort callback: flagged; the sort callback returns the wrong type entirely
// @ts-expect-error sort expects SortKey or SortKey[], gets BoolExpr
void pipe(S).sort(c => c.age.gte(18) || c.active).compile().execute(tab);
// 7. the clean DSL spellings: not flagged
void pipe(S).filter(c => c.active.and(c.age.gte(18))).compile();
void pipe(S).filter(c => c.active.not()).compile();
void pipe(S).filter(c => c.age.gte(18).or(c.active)).compile();
void pipe(S).groupBy(c => ({ country: c.country })).agg(() => ({ n: count() })).compile();
// 7b. plain JavaScript logic inside an accessor callback, not flagged (operands are plain JS)
const by = 'name' as 'name' | 'country';
void pipe(S).groupBy(c => (by === 'name' ? { g: c.name } : { g: c.country })).agg(() => ({ n: count() })).compile();
// 8. not a zamda accessor callback: a native array filter, not flagged
const over30 = [30, 41].filter(n => n >= 30 && n < 50);
void over30;
// 9. an eslint-disable comment silences the rule on the next line
// eslint-disable-next-line zamda/no-js-boolean-ops-in-accessor-callbacks
void pipe(S).filter(c => c.active && c.age.gte(18)).compile().execute(tab);
