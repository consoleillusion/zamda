// Helpers for golden tests. A golden test pins one contract rule
// (docs/CONTRACT.md) and must pass on every backend.
//
// run() executes each plan several times with different chunk sizes and
// requires identical results, so every golden test also proves that chunked
// execution (docs/TASKS.md, T-201) does not change answers.
//
// When the WASM backend exists, `backends` below gains a second entry and every
// golden test runs against both without being rewritten.

import { expect } from 'bun:test';
import { table } from '../../src';
import type { Fields, NoParams, Pipeline, RowInput, RowOf, Schema } from '../../src';
import { pipe } from '../../src';
import { decodePlan, encodePlan } from '../../src/ir-binary';

export const backends = ['js'] as const;

type Outcome<T> = { ok: true; rows: T[] } | { ok: false; error: unknown };

function chunkSizes(rowCount: number): number[] {
  // Purpose: chunk sizes that split the input in awkward places without making huge inputs slow
  const sizes = rowCount <= 2000 ? [1, 2, 3, 7] : [Math.ceil(rowCount / 3), 4096];
  return sizes.filter(function (size) {
    return rowCount / size <= 2000;
  });
}

export async function run<F extends Fields, Out extends Fields>(
  schema: Schema<F>,
  rows: readonly RowInput<F>[],
  build: (p: Pipeline<F, F, NoParams>) => Pipeline<F, Out, NoParams>,
): Promise<RowOf<Out>[]> {
  // Purpose: build a pipeline, run it on the JS backend at several chunk sizes, and return the rows
  const plan = build(pipe(schema)).compile();
  // T-401: every plan the golden suite runs must also survive the binary format unchanged.
  expect(decodePlan(encodePlan(plan.ir))).toEqual(plan.ir);
  const input = table(schema, rows);
  const attempt = async function (chunkRows?: number): Promise<Outcome<RowOf<Out>>> {
    // Purpose: run once, capturing either the rows or the error
    try {
      return { ok: true, rows: (await plan.execute(input, { chunkRows })).toArray() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const reference = await attempt();
  for (const chunkRows of chunkSizes(rows.length)) {
    const chunked = await attempt(chunkRows);
    if (reference.ok && chunked.ok) expect(chunked.rows).toEqual(reference.rows);
    else if (!reference.ok && !chunked.ok) {
      expect((chunked.error as Error).constructor).toBe((reference.error as Error).constructor);
    } else {
      throw new Error(`chunkRows ${chunkRows} ${chunked.ok ? 'succeeded' : 'failed'} but the default run did not`);
    }
  }
  if (!reference.ok) throw reference.error;
  return reference.rows;
}
