// The reference queries, defined once for every engine.
//
// Each query has an `exec` per engine (this is what gets timed, and it forces
// the full result to exist) and a `summary` per engine (untimed) that turns the
// result into one canonical string. The runner requires every engine's summary
// to match before it records any timing, so a fast wrong answer cannot be published.
//
// A future WASM backend adds a third engine here and is checked and timed the
// same way (docs/TASKS.md, S-301).

import { op, desc } from 'arquero';
import type { ColumnTable } from 'arquero';
import { count, pipe } from '../../src';
import type { ExecuteOptions, JsTable, Result } from '../../src';
import { Routes } from '../../scripts/bgp/file';

type ZTable = JsTable<typeof Routes.fields>;

export interface Query {
  readonly id: string;
  readonly label: string;
  // Part of the spike gate's "grouped aggregate and sort" set.
  readonly gate: boolean;
  readonly zamdaExec: (table: ZTable, options?: ExecuteOptions) => Promise<unknown>;
  readonly zamdaSummary: (raw: unknown) => string;
  readonly arqueroExec: (table: ColumnTable) => unknown;
  readonly arqueroSummary: (raw: unknown) => string;
}

export function canonical(lines: readonly string[], ordered: boolean): string {
  // Purpose: one string for a result: lines in order, or sorted when the order is not part of the answer
  return (ordered ? [...lines] : [...lines].sort()).join('\n');
}

export function orderedSummary(values: ArrayLike<number>, other: ArrayLike<number>): string {
  // Purpose: a short fingerprint of a long ordered result: its length, both ends and a sparse checksum
  const n = values.length;
  const parts: string[] = [`n=${n}`];
  for (let i = 0; i < Math.min(5, n); i++) parts.push(`${values[i]},${other[i]}`);
  for (let i = Math.max(5, n - 5); i < n; i++) parts.push(`${values[i]},${other[i]}`);
  let sum = 0;
  for (let i = 0; i < n; i += 997) sum = (sum * 31 + values[i]! * 7 + other[i]!) >>> 0;
  parts.push(`sum=${sum}`);
  return parts.join(';');
}

export const key = (...parts: unknown[]): string => parts.map(p => (p === null || p === undefined ? '~' : String(p))).join('|');

// --- Q1: routes per network (high cardinality group-by on two keys) ---
const q1 = pipe(Routes)
  .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name }))
  .agg(() => ({ n: count() }))
  .compile();

// --- Q2: routes per prefix length (low cardinality) ---
const q2 = pipe(Routes)
  .groupBy(c => ({ prefix_len: c.prefix_len }))
  .agg(() => ({ n: count() }))
  .compile();

// --- Q3: routes and distinct networks per region ---
const q3 = pipe(Routes)
  .groupBy(c => ({ rir: c.rir }))
  .agg(c => ({ n: count(), networks: c.origin_as.countDistinct() }))
  .compile();

// --- Q4: top 20 networks (group, sort, limit) ---
const q4 = pipe(Routes)
  .groupBy(c => ({ origin_as: c.origin_as }))
  .agg(() => ({ n: count() }))
  .sort(c => [c.n.desc(), c.origin_as.asc()])
  .limit(20)
  .compile();

// --- Q5: the dashboard's filtered region chart (filter, then Q3) ---
const q5 = pipe(Routes)
  .filter(c => c.prefix_len.between(22, 24).and(c.path_len.between(2, 6)))
  .groupBy(c => ({ rir: c.rir }))
  .agg(c => ({ n: count(), networks: c.origin_as.countDistinct() }))
  .compile();

// --- Q6: name search (case-insensitive contains on a dictionary column) ---
const q6 = pipe(Routes)
  .filter(c => c.as_name.lower().contains('cloud'))
  .agg(() => ({ n: count() }))
  .compile();

// --- Q7: full sort of every route by prefix length, then address ---
const q7 = pipe(Routes)
  .select(c => ({ prefix_len: c.prefix_len, prefix_addr: c.prefix_addr }))
  .sort(c => [c.prefix_len.asc(), c.prefix_addr.asc()])
  .compile();

type Rows<K extends string> = Record<K, unknown>[];

function zRows<K extends string>(raw: unknown): Rows<K> {
  // Purpose: the rows of a zamda result
  return (raw as Result<never>).toArray() as unknown as Rows<K>;
}

function aRows<K extends string>(raw: unknown): Rows<K> {
  // Purpose: the rows of an Arquero result
  return (raw as ColumnTable).objects() as Rows<K>;
}

