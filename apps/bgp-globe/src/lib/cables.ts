// Physical-route inference over the local submarine-cable geometry. Everything here is a candidate
// path, never a claim that BGP or a packet selected that cable.

export interface CableGeo {
  readonly features: { readonly geometry: { readonly coordinates: number[][][] } }[];
}

export interface CableNode {
  readonly lon: number;
  readonly lat: number;
  readonly edges: { readonly to: number; readonly weight: number }[];
}

interface ShortestTree {
  readonly distance: Float64Array;
  readonly previous: Int32Array;
}

export interface CableGraph {
  readonly nodes: CableNode[];
  readonly cells: Map<string, number[]>;
  readonly paths: Map<string, number[] | null>;
  readonly trees: Map<number, ShortestTree>;
}

export interface Point {
  readonly lon: number;
  readonly lat: number;
}

function nodeKey(lon: number, lat: number): string {
  // Purpose: one node for cable points that are already the same place at the data's precision
  return `${lon.toFixed(3)}|${lat.toFixed(3)}`;
}

function distanceKm(a: Point, b: Point): number {
  // Purpose: great-circle distance between two geographic points
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildCableGraph(geo: CableGeo): CableGraph {
  // Purpose: turn cable lines into an undirected graph that also joins nearby landings
  const nodes: { lon: number; lat: number; edges: { to: number; weight: number }[] }[] = [];
  const index = new Map<string, number>();
  const node = (lon: number, lat: number): number => {
    const key = nodeKey(lon, lat);
    let at = index.get(key);
    if (at === undefined) {
      at = nodes.length;
      index.set(key, at);
      nodes.push({ lon, lat, edges: [] });
    }
    return at;
  };
  const link = (a: number, b: number): void => {
    if (a === b) return;
    const weight = distanceKm(nodes[a]!, nodes[b]!);
    nodes[a]!.edges.push({ to: b, weight });
    nodes[b]!.edges.push({ to: a, weight });
  };
  for (const feature of geo.features) {
    for (const line of feature.geometry.coordinates ?? []) {
      if (line.length < 2) continue;
      let previous = node(line[0]![0]!, line[0]![1]!);
      for (let i = 1; i < line.length; i++) {
        const current = node(line[i]![0]!, line[i]![1]!);
        link(previous, current);
        previous = current;
      }
    }
  }
  const cells = new Map<string, number[]>();
  nodes.forEach((node, at) => {
    const key = cellKey(...cellOf(node));
    let list = cells.get(key);
    if (list === undefined) cells.set(key, list = []);
    list.push(at);
  });
  // Distinct cables meet at landings a few kilometres apart; without this a route cannot change cable.
  nodes.forEach((candidate, i) => {
    const [cx, cy] = cellOf(candidate);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (j > i && distanceKm(candidate, nodes[j]!) < 80) link(i, j);
        }
      }
    }
  });
  return { nodes, cells, paths: new Map(), trees: new Map() };
}

const CELL_DEGREES = 10;

function cellOf(point: Point): [number, number] {
  // Purpose: the coarse spatial cell holding a geographic point, for nearest-landing lookup
  return [Math.floor((point.lon + 180) / CELL_DEGREES), Math.floor((point.lat + 90) / CELL_DEGREES)];
}

function cellKey(x: number, y: number): string {
  // Purpose: a stable key for one spatial cell, wrapping at the antimeridian
  return `${((x % 36) + 36) % 36}|${y}`;
}

