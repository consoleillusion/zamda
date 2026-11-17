// Loads data/routes.bin and runs the reference dashboard's queries once, printing
// the answers and how long each took. A quick look at the real data, and the
// first real-data timings for docs/BENCHMARKS.md (task T-215).
//
//   bun run scripts/inspect-routes.ts [data/routes.bin]

import { count, pipe } from '../src';
import { Routes, formatPrefix, loadRoutes } from './bgp/file';

async function timed<T>(label: string, work: () => Promise<T> | T): Promise<T> {
  // Purpose: run once to warm up, then report the median of five timed runs
  await work();
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    result = await work();
    times.push(performance.now() - started);
  }
  times.sort(function (a, b) {
    return a - b;
  });
  console.log(`\n${label}: ${times[2]!.toFixed(1)} ms`);
  return result;
}

if (import.meta.main) {
  const path = process.argv[2] ?? 'data/routes.bin';
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());

  const started = performance.now();
  const { table, header } = loadRoutes(bytes);
  console.log(`${path}: ${table.rowCount.toLocaleString()} routes, loaded in ${(performance.now() - started).toFixed(0)} ms`);
  console.log(`source: ${JSON.stringify(header.source)}`);
  console.log(`${header.names.length.toLocaleString()} network names, regions: ${header.rirs.join(', ')}`);

  const top = pipe(Routes)
    .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name }))
    .agg(() => ({ routes: count() }))
    .sort(c => [c.routes.desc(), c.origin_as.asc()])
    .limit(10)
    .compile();
  console.table((await timed('Top 10 networks by route count', () => top.execute(table))).toArray());

  const lengths = pipe(Routes)
    .groupBy(c => ({ prefix_len: c.prefix_len }))
    .agg(() => ({ routes: count() }))
    .sort(c => c.prefix_len.asc())
    .compile();
  console.table((await timed('Prefix-length histogram', () => lengths.execute(table))).toArray());

  const paths = pipe(Routes)
    .groupBy(c => ({ path_len: c.path_len }))
    .agg(() => ({ routes: count() }))
    .sort(c => c.path_len.asc())
    .compile();
  console.table((await timed('Path-length histogram', () => paths.execute(table))).toArray());

  const regions = pipe(Routes)
    .groupBy(c => ({ rir: c.rir }))
    .agg(c => ({ routes: count(), networks: c.origin_as.countDistinct() }))
    .sort(c => c.routes.desc())
    .compile();
  console.table((await timed('Routes and networks by region', () => regions.execute(table))).toArray());

  const longest = pipe(Routes)
    .filter(c => c.path_len.gte(30))
    .sort(c => c.path_len.desc())
    .limit(5)
    .compile();
  const rows = (await timed('Longest paths (30 or more)', () => longest.execute(table))).toArray();
  console.table(
    rows.map(function (r) {
      return { prefix: formatPrefix(r.prefix_addr!, r.prefix_len!), origin_as: r.origin_as, as_name: r.as_name, path_len: r.path_len };
    }),
  );
}