export const QUERIES: readonly Query[] = [
  {
    id: 'Q1',
    label: 'routes per network (group by origin and name)',
    gate: true,
    zamdaExec: (t, o) => q1.execute(t, o),
    zamdaSummary: raw => canonical(zRows<'origin_as' | 'as_name' | 'n'>(raw).map(r => `${key(r.origin_as, r.as_name)}=${r.n}`), false),
    arqueroExec: t => t.groupby('origin_as', 'as_name').count(),
    arqueroSummary: raw => canonical(aRows<'origin_as' | 'as_name' | 'count'>(raw).map(r => `${key(r.origin_as, r.as_name)}=${r.count}`), false),
  },
  {
    id: 'Q2',
    label: 'routes per prefix length',
    gate: false,
    zamdaExec: (t, o) => q2.execute(t, o),
    zamdaSummary: raw => canonical(zRows<'prefix_len' | 'n'>(raw).map(r => `${r.prefix_len}=${r.n}`), false),
    arqueroExec: t => t.groupby('prefix_len').count(),
    arqueroSummary: raw => canonical(aRows<'prefix_len' | 'count'>(raw).map(r => `${r.prefix_len}=${r.count}`), false),
  },
  {
    id: 'Q3',
    label: 'routes and distinct networks per region',
    gate: true,
    zamdaExec: (t, o) => q3.execute(t, o),
    zamdaSummary: raw => canonical(zRows<'rir' | 'n' | 'networks'>(raw).map(r => `${key(r.rir)}=${r.n},${r.networks}`), false),
    arqueroExec: t => t.groupby('rir').rollup({ n: op.count(), networks: op.distinct('origin_as') }),
    arqueroSummary: raw => canonical(aRows<'rir' | 'n' | 'networks'>(raw).map(r => `${key(r.rir)}=${r.n},${r.networks}`), false),
  },
  {
    id: 'Q4',
    label: 'top 20 networks (group, sort, limit)',
    gate: true,
    zamdaExec: (t, o) => q4.execute(t, o),
    zamdaSummary: raw => canonical(zRows<'origin_as' | 'n'>(raw).map(r => `${r.origin_as}=${r.n}`), true),
    arqueroExec: t => t.groupby('origin_as').count().orderby(desc('count'), 'origin_as').slice(0, 20),
    arqueroSummary: raw => canonical(aRows<'origin_as' | 'count'>(raw).map(r => `${r.origin_as}=${r.count}`), true),
  },
  {
    id: 'Q5',
    label: 'filtered region chart (prefix /22-/24, path 2-6)',
    gate: false,
    zamdaExec: (t, o) => q5.execute(t, o),
    zamdaSummary: raw => canonical(zRows<'rir' | 'n' | 'networks'>(raw).map(r => `${key(r.rir)}=${r.n},${r.networks}`), false),
    arqueroExec: t =>
      t
        .filter((d: { prefix_len: number; path_len: number }) => d.prefix_len >= 22 && d.prefix_len <= 24 && d.path_len >= 2 && d.path_len <= 6)
        .groupby('rir')
        .rollup({ n: op.count(), networks: op.distinct('origin_as') }),
    arqueroSummary: raw => canonical(aRows<'rir' | 'n' | 'networks'>(raw).map(r => `${key(r.rir)}=${r.n},${r.networks}`), false),
  },
  {
    id: 'Q6',
    label: 'name search ("cloud", case-insensitive)',
    gate: false,
    zamdaExec: (t, o) => q6.execute(t, o),
    zamdaSummary: raw => String(zRows<'n'>(raw)[0]?.n),
    // @ts-expect-error Arquero's typings declare op.includes for arrays only; it also works on strings.
    arqueroExec: t => t.filter((d: { as_name: string | null }) => op.includes(op.lower(d.as_name), 'cloud')).rollup({ n: op.count() }),
    arqueroSummary: raw => String(aRows<'n'>(raw)[0]?.n),
  },
  {
    id: 'Q7',
    label: 'full sort of every route (prefix length, address)',
    gate: true,
    zamdaExec: (t, o) => q7.execute(t, o),
    zamdaSummary: raw => {
      // Purpose: fingerprint the sorted columns
      const result = raw as Result<never>;
      const lens = result.column('prefix_len' as never).values as ArrayLike<number>;
      const addrs = result.column('prefix_addr' as never).values as ArrayLike<number>;
      return orderedSummary(lens, addrs);
    },
    arqueroExec: t => {
      // Purpose: sort, then read both columns so the sort has really happened (Arquero sorts lazily)
      const sorted = t.select(['prefix_len', 'prefix_addr']).orderby('prefix_len', 'prefix_addr');
      return { lens: sorted.array('prefix_len'), addrs: sorted.array('prefix_addr') };
    },
    arqueroSummary: raw => {
      // Purpose: fingerprint the sorted columns
      const { lens, addrs } = raw as { lens: ArrayLike<number>; addrs: ArrayLike<number> };
      return orderedSummary(lens, addrs);
    },
  },
];
