// T-512: pure logic for the deck's route table, path river and concept cards.
// This module never touches the DOM so the geometry and the honest copy can be
// tested directly. The DOM wrapper lives in inspector-view.ts.

import { formatPrefix } from '../scripts/bgp/file';

// The table and river are bounded views of a much larger result. The panel says so.
export const TABLE_ROWS = 400;
export const FLOW_GROUPS = 24;
export const MAX_RIVER_ORIGINS = 6;
const MAX_RIVER_PATHS = 8;

export interface RouteRowInput {
  readonly prefix_addr: number | null;
  readonly prefix_len: number | null;
  readonly origin_as: number | null;
  readonly as_name: string | null;
  readonly path_len: number | null;
  readonly rir: string | null;
}

export interface RouteRow {
  readonly addr: number;
  readonly prefix: string;
  readonly origin: number;
  readonly name: string | null;
  readonly rir: string | null;
  readonly pathLen: number;
}

export interface RouteWindow {
  readonly start: number;
  readonly end: number;
  readonly visible: readonly RouteRow[];
  readonly padTop: number;
  readonly padBottom: number;
}

export interface FlowRowInput {
  readonly origin_as: number | null;
  readonly as_name: string | null;
  readonly path_len: number | null;
  readonly routes: number | null;
}

export interface FlowRow {
  readonly origin: number;
  readonly name: string | null;
  readonly pathLen: number;
  readonly routes: number;
}

