// S-301: times the spike gate's queries on the Rust kernels against zamda's JS
// executor, loading included, and checks every spike answer against zamda's
// before any timing is kept. Shared by the Bun runner and the browser page.

import { measure, once } from '../bench/reference/measure';
import type { Timing } from '../bench/reference/measure';
import { QUERIES, canonical, key, orderedSummary } from '../bench/reference/queries';
import { sample, toRows, zamdaFromColumns, zamdaFromRows } from '../bench/reference/data';
import { EMPTY_SELECTION, compilePlans, paramsFor } from '../demo/dashboard';
import type { Selection } from '../demo/dashboard';
import type { RouteArrays } from '../bench/reference/data';
import { Spike } from './engine';
import type { RawKernels } from './engine';

export interface EngineSpec {
  readonly name: string;
  readonly kernels: RawKernels;
}

export interface EngineResult {
  readonly name: string;
  readonly loadRows: Timing;
  readonly loadColumns: Timing;
  readonly q1: Timing;
  readonly q3: Timing;
  readonly q4: Timing;
  readonly q7Radix: Timing;
  readonly q7Pdq: Timing;
}

export interface DashboardRow {
  readonly label: string;
  readonly zamda: Timing;
  readonly engines: readonly { readonly name: string; readonly timing: Timing }[];
}

export interface SpikeSize {
  readonly rows: number;
  readonly dashboard: readonly DashboardRow[];
  readonly zamda: { readonly loadRows: Timing; readonly q1: Timing; readonly q3: Timing; readonly q4: Timing; readonly q7: Timing };
  readonly engines: readonly EngineResult[];
}

const GATE_IDS = ['Q1', 'Q3', 'Q4', 'Q7'] as const;

function spikeSummaries(spike: Spike): Record<(typeof GATE_IDS)[number], string> {
  // Purpose: the gate queries' answers from the spike, written in the harness's canonical summary format
  const q1 = spike.q1();
  const q1Lines: string[] = [];
  for (let j = 0; j < q1.origin_as.length; j++) {
    const code = q1.name[j]!;
    q1Lines.push(`${key(q1.origin_as[j], code === 0 ? null : spike.nameList[code - 1])}=${q1.n[j]}`);
  }
  const q3 = spike.q3();
  const q3Lines: string[] = [];
  for (let r = 0; r < 256; r++) {
    if (q3.routes[r] === 0) continue;
    q3Lines.push(`${key(r === 0 ? null : spike.rirList[r - 1])}=${q3.routes[r]},${q3.networks[r]}`);
  }
  const q4 = spike.q4(20);
  const q4Lines = Array.from(q4.origin_as, (a, j) => `${a}=${q4.n[j]}`);
  const q7 = spike.q7(true);
  const q7Pdq = spike.q7(false);
  const radix = orderedSummary(q7.prefix_len, q7.prefix_addr);
  if (radix !== orderedSummary(q7Pdq.prefix_len, q7Pdq.prefix_addr)) throw new Error('the two sorts disagree');
  return { Q1: canonical(q1Lines, false), Q3: canonical(q3Lines, false), Q4: canonical(q4Lines, true), Q7: radix };
}

const SCENARIOS: readonly { label: string; selection: Selection }[] = [
  { label: 'nothing selected', selection: EMPTY_SELECTION },
  { label: 'prefix /22-/24, region ARIN, name "cloud"', selection: { ...EMPTY_SELECTION, prefixLen: [22, 24], regions: ['ARIN'], search: 'cloud' } },
];

const CHARTS = ['networks', 'prefixLen', 'pathLen', 'regions'] as const;

function dashboardSummaries(spike: Spike, selection: Selection): Record<(typeof CHARTS)[number], string> {
  // Purpose: the four charts' answers from the spike, in the same canonical form as zamda's
  const d = spike.dashboard(selection);
  const lines: Record<(typeof CHARTS)[number], string[]> = { networks: [], prefixLen: [], pathLen: [], regions: [] };
  for (let j = 0; j < d.networks.origin_as.length; j++) {
    const code = d.networks.name[j]!;
    lines.networks.push(`${key(d.networks.origin_as[j], code === 0 ? null : spike.nameList[code - 1])}=${d.networks.n[j]}`);
  }
  for (let v = 0; v < 256; v++) {
    if (d.prefixLen[v] !== 0) lines.prefixLen.push(`${v}=${d.prefixLen[v]}`);
    if (d.pathLen[v] !== 0) lines.pathLen.push(`${v}=${d.pathLen[v]}`);
    if (d.regions.routes[v] !== 0) lines.regions.push(`${key(v === 0 ? null : spike.rirList[v - 1])}=${d.regions.routes[v]},${d.regions.networks[v]}`);
  }
  return { networks: canonical(lines.networks, false), prefixLen: canonical(lines.prefixLen, false), pathLen: canonical(lines.pathLen, false), regions: canonical(lines.regions, false) };
}

