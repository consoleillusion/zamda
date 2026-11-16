// Golden tests for strings. Every test runs twice, on a utf8 column and on a
// dictionary column, and the two must agree (docs/TASKS.md, T-107).

import { describe, expect, test } from 'bun:test';
import { count, schema, t } from '../../src';
import { run } from './helpers';

for (const type of [t.utf8, t.dictionary]) {
  describe(`strings as ${type.name}`, () => {
    const S = schema({ s: type });
    const rowsOf = (values: (string | null)[]) => values.map(s => ({ s }));

    test('C-STR-LENGTH: length counts code points, not UTF-16 units', async () => {
      const out = await run(S, rowsOf(['', 'abc', 'a\u{1F600}b', '\u{1F600}\u{1F600}', null]), p =>
        p.select(c => ({ n: c.s.length() })),
      );
      expect('a\u{1F600}b'.length).toBe(4);
      expect(out.map(r => r.n)).toEqual([0, 3, 3, 2, null]);
    });

    test('C-STR-CASE: lower and upper use Unicode case mapping', async () => {
      const out = await run(S, rowsOf(['Àb', 'straße', null]), p =>
        p.select(c => ({ lo: c.s.lower(), up: c.s.upper() })),
      );
      expect(out).toEqual([
        { lo: 'àb', up: 'ÀB' },
        { lo: 'straße', up: 'STRASSE' },
        { lo: null, up: null },
      ]);
    });

    test('startsWith, endsWith and contains match literally', async () => {
      const out = await run(S, rowsOf(['Telecom NZ', 'a.b', 'ab', null]), p =>
        p.select(c => ({ st: c.s.startsWith('Tele'), en: c.s.endsWith('NZ'), dot: c.s.contains('.'), any: c.s.contains('') })),
      );
      expect(out).toEqual([
        { st: true, en: true, dot: false, any: true },
        { st: false, en: false, dot: true, any: true },
        { st: false, en: false, dot: false, any: true },
        { st: null, en: null, dot: null, any: null },
      ]);
    });

    test('C-STR-ORDER: comparison and equality', async () => {
      const out = await run(S, rowsOf(['～', 'a', null]), p =>
        p.select(c => ({ lt: c.s.lt('\u{1F600}'), eq: c.s.eq('a'), neq: c.s.neq('a') })),
      );
      expect(out).toEqual([
        { lt: true, eq: false, neq: true },
        { lt: true, eq: true, neq: false },
        { lt: null, eq: null, neq: null },
      ]);
    });

    test('equality with a string that is not in the column', async () => {
      const out = await run(S, rowsOf(['a', 'b']), p => p.select(c => ({ eq: c.s.eq('zzz'), neq: c.s.neq('zzz') })));
      expect(out).toEqual([{ eq: false, neq: true }, { eq: false, neq: true }]);
    });

    test('group-by, countDistinct, min and max', async () => {
      const K = schema({ k: type, v: type });
      const rows = [
        { k: 'x', v: 'b' },
        { k: 'y', v: '\u{1F600}' },
        { k: 'x', v: '～' },
        { k: null, v: 'b' },
        { k: 'x', v: 'b' },
        { k: 'y', v: null },
      ];
      const out = await run(K, rows, p =>
        p.groupBy(c => ({ k: c.k })).agg(c => ({ n: count(), d: c.v.countDistinct(), lo: c.v.min(), hi: c.v.max() })),
      );
      expect(out).toEqual([
        { k: 'x', n: 3, d: 2, lo: 'b', hi: '～' },
        { k: 'y', n: 2, d: 1, lo: '\u{1F600}', hi: '\u{1F600}' },
        { k: null, n: 1, d: 1, lo: 'b', hi: 'b' },
      ]);
    });

    test('filter then group reads through the selection', async () => {
      const K = schema({ k: type, n: t.int32 });
      const rows = [
        { k: 'a', n: 1 },
        { k: 'b', n: 5 },
        { k: 'a', n: 7 },
        { k: 'b', n: 9 },
        { k: 'c', n: 0 },
      ];
      const out = await run(K, rows, p =>
        p.filter(c => c.n.gte(5)).groupBy(c => ({ k: c.k })).agg(c => ({ rows: count(), total: c.n.sum() })),
      );
      expect(out).toEqual([
        { k: 'b', rows: 2, total: 14n },
        { k: 'a', rows: 1, total: 7n },
      ]);
    });
  });
}
