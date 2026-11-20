// Loading the prepared data (data/globe-*.zcl from `bun run prep-globe`) into the shapes the engines and
// the map need. Everything arrives as typed arrays; nothing is parsed per value.

import { decodeColumns } from '@zamda/bgp-data/columns-file';
import type { ColumnsFile } from '@zamda/bgp-data/columns-file';
import { NONE } from './schemas';

export interface Networks {
  readonly count: number;
  readonly asn: Uint32Array;
  readonly names: readonly string[];
  readonly nameCode: Uint32Array;
  readonly cc: Uint8Array;
  readonly rir: Uint8Array;
  // Display position: a PeeringDB facility, or near the country's centre (spread out so ASes of one
  // country do not sit on one pixel). precision 2 = facility, 1 = country, 0 = region only.
  readonly lon: Float32Array;
  readonly lat: Float32Array;
  readonly precision: Uint8Array;
  readonly index: ReadonlyMap<number, number>;
  readonly countries: readonly string[];
  readonly rirs: readonly string[];
}

export interface RouteColumns {
  readonly rows: number;
  readonly columns: {
    prefix_addr: Uint32Array;
    prefix_len: Uint8Array;
    prefix_end: Uint32Array;
    origin_as: Uint32Array;
    path_len: Uint8Array;
    cc: Uint8Array;
    rir: Uint8Array;
    addresses: Float64Array;
  };
  readonly time: number;
  readonly collector: string;
}

export interface UpdateColumns {
  readonly rows: number;
  readonly columns: {
    second: Uint32Array;
    kind: Uint8Array;
    prefix_addr: Uint32Array;
    prefix_len: Uint8Array;
    origin_as: Uint32Array;
    peer_as: Uint32Array;
    path_len: Uint8Array;
    cc: Uint8Array;
    pkey: Float64Array;
  };
  readonly start: number;
  readonly minutes: number;
}

async function fetchFile(path: string, onProgress: (loaded: number, total: number) => void): Promise<ColumnsFile> {
  // Purpose: download one columns file with progress, and decode it
  const response = await fetch(path);
  if (!response.ok || response.body === null) {
    throw new Error(`${path}: HTTP ${response.status}. Run \`bun run prep-bgp && bun run prep-globe\` at the repository root.`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return decodeColumns(bytes);
}

function hash(n: number): number {
  // Purpose: a stable pseudo-random number in [0, 1) for an AS number
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function prefixSize(length: number): number {
  // Purpose: the number of addresses a prefix of this length covers
  return 2 ** (32 - length);
}

export async function loadAll(onProgress: (what: string, fraction: number) => void): Promise<{ networks: Networks; routes: RouteColumns; updates: UpdateColumns }> {
  // Purpose: fetch the three data files in parallel and shape them for the engines and the map
  const sizes = { as: [0, 1], routes: [0, 1], updates: [0, 1] } as Record<string, [number, number]>;
  const report = (name: string) => (loaded: number, total: number) => {
    sizes[name] = [loaded, total || loaded];
    const sum = Object.values(sizes).reduce((s, [l, t]) => [s[0]! + l, s[1]! + t], [0, 0]);
    onProgress('downloading the routing table and an hour of BGP updates', sum[0]! / Math.max(1, sum[1]!));
  };
  const [as, routeFile, updateFile] = await Promise.all([
    fetchFile('/data/globe-as.zcl', report('as')),
    fetchFile('/data/globe-routes.zcl', report('routes')),
    fetchFile('/data/globe-updates.zcl', report('updates')),
  ]);

  const n = as.rows;
  const lon = (as.columns.lon as Float32Array).slice();
  const lat = (as.columns.lat as Float32Array).slice();
  const precision = as.columns.precision as Uint8Array;
  const asn = as.columns.asn as Uint32Array;
  const index = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    index.set(asn[i]!, i);
    if (precision[i]! < 2) {
      // Spread networks placed at a country (or region) centre on a sunflower pattern around it.
      const r = (precision[i] === 1 ? 2.2 : 6) * Math.sqrt(hash(asn[i]!));
      const a = hash(asn[i]! * 7 + 3) * Math.PI * 2;
      lon[i] = lon[i]! + r * Math.cos(a) / Math.max(0.3, Math.cos((lat[i]! * Math.PI) / 180));
      lat[i] = Math.max(-80, Math.min(80, lat[i]! + r * Math.sin(a)));
    }
  }
  const networks: Networks = {
    count: n,
    asn,
    names: as.lists.names!,
    nameCode: as.columns.name as Uint32Array,
    cc: as.columns.cc as Uint8Array,
    rir: as.columns.rir as Uint8Array,
    lon,
    lat,
    precision,
    index,
    countries: as.lists.countries!,
    rirs: as.lists.rirs!,
  };

  const r = routeFile.rows;
  const len = routeFile.columns.prefix_len as Uint8Array;
  const addr = routeFile.columns.prefix_addr as Uint32Array;
  const end = new Uint32Array(r);
  const addresses = new Float64Array(r);
  for (let i = 0; i < r; i++) {
    const size = prefixSize(len[i]!);
    addresses[i] = size;
    end[i] = addr[i]! + size - 1;
  }
  const routes: RouteColumns = {
    rows: r,
    columns: {
      prefix_addr: addr,
      prefix_len: len,
      prefix_end: end,
      origin_as: routeFile.columns.origin_as as Uint32Array,
      path_len: routeFile.columns.path_len as Uint8Array,
      cc: routeFile.columns.cc as Uint8Array,
      rir: routeFile.columns.rir as Uint8Array,
      addresses,
    },
    time: Number(routeFile.meta.time),
    collector: String(routeFile.meta.rrc),
  };

  const u = updateFile.rows;
  const uAddr = updateFile.columns.prefix_addr as Uint32Array;
  const uLen = updateFile.columns.prefix_len as Uint8Array;
  const pkey = new Float64Array(u);
  for (let i = 0; i < u; i++) pkey[i] = uAddr[i]! * 64 + uLen[i]!;
  const updates: UpdateColumns = {
    rows: u,
    columns: {
      second: Uint32Array.from(updateFile.columns.second as Uint16Array),
      kind: updateFile.columns.kind as Uint8Array,
      prefix_addr: uAddr,
      prefix_len: uLen,
      origin_as: updateFile.columns.origin_as as Uint32Array,
      peer_as: updateFile.columns.peer_as as Uint32Array,
      path_len: updateFile.columns.path_len as Uint8Array,
      cc: updateFile.columns.cc as Uint8Array,
      pkey,
    },
    start: Number(updateFile.meta.start),
    minutes: Number(updateFile.meta.minutes),
  };
  return { networks, routes, updates };
}

export function countryName(networks: Networks, code: number, names: ReadonlyMap<string, string>): string {
  // Purpose: a country's display name from its code
  if (code === NONE) return 'Unknown';
  const iso = networks.countries[code] ?? '??';
  return names.get(iso) ?? iso;
}
