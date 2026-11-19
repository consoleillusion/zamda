// The runtime comparison (T-223): the reference queries and the dashboard's
// interactions, timed the same way in whatever runtime imports this file. The
// Bun script (`bun run bench:compare`) and the browser page (`bun run bench:browser`)
// both call it, so the same machine can be measured under JavaScriptCore (Bun)
// and V8 (Chrome) and the numbers compared directly.
//
// Besides each query it times the dashboard's four charts started together,
// the way the page starts them, with the executor's normal time slicing
// (it yields to the event loop about every 8 ms) and with slicing off, to
// separate the engine's speed from the cost of yielding.

import { compilePlans, EMPTY_SELECTION, paramsFor } from '../../demo/dashboard';
import type { Selection } from '../../demo/dashboard';
import type { Table } from '../../src';
import { Routes } from '../../scripts/bgp/file';
import { arqueroFromColumns, sample, zamdaFromColumns } from './data';
import type { RouteArrays } from './data';
import { measure } from './measure';
import type { Timing } from './measure';
import { QUERIES } from './queries';

export interface QueryRow {
  readonly id: string;
  readonly label: string;
  readonly zamda: Timing;
  readonly zamdaNoSlice: Timing;
  readonly arquero: Timing;
  // The same query on the WASM backend, when one was given.
  readonly wasm?: Timing;
}

export interface InteractionRow {
  readonly label: string;
  // Four charts started together with normal time slicing (what the page does).
  readonly together: Timing;
  // The same four charts started together with slicing off.
  readonly togetherNoSlice: Timing;
  // The four charts one after another with slicing off: the plain sum of their work.
  readonly oneByOne: Timing;
  // The four charts together on the WASM backend, when one was given.
  readonly wasmTogether?: Timing;
  readonly wasmOneByOne?: Timing;
}

export interface Comparison {
  readonly runtime: string;
  readonly rows: number;
  readonly queries: readonly QueryRow[];
  readonly interactions: readonly InteractionRow[];
  // Runs the WASM backend executed and runs it handed to the JS executor.
  readonly wasmRuns?: { readonly engine: number; readonly fallback: number };
}

// A WASM backend to measure beside the JS one: a table from the same columns, and its run counts.
export interface WasmTarget {
  readonly table: (arrays: RouteArrays) => Table<typeof Routes.fields>;
  readonly stats: () => { engine: number; fallback: number };
}

// Larger than any slice, so the executor never yields.
const NO_SLICING = 1e9;

const SCENARIOS: readonly { label: string; selection: Selection }[] = [
  { label: 'nothing selected', selection: EMPTY_SELECTION },
  { label: 'prefix /22-/24, region ARIN, name "cloud"', selection: { ...EMPTY_SELECTION, prefixLen: [22, 24], regions: ['ARIN'], search: 'cloud' } },
];

