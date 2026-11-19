// The AS graph file: the full topology in a compact columnar form that loads
// into a zamda table without parsing each value.
//
// Layout:
//   bytes 0-3   magic "ZGR2"
//   bytes 4-7   header length H, uint32 little-endian
//   bytes 8..   header, UTF-8 JSON (GraphHeader), padded to a multiple of 4
//   then        one buffer per column, each starting on a multiple of 4
//
// Node positions are stored, not recomputed in the browser: a deterministic
// country-centred layout with small sunflowers per country, fixed for a given
// file. Unknown countries fall back to an approximate regional centre.

import { schema, table, t } from '../../src';
import type { JsTable } from '../../src';
import type { CountryCentre } from './registry';
import type { GraphColumns } from './graph';

export const GraphEdges = schema({
  from_as: t.uint32,
  to_as: t.uint32,
  prefixes: t.uint32,
});

export type GraphEdgesTable = JsTable<typeof GraphEdges.fields>;

const MAGIC = 'ZGR2';
const NO_NAME = 0xffffffff;
const NO_RIR = 255;
const NO_COUNTRY = 255;
// Leave margin around the world so country groups near the edges stay on screen.
const PROJECTION_SCALE = 0.88;
const MIN_GROUP_RADIUS = 0.018;
const GROUP_RADIUS_RANGE = 0.14;

interface ColumnRef {
  readonly offset: number;
  readonly bytes: number;
}

export interface GraphHeader {
  readonly version: 2;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly source: Readonly<Record<string, string | number>>;
  readonly names: readonly string[];
  readonly rirs: readonly string[];
  readonly countries: readonly string[];
  readonly columns: Readonly<Record<
    'node_asn' | 'node_paths' | 'node_origins' | 'node_name' | 'node_rir' | 'node_country' | 'node_x' | 'node_y' |
    'edge_from' | 'edge_to' | 'edge_prefixes',
    ColumnRef
  >>;
}

export interface Labels {
  readonly asName: (asn: number) => string | null;
  readonly rir: (asn: number) => string | null;
  readonly country: (asn: number) => string | null;
}

export interface Coordinates {
  readonly x: Float32Array;
  readonly y: Float32Array;
}

export interface GraphArrays {
  readonly rowCount: number;
  readonly edgeCount: number;
  readonly asn: Uint32Array;
  readonly paths: Uint32Array;
  readonly origins: Uint32Array;
  readonly name: (string | null)[];
  readonly rir: (string | null)[];
  readonly country: (string | null)[];
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly from_as: Uint32Array;
  readonly to_as: Uint32Array;
  readonly prefixes: Uint32Array;
}

function align4(n: number): number {
  // Purpose: round up to a multiple of 4
  return (n + 3) & ~3;
}

const RIR_CENTRES: Readonly<Record<string, CountryCentre>> = {
  AFRINIC: { lat: 0, lon: 20 },
  APNIC: { lat: -10, lon: 130 },
  ARIN: { lat: 40, lon: -100 },
  LACNIC: { lat: -15, lon: -60 },
  'RIPE NCC': { lat: 50, lon: 15 },
};

function countryKey(code: number, countries: readonly string[]): string | null {
  // Purpose: the ISO-2 code stored for one node, or null when it is unknown
  return code === NO_COUNTRY ? null : (countries[code] ?? null);
}

function centreFor(
  country: string | null,
  rirCode: number,
  rirs: readonly string[],
  centres: ReadonlyMap<string, CountryCentre>,
): CountryCentre {
  // Purpose: use a country centroid, then an approximate RIR centre, then the world centre
  if (country !== null) {
    const found = centres.get(country);
    if (found) return found;
  }
  const rir = rirCode === NO_RIR ? null : (rirs[rirCode] ?? null);
  return (rir === null ? undefined : RIR_CENTRES[rir]) ?? { lat: 0, lon: 0 };
}

function groupKey(centre: CountryCentre): string {
  // Purpose: one stable key for every AS that shares an approximate point
  return `${centre.lat},${centre.lon}`;
}

function clampToCanvas(value: number): number {
  // Purpose: keep a country group's outer nodes inside the renderer's -1..1 square
  return Math.max(-0.995, Math.min(0.995, value));
}

