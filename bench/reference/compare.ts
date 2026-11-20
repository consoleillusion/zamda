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

import { compilePlans, EMPTY_SELECTION, paramsFor } from './crossfilter';
import type { Selection } from './crossfilter';
import { count, pipe } from 'zamda';
import type { Table } from 'zamda';
import { Routes } from '@zamda/bgp-data/file';
import { arqueroFromColumns, sample, zamdaFromColumns } from './data';
import type { RouteArrays } from './data';
import { measure } from './measure';
import type { Timing } from './measure';
import { QUERIES } from './queries';
import type { WasmSession } from 'zamda/internal/backends/wasm/index';

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
  readonly stats: () => {
    engine: number;
    fallback: number;
    phasesMs: { prepare: number; tables: number; start: number; steps: number; read: number };
    cache: { hits: number; misses: number };
  };
  // Open a session for one interaction's runs to share, when the backend supports it.
  readonly session?: () => WasmSession;
}

// Larger than any slice, so the executor never yields.
const NO_SLICING = 1e9;

const SCENARIOS: readonly { label: string; selection: Selection }[] = [
  { label: 'nothing selected', selection: EMPTY_SELECTION },
  { label: 'prefix /22-/24, region ARIN, name "cloud"', selection: { ...EMPTY_SELECTION, prefixLen: [22, 24], regions: ['ARIN'], search: 'cloud' } },
];

async function measureWithPhases(wasm: WasmTarget, log: (line: string) => void, f: () => Promise<unknown>, runs: number): Promise<Timing> {
  // Purpose: time f like `measure`, and log where the engine runs spent their time per interaction (host and engine phases, ms)
  const before = JSON.parse(JSON.stringify(wasm.stats())) as ReturnType<WasmTarget['stats']>;
  const timing = await measure(f, runs);
  const after = wasm.stats();
  const n = (after.engine - before.engine) / 4;
  const per = (k: keyof typeof after.phasesMs): string => ((after.phasesMs[k] - before.phasesMs[k]) / n).toFixed(1);
  const hits = after.cache.hits - before.cache.hits;
  const misses = after.cache.misses - before.cache.misses;
  log(`  WASM phases per interaction (four runs): prepare ${per('prepare')}, strings and tables ${per('tables')}, start ${per('start')}, steps ${per('steps')}, read ${per('read')} ms`);
  log(`  WASM session cache over these runs: ${hits} hits, ${misses} misses`);
  return timing;
}

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
    const start = function (id: (typeof charts)[number], sliceMs?: number, on: Table<typeof Routes.fields> = zt, session?: WasmSession): Promise<unknown> {
      // Purpose: start one chart's plan with this scenario's parameters, sharing work through `session` when given
      const options = { params: paramsFor(selection, id), ...(sliceMs === undefined ? {} : { sliceMs }), ...(session === undefined ? {} : { session }) };
      return (plans[id] as { execute(t: typeof zt, o: unknown): Promise<unknown> }).execute(on as typeof zt, options);
    };
    // One session per interaction, closed once its charts settle, as the page will do (T-416).
    const withSession = async function (body: (session: WasmSession | undefined) => Promise<unknown>): Promise<void> {
      // Purpose: run one interaction with a fresh session, closing it afterwards
      const session = wasm?.session?.();
      try {
        await body(session);
      } finally {
        session?.close();
      }
    };
    if (wt !== undefined) {
      // Before timing, each chart's answer on the WASM backend (in a session, as timed) must equal the JS backend's.
      const rowsOf = async (id: (typeof charts)[number], on: typeof zt, session?: WasmSession): Promise<string> => {
        // Purpose: one chart's result as sorted text lines
        const result = await (plans[id] as { execute(t: typeof zt, o: unknown): Promise<{ toArray(): unknown[] }> }).execute(on, { params: paramsFor(selection, id), ...(session === undefined ? {} : { session }) });
        return result.toArray().map(r => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).sort().join('\n');
      };
      const session = wasm?.session?.();
      try {
        const got = await Promise.all(charts.map(id => rowsOf(id, wt as unknown as typeof zt, session)));
        const want = await Promise.all(charts.map(id => rowsOf(id, zt)));
        charts.forEach((id, i) => {
          if (got[i] !== want[i]) throw new Error(`${label}: chart ${id} differs between the WASM backend (with a session) and the JS backend in ${runtime}`);
        });
      } finally {
        session?.close();
      }
    }
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
            wasmTogether: await measure(() => withSession(s => Promise.all(charts.map(id => start(id, undefined, wt, s)))), runs),
            wasmOneByOne: await measureWithPhases(wasm!, log, () =>
              withSession(async s => {
                // Purpose: the four charts in turn on the WASM backend, sharing one session
                for (const id of charts) await start(id, NO_SLICING, wt, s);
              }), runs),
          }),
    };
    interactions.push(row);
    log(`interaction (${label}): together ${row.together.median.toFixed(0)} ms, together no slicing ${row.togetherNoSlice.median.toFixed(0)} ms, one by one ${row.oneByOne.median.toFixed(0)} ms${row.wasmTogether ? `; WASM together ${row.wasmTogether.median.toFixed(1)} ms, one by one ${row.wasmOneByOne!.median.toFixed(1)} ms` : ''}`);
  }
  if (wt !== undefined) {
    // Each filter condition of the second scenario on its own, counting the rows that pass, to show which condition costs the time.
    const alone = [
      ['no filter', pipe(Routes).agg(() => ({ n: count() })).compile()],
      ['prefix length 22-24', pipe(Routes).filter(c => c.prefix_len.between(22, 24)).agg(() => ({ n: count() })).compile()],
      ['region is ARIN', pipe(Routes).filter(c => c.rir.isIn(['ARIN'])).agg(() => ({ n: count() })).compile()],
      ['name contains cloud', pipe(Routes).filter(c => c.as_name.lower().contains('cloud')).agg(() => ({ n: count() })).compile()],
      ['all three', pipe(Routes).filter(c => c.prefix_len.between(22, 24).and(c.rir.isIn(['ARIN'])).and(c.as_name.lower().contains('cloud'))).agg(() => ({ n: count() })).compile()],
    ] as const;
    const parts: string[] = [];
    for (const [name, plan] of alone) {
      const timing = await measure(() => (plan as { execute(t: typeof wt, o: unknown): Promise<unknown> }).execute(wt, { sliceMs: NO_SLICING }), runs);
      parts.push(`${name} ${timing.median.toFixed(1)}`);
    }
    log(`  WASM one filter condition alone, counting rows (median ms): ${parts.join(', ')}`);
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
  if (c.wasmRuns) lines.push('', `WASM backend runs: ${c.wasmRuns.engine} in the engine, ${c.wasmRuns.fallback} on the JS executor (the string fallbacks of D-074 and T-219).`);
  return lines.join('\n');
}