function shortestTree(graph: CableGraph, from: number): ShortestTree {
  // Purpose: one Dijkstra tree from a cable node, reusable for every destination from that landing
  const cached = graph.trees.get(from);
  if (cached !== undefined) return cached;
  const { nodes } = graph;
  const distance = new Float64Array(nodes.length).fill(Infinity);
  const previous = new Int32Array(nodes.length).fill(-1);
  const heap: { at: number; d: number }[] = [];
  const push = (item: { at: number; d: number }): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.d <= heap[i]!.d) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): { at: number; d: number } | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined) return top;
    if (heap.length === 0) return top;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < heap.length && heap[l]!.d < heap[small]!.d) small = l;
      if (r < heap.length && heap[r]!.d < heap[small]!.d) small = r;
      if (small === i) break;
      [heap[small], heap[i]] = [heap[i]!, heap[small]!];
      i = small;
    }
    return top;
  };
  distance[from] = 0;
  push({ at: from, d: 0 });
  while (heap.length > 0) {
    const current = pop()!;
    if (current.d !== distance[current.at]) continue;
    for (const edge of nodes[current.at]!.edges) {
      const next = current.d + edge.weight;
      if (next >= distance[edge.to]!) continue;
      distance[edge.to] = next;
      previous[edge.to] = current.at;
      push({ at: edge.to, d: next });
    }
  }
  const tree = { distance, previous };
  graph.trees.set(from, tree);
  return tree;
}

function shortestPath(graph: CableGraph, from: number, to: number): number[] | null {
  // Purpose: one least-distance cable path, cached per pair of landings
  if (from === to) return [from];
  const key = from < to ? `${from}|${to}` : `${to}|${from}`;
  const cached = graph.paths.get(key);
  if (cached !== undefined) return cached;
  const root = Math.min(from, to);
  const { distance, previous } = shortestTree(graph, root);
  if (!Number.isFinite(distance[Math.max(from, to)]!)) {
    graph.paths.set(key, null);
    return null;
  }
  const backwards: number[] = [];
  for (let at = Math.max(from, to); at !== -1; at = previous[at]!) {
    backwards.push(at);
    if (at === root) break;
  }
  const path = from === root ? backwards.reverse() : backwards;
  graph.paths.set(key, path);
  return path;
}

function nearestNodes(graph: CableGraph, point: Point, limit: number, maxKm: number): number[] {
  // Purpose: the landings where a router could plausibly meet the cable network, found through a spatial index
  const [cx, cy] = cellOf(point);
  const radius = Math.ceil(maxKm / (111 * CELL_DEGREES)) + 1;
  const candidates: { at: number; km: number }[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= 18) continue;
      for (const at of graph.cells.get(cellKey(cx + dx, y)) ?? []) {
        const node = graph.nodes[at]!;
        const km = distanceKm(point, node);
        if (km <= maxKm) candidates.push({ at, km });
      }
    }
  }
  return candidates.sort((a, b) => a.km - b.km).slice(0, limit).map(candidate => candidate.at);
}

export function pathKey(points: readonly (Point | readonly [number, number])[]): string {
  // Purpose: a stable identity for one drawn candidate so co-located routes share a line
  return points.map(point => 'lon' in point
    ? `${point.lon.toFixed(2)},${point.lat.toFixed(2)}`
    : `${point[0]!.toFixed(2)},${point[1]!.toFixed(2)}`).join(';');
}

export function physicalAlternatives(graph: CableGraph, from: Point, to: Point, landings = 3): [number, number][][] {
  // Purpose: every candidate cable route between two places, one per plausible pair of landings
  const starts = nearestNodes(graph, from, landings, 1200);
  const ends = nearestNodes(graph, to, landings, 1200);
  const seen = new Set<string>();
  const out: [number, number][][] = [];
  for (const start of starts) {
    for (const end of ends) {
      const path = shortestPath(graph, start, end);
      if (path === null) continue;
      const points: Point[] = [from, ...path.map(at => graph.nodes[at]!), to];
      const key = pathKey(points);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(points.map(point => [point.lon, point.lat] as [number, number]));
    }
  }
  return out;
}

