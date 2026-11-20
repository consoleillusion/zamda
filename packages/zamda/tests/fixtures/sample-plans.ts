// Sample plans for the IR, Substrait and engine-corpus tests: a crossfiltered dashboard over a
// six-column table (two dictionary columns, parameters, list parameters, string search, distinct
// counts, sort and limit). The schema mirrors the BGP reference dataset, but nothing here reads it.

import { count, list, pipe, schema, t } from '../../src';

export const Routes = schema({
  prefix_addr: t.uint32,
  prefix_len: t.uint8,
  origin_as: t.uint32,
  as_name: t.dictionary,
  path_len: t.uint8,
  rir: t.dictionary,
});

const TABLE_ROWS = 400;
const FLOW_GROUPS = 24;

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
    // Every network's route count under the current filters. The top 20, the
    // number of networks and the number of routes are all read from this.
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
    // The table and river are bounded, sorted views over the same filtered routes.
    table: filtered()
      .sort(c => c.prefix_addr.asc())
      .limit(TABLE_ROWS)
      .compile(),
    flow: filtered()
      .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name, path_len: c.path_len }))
      .agg(() => ({ routes: count() }))
      .sort(c => [c.routes.desc(), c.origin_as.asc()])
      .limit(FLOW_GROUPS)
      .compile(),
  };
}

