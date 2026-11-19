// Helpers for golden tests. A golden test pins one contract rule
// (docs/CONTRACT.md) and must pass on every backend.
//
// run() executes each plan several times with different chunk sizes and
// requires identical results, so every golden test also proves that chunked
// execution (docs/TASKS.md, T-201) does not change answers.
//
// The same plans also run on the WASM backend (the native engine library, when
// it can be built here) and must give the same rows or raise the same class of
// error. Plans the engine cannot run yet fall back to the JS executor, which
// `wasmStats` counts.

import { expect } from 'bun:test';
import { table } from '../../src';
import type { Fields, NoParams, Pipeline, RowInput, RowOf, Schema } from '../../src';
import { pipe } from '../../src';
import { decodePlan, encodePlan } from '../../src/ir-binary';
import { createWasmBackend } from '../../src/backends/wasm';
import { nativeHost } from '../engine-host';

const host = nativeHost();
const wasm = host === null ? null : createWasmBackend(host);

export function wasmStats(): { engine: number; fallback: number } | null {
  // Purpose: how many golden runs the engine executed and how many fell back to JS (null without the native engine)
  return wasm === null ? null : { ...wasm.backend.stats };
}

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
  if (wasm !== null) await compareWasm(plan, schema, rows, reference, chunkSizes(rows.length));
  if (!reference.ok) throw reference.error;
  return reference.rows;
}

async function compareWasm<F extends Fields, Out extends Fields>(
  plan: { execute: (t: never, o: { chunkRows?: number }) => Promise<{ toArray(): RowOf<Out>[] }> },
  schema: Schema<F>,
  rows: readonly RowInput<F>[],
  reference: Outcome<RowOf<Out>>,
  sizes: number[],
): Promise<void> {
  // Purpose: run the plan on the WASM backend at the same chunk sizes and require the JS reference's rows, or an error of the same class
  const input = wasm!.table(schema, rows);
  try {
    for (const chunkRows of [undefined, ...sizes]) {
      let outcome: Outcome<RowOf<Out>>;
      try {
        outcome = { ok: true, rows: (await plan.execute(input as never, { chunkRows })).toArray() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      const label = `wasm backend, chunkRows ${chunkRows}`;
      if (reference.ok && outcome.ok) expect(outcome.rows, label).toEqual(reference.rows);
      else if (!reference.ok && !outcome.ok) {
        expect((outcome.error as Error).constructor, label).toBe((reference.error as Error).constructor);
        // Same words up to the JS backend's detail after a colon.
        expect((reference.error as Error).message.startsWith((outcome.error as Error).message), `${label}: ${(outcome.error as Error).message} vs ${(reference.error as Error).message}`).toBe(true);
      } else {
        throw new Error(`${label}: ${outcome.ok ? 'succeeded' : `failed (${(outcome.error as Error).message})`} but the JS backend ${reference.ok ? 'succeeded' : 'failed'}`);
      }
    }
  } finally {
    input.dispose();
  }
}