export async function runComparison(
  all: RouteArrays,
  rows: number,
  runs: number,
  runtime: string,
  log: (line: string) => void,
  wasm?: WasmTarget,
): Promise<Comparison> {
  // Purpose: time every reference query and the dashboard interactions at one size, after checking the engines agree
  const arrays = sample(all, rows);
  const zt = zamdaFromColumns(arrays);
  const at = arqueroFromColumns(arrays);
  const wt = wasm?.table(arrays);
  const queries: QueryRow[] = [];
  for (const q of QUERIES) {
    const z = q.zamdaSummary(await q.zamdaExec(zt));
    const a = q.arqueroSummary(q.arqueroExec(at));
    if (z !== a) throw new Error(`${q.id}: zamda and Arquero disagree in ${runtime}`);
    if (wt !== undefined) {
      const w = q.zamdaSummary(await q.zamdaExec(wt));
      if (w !== z) throw new Error(`${q.id}: the WASM backend and the JS backend disagree in ${runtime}\n  wasm: ${w.slice(0, 200)}\n  js:   ${z.slice(0, 200)}`);
    }
    const row: QueryRow = {
      id: q.id,
      label: q.label,
      zamda: await measure(() => q.zamdaExec(zt), runs),
      zamdaNoSlice: await measure(() => q.zamdaExec(zt, { sliceMs: NO_SLICING }), runs),
      arquero: await measure(() => q.arqueroExec(at), runs),
      ...(wt === undefined ? {} : { wasm: await measure(() => q.zamdaExec(wt), runs) }),
    };
    queries.push(row);
    log(`${q.id}: zamda ${row.zamda.median.toFixed(1)} ms, no slicing ${row.zamdaNoSlice.median.toFixed(1)} ms, Arquero ${row.arquero.median.toFixed(1)} ms${row.wasm ? `, WASM ${row.wasm.median.toFixed(1)} ms` : ''}`);
  }
  const plans = compilePlans();
  const charts = ['networks', 'prefixLen', 'pathLen', 'regions'] as const;
  const interactions: InteractionRow[] = [];
  for (const { label, selection } of SCENARIOS) {
    const start = function (id: (typeof charts)[number], sliceMs?: number, on: Table<typeof Routes.fields> = zt): Promise<unknown> {
      // Purpose: start one chart's plan with this scenario's parameters
      const options = { params: paramsFor(selection, id), ...(sliceMs === undefined ? {} : { sliceMs }) };
      return (plans[id] as { execute(t: typeof zt, o: unknown): Promise<unknown> }).execute(on as typeof zt, options);
    };
    const row: InteractionRow = {
      label,
      together: await measure(() => Promise.all(charts.map(id => start(id))), runs),
      togetherNoSlice: await measure(() => Promise.all(charts.map(id => start(id, NO_SLICING))), runs),
      oneByOne: await measure(async () => {
        // Purpose: the four charts in turn
        for (const id of charts) await start(id, NO_SLICING);
      }, runs),
      ...(wt === undefined
        ? {}
        : {
            wasmTogether: await measure(() => Promise.all(charts.map(id => start(id, undefined, wt))), runs),
            wasmOneByOne: await measure(async () => {
              // Purpose: the four charts in turn on the WASM backend
              for (const id of charts) await start(id, NO_SLICING, wt);
            }, runs),
          }),
    };
    interactions.push(row);
    log(`interaction (${label}): together ${row.together.median.toFixed(0)} ms, together no slicing ${row.togetherNoSlice.median.toFixed(0)} ms, one by one ${row.oneByOne.median.toFixed(0)} ms${row.wasmTogether ? `; WASM together ${row.wasmTogether.median.toFixed(1)} ms, one by one ${row.wasmOneByOne!.median.toFixed(1)} ms` : ''}`);
  }
  return { runtime, rows: arrays.rowCount, queries, interactions, ...(wasm === undefined ? {} : { wasmRuns: wasm.stats() }) };
}

function fmt(ms: number): string {
  // Purpose: a time for a table cell
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

export function comparisonMarkdown(c: Comparison): string {
  // Purpose: the comparison as markdown
  const lines = [`## ${c.runtime}: ${c.rows.toLocaleString()} rows (medians, ms)`, ''];
  const withWasm = c.queries.some(q => q.wasm !== undefined);
  lines.push(`| Query | zamda | zamda, no slicing | Arquero |${withWasm ? ' WASM |' : ''}`, `| --- | ---: | ---: | ---: |${withWasm ? ' ---: |' : ''}`);
  for (const q of c.queries) lines.push(`| ${q.id} ${q.label} | ${fmt(q.zamda.median)} | ${fmt(q.zamdaNoSlice.median)} | ${fmt(q.arquero.median)} |${q.wasm ? ` ${fmt(q.wasm.median)} |` : ''}`);
  lines.push('', `| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing |${withWasm ? ' WASM together | WASM one by one |' : ''}`, `| --- | ---: | ---: | ---: |${withWasm ? ' ---: | ---: |' : ''}`);
  for (const i of c.interactions) lines.push(`| ${i.label} | ${fmt(i.together.median)} | ${fmt(i.togetherNoSlice.median)} | ${fmt(i.oneByOne.median)} |${i.wasmTogether ? ` ${fmt(i.wasmTogether.median)} | ${fmt(i.wasmOneByOne!.median)} |` : ''}`);
  if (c.wasmRuns) lines.push('', `WASM backend runs: ${c.wasmRuns.engine} in the engine, ${c.wasmRuns.fallback} on the JS executor (should be 0).`);
  return lines.join('\n');
}
