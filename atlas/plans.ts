// The compiled columnar queries behind the standalone BGP topology demo.
// One plan picks the strongest observed hops, one expands a chosen AS, and one
// counts the whole file so the caption never confuses the sample with the source.

import { count, list, pipe, t } from '../src';
import { GraphEdges } from '../scripts/bgp/graph-file';

export const TOP_HOPS = 160;

export interface AtlasRow {
  readonly from_as: number;
  readonly to_as: number;
  readonly prefixes: number;
  readonly span_km: number;
}

export function compileOverviewPlan(limit = TOP_HOPS) {
  // Purpose: the strongest directed AS adjacencies in the entire observed graph
  return pipe(GraphEdges)
    .filter(c => c.prefixes.gte(1))
    .sort(c => [c.prefixes.desc(), c.from_as.asc(), c.to_as.asc()])
    .limit(limit)
    .compile();
}

export function compileNeighbourPlan(limit = TOP_HOPS) {
  // Purpose: the strongest observed hops touching one or more selected ASes
  return pipe(GraphEdges, { asns: list(t.uint32) })
    .filter((c, p) => c.from_as.isIn(p.asns).or(c.to_as.isIn(p.asns)))
    .sort(c => [c.prefixes.desc(), c.from_as.asc(), c.to_as.asc()])
    .limit(limit)
    .compile();
}

export function compileCountPlan() {
  // Purpose: exact source counts, independent of the bounded drawing budget
  return pipe(GraphEdges)
    .agg(c => ({ pairs: count(), observations: c.prefixes.sum() }))
    .compile();
}
