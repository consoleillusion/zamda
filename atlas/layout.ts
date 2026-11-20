// The visual model for the standalone BGP topology view. It turns compiled
// adjacency rows into five regional lanes (one per RIR), draws the strongest
// hops individually, and keeps every remaining pair as an honest regional
// bundle. No DOM, no old demo code.

import type { GraphArrays } from '../scripts/bgp/graph-file';
import type { AtlasRow } from './plans';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Curve {
  readonly p0: Point;
  readonly p1: Point;
  readonly p2: Point;
}

export interface Hub extends Point {
  readonly key: string;
  readonly code: string;
  readonly label: string;
  readonly color: string;
  readonly ases: number;
  readonly routes: number;
  shown: number;
}

export interface AsNode extends Point {
  readonly asn: number;
  readonly label: string;
  readonly hub: string;
  readonly paths: number;
  readonly origins: number;
  readonly radius: number;
  readonly weight: number;
  readonly rank: number;
}

export interface Flow extends Curve {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly fromHub: string;
  readonly toHub: string;
  readonly weight: number;
  readonly spanKm: number;
  readonly width: number;
  readonly color: string;
}

export interface Beam extends Curve {
  readonly key: string;
  readonly fromHub: string;
  readonly toHub: string;
  readonly hops: number;
  readonly weight: number;
  readonly width: number;
  readonly color: string;
}

export interface Scene {
  readonly hubs: readonly Hub[];
  readonly nodes: readonly AsNode[];
  readonly flows: readonly Flow[];
  readonly beams: readonly Beam[];
  readonly maxWeight: number;
  readonly maxBeamWeight: number;
  readonly visibleCount: number;
  readonly tailCount: number;
  readonly tailWeight: number;
}

export const VISIBLE_FLOWS = 32;

const REGION_ORDER = ['ARIN', 'RIPE', 'APNIC', 'AFRINIC', 'LACNIC', 'UNKNOWN'] as const;
const REGION_CODES: Readonly<Record<string, string>> = {
  ARIN: 'ARIN',
  RIPE: 'RIPE NCC',
  APNIC: 'APNIC',
  AFRINIC: 'AFRINIC',
  LACNIC: 'LACNIC',
  UNKNOWN: 'unmapped',
};
const HUB_LABELS: Readonly<Record<string, string>> = {
  ARIN: 'North America',
  RIPE: 'Europe',
  APNIC: 'Asia Pacific',
  AFRINIC: 'Africa',
  LACNIC: 'Latin America',
  UNKNOWN: 'Unmapped',
};
export const HUB_COLORS: Readonly<Record<string, string>> = {
  ARIN: '#63a4ff',
  RIPE: '#ff6b6b',
  APNIC: '#45d4a1',
  AFRINIC: '#ffc857',
  LACNIC: '#c792ea',
  UNKNOWN: '#94a8c0',
};
const LANE_X: Readonly<Record<string, number>> = {
  ARIN: -0.88,
  RIPE: -0.53,
  APNIC: -0.18,
  AFRINIC: 0.18,
  LACNIC: 0.53,
  UNKNOWN: 0.88,
};
const LANE_TOP = 0.58;
const LANE_BOTTOM = -0.53;
const HEADER_Y = 0.84;
const BUNDLE_Y = -0.68;

function clamp(value: number, low: number, high: number): number {
  // Purpose: keep every derived point inside the renderer's square
  return Math.max(low, Math.min(high, value));
}

function hubKey(rir: string | null): string {
  // Purpose: map the graph file's full RIR names to stable drawing keys
  switch (rir) {
    case 'ARIN': return 'ARIN';
    case 'RIPE':
    case 'RIPE NCC': return 'RIPE';
    case 'APNIC': return 'APNIC';
    case 'AFRINIC': return 'AFRINIC';
    case 'LACNIC': return 'LACNIC';
    default: return 'UNKNOWN';
  }
}

function laneRank(key: string): number {
  // Purpose: keep the same left-to-right region order even when a region is absent
  const rank = REGION_ORDER.indexOf(key as (typeof REGION_ORDER)[number]);
  return rank < 0 ? REGION_ORDER.length - 1 : rank;
}

function hash(asn: number): number {
  // Purpose: give each AS a stable jitter inside its lane without moving it between runs
  return (Math.imul(asn, 0x9e3779b1) >>> 0) % 1000;
}

function lineWidth(weight: number): number {
  // Purpose: a log scale lets one huge adjacency stay visible without erasing smaller ones
  return 0.7 + Math.min(5.2, Math.log2(weight + 1) / 2);
}

