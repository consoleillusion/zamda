import { dataFile } from '@zamda/bgp-data/paths';
// The reference benchmark: zamda's JS backend against Arquero on the routing
// table, at several sizes, with every answer checked against the other engine
// before any timing is kept.
//
//   bun run bench:ref                                   all sizes, data/routes.bin
//   bun run bench:ref --rows 100000,1000000 --runs 9
//   bun run bench:ref --data other.bin --out my-laptop  writes bench/results/my-laptop.{json,md}
//
// Results are written as JSON and as a markdown table. The spike (S-301) runs
// the same queries and must be at least 3x faster than the zamda column below,
// loading included, at 1,000,000 rows (docs/ROADMAP.md, "Spike gate").

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { decodeRoutes } from '@zamda/bgp-data/file';
import {
  arqueroFromColumns,
  arqueroFromRows,
  sample,
  toRows,
  zamdaFromColumns,
  zamdaFromRows,
} from './data';
import { measure, once } from './measure';
import type { Timing } from './measure';
import { QUERIES } from './queries';
import type { RouteArrays } from './data';

export interface SizeResult {
  readonly rows: number;
  // Building a table from row objects (what the spike gate counts) and from columns.
  readonly load: { readonly zamdaRows: Timing; readonly arqueroRows: Timing; readonly zamdaColumns: Timing; readonly arqueroColumns: Timing };
  readonly queries: readonly { readonly id: string; readonly label: string; readonly gate: boolean; readonly zamda: Timing; readonly arquero: Timing }[];
}

function loadFile(path: string): { arrays: RouteArrays; source: string } {
  // Purpose: read the routes file and describe where it came from
  const { arrays, header } = decodeRoutes(new Uint8Array(readFileSync(path)));
  const source = header.source.synthetic
    ? 'synthetic routes (scripts/fake-routes.ts)'
    : `RIPE RIS ${String(header.source.rrc ?? '')} ${String(header.source.date ?? '')} ${String(header.source.time ?? '')}`.trim();
  return { arrays, source };
}

function parseArgs(argv: readonly string[]): { rows: number[]; data: string; out: string; runs: number } {
  // Purpose: read --rows, --data, --out and --runs
  const get = (name: string, fallback: string): string => {
    // Purpose: the value after --name, or the fallback
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1]!;
  };
  const rows = get('rows', '1000000,100000,10000').split(',').map(Number);
  if (rows.some(n => !Number.isInteger(n) || n < 1)) throw new Error('--rows takes a comma-separated list of positive integers');
  return { rows, data: get('data', dataFile('routes.bin')), out: get('out', 'latest'), runs: Number(get('runs', '7')) };
}

async function benchmarkSize(arrays: ReturnType<typeof sample>, runs: number): Promise<SizeResult> {
  // Purpose: check and time every query at one table size
  const rows = toRows(arrays);
  const load = {
    zamdaRows: await once(() => zamdaFromRows(rows), runs),
    arqueroRows: await once(() => arqueroFromRows(rows), runs),
    zamdaColumns: await once(() => zamdaFromColumns(arrays), runs),
    arqueroColumns: await once(() => arqueroFromColumns(arrays), runs),
  };
  const zt = zamdaFromColumns(arrays);
  const at = arqueroFromColumns(arrays);
  const queries = [];
  for (const q of QUERIES) {
    const z = q.zamdaSummary(await q.zamdaExec(zt));
    const a = q.arqueroSummary(q.arqueroExec(at));
    if (z !== a) {
      throw new Error(`${q.id} (${q.label}): zamda and Arquero disagree at ${arrays.rowCount} rows\n  zamda:   ${z.slice(0, 200)}\n  arquero: ${a.slice(0, 200)}`);
    }
    queries.push({
      id: q.id,
      label: q.label,
      gate: q.gate,
      zamda: await measure(() => q.zamdaExec(zt), runs),
      arquero: await measure(() => q.arqueroExec(at), runs),
    });
    console.log(`  ${q.id} ${q.label}: zamda ${queries.at(-1)!.zamda.median.toFixed(1)} ms, arquero ${queries.at(-1)!.arquero.median.toFixed(1)} ms`);
  }
  return { rows: arrays.rowCount, load, queries };
}

function fmt(ms: number): string {
  // Purpose: a time for a table cell
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

export function markdown(meta: Record<string, string | number>, sizes: readonly SizeResult[]): string {
  // Purpose: the results as a markdown report
  const lines: string[] = [];
  lines.push(`# Reference benchmark: ${meta.label}`, '');
  lines.push(`Data: ${meta.source}. Runtime: ${meta.runtime}, ${meta.platform}, ${meta.cpu} (${meta.cores} threads, ${meta.memoryGB} GB). Run on ${meta.date}.`);
  lines.push('Medians in ms over several runs after two warm-ups. Every answer was checked against the other engine first.', '');
  for (const size of sizes) {
    lines.push(`## ${size.rows.toLocaleString()} rows`, '');
    lines.push('| Query | zamda | Arquero | zamda vs Arquero |', '| --- | ---: | ---: | ---: |');
    for (const q of size.queries) {
      lines.push(`| ${q.id} ${q.label}${q.gate ? ' *' : ''} | ${fmt(q.zamda.median)} | ${fmt(q.arquero.median)} | ${(q.arquero.median / q.zamda.median).toFixed(1)}x |`);
    }
    const gateJs = size.queries.filter(q => q.gate).reduce((s, q) => s + q.zamda.median, 0);
    lines.push('', '\\* the spike gate\'s "grouped aggregate and sort" set.', '');
    lines.push('| Building the table | zamda | Arquero |', '| --- | ---: | ---: |');
    lines.push(`| from row objects | ${fmt(size.load.zamdaRows.median)} | ${fmt(size.load.arqueroRows.median)} |`);
    lines.push(`| from columns | ${fmt(size.load.zamdaColumns.median)} | ${fmt(size.load.arqueroColumns.median)} |`, '');
    lines.push(
      `**Number the spike must beat by 3x at this size:** the gate queries take ${fmt(gateJs)} ms in zamda, plus ${fmt(size.load.zamdaRows.median)} ms to load row objects, ` +
        `${fmt(gateJs + size.load.zamdaRows.median)} ms in all.`,
      '',
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  // Purpose: run the benchmark at every requested size and write the report
  const args = parseArgs(process.argv.slice(2));
  const { arrays, source } = loadFile(args.data);
  console.log(`${source}: ${arrays.rowCount.toLocaleString()} routes`);
  const sizes: SizeResult[] = [];
  for (const rows of args.rows) {
    if (rows > arrays.rowCount) {
      console.log(`skipping ${rows.toLocaleString()} rows: the file has only ${arrays.rowCount.toLocaleString()}`);
      continue;
    }
    console.log(`${rows.toLocaleString()} rows`);
    sizes.push(await benchmarkSize(sample(arrays, rows), args.runs));
  }
  const meta = {
    label: args.out,
    source,
    runtime: `Bun ${Bun.version}`,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown CPU',
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    date: new Date().toISOString().slice(0, 10),
  };
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(`bench/results/${args.out}.json`, `${JSON.stringify({ meta, sizes }, null, 2)}\n`);
  const report = markdown(meta, sizes);
  writeFileSync(`bench/results/${args.out}.md`, `${report}\n`);
  console.log(`\nwrote bench/results/${args.out}.json and .md\n`);
  console.log(report);
}

if (import.meta.main) await main();
