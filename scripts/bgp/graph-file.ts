// The AS graph file: the full topology in a compact columnar form that loads
// into a zamda table without parsing each value.
//
// Layout:
//   bytes 0-3   magic "ZGR1"
//   bytes 4-7   header length H, uint32 little-endian
//   bytes 8..   header, UTF-8 JSON (GraphHeader), padded to a multiple of 4
//   then        one buffer per column, each starting on a multiple of 4
//
// Node positions are stored, not recomputed in the browser: a deterministic
// radial layout by region and AS number, fixed for a given file.

import { schema, table, t } from '../../src';
import type { JsTable } from '../../src';
import type { GraphColumns } from './graph';

export const GraphEdges = schema({
  from_as: t.uint32,
  to_as: t.uint32,
  prefixes: t.uint32,
});

export type GraphEdgesTable = JsTable<typeof GraphEdges.fields>;

const MAGIC = 'ZGR1';
const NO_NAME = 0xffffffff;
const NO_RIR = 255;

interface ColumnRef {
  readonly offset: number;
  readonly bytes: number;
}

export interface GraphHeader {
  readonly version: 1;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly source: Readonly<Record<string, string | number>>;
  readonly names: readonly string[];
  readonly rirs: readonly string[];
  readonly columns: Readonly<Record<
    'node_asn' | 'node_paths' | 'node_origins' | 'node_name' | 'node_rir' | 'node_x' | 'node_y' |
    'edge_from' | 'edge_to' | 'edge_prefixes',
    ColumnRef
  >>;
}

export interface Labels {
  readonly asName: (asn: number) => string | null;
  readonly rir: (asn: number) => string | null;
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

function layoutNodes(asn: Uint32Array, rirCodes: Uint8Array, groupCount: number): Coordinates {
  // Purpose: spread every node evenly over one frozen disc, with regions mixed rather than stacked in arcs
  const order = Array.from({ length: asn.length }, function (_, i): number {
    // Purpose: index each node before sorting it into the layout
    return i;
  }).sort(function (a, b): number {
    // Purpose: keep the placement stable by region, then AS number
    const ra = rirCodes[a]! === NO_RIR ? groupCount - 1 : rirCodes[a]!;
    const rb = rirCodes[b]! === NO_RIR ? groupCount - 1 : rirCodes[b]!;
    return ra - rb || asn[a]! - asn[b]! || a - b;
  });
  const x = new Float32Array(asn.length);
  const y = new Float32Array(asn.length);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let j = 0; j < order.length; j++) {
    // Purpose: a sunflower spiral gives near-uniform spacing without a layout pass in the browser
    const index = order[j]!;
    const angle = j * goldenAngle;
    const radius = Math.sqrt((j + 0.5) / order.length);
    x[index] = Math.cos(angle) * radius;
    y[index] = Math.sin(angle) * radius;
  }
  return { x, y };
}

export function encodeGraph(
  graph: GraphColumns,
  labels: Labels,
  source: Readonly<Record<string, string | number>>,
): Uint8Array {
  // Purpose: label and place every node, then write the graph file
  const n = graph.nodes.rowCount;
  const m = graph.edges.rowCount;
  const names: string[] = [];
  const nameCodes = new Map<string, number>();
  const rirs: string[] = [];
  const rirCodes = new Map<string, number>();
  const nodeName = new Uint32Array(n);
  const nodeRir = new Uint8Array(n);
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
  }
  const { x, y } = layoutNodes(graph.nodes.asn, nodeRir, rirs.length + 1);

  const buffers: [keyof GraphHeader['columns'], Uint8Array][] = [
    ['node_asn', new Uint8Array(graph.nodes.asn.buffer, graph.nodes.asn.byteOffset, n * 4)],
    ['node_paths', new Uint8Array(graph.nodes.paths.buffer, graph.nodes.paths.byteOffset, n * 4)],
    ['node_origins', new Uint8Array(graph.nodes.origins.buffer, graph.nodes.origins.byteOffset, n * 4)],
    ['node_name', new Uint8Array(nodeName.buffer, nodeName.byteOffset, n * 4)],
    ['node_rir', nodeRir],
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
      version: 1,
      nodeCount: n,
      edgeCount: m,
      source,
      names,
      rirs,
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
  if (header.version !== 1) throw new Error(`Unsupported graph file version ${String(header.version)}`);
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
  const name: (string | null)[] = new Array(n);
  const rir: (string | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const code = nameCodes[i]!;
    name[i] = code === NO_NAME ? null : header.names[code]!;
    const region = rirCodes[i]!;
    rir[i] = region === NO_RIR ? null : header.rirs[region]!;
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