function pathSequences(text: string): number[][] {
  // Purpose: AS_SEQUENCEs only; a set or confederation is ambiguous and must not invent adjacency
  const sequences: number[][] = [];
  let current: number[] = [];
  for (const token of text.trim().split(/\s+/)) {
    if (/^\d+$/.test(token)) {
      current.push(Number(token));
    } else if (current.length > 0) {
      sequences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sequences.push(current);
  return sequences;
}

export function asPathHops(text: string): [number, number][] {
  // Purpose: consecutive AS pairs in travel order (origin to RIS peer), with prepends collapsed
  const sequences = pathSequences(text);
  const hops: [number, number][] = [];
  for (let s = sequences.length - 1; s >= 0; s--) {
    const reversed = [...sequences[s]!].reverse().filter((asn, i, all) => i === 0 || asn !== all[i - 1]!);
    for (let i = 1; i < reversed.length; i++) hops.push([reversed[i - 1]!, reversed[i]!]);
  }
  return hops;
}

export function asPathAsns(text: string): number[] {
  // Purpose: every unambiguous AS on a path, for selecting routes that involve a network
  return pathSequences(text).flat();
}

export interface PhysicalRouteRow {
  readonly originAs: number;
  readonly peerAs: number;
  readonly nextHop: number;
  readonly path: string;
  readonly originLon: number;
  readonly originLat: number;
  readonly prefixes: number;
  readonly count: number;
}

export interface PhysicalPointLookup {
  asnPoint(asn: number): Point | null;
  ipPoint(ip: number): Point | null;
}

export interface PhysicalRouteGroup {
  readonly fromAs: number;
  readonly toAs: number;
  readonly path: [number, number][];
  readonly count: number;
  readonly prefixes: number;
  readonly routes: number;
  readonly paths: number;
}

export function collectPhysicalRoutes(
  graph: CableGraph,
  rows: readonly PhysicalRouteRow[],
  lookup: PhysicalPointLookup,
): PhysicalRouteGroup[] {
  // Purpose: draw every candidate cable path for every adjacent AS hop once, merging all routes that could use it
  const alternatives = new Map<string, readonly [number, number][][]>();
  const merged = new Map<string, {
    fromAs: number;
    toAs: number;
    path: [number, number][];
    count: number;
    prefixes: number;
    routes: number;
    paths: Set<string>;
  }>();
  for (const row of rows) {
    const hops = asPathHops(row.path);
    if (hops.length === 0 && row.originAs !== 0 && row.peerAs !== 0 && row.originAs !== row.peerAs) {
      hops.push([row.originAs, row.peerAs]);
    }
    const used = new Set<string>();
    hops.forEach(([fromAs, toAs], index) => {
      const fromPoint = index === 0 && fromAs === row.originAs && Number.isFinite(row.originLon) && Number.isFinite(row.originLat)
        ? { lon: row.originLon, lat: row.originLat }
        : lookup.asnPoint(fromAs);
      const toPoint = index === hops.length - 1 && toAs === row.peerAs
        ? lookup.ipPoint(row.nextHop) ?? lookup.asnPoint(toAs)
        : lookup.asnPoint(toAs);
      if (fromPoint === null || toPoint === null
        || !Number.isFinite(fromPoint.lon) || !Number.isFinite(fromPoint.lat)
        || !Number.isFinite(toPoint.lon) || !Number.isFinite(toPoint.lat)) return;
      const endpointKey = `${fromAs}|${toPoint === fromPoint ? 'same' : `${fromPoint.lon.toFixed(3)},${fromPoint.lat.toFixed(3)}`}|${toPoint.lon.toFixed(3)},${toPoint.lat.toFixed(3)}`;
      let candidates = alternatives.get(endpointKey);
      if (candidates === undefined) {
        candidates = physicalAlternatives(graph, fromPoint, toPoint);
        alternatives.set(endpointKey, candidates);
      }
      for (const path of candidates) {
        const key = `${fromAs}>${toAs}|${pathKey(path)}`;
        if (used.has(key)) continue;
        used.add(key);
        let group = merged.get(key);
        if (group === undefined) {
          group = { fromAs, toAs, path, count: 0, prefixes: 0, routes: 0, paths: new Set() };
          merged.set(key, group);
        }
        group.count += row.count;
        group.prefixes += row.prefixes;
        group.routes++;
        group.paths.add(row.path);
      }
    });
  }
  return [...merged.values()]
    .map(group => ({ ...group, paths: group.paths.size }))
    .sort((a, b) => b.count - a.count || a.fromAs - b.fromAs || a.toAs - b.toAs);
}
