// Helpers for golden tests. A golden test pins one contract rule
// (docs/CONTRACT.md) and must pass on every backend.
//
// run() executes each plan several times with different chunk sizes and
// requires identical results, so every golden test also proves that chunked
// execution (docs/TASKS.md, T-201) does not change answers.
//
// Every case is also compiled twice, with the optimizer passes on and off
// (T-203), and the two answers, including errors, must agree. That makes the
// golden suite the safety net for every IR-to-IR rewrite.
//
// The same plans also run on the WASM backend (the native engine library, when
// it can be built here) and must give the same rows or raise the same class of
// error. Plans the engine cannot run yet fall back to the JS executor, which
// `wasmStats` counts.

import { expect } from 'bun:test';
import { pipe, table } from '../../src';
import type { Fields, NoParams, Pipeline, RowInput, RowOf, Schema } from '../../src';
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

function sameOutcome<T>(got: Outcome<T>, want: Outcome<T>, label: string): void {
  // Purpose: require two runs to agree on rows, or on the error's class and message
  if (got.ok && want.ok) {
    expect(got.rows, label).toEqual(want.rows);
  } else if (!got.ok && !want.ok) {
    expect((got.error as Error).constructor, label).toBe((want.error as Error).constructor);
    expect((got.error as Error).message, label).toBe((want.error as Error).message);
  } else {
    throw new Error(`${label}: ${got.ok ? 'succeeded' : `failed (${(got.error as Error).message})`} but the other plan did not`);
  }
}

export async function run<F extends Fields, Out extends Fields>(
  schema: Schema<F>,
  rows: readonly RowInput<F>[],
  build: (p: Pipeline<F, F, NoParams>) => Pipeline<F, Out, NoParams>,
): Promise<RowOf<Out>[]> {
  // Purpose: build a pipeline, run it with passes on and off at several chunk sizes, and return the rows
  const optimized = build(pipe(schema)).compile();
  const plain = build(pipe(schema))._compile(false);
  // T-401: every plan the golden suite runs must also survive the binary format unchanged.
  expect(decodePlan(encodePlan(optimized.ir))).toEqual(optimized.ir);
  expect(decodePlan(encodePlan(plain.ir))).toEqual(plain.ir);
  const input = table(schema, rows);
  const sizes = chunkSizes(rows.length);
  const answers = async function (plan: typeof optimized): Promise<Outcome<RowOf<Out>>> {
    // Purpose: run one plan at the default and every chunk size, comparing each answer to the first
    const attempt = async function (chunkRows?: number): Promise<Outcome<RowOf<Out>>> {
      // Purpose: run once, capturing either the rows or the error
      try {
        return { ok: true, rows: (await plan.execute(input, { chunkRows })).toArray() };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const reference = await attempt();
    for (const chunkRows of sizes) {
      sameOutcome(await attempt(chunkRows), reference, `chunkRows ${chunkRows}`);
    }
    return reference;
  };
  const reference = await answers(optimized);
  sameOutcome(await answers(plain), reference, 'optimizer passes off');
  if (wasm !== null) await compareWasm(optimized, schema, rows, reference, sizes);
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
