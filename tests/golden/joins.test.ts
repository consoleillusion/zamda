// Golden tests: C-JOIN, equi-joins over two tables. The right table is bound to
// the plan (D-076), so these plans cannot use the golden `run` helper's WASM
// comparison: per D-077 the WASM backend rejects a join with PlanError. These
// cases run on the JS reference backend at several chunk sizes with the
// optimizer both on and off; the WASM rejection is checked separately below.

import { describe, expect, test } from 'bun:test';
import { ExpressionError, PlanError, pipe, schema, table, t } from '../../src';
import type { Fields, NoParams, Pipeline, RowInput, RowOf, Schema, Table } from '../../src';
import { createWasmBackend } from '../../src/backends/wasm';
import { nativeHost } from '../engine-host';

const L = schema({ a: t.int32, b: t.utf8, lv: t.int32 });
const R = schema({ x: t.int32, y: t.dictionary, rv: t.int32 });

const leftRows: readonly RowInput<typeof L.fields>[] = [
  { a: 1, b: 'p', lv: 10 },
  { a: 1, b: 'p', lv: 11 },
  { a: 2, b: 'q', lv: 20 },
  { a: null, b: 'p', lv: 30 },
  { a: 3, b: null, lv: 40 },
];

const rightRows: readonly RowInput<typeof R.fields>[] = [
  { x: 1, y: 'p', rv: 100 },
  { x: 1, y: 'p', rv: 101 },
  { x: 2, y: 'r', rv: 200 },
  { x: null, y: 'q', rv: 300 },
  { x: 3, y: null, rv: 400 },
];

function rightTable(): Table<typeof R.fields> {
  // Purpose: a fresh right table with duplicate, null and unmatched keys
  return table(R, rightRows);
}

async function runPlan<F extends Fields, Out extends Fields>(
  inputSchema: Schema<F>,
  rows: readonly RowInput<F>[],
  build: (p: Pipeline<F, F, NoParams>) => Pipeline<F, Out, NoParams>,
): Promise<RowOf<Out>[]> {
  // Purpose: run a bound join plan with the optimizer on and off at several chunk sizes
  const plans = [build(pipe(inputSchema)).compile(), build(pipe(inputSchema))._compile(false)];
  const input = table(inputSchema, rows);
  let first: RowOf<Out>[] | undefined;
  for (const plan of plans) {
    for (const chunkRows of [undefined, 1, 2, 3]) {
      const got = (await plan.execute(input, { chunkRows })).toArray();
      if (first === undefined) first = got;
      else expect(got, `chunkRows ${chunkRows}`).toEqual(first);
    }
  }
  return first!;
}

function keys(): { readonly left: readonly ['a', 'b']; readonly right: readonly ['x', 'y'] } {
  // Purpose: the multi-column key pair mixing int32 with int32 and utf8 with dictionary
  return { left: ['a', 'b'], right: ['x', 'y'] };
}

const matched: RowOf<MergeFields>[] = [
  { a: 1, b: 'p', lv: 10, x: 1, y: 'p', rv: 100 },
  { a: 1, b: 'p', lv: 10, x: 1, y: 'p', rv: 101 },
  { a: 1, b: 'p', lv: 11, x: 1, y: 'p', rv: 100 },
  { a: 1, b: 'p', lv: 11, x: 1, y: 'p', rv: 101 },
];

type MergeFields = typeof L.fields & typeof R.fields;

const unmatchedLeft: RowOf<MergeFields>[] = [
  { a: 2, b: 'q', lv: 20, x: null, y: null, rv: null },
  { a: null, b: 'p', lv: 30, x: null, y: null, rv: null },
  { a: 3, b: null, lv: 40, x: null, y: null, rv: null },
];

const unmatchedRight: RowOf<MergeFields>[] = [
  { a: null, b: null, lv: null, x: 2, y: 'r', rv: 200 },
  { a: null, b: null, lv: null, x: null, y: 'q', rv: 300 },
  { a: null, b: null, lv: null, x: 3, y: null, rv: 400 },
];

