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
}

export interface InteractionRow {
  readonly label: string;
  // Four charts started together with normal time slicing (what the page does).
  readonly together: Timing;
  // The same four charts started together with slicing off.
  readonly togetherNoSlice: Timing;
  // The four charts one after another with slicing off: the plain sum of their work.
  readonly oneByOne: Timing;
}

export interface Comparison {
  readonly runtime: string;
  readonly rows: number;
  readonly queries: readonly QueryRow[];
  readonly interactions: readonly InteractionRow[];
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
): Promise<Comparison> {
  // Purpose: time every reference query and the dashboard interactions at one size, after checking the engines agree
  const arrays = sample(all, rows);
  const zt = zamdaFromColumns(arrays);
  const at = arqueroFromColumns(arrays);
  const queries: QueryRow[] = [];
  for (const q of QUERIES) {
    const z = q.zamdaSummary(await q.zamdaExec(zt));
    const a = q.arqueroSummary(q.arqueroExec(at));
    if (z !== a) throw new Error(`${q.id}: zamda and Arquero disagree in ${runtime}`);
    const row: QueryRow = {
      id: q.id,
      label: q.label,
      zamda: await measure(() => q.zamdaExec(zt), runs),
      zamdaNoSlice: await measure(() => q.zamdaExec(zt, { sliceMs: NO_SLICING }), runs),
      arquero: await measure(() => q.arqueroExec(at), runs),
    };
    queries.push(row);
    log(`${q.id}: zamda ${row.zamda.median.toFixed(1)} ms, no slicing ${row.zamdaNoSlice.median.toFixed(1)} ms, Arquero ${row.arquero.median.toFixed(1)} ms`);
  }
  const plans = compilePlans();
  const charts = ['networks', 'prefixLen', 'pathLen', 'regions'] as const;
  const interactions: InteractionRow[] = [];
  for (const { label, selection } of SCENARIOS) {
    const start = function (id: (typeof charts)[number], sliceMs?: number): Promise<unknown> {
      // Purpose: start one chart's plan with this scenario's parameters
      const options = { params: paramsFor(selection, id), ...(sliceMs === undefined ? {} : { sliceMs }) };
      return (plans[id] as { execute(t: typeof zt, o: unknown): Promise<unknown> }).execute(zt, options);
    };
    const row: InteractionRow = {
      label,
      together: await measure(() => Promise.all(charts.map(id => start(id))), runs),
      togetherNoSlice: await measure(() => Promise.all(charts.map(id => start(id, NO_SLICING))), runs),
      oneByOne: await measure(async () => {
        // Purpose: the four charts in turn
        for (const id of charts) await start(id, NO_SLICING);
      }, runs),
    };
    interactions.push(row);
    log(`interaction (${label}): together ${row.together.median.toFixed(0)} ms, together no slicing ${row.togetherNoSlice.median.toFixed(0)} ms, one by one ${row.oneByOne.median.toFixed(0)} ms`);
  }
  return { runtime, rows: arrays.rowCount, queries, interactions };
}

function fmt(ms: number): string {
  // Purpose: a time for a table cell
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

export function comparisonMarkdown(c: Comparison): string {
  // Purpose: the comparison as markdown
  const lines = [`## ${c.runtime}: ${c.rows.toLocaleString()} rows (medians, ms)`, ''];
  lines.push('| Query | zamda | zamda, no slicing | Arquero |', '| --- | ---: | ---: | ---: |');
  for (const q of c.queries) lines.push(`| ${q.id} ${q.label} | ${fmt(q.zamda.median)} | ${fmt(q.zamdaNoSlice.median)} | ${fmt(q.arquero.median)} |`);
  lines.push('', '| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing |', '| --- | ---: | ---: | ---: |');
  for (const i of c.interactions) lines.push(`| ${i.label} | ${fmt(i.together.median)} | ${fmt(i.togetherNoSlice.median)} | ${fmt(i.oneByOne.median)} |`);
  return lines.join('\n');
}