function curveBetween(
  from: Point,
  to: Point,
  fromAsn: number,
  toAsn: number,
  fromKey: string,
  toKey: string,
  weight: number,
): Curve {
  // Purpose: bow directed hops so forward and reverse regional traffic do not overlap
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(0.001, Math.hypot(dx, dy));
  if (fromKey === toKey) {
    // Purpose: keep intra-region hops inside the gutter beside their own lane
    const side = from.x <= 0 ? 1 : -1;
    return {
      p0: { x: from.x, y: from.y },
      p1: { x: clamp(from.x + side * 0.2, -0.99, 0.99), y: (from.y + to.y) / 2 },
      p2: { x: to.x, y: to.y },
    };
  }
  const forward = laneRank(fromKey) < laneRank(toKey);
  const bow = Math.min(0.16, 0.035 + distance * 0.075 + Math.log10(weight + 1) * 0.008);
  const sign = forward ? 1 : -1;
  const parity = (hash(fromAsn) + hash(toAsn)) % 2 === 0 ? 1 : -1;
  return {
    p0: { x: from.x, y: from.y },
    p1: {
      x: clamp((from.x + to.x) / 2 - (dy / distance) * bow * sign * parity, -0.99, 0.99),
      y: clamp((from.y + to.y) / 2 + (dx / distance) * bow * sign * parity, -0.99, 0.99),
    },
    p2: { x: to.x, y: to.y },
  };
}

export function buildScene(arrays: GraphArrays, rows: readonly AtlasRow[], visible = VISIBLE_FLOWS): Scene {
  // Purpose: convert one bounded adjacency result into an explainable, drawable topology
  const index = new Map<number, number>();
  for (let i = 0; i < arrays.rowCount; i++) index.set(arrays.asn[i]!, i);

  const regionStats = new Map<string, { ases: number; routes: number }>();
  for (let i = 0; i < arrays.rowCount; i++) {
    const key = hubKey(arrays.rir[i] ?? null);
    const stats = regionStats.get(key) ?? { ases: 0, routes: 0 };
    stats.ases += 1;
    stats.routes += arrays.paths[i]!;
    regionStats.set(key, stats);
  }
  const hubs: Hub[] = [...regionStats]
    .sort(([a], [b]) => laneRank(a) - laneRank(b))
    .map(([key, stats]) => ({
      key,
      code: REGION_CODES[key] ?? key,
      label: HUB_LABELS[key] ?? key,
      color: HUB_COLORS[key] ?? HUB_COLORS.UNKNOWN!,
      x: LANE_X[key] ?? LANE_X.UNKNOWN!,
      y: HEADER_Y,
      ases: stats.ases,
      routes: stats.routes,
      shown: 0,
    }));
  const hubByKey = new Map(hubs.map(hub => [hub.key, hub]));

  const visibleRows = rows.slice(0, visible);
  const tailRows = rows.slice(visible);
  const incident = new Map<number, number>();
  const endpoints = new Set<number>();
  for (const row of visibleRows) {
    if (!index.has(row.from_as) || !index.has(row.to_as)) continue;
    endpoints.add(row.from_as);
    endpoints.add(row.to_as);
    incident.set(row.from_as, (incident.get(row.from_as) ?? 0) + row.prefixes);
    incident.set(row.to_as, (incident.get(row.to_as) ?? 0) + row.prefixes);
  }

  const byRegion = new Map<string, number[]>();
  for (const asn of endpoints) {
    const key = hubKey(arrays.rir[index.get(asn)!] ?? null);
    const members = byRegion.get(key) ?? [];
    members.push(asn);
    byRegion.set(key, members);
  }
  const slots = new Map<number, Point>();
  for (const [key, members] of byRegion) {
    const ordered = members.sort((a, b) => (incident.get(b) ?? 0) - (incident.get(a) ?? 0) || a - b);
    const hub = hubByKey.get(key)!;
    for (let slot = 0; slot < ordered.length; slot++) {
      const asn = ordered[slot]!;
      const jitter = (hash(asn) / 1000 - 0.5) * 0.055;
      slots.set(asn, {
        x: clamp(hub.x + jitter, -0.98, 0.98),
        y: LANE_TOP - ((slot + 0.5) / ordered.length) * (LANE_TOP - LANE_BOTTOM),
      });
    }
    hub.shown = ordered.length;
  }

  const rankByAsn = new Map<number, number>();
  [...endpoints]
    .sort((a, b) => (incident.get(b) ?? 0) - (incident.get(a) ?? 0) || a - b)
    .forEach((asn, rank) => rankByAsn.set(asn, rank));

  const nodes: AsNode[] = [...endpoints]
    .sort((a, b) => laneRank(hubKey(arrays.rir[index.get(a)!] ?? null)) - laneRank(hubKey(arrays.rir[index.get(b)!] ?? null)) || rankByAsn.get(a)! - rankByAsn.get(b)!)
    .map(asn => {
      const i = index.get(asn)!;
      const key = hubKey(arrays.rir[i] ?? null);
      const point = slots.get(asn)!;
      const weight = incident.get(asn) ?? 0;
      return {
        asn,
        label: arrays.name[i] ?? `AS${asn}`,
        hub: key,
        paths: arrays.paths[i]!,
        origins: arrays.origins[i]!,
        x: point.x,
        y: point.y,
        radius: 0.0038 + Math.min(0.006, Math.log10(weight + 1) * 0.0015),
        weight,
        rank: rankByAsn.get(asn)!,
      };
    });
  const nodeByAsn = new Map(nodes.map(node => [node.asn, node]));

  const flows: Flow[] = [];
  for (const row of visibleRows) {
    const from = nodeByAsn.get(row.from_as);
    const to = nodeByAsn.get(row.to_as);
    if (!from || !to) continue;
    const fromKey = hubKey(arrays.rir[index.get(row.from_as)!] ?? null);
    const toKey = hubKey(arrays.rir[index.get(row.to_as)!] ?? null);
    flows.push({
      key: `${row.from_as}:${row.to_as}`,
      from: row.from_as,
      to: row.to_as,
      fromHub: fromKey,
      toHub: toKey,
      weight: row.prefixes,
      spanKm: row.span_km,
      width: lineWidth(row.prefixes),
      color: HUB_COLORS[fromKey] ?? HUB_COLORS.UNKNOWN!,
      ...curveBetween(from, to, row.from_as, row.to_as, fromKey, toKey, row.prefixes),
    });
  }

  const grouped = new Map<string, { fromHub: string; toHub: string; hops: number; weight: number }>();
  for (const row of tailRows) {
    if (!index.has(row.from_as) || !index.has(row.to_as)) continue;
    const fromHub = hubKey(arrays.rir[index.get(row.from_as)!] ?? null);
    const toHub = hubKey(arrays.rir[index.get(row.to_as)!] ?? null);
    const key = `${fromHub}>${toHub}`;
    const group = grouped.get(key) ?? { fromHub, toHub, hops: 0, weight: 0 };
    group.hops += 1;
    group.weight += row.prefixes;
    grouped.set(key, group);
  }
  const beams: Beam[] = [...grouped].map(([key, group]) => {
    // Purpose: one bottom-of-chart band stands for every hidden pair between two regions
    const from = hubByKey.get(group.fromHub)!;
    const to = hubByKey.get(group.toHub)!;
    const same = from.key === to.key;
    const sag = -0.98 + Math.min(0.08, Math.log10(group.weight + 1) * 0.012);
    return {
      key,
      fromHub: group.fromHub,
      toHub: group.toHub,
      hops: group.hops,
      weight: group.weight,
      width: 1 + Math.min(8, Math.log2(group.weight + 1) / 3),
      color: HUB_COLORS[group.fromHub] ?? HUB_COLORS.UNKNOWN!,
      p0: { x: from.x, y: BUNDLE_Y },
      p1: { x: same ? from.x + (from.x <= 0 ? 0.12 : -0.12) : (from.x + to.x) / 2, y: sag },
      p2: { x: to.x, y: BUNDLE_Y },
    };
  }).sort((a, b) => b.weight - a.weight);

  return {
    hubs,
    nodes,
    flows,
    beams,
    maxWeight: Math.max(1, ...flows.map(flow => flow.weight)),
    maxBeamWeight: Math.max(1, ...beams.map(beam => beam.weight)),
    visibleCount: visibleRows.length,
    tailCount: tailRows.length,
    tailWeight: tailRows.reduce((sum, row) => sum + row.prefixes, 0),
  };
}

