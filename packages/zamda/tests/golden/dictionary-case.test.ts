// Golden test for T-219: lower and upper keep dictionary encoding, deduplicating entries.

import { expect, test } from 'bun:test';
import { pipe, schema, t } from '../../src';
import { KERNELS } from '../../src/backends/js/kernels';
import { makeColumn, nums } from '../../src/column';
import { run } from './helpers';

const S = schema({ s: t.dictionary });
const rows = [{ s: 'Àb' }, { s: 'ÀB' }, { s: 'straße' }, { s: null }];

test('C-STR-CASE: lower and upper keep the input storage type', async () => {
  const plan = pipe(S)
    .select(c => ({ lo: c.s.lower(), up: c.s.upper() }))
    .compile();
  expect(plan.ir.output.map(f => f.type.name)).toEqual(['dictionary', 'dictionary']);
  expect(await run(S, rows, p => p.select(c => ({ lo: c.s.lower(), up: c.s.upper() })))).toEqual([
    { lo: 'àb', up: 'ÀB' },
    { lo: 'àb', up: 'ÀB' },
    { lo: 'straße', up: 'STRASSE' },
    { lo: null, up: null },
  ]);
});

test('T-219: case mapping re-deduplicates dictionary entries', () => {
  const lower = KERNELS.get('lower')!;
  const input = makeColumn(t.dictionary, Int32Array.of(0, 1, 2, 3), null, ['A', 'a', 'B', 'ß']);
  const out = lower([input], t.dictionary, 4);
  expect(out.type.name).toBe('dictionary');
  expect(out.dictionary).toEqual(['a', 'b', 'ß']);
  expect(Array.from(nums(out))).toEqual([0, 0, 1, 2]);
});