function layoutNodes(
  asn: Uint32Array,
  countryCodes: Uint8Array,
  countries: readonly string[],
  rirCodes: Uint8Array,
  rirs: readonly string[],
  centres: ReadonlyMap<string, CountryCentre>,
): Coordinates {
  // Purpose: place each AS in a small deterministic sunflower around its country's centroid
  const groups = new Map<string, { centre: CountryCentre; indexes: number[] }>();
  for (let i = 0; i < asn.length; i++) {
    const centre = centreFor(countryKey(countryCodes[i]!, countries), rirCodes[i]!, rirs, centres);
    const key = groupKey(centre);
    let group = groups.get(key);
    if (!group) {
      group = { centre, indexes: [] };
      groups.set(key, group);
    }
    group.indexes.push(i);
  }
  let largest = 1;
  for (const group of groups.values()) largest = Math.max(largest, group.indexes.length);
  const x = new Float32Array(asn.length);
  const y = new Float32Array(asn.length);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const group of groups.values()) {
    // Purpose: larger countries get a wider group so zooming in reveals their ASes
    group.indexes.sort(function (a, b): number {
      return asn[a]! - asn[b]! || a - b;
    });
    const centreX = (group.centre.lon / 180) * PROJECTION_SCALE;
    const centreY = (group.centre.lat / 90) * PROJECTION_SCALE;
    const radius = MIN_GROUP_RADIUS + GROUP_RADIUS_RANGE * Math.sqrt(group.indexes.length / largest);
    for (let j = 0; j < group.indexes.length; j++) {
      // Purpose: golden-angle spacing is stable and needs no browser layout pass
      const angle = j * goldenAngle;
      const distance = radius * Math.sqrt((j + 0.5) / group.indexes.length);
      x[group.indexes[j]!] = clampToCanvas(centreX + Math.cos(angle) * distance);
      y[group.indexes[j]!] = clampToCanvas(centreY + Math.sin(angle) * distance);
    }
  }
  return { x, y };
}

export function encodeGraph(
  graph: GraphColumns,
  labels: Labels,
  centres: ReadonlyMap<string, CountryCentre>,
  source: Readonly<Record<string, string | number>>,
): Uint8Array {
  // Purpose: label and place every node, then write the graph file
  const n = graph.nodes.rowCount;
  const m = graph.edges.rowCount;
  const names: string[] = [];
  const nameCodes = new Map<string, number>();
  const rirs: string[] = [];
  const rirCodes = new Map<string, number>();
  const countries: string[] = [];
  const countryCodes = new Map<string, number>();
  const nodeName = new Uint32Array(n);
  const nodeRir = new Uint8Array(n);
  const nodeCountry = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const asn = graph.nodes.asn[i]!;
    const name = labels.asName(asn);
    if (name === null) nodeName[i] = NO_NAME;
    else {
      let code = nameCodes.get(name);
      if (code === undefined) {
        code = names.length;
        nameCodes.set(name, code);
        names.push(name);
      }
      nodeName[i] = code;
    }
    const region = labels.rir(asn);
    if (region === null) nodeRir[i] = NO_RIR;
    else {
      let code = rirCodes.get(region);
      if (code === undefined) {
        code = rirs.length;
        rirCodes.set(region, code);
        rirs.push(region);
      }
      nodeRir[i] = code;
    }
    const country = labels.country(asn);
    if (country === null || !/^[A-Z]{2}$/.test(country)) nodeCountry[i] = NO_COUNTRY;
    else {
      let code = countryCodes.get(country);
      if (code === undefined) {
        code = countries.length;
        if (code === NO_COUNTRY) throw new Error('Too many country codes for the graph file');
        countryCodes.set(country, code);
        countries.push(country);
      }
      nodeCountry[i] = code;
    }
  }
  const { x, y } = layoutNodes(graph.nodes.asn, nodeCountry, countries, nodeRir, rirs, centres);

  const buffers: [keyof GraphHeader['columns'], Uint8Array][] = [
    ['node_asn', new Uint8Array(graph.nodes.asn.buffer, graph.nodes.asn.byteOffset, n * 4)],
    ['node_paths', new Uint8Array(graph.nodes.paths.buffer, graph.nodes.paths.byteOffset, n * 4)],
    ['node_origins', new Uint8Array(graph.nodes.origins.buffer, graph.nodes.origins.byteOffset, n * 4)],
    ['node_name', new Uint8Array(nodeName.buffer, nodeName.byteOffset, n * 4)],
    ['node_rir', nodeRir],
    ['node_country', nodeCountry],
    ['node_x', new Uint8Array(x.buffer, x.byteOffset, n * 4)],
    ['node_y', new Uint8Array(y.buffer, y.byteOffset, n * 4)],
    ['edge_from', new Uint8Array(graph.edges.from_as.buffer, graph.edges.from_as.byteOffset, m * 4)],
    ['edge_to', new Uint8Array(graph.edges.to_as.buffer, graph.edges.to_as.byteOffset, m * 4)],
    ['edge_prefixes', new Uint8Array(graph.edges.prefixes.buffer, graph.edges.prefixes.byteOffset, m * 4)],
  ];

  let headerBytes = new Uint8Array(0);
  let columns: Record<string, ColumnRef> = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    let at = align4(8 + headerBytes.length);
    columns = {};
    for (const [name, bytes] of buffers) {
      columns[name] = { offset: at, bytes: bytes.length };
      at = align4(at + bytes.length);
    }
    const header: GraphHeader = {
      version: 2,
      nodeCount: n,
      edgeCount: m,
      source,
      names,
      rirs,
      countries,
      columns: columns as GraphHeader['columns'],
    };
    const next = new TextEncoder().encode(JSON.stringify(header));
    const settled = next.length === headerBytes.length;
    headerBytes = next;
    if (settled) break;
    if (attempt === 3) throw new Error('Graph file header length did not settle');
  }

  let total = align4(8 + headerBytes.length);
  for (const [, bytes] of buffers) total = align4(total + bytes.length);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, headerBytes.length, true);
  out.set(headerBytes, 8);
  for (const [name, bytes] of buffers) out.set(bytes, columns[name]!.offset);
  return out;
}