export interface RiverNode {
  readonly id: string;
  readonly label: string;
  readonly total: number;
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

export interface RiverRibbon {
  readonly id: string;
  readonly origin: number;
  readonly pathLen: number;
  readonly routes: number;
  readonly width: number;
  readonly d: string;
}

export interface RiverLayout {
  readonly origins: readonly RiverNode[];
  readonly paths: readonly RiverNode[];
  readonly ribbons: readonly RiverRibbon[];
  readonly maxRoutes: number;
  readonly droppedOrigins: number;
}

export type ConceptKey = 'overview' | 'table' | 'river' | 'prefix' | 'path' | 'region' | 'trace';

export interface Concept {
  readonly title: string;
  readonly body: string;
}

type FullRoute = RouteRowInput & {
  readonly prefix_addr: number;
  readonly prefix_len: number;
  readonly origin_as: number;
  readonly path_len: number;
};

type FullFlow = FlowRowInput & {
  readonly origin_as: number;
  readonly path_len: number;
  readonly routes: number;
};

function fullRoute(row: RouteRowInput): row is FullRoute {
  // Purpose: a result row with every field the table needs present
  return row.prefix_addr !== null && row.prefix_len !== null && row.origin_as !== null && row.path_len !== null;
}

function fullFlow(row: FlowRowInput): row is FullFlow {
  // Purpose: a result row with every field the river needs present and positive
  return (row.origin_as ?? 0) > 0 && (row.path_len ?? 0) > 0 && (row.routes ?? 0) > 0;
}

export function routeRows(rows: readonly RouteRowInput[]): readonly RouteRow[] {
  // Purpose: format the first bounded slice of a sorted route result for the table
  return rows.filter(fullRoute).slice(0, TABLE_ROWS).map(function (row): RouteRow {
    // Purpose: one address-ordered route, without re-parsing the binary file
    return {
      addr: row.prefix_addr,
      prefix: formatPrefix(row.prefix_addr, row.prefix_len),
      origin: row.origin_as,
      name: row.as_name,
      rir: row.rir,
      pathLen: row.path_len,
    };
  });
}

export function windowRows(
  rows: readonly RouteRow[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): RouteWindow {
  // Purpose: the small window of rows a virtualized list actually draws, with spacer heights
  const start = Math.min(rows.length, Math.max(0, Math.floor(scrollTop / rowHeight) - 1));
  const end = Math.min(rows.length, Math.max(start, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 1));
  return {
    start,
    end,
    visible: rows.slice(start, end),
    padTop: start * rowHeight,
    padBottom: (rows.length - end) * rowHeight,
  };
}

export function flowRows(rows: readonly FlowRowInput[]): readonly FlowRow[] {
  // Purpose: strongest origin-to-hop-count groups first, bounded for a readable river
  return rows
    .filter(fullFlow)
    .map(function (row): FlowRow {
      // Purpose: one narrow flow record
      return { origin: row.origin_as, name: row.as_name, pathLen: row.path_len, routes: row.routes };
    })
    .sort(function (a, b): number {
      // Purpose: volume first; AS number and hop count break ties deterministically
      return b.routes - a.routes || a.origin - b.origin || a.pathLen - b.pathLen;
    })
    .slice(0, FLOW_GROUPS);
}

function round1(value: number): number {
  // Purpose: stable, short SVG coordinates
  return Math.round(value * 10) / 10;
}

function sideNodes(
  entries: readonly { readonly id: string; readonly label: string; readonly total: number }[],
  x: number,
  height: number,
): readonly RiverNode[] {
  // Purpose: place one side of the river, scaling node heights to fit the panel
  if (entries.length === 0) return [];
  const gap = Math.min(10, Math.max(4, (height - 24) / Math.max(2, entries.length * 2)));
  const available = Math.max(20, height - 24 - gap * (entries.length - 1));
  const max = Math.max(1, ...entries.map(entry => entry.total));
  const raw = entries.map(entry => Math.max(4, (entry.total / max) * available));
  const total = raw.reduce((sum, value) => sum + value, 0);
  const scale = Math.min(1, available / total);
  let y = 12;
  return entries.map(function (entry, i): RiverNode {
    // Purpose: one placed node, advancing the cursor for the next one
    const nodeHeight = raw[i]! * scale;
    const node = { id: entry.id, label: entry.label, total: entry.total, x, y: round1(y), height: round1(nodeHeight) };
    y += nodeHeight + gap;
    return node;
  });
}

export function riverLayout(rows: readonly FlowRow[], width: number, height: number): RiverLayout {
  // Purpose: lay out a bipartite origin-to-hop-count river with width-proportional ribbons
  if (rows.length === 0) {
    return { origins: [], paths: [], ribbons: [], maxRoutes: 0, droppedOrigins: 0 };
  }
  const maxRoutes = Math.max(1, ...rows.map(row => row.routes));
  const pathCap = Math.min(MAX_RIVER_PATHS, Math.max(...rows.map(row => row.pathLen)));
  const pathId = function (pathLen: number): string {
    // Purpose: fold long tails into one honest "8+" node
    return pathLen > pathCap ? `${MAX_RIVER_PATHS}+` : String(pathLen);
  };
  const pathLabel = function (id: string): string {
    // Purpose: the readable label for a hop-count node
    return `${id} hop${id.endsWith('+') ? 's' : id === '1' ? '' : 's'}`;
  };

  const byOrigin = new Map<number, number>();
  for (const row of rows) byOrigin.set(row.origin, (byOrigin.get(row.origin) ?? 0) + row.routes);
  const topOrigins = [...byOrigin.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_RIVER_ORIGINS)
    .map(entry => entry[0]);
  const originSet = new Set(topOrigins);

  const byPath = new Map<string, number>();
  for (const row of rows) {
    if (!originSet.has(row.origin)) continue;
    const id = pathId(row.pathLen);
    byPath.set(id, (byPath.get(id) ?? 0) + row.routes);
  }
  const pathOrder = function (a: string, b: string): number {
    // Purpose: numeric hop order, with the folded tail last
    const value = function (id: string): number {
      // Purpose: sort key for one hop-count node
      return id.endsWith('+') ? 10_000 : Number(id);
    };
    return value(a) - value(b);
  };
  const pathIds = [...byPath.keys()].sort(pathOrder);

  const origins = sideNodes(topOrigins.map(function (asn): { id: string; label: string; total: number } {
    // Purpose: one origin node, labelled with its AS number
    const named = rows.find(row => row.origin === asn)?.name;
    return { id: `AS${asn}`, label: named ? `AS${asn} ${named}` : `AS${asn}`, total: byOrigin.get(asn)! };
  }), 10, height);
  const paths = sideNodes(pathIds.map(function (id): { id: string; label: string; total: number } {
    // Purpose: one hop-count node
    return { id, label: pathLabel(id), total: byPath.get(id)! };
  }), width - 10, height);

  const originIndex = new Map(origins.map((node, i) => [node.id, i]));
  const pathIndex = new Map(paths.map((node, i) => [node.id, i]));
  const sourceOffset = new Map<number, number>();
  const targetOffset = new Map<string, number>();
  const leftEdge = 10 + 9;
  const rightEdge = width - 10;
  const bend = (rightEdge - leftEdge) * 0.45;
  const ribbons: RiverRibbon[] = [];

  for (const row of rows) {
    if (!originSet.has(row.origin)) continue;
    const originNode = origins[originIndex.get(`AS${row.origin}`)!]!;
    const path = pathId(row.pathLen);
    const pathNode = paths[pathIndex.get(path)!]!;
    const source = originNode.y + (sourceOffset.get(row.origin) ?? 0) / originNode.total * originNode.height;
    const target = pathNode.y + (targetOffset.get(path) ?? 0) / pathNode.total * pathNode.height;
    const ribbonWidth = Math.max(1, Math.min(28, (row.routes / maxRoutes) * 28));
    ribbons.push({
      id: `${row.origin}-${row.pathLen}`,
      origin: row.origin,
      pathLen: row.pathLen,
      routes: row.routes,
      width: round1(ribbonWidth),
      d: `M ${round1(leftEdge)} ${round1(source)} C ${round1(leftEdge + bend)} ${round1(source)}, ` +
         `${round1(rightEdge - bend)} ${round1(target)}, ${round1(rightEdge)} ${round1(target)}`,
    });
    sourceOffset.set(row.origin, (sourceOffset.get(row.origin) ?? 0) + row.routes);
    targetOffset.set(path, (targetOffset.get(path) ?? 0) + row.routes);
  }

  return {
    origins,
    paths,
    ribbons,
    maxRoutes,
    droppedOrigins: byOrigin.size - origins.length,
  };
}

export function conceptFor(key: ConceptKey, detail?: string | number): Concept {
  // Purpose: the short teaching card that follows a user's selection
  if (key === 'table') {
    return {
      title: 'Living route table',
      body: `The first ${TABLE_ROWS} matching routes, sorted by address. Every filter is a plan parameter, so the table, river and charts answer the same question. Click a prefix to focus that block.`,
    };
  }
  if (key === 'river') {
    return {
      title: 'Path shape, not hop identity',
      body: 'This snapshot stores path length, not the sequence of ASNs. Ribbons group origins by observed hop count — where traffic could have travelled, not the exact path it took. Click an origin to trace its observed adjacency on the map.',
    };
  }
  if (key === 'prefix') {
    return {
      title: 'Prefix and origin',
      body: 'An IPv4 prefix is a block of addresses announced by one network. Its origin AS is the network claiming the block; the path length counts collector-to-origin hops, not quality or latency.',
    };
  }
  if (key === 'path') {
    return {
      title: 'Why paths have different lengths',
      body: 'BGP paths grow when networks add transit operators. A shorter path is preferred by one local rule, but length alone says nothing about latency, capacity or reliability.',
    };
  }
  if (key === 'region') {
    return {
      title: 'Where a network is registered',
      body: 'The region comes from the RIR registry, not from a measurement. It describes where an AS is registered, so it is a weak proxy for where its routers or users are.',
    };
  }
  if (key === 'trace') {
    return {
      title: `Observed adjacency for AS${detail ?? '?'}`,
      body: 'The map expands consecutive AS hops seen in one observed BGP path. Edges are adjacency, not physical circuits, and the click keeps your current pan and zoom.',
    };
  }
  return {
    title: 'How to read this deck',
    body: 'Every chart, table and river is a compiled zamda plan. The JS result drives the picture; WASM runs the same plan in a worker and the measured times are printed beside it. Nothing here is a quoted speed claim.',
  };
}