export function pointOn(curve: Curve, t: number): Point {
  // Purpose: one point on a quadratic hop, used for arrowheads and direction dots
  const u = 1 - t;
  return {
    x: u * u * curve.p0.x + 2 * u * t * curve.p1.x + t * t * curve.p2.x,
    y: u * u * curve.p0.y + 2 * u * t * curve.p1.y + t * t * curve.p2.y,
  };
}

function segmentDistance(point: Point, a: Point, b: Point): number {
  // Purpose: point-to-segment distance for hover testing a curved hop
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function distanceTo(curve: Curve, point: Point): number {
  // Purpose: fixed-step polyline distance, accurate enough for pointer hit testing
  let previous = curve.p0;
  let best = Infinity;
  for (let i = 1; i <= 18; i++) {
    const next = pointOn(curve, i / 18);
    best = Math.min(best, segmentDistance(point, previous, next));
    previous = next;
  }
  return best;
}

export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export function sceneBounds(scene: Scene): Bounds {
  // Purpose: include lane headers and bundle bands when fitting the view
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const include = function (point: Point): void {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  };
  for (const hub of scene.hubs) include(hub);
  for (const node of scene.nodes) include(node);
  for (const shape of [...scene.flows, ...scene.beams]) {
    include(shape.p0);
    include(shape.p1);
    include(shape.p2);
  }
  if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return { minX, maxX, minY, maxY };
}