export function readGraphHeader(bytes: Uint8Array): GraphHeader {
  // Purpose: check the magic number and decode the graph file's header
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('Not a zamda graph file (bad magic number)');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as GraphHeader;
  if (header.version !== 2) throw new Error(`Unsupported graph file version ${String(header.version)}`);
  return header;
}

export function decodeGraph(input: Uint8Array): { arrays: GraphArrays; header: GraphHeader } {
  // Purpose: the graph file's columns as plain arrays; number columns are views of the input
  const bytes = input.byteOffset % 4 === 0 ? input : input.slice();
  const header = readGraphHeader(bytes);
  const n = header.nodeCount;
  const m = header.edgeCount;
  const col = header.columns;
  const u32 = function (ref: ColumnRef, count: number): Uint32Array {
    // Purpose: a Uint32Array view of one column
    return new Uint32Array(bytes.buffer, bytes.byteOffset + ref.offset, count);
  };
  const u8 = function (ref: ColumnRef, count: number): Uint8Array {
    // Purpose: a Uint8Array view of one column
    return new Uint8Array(bytes.buffer, bytes.byteOffset + ref.offset, count);
  };
  const f32 = function (ref: ColumnRef, count: number): Float32Array {
    // Purpose: a Float32Array view of one column
    return new Float32Array(bytes.buffer, bytes.byteOffset + ref.offset, count);
  };
  const nameCodes = u32(col.node_name, n);
  const rirCodes = u8(col.node_rir, n);
  const countryCodes = u8(col.node_country, n);
  const name: (string | null)[] = new Array(n);
  const rir: (string | null)[] = new Array(n);
  const country: (string | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const code = nameCodes[i]!;
    name[i] = code === NO_NAME ? null : header.names[code]!;
    const region = rirCodes[i]!;
    rir[i] = region === NO_RIR ? null : header.rirs[region]!;
    const place = countryCodes[i]!;
    country[i] = place === NO_COUNTRY ? null : (header.countries[place] ?? null);
  }
  return {
    header,
    arrays: {
      rowCount: n,
      edgeCount: m,
      asn: u32(col.node_asn, n),
      paths: u32(col.node_paths, n),
      origins: u32(col.node_origins, n),
      name,
      rir,
      country,
      x: f32(col.node_x, n),
      y: f32(col.node_y, n),
      from_as: u32(col.edge_from, m),
      to_as: u32(col.edge_to, m),
      prefixes: u32(col.edge_prefixes, m),
    },
  };
}

export function loadGraph(input: Uint8Array): { edges: GraphEdgesTable; arrays: GraphArrays; header: GraphHeader } {
  // Purpose: build a zamda table of edges; the number columns are views of the file
  const { arrays, header } = decodeGraph(input);
  const edges = table(GraphEdges, {
    columns: {
      from_as: arrays.from_as,
      to_as: arrays.to_as,
      prefixes: arrays.prefixes,
    },
  });
  return { edges, arrays, header };
}
