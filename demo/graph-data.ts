// The graph view's data selection: compiled zamda plans over the edge table,
// and the pure conversion from rows to the nodes and edges the renderer draws.
// Nothing in this module needs a DOM, so it is tested directly.

import { list, pipe, t } from '../src';
import type { JsTable } from '../src';
import type { GraphArrays } from '../scripts/bgp/graph-file';
import { GraphEdges } from '../scripts/bgp/graph-file';

export type EdgeTable = JsTable<typeof GraphEdges.fields>;

export const OVERVIEW_EDGES = 10_000;
export const OVERVIEW_NODES = 2_000;
export const NEIGHBOURHOOD_EDGES = 2_000;
export const NEIGHBOURHOOD_NODES = 2_000;
export const NEIGHBOURHOOD_HOPS = 2;

export interface GraphEdgeRow {
  readonly from_as: number;
  readonly to_as: number;
  readonly prefixes: number;
}

export interface GraphNodeView {
  readonly asn: number;
  readonly name: string | null;
  readonly label: string;
  readonly rir: string | null;
  readonly x: number;
  readonly y: number;
  readonly paths: number;
  readonly origins: number;
}

export interface GraphEdgeView {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly weight: number;
}

export interface ActivityRow {
  readonly from_as: number | null;
  readonly to_as: number | null;
  readonly updates: number | null;
}

export interface GraphViewData {
  readonly nodes: readonly GraphNodeView[];
  readonly edges: readonly GraphEdgeView[];
  // Selected edges whose endpoint did not fit the node budget.
  readonly truncated: number;
}

export interface ViewOptions {
  readonly nodeLimit: number;
}

export function compileOverviewPlan(edgeLimit: number = OVERVIEW_EDGES) {
  // Purpose: the simplified overview's strongest-edge plan, compiled once
  return pipe(GraphEdges)
    .sort(c => [c.prefixes.desc(), c.from_as.asc(), c.to_as.asc()])
    .limit(edgeLimit)
    .compile();
}

export function compileNeighbourhoodPlans(edgeLimit: number = NEIGHBOURHOOD_EDGES) {
  // Purpose: the two plans that expand a clicked AS's neighbourhood
  const connected = pipe(GraphEdges, { asns: list(t.uint32) }).filter((c, p) =>
    c.from_as.isIn(p.asns).or(c.to_as.isIn(p.asns)),
  );
  return {
    first: connected.sort(c => [c.prefixes.desc(), c.from_as.asc(), c.to_as.asc()]).limit(edgeLimit).compile(),
    expand: connected.sort(c => [c.prefixes.desc(), c.from_as.asc(), c.to_as.asc()]).limit(edgeLimit).compile(),
  };
}

export function compileAllPlan() {
  // Purpose: the all-data mode's plan: every weighted edge, in file order
  return pipe(GraphEdges)
    .select(c => ({ from_as: c.from_as, to_as: c.to_as, prefixes: c.prefixes }))
    .compile();
}

export function compileGraphPlans() {
  // Purpose: compile the graph's plans once at start-up
  return {
    overview: compileOverviewPlan(),
    all: compileAllPlan(),
    ...compileNeighbourhoodPlans(),
  };
}

export type GraphPlans = ReturnType<typeof compileGraphPlans>;

export function edgeKey(from: number, to: number): string {
  // Purpose: one stable key for a directed AS pair, shared by the view and the live overlay
  return `${from}:${to}`;
}

export function hotKeys(rows: readonly ActivityRow[]): Map<string, number> {
  // Purpose: mark hot edges and both endpoints, keeping the strongest recent count for each
  const hot = new Map<string, number>();
  for (const row of rows) {
    if (row.from_as === null || row.to_as === null) continue;
    const updates = row.updates ?? 0;
    if (updates === 0) continue;
    for (const key of [edgeKey(row.from_as, row.to_as), String(row.from_as), String(row.to_as)]) {
      hot.set(key, Math.max(hot.get(key) ?? 0, updates));
    }
  }
  return hot;
}

export async function overviewEdges(
  edges: EdgeTable,
  limit: number = OVERVIEW_EDGES,
  plan = compileOverviewPlan(limit),
): Promise<readonly GraphEdgeRow[]> {
  // Purpose: the strongest edges in the graph, within the given budget
  return (await plan.execute(edges)).toArray() as GraphEdgeRow[];
}

export async function allEdges(
  edges: EdgeTable,
  plan = compileAllPlan(),
): Promise<readonly GraphEdgeRow[]> {
  // Purpose: every edge in the graph, for the explicit all-data mode
  return (await plan.execute(edges)).toArray() as GraphEdgeRow[];
}

export async function neighbourhoodEdges(
  edges: EdgeTable,
  plans: GraphPlans,
  asn: number,
  limit?: number,
): Promise<readonly GraphEdgeRow[]> {
  // Purpose: the strongest edges within two hops of one AS
  const use = limit === undefined ? plans : compileNeighbourhoodPlans(limit);
  const first = (await use.first.execute(edges, { params: { asns: [asn] } })).toArray() as GraphEdgeRow[];
  const asns = new Set<number>([asn]);
  for (const row of first) {
    asns.add(row.from_as);
    asns.add(row.to_as);
  }
  return (await use.expand.execute(edges, { params: { asns: [...asns] } })).toArray() as GraphEdgeRow[];
}

export function buildViewData(
  arrays: GraphArrays,
  rows: readonly GraphEdgeRow[],
  options: ViewOptions = { nodeLimit: OVERVIEW_NODES },
): GraphViewData {
  // Purpose: choose the nodes that can draw the selected edges, with labels and frozen positions
  const index = new Map<number, number>();
  for (let i = 0; i < arrays.rowCount; i++) index.set(arrays.asn[i]!, i);
  const strength = new Map<number, number>();
  for (const row of rows) {
    strength.set(row.from_as, Math.max(strength.get(row.from_as) ?? 0, row.prefixes));
    strength.set(row.to_as, Math.max(strength.get(row.to_as) ?? 0, row.prefixes));
  }
  const ranked = [...strength.keys()].sort(function (a, b) {
    // Purpose: strongest incident edge first, then most routes, then lowest ASN
    const ai = index.get(a);
    const bi = index.get(b);
    return (
      (strength.get(b) ?? 0) - (strength.get(a) ?? 0) ||
      (bi === undefined ? 0 : arrays.paths[bi]!) - (ai === undefined ? 0 : arrays.paths[ai]!) ||
      a - b
    );
  });
  const kept = new Set(ranked.slice(0, options.nodeLimit));
  const nodes: GraphNodeView[] = [...kept].map(function (asn): GraphNodeView {
    // Purpose: one labelled, positioned node for the renderer
    const i = index.get(asn)!;
    return {
      asn,
      name: arrays.name[i] ?? null,
      label: arrays.name[i] ?? `AS${asn}`,
      rir: arrays.rir[i] ?? null,
      x: arrays.x[i]!,
      y: arrays.y[i]!,
      paths: arrays.paths[i]!,
      origins: arrays.origins[i]!,
    };
  });
  const edges: GraphEdgeView[] = [];
  for (const row of rows) {
    if (!kept.has(row.from_as) || !kept.has(row.to_as)) continue;
    edges.push({ key: edgeKey(row.from_as, row.to_as), from: row.from_as, to: row.to_as, weight: row.prefixes });
  }
  return { nodes, edges, truncated: rows.length - edges.length };
}
