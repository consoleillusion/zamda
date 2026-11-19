// Golden test for C-STR-MIX: utf8 and dictionary expressions work together.

import { expect, test } from 'bun:test';
import { ifElse, schema, t } from '../../src';
import { run } from './helpers';

const S = schema({ u: t.utf8, d: t.dictionary });
const rows = [
  { u: 'a', d: 'b' },
  { u: 'b', d: 'a' },
  { u: null, d: 'a' },
  { u: 'a', d: null },
  { u: '～', d: '\u{1F600}' },
];

test('C-STR-MIX: mixed string storage compares and chooses by string value', async () => {
  const out = await run(S, rows, function (p) {
    return p.select(function (c) {
      return {
        eq: c.u.eq(c.d),
        revEq: c.d.eq(c.u),
        lt: c.u.lt(c.d),
        eqWith: c.u.startsWith(c.d),
        member: c.u.isIn(['a', '～']),
        revMember: c.d.isIn(['a']),
        filled: c.u.coalesce(c.d),
        revFilled: c.d.coalesce(c.u),
        picked: ifElse(c.u.eq(c.d), c.u, c.d),
        revPicked: ifElse(c.u.eq(c.d), c.d, c.u),
      };
    });
  });
  expect(out).toEqual([
    { eq: false, revEq: false, lt: true, eqWith: false, member: true, revMember: false, filled: 'a', revFilled: 'b', picked: 'b', revPicked: 'a' },
    { eq: false, revEq: false, lt: false, eqWith: false, member: false, revMember: true, filled: 'b', revFilled: 'a', picked: 'a', revPicked: 'b' },
    { eq: null, revEq: null, lt: null, eqWith: null, member: null, revMember: true, filled: 'a', revFilled: 'a', picked: 'a', revPicked: null },
    { eq: null, revEq: null, lt: null, eqWith: null, member: true, revMember: null, filled: 'a', revFilled: 'a', picked: null, revPicked: 'a' },
    { eq: false, revEq: false, lt: true, eqWith: false, member: true, revMember: false, filled: '～', revFilled: '\u{1F600}', picked: '\u{1F600}', revPicked: '～' },
  ]);
});
