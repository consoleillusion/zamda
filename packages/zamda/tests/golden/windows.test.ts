// Golden tests: C-WINDOW, row numbering and ranking over partitions. The plans
// are bound to no second table, but the WASM backend rejects a window node
// (D-077), so these cases run on the JS reference backend at several chunk
// sizes with the optimizer both on and off. The WASM rejection is checked
// separately below.

import { describe, expect, test } from 'bun:test';
import { ExpressionError, PlanError, pipe, schema, table, t } from '../../src';
import type { Fields, NoParams, Pipeline, RowInput, RowOf, SortKey } from '../../src';
import { createWasmBackend } from '../../src/backends/wasm';
import { nativeHost } from '../engine-host';

const Events = schema({ grp: t.utf8, ord: t.int32, val: t.int64, weight: t.float64 });

const rows: readonly RowInput<typeof Events.fields>[] = [
  { grp: 'a', ord: 1, val: 10n, weight: 1.5 },
  { grp: 'a', ord: 1, val: 11n, weight: 2.5 },
  { grp: 'a', ord: null, val: 12n, weight: 3.5 },
  { grp: 'b', ord: 2, val: 20n, weight: 4.5 },
  { grp: 'b', ord: null, val: 21n, weight: 5.5 },
  { grp: null, ord: 1, val: 30n, weight: 6.5 },
  { grp: null, ord: 1, val: 31n, weight: 7.5 },
  { grp: '', ord: null, val: 40n, weight: 8.5 },
];

function functions(): Readonly<Record<'rn' | 'rk' | 'drk', 'row_number' | 'rank' | 'dense_rank'>> {
  // Purpose: the three ranking functions, named in insertion order
  return { rn: 'row_number', rk: 'rank', drk: 'dense_rank' };
}

async function runWindow<Out extends Fields>(
  input: readonly RowInput<typeof Events.fields>[],
  build: (
    p: Pipeline<typeof Events.fields, typeof Events.fields, NoParams>,
  ) => Pipeline<typeof Events.fields, Out, NoParams>,
): Promise<RowOf<Out>[]> {
  // Purpose: run a window plan with the optimizer on and off at several chunk sizes
  const plans = [build(pipe(Events)).compile(), build(pipe(Events))._compile(false)];
  const inputTable = table(Events, input);
  let first: RowOf<Out>[] | undefined;
  for (const plan of plans) {
    for (const chunkRows of [undefined, 1, 2, 3, 7]) {
      const got = (await plan.execute(inputTable, { chunkRows })).toArray();
      if (first === undefined) first = got;
      else expect(got, `chunkRows ${chunkRows}`).toEqual(first);
    }
  }
  return first!;
}

// Nulls sort last by default. In partition 'a' the two rows with ord 1 form one
// peer group and the null row forms a second; ranks use the row position of the
// first peer, dense ranks count peer groups. Input order is kept in the output.
const expected = [
  { grp: 'a', ord: 1, val: 10n, weight: 1.5, rn: 1n, rk: 1n, drk: 1n },
  { grp: 'a', ord: 1, val: 11n, weight: 2.5, rn: 2n, rk: 1n, drk: 1n },
  { grp: 'a', ord: null, val: 12n, weight: 3.5, rn: 3n, rk: 3n, drk: 2n },
  { grp: 'b', ord: 2, val: 20n, weight: 4.5, rn: 1n, rk: 1n, drk: 1n },
  { grp: 'b', ord: null, val: 21n, weight: 5.5, rn: 2n, rk: 2n, drk: 2n },
  { grp: null, ord: 1, val: 30n, weight: 6.5, rn: 1n, rk: 1n, drk: 1n },
  { grp: null, ord: 1, val: 31n, weight: 7.5, rn: 2n, rk: 1n, drk: 1n },
  { grp: '', ord: null, val: 40n, weight: 8.5, rn: 1n, rk: 1n, drk: 1n },
];

