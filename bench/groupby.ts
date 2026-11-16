// Benchmark: grouped aggregation over synthetic routing-table rows.
// Compares a hand-written loop over row objects, Arquero, and zamda's JS backend.
// Run with `bun run bench` (optionally `bun run bench 1000000` to set the row count).
//
// All three start from the same array of row objects. Loading (rows -> columns)
// is timed separately from the queries, because it is paid once per table.

import { desc, from, op } from 'arquero';
import { count, pipe, schema, t, table } from '../src';

const ROWS = Number(process.argv[2] ?? 1_000_000);
const NETWORKS = 75_000;
const RIRS = ['APNIC', 'ARIN', 'RIPE NCC', 'LACNIC', 'AFRINIC'];

interface Route {
  origin_as: number;
  prefix_len: number;
  path_len: number;
  rir: string;
}

function random(seed: number): () => number {
  // Purpose: deterministic PRNG (mulberry32) so every run sees the same data
  let state = seed;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(n: number): Route[] {
  // Purpose: synthetic routes: skewed across 75k networks, most prefixes /24
  const rand = random(42);
  const rows: Route[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Cubing skews towards low indexes, so a few networks announce many routes.
    const network = Math.floor(NETWORKS * rand() ** 3);
    // Mix 16-bit-range and 32-bit-range AS numbers.
    const origin_as = network % 3 === 0 ? 4_200_000_000 + network : network * 5 + 1;
    rows[i] = {
      origin_as,
      prefix_len: rand() < 0.6 ? 24 : 16 + Math.floor(rand() * 8),
      path_len: 1 + Math.floor(rand() * 10),
      rir: RIRS[network % RIRS.length]!,
    };
  }
  return rows;
}

function median(values: number[]): number {
  // Purpose: middle value of a list of timings
  const sorted = [...values].sort(function (a, b) {
    return a - b;
  });
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function time(run: () => unknown): Promise<number> {
  // Purpose: median wall time in ms over 9 runs, after 3 warm-up runs
  for (let i = 0; i < 3; i++) await run();
  const times: number[] = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return median(times);
}

function timeOnce(run: () => unknown): number {
  // Purpose: wall time in ms of a single run, for one-off costs such as loading
  const start = performance.now();
  run();
  return performance.now() - start;
}

console.log(`rows: ${ROWS.toLocaleString()}, networks: ${NETWORKS.toLocaleString()}`);
const rows = generate(ROWS);

// --- one-off loading ---
const Routes = schema({ origin_as: t.uint32, prefix_len: t.uint8, path_len: t.uint8, rir: t.dictionary });
let routes = table(Routes, []);
let dt = from([] as Route[]);
const loadZamda = timeOnce(function () {
  routes = table(Routes, rows);
});
const loadArquero = timeOnce(function () {
  dt = from(rows);
});

// --- Q1: count per network (high cardinality) ---
const q1 = pipe(Routes).groupBy(c => ({ origin_as: c.origin_as })).agg(() => ({ n: count() })).compile();

function plainQ1(): Map<number, number> {
  // Purpose: hand-written count per network over row objects
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.origin_as, (counts.get(row.origin_as) ?? 0) + 1);
  return counts;
}

// --- Q2: count per prefix length (low cardinality) ---
const q2 = pipe(Routes).groupBy(c => ({ prefix_len: c.prefix_len })).agg(() => ({ n: count() })).compile();

function plainQ2(): Map<number, number> {
  // Purpose: hand-written count per prefix length over row objects
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.prefix_len, (counts.get(row.prefix_len) ?? 0) + 1);
  return counts;
}

// --- Q3: filter, then routes and distinct networks per region ---
const q3 = pipe(Routes)
  .filter(c => c.path_len.between(3, 6))
  .groupBy(c => ({ rir: c.rir }))
  .agg(c => ({ n: count(), networks: c.origin_as.countDistinct() }))
  .compile();

function plainQ3(): Map<string, { n: number; networks: Set<number> }> {
  // Purpose: hand-written filter plus count and distinct count per region
  const groups = new Map<string, { n: number; networks: Set<number> }>();
  for (const row of rows) {
    if (row.path_len < 3 || row.path_len > 6) continue;
    let group = groups.get(row.rir);
    if (!group) {
      group = { n: 0, networks: new Set() };
      groups.set(row.rir, group);
    }
    group.n++;
    group.networks.add(row.origin_as);
  }
  return groups;
}