describe('C-JOIN: matching and output order', () => {
  test('inner emits matched pairs in left order, then right order within each left row', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys()));
    expect(rows).toEqual(matched);
  });

  test('left appends unmatched left rows in left order', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys(), 'left'));
    expect(rows).toEqual([...matched, ...unmatchedLeft]);
  });

  test('right appends unmatched right rows in right order', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys(), 'right'));
    expect(rows).toEqual([...matched, ...unmatchedRight]);
  });

  test('full appends unmatched left rows then unmatched right rows', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys(), 'full'));
    expect(rows).toEqual([...matched, ...unmatchedLeft, ...unmatchedRight]);
  });

  test('inner is the default join kind', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys()));
    const inner = await runPlan(L, leftRows, p => p.join(rightTable(), keys(), 'inner'));
    expect(rows).toEqual(inner);
  });

  test('a null key component never matches, even if the other components match', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys()));
    for (const row of rows) {
      expect(row.a === null || row.x === null || row.b === null || row.y === null).toBe(false);
    }
    expect(rows).toHaveLength(4);
  });

  test('duplicate keys produce every matching pair', async () => {
    const A = schema({ k: t.int32, av: t.int32 });
    const B = schema({ r: t.int32, bv: t.int32 });
    const rows = await runPlan(A, [{ k: 1, av: 10 }, { k: 1, av: 11 }], p =>
      p.join(table(B, [{ r: 1, bv: 100 }, { r: 1, bv: 101 }]), { left: ['k'], right: ['r'] }));
    expect(rows).toEqual([
      { k: 1, av: 10, r: 1, bv: 100 },
      { k: 1, av: 10, r: 1, bv: 101 },
      { k: 1, av: 11, r: 1, bv: 100 },
      { k: 1, av: 11, r: 1, bv: 101 },
    ]);
  });

  test('matched pairs follow left order, then right order', async () => {
    const A = schema({ k: t.int32, av: t.int32 });
    const B = schema({ r: t.int32, bv: t.int32 });
    const rows = await runPlan(A, [{ k: 2, av: 20 }, { k: 1, av: 10 }], p =>
      p.join(table(B, [{ r: 1, bv: 1 }, { r: 2, bv: 2 }]), { left: ['k'], right: ['r'] }));
    expect(rows.map(row => row.av)).toEqual([20, 10]);
    expect(rows.map(row => row.bv)).toEqual([2, 1]);
  });

  test('utf8 and dictionary key columns compare by string value (C-STR-MIX)', async () => {
    const A = schema({ s: t.utf8, av: t.int32 });
    const B = schema({ q: t.dictionary, bv: t.int32 });
    const rows = await runPlan(A, [{ s: 'x', av: 1 }, { s: null, av: 2 }, { s: 'y', av: 3 }], p =>
      p.join(table(B, [{ q: 'x', bv: 10 }, { q: 'y', bv: 20 }]), { left: ['s'], right: ['q'] }));
    expect(rows).toEqual([
      { s: 'x', av: 1, q: 'x', bv: 10 },
      { s: 'y', av: 3, q: 'y', bv: 20 },
    ]);
  });

  test('multi-column keys require every component to be equal and non-null', async () => {
    const rows = await runPlan(L, leftRows, p => p.join(rightTable(), keys()));
    expect(rows.every(row => row.a === 1 && row.b === 'p')).toBe(true);
  });
});

describe('C-JOIN: golden comparison and validation', () => {
  test('join(...).select(...) matches hand-built rows', async () => {
    const rows = await runPlan(L, leftRows, p =>
      p.join(rightTable(), keys()).select(c => ({ lv: c.lv, label: c.y, rv: c.rv })));
    expect(rows).toEqual([
      { lv: 10, label: 'p', rv: 100 },
      { lv: 10, label: 'p', rv: 101 },
      { lv: 11, label: 'p', rv: 100 },
      { lv: 11, label: 'p', rv: 101 },
    ]);
  });

  test('duplicate output column names are rejected', () => {
    expect(() => pipe(L).join(table(schema({ a: t.int32, z: t.int32 }), []), { left: ['a'], right: ['a'] }))
      .toThrow(new ExpressionError('join: duplicate output column name "a"'));
  });

  test('unknown, empty, unequal, duplicated and incompatible keys are rejected', () => {
    expect(() => pipe(L).join(rightTable(), { left: ['nope' as never], right: ['x'] }))
      .toThrow(/join: unknown left key column "nope"/);
    expect(() => pipe(L).join(rightTable(), { left: ['a'], right: ['nope' as never] }))
      .toThrow(/join: unknown right key column "nope"/);
    expect(() => pipe(L).join(rightTable(), { left: [], right: [] }))
      .toThrow(new ExpressionError('join: at least one key is required'));
    expect(() => pipe(L).join(rightTable(), { left: ['a', 'b'], right: ['x'] }))
      .toThrow(new ExpressionError('join: expected the same number of left and right keys, got 2 and 1'));
    expect(() => pipe(L).join(rightTable(), { left: ['a', 'a'], right: ['x', 'x'] }))
      .toThrow(new ExpressionError('join: duplicate left key column'));
    expect(() => pipe(L).join(rightTable(), { left: ['lv'], right: ['y'] }))
      .toThrow(ExpressionError);
  });

  test('an unknown join kind is rejected', () => {
    expect(() => pipe(L).join(rightTable(), keys(), 'cross' as never))
      .toThrow(new ExpressionError('join: unknown join kind "cross"; expected inner, left, right or full'));
  });

  test('a join plan can be followed by more operators', async () => {
    const rows = await runPlan(L, leftRows, p =>
      p.join(rightTable(), keys(), 'full').filter(c => c.rv.isNull()).select(c => ({ lv: c.lv, rv: c.rv })));
    expect(rows).toEqual([
      { lv: 20, rv: null },
      { lv: 30, rv: null },
      { lv: 40, rv: null },
    ]);
  });
});

const host = nativeHost();
const wasm = host === null ? null : createWasmBackend(host);

test.skipIf(wasm === null)('the WASM backend rejects joins with PlanError (D-077)', async () => {
  const plan = pipe(L).join(rightTable(), keys()).compile();
  const input = wasm!.table(L, leftRows);
  try {
    await expect(plan.execute(input as never)).rejects.toThrow(PlanError);
  } finally {
    input.dispose();
  }
});
