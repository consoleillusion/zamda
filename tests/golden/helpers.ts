// Helpers for golden tests. A golden test pins one contract rule
// (docs/CONTRACT.md) and must pass on every backend.
//
// When the WASM backend exists, `backends` below gains a second entry and every
// golden test runs against both without being rewritten.

import { table } from '../../src';
import type { Fields, Pipeline, RowInput, RowOf, Schema } from '../../src';
import { pipe } from '../../src';

export const backends = ['js'] as const;

export async function run<F extends Fields, Out extends Fields>(
  schema: Schema<F>,
  rows: readonly RowInput<F>[],
  build: (p: Pipeline<F, F>) => Pipeline<F, Out>,
): Promise<RowOf<Out>[]> {
  // Purpose: build a pipeline, run it on the JS backend and return the rows
  const plan = build(pipe(schema)).compile();
  const result = await plan.execute(table(schema, rows));
  return result.toArray();
}