describe('C-WINDOW: ranks over partitions', () => {
  test('row_number, rank and dense_rank with ties, nulls and several partitions', async () => {
    const got = await runWindow(rows, p => p.window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: functions(),
    }));
    expect(got).toEqual(expected);
  });

  test('input order and input columns are preserved and new columns are int64 bigints', async () => {
    const got = await runWindow(rows, p => p.window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: functions(),
    }));
    expect(got.map(row => row.val)).toEqual(rows.map(row => row.val ?? null));
    expect(got.map(row => row.grp)).toEqual(rows.map(row => row.grp ?? null));
    expect(typeof got[0]!.val).toBe('bigint');
    expect(typeof got[0]!.rn).toBe('bigint');
    expect(typeof got[0]!.rk).toBe('bigint');
    expect(typeof got[0]!.drk).toBe('bigint');
  });

  test('null order keys can be placed first; peer groups follow the sort order', async () => {
    const got = await runWindow(rows, p => p.window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc().nullsFirst(),
      functions: functions(),
    }));
    expect(got).toEqual([
      { grp: 'a', ord: 1, val: 10n, weight: 1.5, rn: 2n, rk: 2n, drk: 2n },
      { grp: 'a', ord: 1, val: 11n, weight: 2.5, rn: 3n, rk: 2n, drk: 2n },
      { grp: 'a', ord: null, val: 12n, weight: 3.5, rn: 1n, rk: 1n, drk: 1n },
      { grp: 'b', ord: 2, val: 20n, weight: 4.5, rn: 2n, rk: 2n, drk: 2n },
      { grp: 'b', ord: null, val: 21n, weight: 5.5, rn: 1n, rk: 1n, drk: 1n },
      { grp: null, ord: 1, val: 30n, weight: 6.5, rn: 1n, rk: 1n, drk: 1n },
      { grp: null, ord: 1, val: 31n, weight: 7.5, rn: 2n, rk: 1n, drk: 1n },
      { grp: '', ord: null, val: 40n, weight: 8.5, rn: 1n, rk: 1n, drk: 1n },
    ]);
  });

  test('a null partition key forms one group with the rows in input order', async () => {
    const got = await runWindow(rows, p => p.window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: { rn: 'row_number' },
    }));
    expect(got.filter(row => row.grp === null)).toEqual([
      { grp: null, ord: 1, val: 30n, weight: 6.5, rn: 1n },
      { grp: null, ord: 1, val: 31n, weight: 7.5, rn: 2n },
    ]);
  });

  test('an empty input gives no rows', async () => {
    const got = await runWindow([], p => p.window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: functions(),
    }));
    expect(got).toEqual([]);
  });

  test('window output can be filtered and projected afterwards', async () => {
    const got = await runWindow(rows, p => p.window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: functions(),
    }).filter(c => c.rn.eq(1n)).select(c => ({ grp: c.grp, val: c.val, rk: c.rk })));
    expect(got).toEqual([
      { grp: 'a', val: 10n, rk: 1n },
      { grp: 'b', val: 20n, rk: 1n },
      { grp: null, val: 30n, rk: 1n },
      { grp: '', val: 40n, rk: 1n },
    ]);
  });
});

describe('C-WINDOW: plan validation', () => {
  test('an empty order is rejected', () => {
    expect(() => pipe(Events).window({ partitionBy: ['grp'], orderBy: () => [], functions: functions() }))
      .toThrow(new ExpressionError('window: at least one order key is required'));
  });

  test('an empty function set is rejected', () => {
    expect(() => pipe(Events).window({ partitionBy: ['grp'], orderBy: c => c.ord.asc(), functions: {} }))
      .toThrow(new ExpressionError('window: at least one function is required'));
  });

  test('an unknown function name is rejected', () => {
    expect(() => pipe(Events).window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: { n: 'ntile' as never },
    })).toThrow(ExpressionError);
  });

  test('unknown partition and order columns are rejected', () => {
    expect(() => pipe(Events).window({
      partitionBy: ['nope' as never],
      orderBy: c => c.ord.asc(),
      functions: functions(),
    })).toThrow(new ExpressionError('window: unknown partition column "nope"'));
    expect(() => pipe(Events).window({
      partitionBy: ['grp'],
      orderBy: c => (c as unknown as { nope: { asc(): SortKey } }).nope.asc(),
      functions: functions(),
    })).toThrow(ExpressionError);
  });

  test('a duplicate output column name is rejected', () => {
    expect(() => pipe(Events).window({
      partitionBy: ['grp'],
      orderBy: c => c.ord.asc(),
      functions: { ord: 'row_number' },
    })).toThrow(new ExpressionError('window: duplicate output column name "ord"'));
  });
});

const host = nativeHost();
const wasm = host === null ? null : createWasmBackend(host);

test.skipIf(wasm === null)('the WASM backend rejects windows with PlanError (D-077)', async () => {
  const plan = pipe(Events).window({
    partitionBy: ['grp'],
    orderBy: c => c.ord.asc(),
    functions: functions(),
  }).compile();
  const input = wasm!.table(Events, rows);
  try {
    await expect(plan.execute(input as never)).rejects.toThrow(PlanError);
  } finally {
    input.dispose();
  }
});