// --- Q4: top 20 networks by route count (group, sort, limit) ---
const q4 = pipe(Routes)
  .groupBy(c => ({ origin_as: c.origin_as }))
  .agg(() => ({ n: count() }))
  .sort(c => [c.n.desc(), c.origin_as.asc()])
  .limit(20)
  .compile();

function plainQ4(): [number, number][] {
  // Purpose: hand-written top 20: count per network, sort every group, slice
  return [...plainQ1()]
    .sort(function (a, b) {
      return b[1] - a[1] || a[0] - b[0];
    })
    .slice(0, 20);
}

function arqueroQ4(): unknown {
  // Purpose: the same top 20 in Arquero
  return dt
    .groupby('origin_as')
    .count()
    .orderby(desc('count'), 'origin_as')
    .slice(0, 20)
    .objects();
}

// --- check all three agree before timing anything ---
const z1 = (await q1.execute(routes)).toArray();
const a1 = dt.groupby('origin_as').count();
const p1 = plainQ1();
const z3 = (await q3.execute(routes)).toArray();
const a3 = dt
  .filter((d: Route) => d.path_len >= 3 && d.path_len <= 6)
  .groupby('rir')
  .rollup({ n: op.count(), networks: op.distinct('origin_as') })
  .objects() as { rir: string; n: number; networks: number }[];
const p3 = plainQ3();

function check(condition: boolean, what: string): void {
  // Purpose: stop the benchmark if the engines disagree
  if (!condition) throw new Error(`Results differ: ${what}`);
}

check(z1.length === p1.size && a1.numRows() === p1.size, 'Q1 group count');
check(z1.every(r => p1.get(r.origin_as!) === r.n), 'Q1 counts');
check(z3.length === p3.size && a3.length === p3.size, 'Q3 group count');
check(z3.every(r => p3.get(r.rir!)!.n === r.n && p3.get(r.rir!)!.networks.size === r.networks), 'Q3 zamda');
check(a3.every(r => p3.get(r.rir)!.n === r.n && p3.get(r.rir)!.networks.size === r.networks), 'Q3 arquero');
const z4 = (await q4.execute(routes)).toArray();
const p4 = plainQ4();
const a4 = arqueroQ4() as { origin_as: number; count: number }[];
check(z4.length === 20 && z4.every((r, i) => r.origin_as === p4[i]![0] && r.n === p4[i]![1]), 'Q4 zamda');
check(a4.every((r, i) => r.origin_as === p4[i]![0] && r.count === p4[i]![1]), 'Q4 arquero');

// --- timings ---
const results = [
  {
    query: 'load rows into columns (once)',
    plain: 0,
    arquero: loadArquero,
    zamda: loadZamda,
  },
  {
    query: `Q1 count per network (${p1.size.toLocaleString()} groups)`,
    plain: await time(plainQ1),
    arquero: await time(() => dt.groupby('origin_as').count()),
    zamda: await time(() => q1.execute(routes)),
  },
  {
    query: 'Q2 count per prefix length (9 groups)',
    plain: await time(plainQ2),
    arquero: await time(() => dt.groupby('prefix_len').count()),
    zamda: await time(() => q2.execute(routes)),
  },
  {
    query: 'Q3 filter + count + distinct per region (5 groups)',
    plain: await time(plainQ3),
    arquero: await time(() =>
      dt
        .filter((d: Route) => d.path_len >= 3 && d.path_len <= 6)
        .groupby('rir')
        .rollup({ n: op.count(), networks: op.distinct('origin_as') }),
    ),
    zamda: await time(() => q3.execute(routes)),
  },
  {
    query: 'Q4 top 20 networks by route count',
    plain: await time(plainQ4),
    arquero: await time(arqueroQ4),
    zamda: await time(() => q4.execute(routes)),
  },
];

console.log('\nmedian ms (lower is better)');
console.table(
  results.map(function (r) {
    return {
      query: r.query,
      'plain JS': r.plain.toFixed(1),
      arquero: r.arquero.toFixed(1),
      zamda: r.zamda.toFixed(1),
      'zamda vs plain': r.plain ? `${(r.plain / r.zamda).toFixed(2)}x` : '',
      'zamda vs arquero': `${(r.arquero / r.zamda).toFixed(2)}x`,
    };
  }),
);