async function zamdaDashboard(table: ReturnType<typeof zamdaFromColumns>, plans: ReturnType<typeof compilePlans>, selection: Selection): Promise<unknown[]> {
  // Purpose: start the four charts the way the dashboard does, together
  return Promise.all(CHARTS.map(id => (plans[id] as { execute(t: typeof table, o: unknown): Promise<unknown> }).execute(table, { params: paramsFor(selection, id) })));
}

export async function compareDashboard(arrays: RouteArrays, engines: readonly EngineSpec[], runs: number): Promise<DashboardRow[]> {
  // Purpose: one dashboard interaction on zamda JS and on each spike engine, after checking all four charts agree
  const table = zamdaFromColumns(arrays);
  const plans = compilePlans();
  const spikes = engines.map(e => {
    // Purpose: load the table into this engine
    const spike = new Spike(e.kernels);
    spike.loadColumns(arrays);
    return spike;
  });
  const rows: DashboardRow[] = [];
  for (const { label, selection } of SCENARIOS) {
    const expected = await zamdaDashboard(table, plans, selection);
    const z = {
      networks: canonical((expected[0] as { toArray(): Record<string, unknown>[] }).toArray().map(r => `${key(r.origin_as, r.as_name)}=${r.routes}`), false),
      prefixLen: canonical((expected[1] as { toArray(): Record<string, unknown>[] }).toArray().map(r => `${r.prefix_len}=${r.routes}`), false),
      pathLen: canonical((expected[2] as { toArray(): Record<string, unknown>[] }).toArray().map(r => `${r.path_len}=${r.routes}`), false),
      regions: canonical((expected[3] as { toArray(): Record<string, unknown>[] }).toArray().map(r => `${key(r.rir)}=${r.routes},${r.networks}`), false),
    };
    for (let e = 0; e < engines.length; e++) {
      const got = dashboardSummaries(spikes[e]!, selection);
      for (const id of CHARTS) {
        if (got[id] !== z[id]) throw new Error(`${engines[e]!.name} dashboard (${label}), chart ${id}: differs from zamda\nzamda: ${z[id].slice(0, 200)}\nspike: ${got[id].slice(0, 200)}`);
      }
    }
    rows.push({
      label,
      zamda: await measure(() => zamdaDashboard(table, plans, selection), runs),
      engines: await Promise.all(engines.map(async (e, i) => ({ name: e.name, timing: await measure(() => spikes[i]!.dashboard(selection), runs) }))),
    });
  }
  for (const spike of spikes) spike.release();
  return rows;
}

export async function compareSize(arrays: RouteArrays, engines: readonly EngineSpec[], runs: number): Promise<SpikeSize> {
  // Purpose: check and time the gate queries at one table size
  const rows = toRows(arrays);
  const table = zamdaFromRows(rows);
  const q = (id: string) => QUERIES.find(x => x.id === id)!;
  const zTime = async (id: string): Promise<Timing> => measure(() => q(id).zamdaExec(table), runs);
  const expected: Record<string, string> = {};
  for (const id of GATE_IDS) expected[id] = q(id).zamdaSummary(await q(id).zamdaExec(table));

  const results: EngineResult[] = [];
  for (const engine of engines) {
    const spike = new Spike(engine.kernels);
    spike.loadRows(rows);
    const got = spikeSummaries(spike);
    for (const id of GATE_IDS) {
      if (got[id] !== expected[id]) throw new Error(`${engine.name} ${id}: answer differs from zamda\nzamda: ${expected[id]!.slice(0, 200)}\nspike: ${got[id].slice(0, 200)}`);
    }
    results.push({
      name: engine.name,
      loadRows: await once(() => spike.loadRows(rows), runs),
      loadColumns: await once(() => spike.loadColumns(arrays), runs),
      q1: await measure(() => spike.q1(), runs),
      q3: await measure(() => spike.q3(), runs),
      q4: await measure(() => spike.q4(20), runs),
      q7Radix: await measure(() => spike.q7(true), runs),
      q7Pdq: await measure(() => spike.q7(false), runs),
    });
    spike.release();
  }
  return {
    rows: arrays.rowCount,
    dashboard: await compareDashboard(arrays, engines, runs),
    zamda: { loadRows: await once(() => zamdaFromRows(rows), runs), q1: await zTime('Q1'), q3: await zTime('Q3'), q4: await zTime('Q4'), q7: await zTime('Q7') },
    engines: results,
  };
}

