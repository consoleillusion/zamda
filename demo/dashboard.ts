// The reference dashboard's queries (docs/ROADMAP.md, "Reference dashboard").
//
// Every chart runs over the same filters, linked the usual way for this kind of
// dashboard: each chart applies every selection EXCEPT its own, so a histogram
// keeps showing the bars you can still brush to. The filters are plan
// parameters, so each plan is compiled once and a slider move only re-binds
// values. A filter that is "off" is given values that let every row through.

import { count, list, pipe, t } from '../src';
import type { JsTable, ParamValues } from '../src';
import { Routes } from '../scripts/bgp/file';

export type RoutesTable = JsTable<typeof Routes.fields>;

export const PARAMS = {
  prefixLo: t.uint8,
  prefixHi: t.uint8,
  pathLo: t.uint8,
  pathHi: t.uint8,
  addrLo: t.uint32,
  addrHi: t.uint32,
  // When true, the region filter lets every row through, including rows with no region.
  allRegions: t.bool,
  regions: list(t.dictionary),
  // When true, the name search lets every row through, including rows with no name.
  noSearch: t.bool,
  // Lower-case text to find inside the network name.
  search: t.utf8,
};

export type Params = ParamValues<typeof PARAMS>;

// What the user has selected. null means "no selection" for that control.
export interface Selection {
  readonly prefixLen: readonly [number, number] | null;
  readonly pathLen: readonly [number, number] | null;
  readonly regions: readonly string[] | null;
  readonly search: string;
  readonly addr: readonly [number, number] | null;
}

export const EMPTY_SELECTION: Selection = { prefixLen: null, pathLen: null, regions: null, search: '', addr: null };

export type ChartId = 'top' | 'prefixLen' | 'pathLen' | 'regions' | 'totals';

function filtered() {
  // Purpose: a pipeline over the routes with every dashboard filter applied
  return pipe(Routes, PARAMS).filter((c, p) =>
    c.prefix_len
      .between(p.prefixLo, p.prefixHi)
      .and(c.path_len.between(p.pathLo, p.pathHi))
      .and(c.prefix_addr.between(p.addrLo, p.addrHi))
      .and(p.allRegions.or(c.rir.isIn(p.regions)))
      .and(p.noSearch.or(c.as_name.lower().contains(p.search))),
  );
}

export const TOP_LIMIT = 20;

export function compilePlans() {
  // Purpose: compile every chart's plan once
  return {
    top: filtered()
      .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name }))
      .agg(() => ({ routes: count() }))
      .sort(c => [c.routes.desc(), c.origin_as.asc()])
      .limit(TOP_LIMIT)
      .compile(),
    prefixLen: filtered()
      .groupBy(c => ({ prefix_len: c.prefix_len }))
      .agg(() => ({ routes: count() }))
      .compile(),
    pathLen: filtered()
      .groupBy(c => ({ path_len: c.path_len }))
      .agg(() => ({ routes: count() }))
      .compile(),
    regions: filtered()
      .groupBy(c => ({ rir: c.rir }))
      .agg(c => ({ routes: count(), networks: c.origin_as.countDistinct() }))
      .compile(),
    totals: filtered()
      .agg(c => ({ routes: count(), networks: c.origin_as.countDistinct() }))
      .compile(),
  };
}

export type Plans = ReturnType<typeof compilePlans>;

export function paramsFor(selection: Selection, chart: ChartId): Params {
  // Purpose: the parameter values for one chart: every selection except the chart's own
  const own = function (id: ChartId): boolean {
    // Purpose: true if this selection belongs to the chart being run, so it is ignored
    return chart === id;
  };
  const prefix = !own('prefixLen') && selection.prefixLen ? selection.prefixLen : [0, 255];
  const path = !own('pathLen') && selection.pathLen ? selection.pathLen : [0, 255];
  const addr = selection.addr ?? [0, 4294967295];
  const regions = !own('regions') && selection.regions ? selection.regions : null;
  const search = selection.search.trim().toLowerCase();
  return {
    prefixLo: prefix[0],
    prefixHi: prefix[1],
    pathLo: path[0],
    pathHi: path[1],
    addrLo: addr[0],
    addrHi: addr[1],
    allRegions: regions === null,
    regions: regions ?? [],
    noSearch: search === '',
    search,
  };
}

// Which charts must re-run when a control changes. Touching a chart's own
// selection does not change that chart, so it is left out.
export function affectedBy(control: keyof Selection): ChartId[] {
  // Purpose: the charts that depend on one control
  const all: ChartId[] = ['top', 'prefixLen', 'pathLen', 'regions', 'totals'];
  if (control === 'prefixLen' || control === 'pathLen' || control === 'regions') {
    return all.filter(function (id) {
      return id !== control;
    });
  }
  return all;
}

export function parseAddressRange(text: string): readonly [number, number] | null | 'invalid' {
  // Purpose: "10.0.0.0/8" or "1.2.3.4" to the range of network addresses it covers; empty means no filter
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(trimmed);
  if (!match) return 'invalid';
  const octets = match.slice(1, 5).map(Number);
  const length = match[5] === undefined ? 32 : Number(match[5]);
  if (octets.some(o => o > 255) || length > 32) return 'invalid';
  const addr = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const size = 2 ** (32 - length);
  const lo = Math.floor(addr / size) * size;
  return [lo, lo + size - 1];
}

export async function nameIndex(routes: RoutesTable): Promise<Map<number, string>> {
  // Purpose: origin AS to network name, for labelling the live panel
  const plan = pipe(Routes)
    .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name }))
    .agg(() => ({ n: count() }))
    .compile();
  const names = new Map<number, string>();
  for (const row of (await plan.execute(routes)).toArray()) {
    if (row.origin_as !== null && row.as_name !== null) names.set(row.origin_as, row.as_name);
  }
  return names;
}
