// Golden tests for the sort operator. Named by rule ID in docs/CONTRACT.md.

import { describe, expect, test } from 'bun:test';
import { schema, t } from '../../src';
import { run } from './helpers';

describe('C-NULL-SORT: nulls in sorts', () => {
  const S = schema({ x: t.int32 });
  const rows = [{ x: 3 }, { x: null }, { x: 1 }, { x: 2 }];

  test('nulls sort last in both directions', async () => {
    const asc = await run(S, rows, p => p.sort(c => c.x.asc()));
    const desc = await run(S, rows, p => p.sort(c => c.x.desc()));
    expect(asc.map(r => r.x)).toEqual([1, 2, 3, null]);
    expect(desc.map(r => r.x)).toEqual([3, 2, 1, null]);
  });

  test('nullsFirst() places nulls first in both directions', async () => {
    const asc = await run(S, rows, p => p.sort(c => c.x.asc().nullsFirst()));
    const desc = await run(S, rows, p => p.sort(c => c.x.desc().nullsFirst()));
    expect(asc.map(r => r.x)).toEqual([null, 1, 2, 3]);
    expect(desc.map(r => r.x)).toEqual([null, 3, 2, 1]);
  });
});

describe('C-SORT-STABLE: sort is stable', () => {
  test('rows with equal keys keep input order, ascending and descending', async () => {
    const S = schema({ k: t.int8, id: t.int32 });
    const rows = [1, 0, 1, 0, 1].map((k, id) => ({ k, id }));
    const asc = await run(S, rows, p => p.sort(c => c.k.asc()));
    const desc = await run(S, rows, p => p.sort(c => c.k.desc()));
    expect(asc.map(r => r.id)).toEqual([1, 3, 0, 2, 4]);
    expect(desc.map(r => r.id)).toEqual([0, 2, 4, 1, 3]);
  });
});

describe('C-NAN-ORDER: NaN in sorting', () => {
  test('NaN is greater than every number, and nulls still come last', async () => {
    const S = schema({ x: t.float64 });
    const rows = [{ x: NaN }, { x: 1 }, { x: null }, { x: -Infinity }, { x: Infinity }, { x: 0 }];
    const asc = await run(S, rows, p => p.sort(c => c.x.asc()));
    const desc = await run(S, rows, p => p.sort(c => c.x.desc()));
    expect(asc.map(r => r.x)).toEqual([-Infinity, 0, 1, Infinity, NaN, null]);
    expect(desc.map(r => r.x)).toEqual([NaN, Infinity, 1, 0, -Infinity, null]);
  });
});

describe('sort: types and multiple keys', () => {
  test('strings sort by code point (C-STR-ORDER)', async () => {
    const S = schema({ s: t.utf8, d: t.dictionary });
    const values = ['b', '～', '\u{1F600}', 'a', 'ab'];
    const rows = values.map(v => ({ s: v, d: v }));
    const expected = ['a', 'ab', 'b', '～', '\u{1F600}'];
    const plain = await run(S, rows, p => p.sort(c => c.s.asc()));
    const dict = await run(S, rows, p => p.sort(c => c.d.asc()));
    expect(plain.map(r => r.s)).toEqual(expected);
    expect(dict.map(r => r.d)).toEqual(expected);
  });

  test('64-bit integers and dates sort by value', async () => {
    const S = schema({ big: t.int64, day: t.date32 });
    const days = [new Date('2024-03-01'), new Date('1969-07-20'), new Date('2001-01-01')];
    const rows = [
      { big: 2n ** 62n, day: days[0]! },
      { big: -(2n ** 62n), day: days[1]! },
      { big: 5n, day: days[2]! },
    ];
    const byBig = await run(S, rows, p => p.sort(c => c.big.asc()));
    const byDay = await run(S, rows, p => p.sort(c => c.day.desc()));
    expect(byBig.map(r => r.big)).toEqual([-(2n ** 62n), 5n, 2n ** 62n]);
    expect(byDay.map(r => r.day)).toEqual([days[0]!, days[2]!, days[1]!]);
  });

  test('later keys break ties in earlier keys', async () => {
    const S = schema({ a: t.utf8, b: t.int32 });
    const rows = [
      { a: 'x', b: 1 },
      { a: 'y', b: 5 },
      { a: 'x', b: 3 },
      { a: 'y', b: null },
      { a: 'x', b: 2 },
    ];
    const out = await run(S, rows, p => p.sort(c => [c.a.asc(), c.b.desc()]));
    expect(out).toEqual([
      { a: 'x', b: 3 },
      { a: 'x', b: 2 },
      { a: 'x', b: 1 },
      { a: 'y', b: 5 },
      { a: 'y', b: null },
    ]);
  });

  test('a sort key can be a computed expression', async () => {
    const S = schema({ x: t.int32 });
    const out = await run(S, [{ x: 3 }, { x: -5 }, { x: 1 }], p => p.sort(c => c.x.abs().desc()));
    expect(out.map(r => r.x)).toEqual([-5, 3, 1]);
  });
});

describe('top-k: sort().limit(k) equals a full sort then limit', () => {
  const S = schema({ k: t.int32, f: t.float64, id: t.int32 });
  const rows = Array.from({ length: 1000 }, (_, id) => ({
    k: id % 13 === 0 ? null : (id * 7919) % 37,
    f: id % 17 === 0 ? NaN : ((id * 104729) % 1000) / 7,
    id,
  }));

  for (const k of [0, 1, 7, 100, 999, 1000, 2000]) {
    test(`k = ${k}`, async () => {
      const full = await run(S, rows, p => p.sort(c => [c.k.desc(), c.f.asc()]));
      const top = await run(S, rows, p => p.sort(c => [c.k.desc(), c.f.asc()]).limit(k));
      expect(top.map(r => r.id)).toEqual(full.slice(0, k).map(r => r.id));
    });
  }
});