const f = (t: number): string => (t >= 100 ? t.toFixed(0) : t >= 10 ? t.toFixed(1) : t.toFixed(2));

export function gateTotals(size: SpikeSize, e: EngineResult): { jsQueries: number; jsAll: number; spikeQueries: number; spikeAll: number } {
  // Purpose: the gate's two sums for one engine: queries only, and queries plus loading from row objects
  const jsQueries = size.zamda.q1.median + size.zamda.q3.median + size.zamda.q4.median + size.zamda.q7.median;
  const spikeQueries = e.q1.median + e.q3.median + e.q4.median + Math.min(e.q7Radix.median, e.q7Pdq.median);
  return { jsQueries, jsAll: jsQueries + size.zamda.loadRows.median, spikeQueries, spikeAll: spikeQueries + e.loadRows.median };
}

export function spikeMarkdown(meta: Record<string, string | number>, sizes: readonly SpikeSize[]): string {
  // Purpose: the results as markdown: per size, per engine, with the gate's 3x test
  const lines = ['# Spike S-301: Rust kernels against the JS executor', '', Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`).join('\n'), ''];
  for (const size of sizes) {
    lines.push(`## ${size.rows.toLocaleString()} rows`, '', '| Step | zamda JS (ms) | ' + size.engines.map(e => `${e.name} (ms)`).join(' | ') + ' |', '| --- | ---: |' + size.engines.map(() => ' ---: |').join(''));
    const row = (label: string, js: number | null, pick: (e: EngineResult) => number): void => {
      // Purpose: one table row
      lines.push(`| ${label} | ${js === null ? '' : f(js)} | ` + size.engines.map(e => f(pick(e))).join(' | ') + ' |');
    };
    row('load from row objects', size.zamda.loadRows.median, e => e.loadRows.median);
    row('load from columns (strings encoded)', null, e => e.loadColumns.median);
    row('Q1 routes per network', size.zamda.q1.median, e => e.q1.median);
    row('Q3 routes and distinct networks per region', size.zamda.q3.median, e => e.q3.median);
    row('Q4 top 20 networks', size.zamda.q4.median, e => e.q4.median);
    row('Q7 full sort, radix', size.zamda.q7.median, e => e.q7Radix.median);
    row('Q7 full sort, pdqsort', null, e => e.q7Pdq.median);
    lines.push('');
    lines.push('| Dashboard interaction (four charts) | zamda JS (ms) | ' + size.engines.map(e => `${e.name} (ms)`).join(' | ') + ' |', '| --- | ---: |' + size.engines.map(() => ' ---: |').join(''));
    for (const d of size.dashboard) lines.push(`| ${d.label} | ${f(d.zamda.median)} | ` + d.engines.map(e => `${f(e.timing.median)} (${(d.zamda.median / e.timing.median).toFixed(1)}x)`).join(' | ') + ' |');
    lines.push('');
    for (const e of size.engines) {
      const t = gateTotals(size, e);
      lines.push(
        `**${e.name}:** gate queries ${f(t.jsQueries)} ms in JS against ${f(t.spikeQueries)} ms (${(t.jsQueries / t.spikeQueries).toFixed(1)}x); ` +
          `with row loading ${f(t.jsAll)} against ${f(t.spikeAll)} ms (**${(t.jsAll / t.spikeAll).toFixed(1)}x**).`,
      );
    }
    lines.push('');
  }
  lines.push('The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda\'s before timing.');
  return lines.join('\n');
}

export { sample };
