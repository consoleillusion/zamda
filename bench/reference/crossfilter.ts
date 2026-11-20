// The reference dashboard's interaction (spec v4, "Reference dashboard"): four crossfiltered charts over
// the routes, each applying every selection except its own. Every control is a plan parameter with a
// neutral value, so the plans compile once. This is what the dashboard benchmarks time.

import { count, list, pipe, t } from 'zamda';
import type { ParamValues } from 'zamda';
import { Routes } from '@zamda/bgp-data/file';

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

// 'networks' is one query that feeds both the top-20 chart and the totals line:
// they apply exactly the same filters, so one grouping by network answers both.
export type ChartId = 'networks' | 'prefixLen' | 'pathLen' | 'regions';

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

export function compilePlans() {
  // Purpose: compile every chart's plan once
  return {
    // Every network's route count under the current filters (the top-20 chart and the totals line).
    networks: filtered()
      .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name }))
      .agg(() => ({ routes: count() }))
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
  };
}

export function paramsFor(selection: Selection, chart: ChartId): Params {
  // Purpose: the parameter values for one chart: every selection except the chart's own
  const prefix = chart !== 'prefixLen' && selection.prefixLen ? selection.prefixLen : [0, 255];
  const path = chart !== 'pathLen' && selection.pathLen ? selection.pathLen : [0, 255];
  const addr = selection.addr ?? [0, 4294967295];
  const regions = chart !== 'regions' && selection.regions ? selection.regions : null;
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
