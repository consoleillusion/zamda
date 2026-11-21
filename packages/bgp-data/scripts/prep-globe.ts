// Builds the globe demo's data from the outputs of prep-bgp plus RIS update dumps:
//
//   data/globe-as.zcl       one row per AS: asn, name, country, registry, lon/lat and how precise it is
//   data/globe-routes.zcl   the routing table at the dump's time: one route per IPv4 prefix
//   data/globe-updates.zcl  every IPv4 announcement and withdrawal seen in the next N minutes, one row per
//                           prefix, in time order: the replay
//   data/globe-ips.zcl      every BGP-speaking IP observed in those updates, placed at its AS's known position
//   data/globe-ip-routes.zcl  observed announced paths, grouped by origin, peer, next hop and prefix
//
//   bun run prep:globe                     60 minutes of updates after the routes dump
//   bun run prep:globe --minutes 30        fewer minutes (a smaller replay)
//
// Run `bun run prep` first (it writes routes.bin and graph.bin). Update dumps are 5-minute files
// (data.ris.ripe.net/<rrc>/<YYYY.MM>/updates.<date>.<HHMM>.gz), downloaded once into data/ and reused.

import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { encodeColumns } from '../src/columns-file';
import { decodeRoutes } from '../src/file';
import { decodeGraph } from '../src/graph-file';
import { MrtReader } from '../src/mrt';
import { dataFile } from '../src/paths';

const SCALE = 0.88; // graph.bin stores lon / 180 * 0.88 and lat / 90 * 0.88
const NONE = 255;

function flag(name: string, fallback: string): string {
  // Purpose: one --name value from the command line
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
}

function pad(n: number, width: number): string {
  // Purpose: a zero-padded number
  return String(n).padStart(width, '0');
}

async function download(url: string, path: string): Promise<void> {
  // Purpose: fetch one file into data/ unless it is there already
  if (existsSync(path)) return;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await writeFile(`${path}.part`, new Uint8Array(await response.arrayBuffer()));
  await rename(`${path}.part`, path);
}

const minutes = Number(flag('minutes', '60'));
if (!Number.isInteger(minutes) || minutes < 5 || minutes % 5 !== 0) throw new Error('--minutes must be a multiple of 5');

// The ASes, with positions from graph.bin.
const graph = decodeGraph(new Uint8Array(await readFile(dataFile('graph.bin')))).arrays;
const countries = [...new Set(graph.country.filter((c): c is string => c !== null))].sort();
const rirs = [...new Set(graph.rir.filter((r): r is string => r !== null))].sort();
const names: string[] = [];
const nameCode = new Map<string, number>();
const n = graph.rowCount;
const as = {
  asn: new Uint32Array(n),
  name: new Uint32Array(n),
  cc: new Uint8Array(n),
  rir: new Uint8Array(n),
  lon: new Float32Array(n),
  lat: new Float32Array(n),
  precision: new Uint8Array(n),
};
const asIndex = new Map<number, number>();
for (let i = 0; i < n; i++) {
  as.asn[i] = graph.asn[i]!;
  asIndex.set(graph.asn[i]!, i);
  const name = graph.name[i] ?? '';
  let code = nameCode.get(name);
  if (code === undefined) {
    code = names.length;
    names.push(name);
    nameCode.set(name, code);
  }
  as.name[i] = code;
  as.cc[i] = graph.country[i] === null ? NONE : countries.indexOf(graph.country[i]!);
  as.rir[i] = graph.rir[i] === null ? NONE : rirs.indexOf(graph.rir[i]!);
  as.lon[i] = (graph.x[i]! / SCALE) * 180;
  as.lat[i] = (graph.y[i]! / SCALE) * 90;
  as.precision[i] = graph.location[i]!;
}
const ccOf = (asn: number): number => {
  const i = asIndex.get(asn);
  return i === undefined ? NONE : as.cc[i]!;
};
const ROLE_PEER = 1;
const ROLE_NEXT_HOP = 2;
// Lower numbers mean a more exact attribution; a header IP beats an inferred next hop.
const SOURCE_MRT_HEADER = 0;
const SOURCE_PEER_INDEX = 1;
const SOURCE_NEXT_HOP_INFERRED = 2;

function ipNumber(text: string | null | undefined): number | null {
  // Purpose: a dotted-quad IP as an unsigned number, or null when it is not IPv4
  if (typeof text !== 'string') return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(p => Number(p));
  if (octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

interface IpObservation {
  ip: number;
  asn: number;
  roleMask: number;
  source: number;
  precision: number;
  lon: number;
  lat: number;
  count: number;
  first: number;
  last: number;
}

interface RouteObservation {
  originAs: number;
  peerAs: number;
  nextHop: number;
  addr: number;
  len: number;
  path: string;
  count: number;
  first: number;
  last: number;
}

const ipObservations = new Map<number, IpObservation>();
const routeObservations = new Map<string, RouteObservation>();
const paths: string[] = [];
const pathCodes = new Map<string, number>();
const peerAsByIp = new Map<number, number>();

function asnPosition(asn: number): { lon: number; lat: number; precision: number } {
  // Purpose: the prepared display position of an AS, used until interface-level geolocation is available
  const i = asIndex.get(asn);
  if (i === undefined) return { lon: 0, lat: 0, precision: 0 };
  return { lon: as.lon[i]!, lat: as.lat[i]!, precision: as.precision[i]! };
}

function observeIp(ip: number, asn: number, role: number, source: number, second: number): void {
  // Purpose: merge every sighting of one IP into a single point with roles, attribution and a time range
  let row = ipObservations.get(ip);
  if (row === undefined) {
    const at = asnPosition(asn);
    row = { ip, asn, roleMask: 0, source, precision: at.precision, lon: at.lon, lat: at.lat, count: 0, first: second, last: second };
    ipObservations.set(ip, row);
  }
  if (source < row.source) {
    row.source = source;
    row.asn = asn;
    const at = asnPosition(asn);
    row.precision = at.precision;
    row.lon = at.lon;
    row.lat = at.lat;
  }
  row.roleMask |= role;
  row.count++;
  row.first = Math.min(row.first, second);
  row.last = Math.max(row.last, second);
}

function observeRoute(originAs: number, peerAs: number, nextHop: number, addr: number, len: number, path: string, second: number): void {
  // Purpose: count an advertised prefix on its observed next hop, keeping the full AS path for the tooltip
  const key = `${originAs}|${peerAs}|${nextHop}|${addr}|${len}|${path}`;
  let row = routeObservations.get(key);
  if (row === undefined) {
    row = { originAs, peerAs, nextHop, addr, len, path, count: 0, first: second, last: second };
    routeObservations.set(key, row);
  }
  row.count++;
  row.first = Math.min(row.first, second);
  row.last = Math.max(row.last, second);
  if (!pathCodes.has(path)) {
    pathCodes.set(path, paths.length);
    paths.push(path);
  }
}

await writeFile(dataFile('globe-as.zcl'), encodeColumns({ rows: n, columns: as, lists: { names, countries, rirs }, meta: { source: 'graph.bin' } }));
console.log(`wrote globe-as.zcl: ${n.toLocaleString()} ASes, ${countries.length} countries`);

// The routing table at the dump's time.
const routesFile = decodeRoutes(new Uint8Array(await readFile(dataFile('routes.bin'))));
const routes = routesFile.arrays;
const source = routesFile.header.source as Record<string, string>;
const r = routes.rowCount;
const routeCols = {
  prefix_addr: routes.prefix_addr.slice(),
  prefix_len: routes.prefix_len.slice(),
  origin_as: routes.origin_as.slice(),
  path_len: routes.path_len.slice(),
  cc: new Uint8Array(r),
  rir: new Uint8Array(r),
};
for (let i = 0; i < r; i++) {
  routeCols.cc[i] = ccOf(routes.origin_as[i]!);
  const region = routes.rir[i];
  routeCols.rir[i] = region === null ? NONE : Math.max(0, rirs.indexOf(region === 'RIPE' ? 'RIPE NCC' : region));
}
// The dump's collector and time come from its URL (…/rrc00/2026.11/bview.20261119.0000.gz).
const dumpMatch = /\/(rrc\d\d)\/\d{4}\.\d{2}\/bview\.(\d{8})\.(\d{4})\.gz$/.exec(source.dump ?? '');
if (dumpMatch === null) throw new Error(`routes.bin does not name a RIS dump (${String(source.dump)}); run prep-bgp without --mrt`);
const [, rrc, date, time] = dumpMatch as unknown as [string, string, string, string];
console.log(`routes: ${r.toLocaleString()} from ${rrc} ${date} ${time}`);
const start = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), Number(time.slice(0, 2)), Number(time.slice(2, 4))) / 1000;
await writeFile(dataFile('globe-routes.zcl'), encodeColumns({ rows: r, columns: routeCols, lists: { countries, rirs }, meta: { rrc, time: start } }));
console.log(`wrote globe-routes.zcl`);

// The replay: every update in the next `minutes` minutes, one row per prefix.
const origin = new Map<number, number>(); // prefix key -> current origin, for withdrawals
const key = (addr: number, len: number): number => addr * 64 + len;
for (let i = 0; i < r; i++) origin.set(key(routes.prefix_addr[i]!, routes.prefix_len[i]!), routes.origin_as[i]!);
let cap = 1 << 22;
let u = {
  second: new Uint16Array(cap),
  kind: new Uint8Array(cap),
  prefix_addr: new Uint32Array(cap),
  prefix_len: new Uint8Array(cap),
  origin_as: new Uint32Array(cap),
  peer_as: new Uint32Array(cap),
  path_len: new Uint8Array(cap),
  cc: new Uint8Array(cap),
};
let rows = 0;
const grow = (): void => {
  cap *= 2;
  const next = Object.fromEntries(Object.entries(u).map(([k, a]) => {
    const b = new (a.constructor as new (n: number) => typeof a)(cap);
    b.set(a);
    return [k, b];
  })) as typeof u;
  u = next;
};
const push = (second: number, kind: number, addr: number, len: number, originAs: number, peer: number, pathLen: number): void => {
  if (rows === cap) grow();
  u.second[rows] = second;
  u.kind[rows] = kind;
  u.prefix_addr[rows] = addr;
  u.prefix_len[rows] = len;
  u.origin_as[rows] = originAs;
  u.peer_as[rows] = peer;
  u.path_len[rows] = Math.min(255, pathLen);
  u.cc[rows] = ccOf(originAs);
  rows++;
};

function observeUpdate(second: number, originAs: number, peer: number, addr: number, len: number, update: { peerIp: string; nextHop: string | null; asPath: string }): void {
  // Purpose: retain the physical addresses and the advertised path that the replay columns discard
  const peerIp = ipNumber(update.peerIp);
  if (peerIp !== null) observeIp(peerIp, peer, ROLE_PEER, SOURCE_MRT_HEADER, second);
  const nextHop = ipNumber(update.nextHop);
  if (nextHop === null) return;
  let asn = peerAsByIp.get(nextHop) ?? peer;
  let source = SOURCE_NEXT_HOP_INFERRED;
  if (nextHop === peerIp) {
    asn = peer;
    source = SOURCE_MRT_HEADER;
  } else if (peerAsByIp.has(nextHop)) source = SOURCE_PEER_INDEX;
  observeIp(nextHop, asn, ROLE_NEXT_HOP, source, second);
  if (originAs > 0) observeRoute(originAs, peer, nextHop, addr, len, update.asPath, second);
}
let skipped = 0;
for (let m = 0; m < minutes; m += 5) {
  const t = new Date((start + m * 60) * 1000);
  const stamp = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1, 2)}${pad(t.getUTCDate(), 2)}.${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}`;
  const path = dataFile(`${rrc}-updates.${stamp}.gz`);
  await download(`https://data.ris.ripe.net/${rrc}/${stamp.slice(0, 4)}.${stamp.slice(4, 6)}/updates.${stamp}.gz`, path);
  const reader = new MrtReader({
    onPeers(peers) {
      for (const peer of peers) {
        const ip = ipNumber(peer.address);
        if (ip !== null) peerAsByIp.set(ip, peer.asn);
      }
    },
    onUpdate(update) {
      const second = Math.max(0, Math.min(65535, update.time - start));
      for (const p of update.withdrawn) {
        const k = key(p.addr, p.length);
        const was = origin.get(k);
        if (was === undefined) {
          skipped++;
          continue;
        }
        push(second, 1, p.addr, p.length, was, update.peerAs, 0);
      }
      if (update.originAs === null) {
        skipped += update.announced.length;
        return;
      }
      for (const p of update.announced) {
        origin.set(key(p.addr, p.length), update.originAs);
        push(second, 0, p.addr, p.length, update.originAs, update.peerAs, update.pathLength);
        observeUpdate(second, update.originAs, update.peerAs, p.addr, p.length, update);
      }
    },
  });
  for await (const chunk of createReadStream(path).pipe(createGunzip())) reader.push(chunk as Uint8Array);
  reader.finish();
  console.log(`  ${stamp}: ${rows.toLocaleString()} update rows so far`);
}
// Files are in time order and records nearly so; a stable sort by second makes the replay exact.
const order = Uint32Array.from({ length: rows }, (_, i) => i).sort((a, b) => u.second[a]! - u.second[b]! || a - b);
const sorted = Object.fromEntries(Object.entries(u).map(([k, a]) => {
  const b = new (a.constructor as new (n: number) => typeof a)(rows);
  for (let i = 0; i < rows; i++) b[i] = a[order[i]!]!;
  return [k, b];
})) as typeof u;
await writeFile(
  dataFile('globe-updates.zcl'),
  encodeColumns({ rows, columns: sorted, lists: { countries, kinds: ['announce', 'withdraw'] }, meta: { rrc, start, minutes } }),
);
console.log(`wrote globe-updates.zcl: ${rows.toLocaleString()} rows over ${minutes} minutes (${skipped.toLocaleString()} skipped: withdrawals of unknown prefixes, AS_SET origins)`);

const ipRows = [...ipObservations.values()].sort((a, b) => a.ip - b.ip);
const ipCount = ipRows.length;
const ipColumns = {
  ip: new Uint32Array(ipCount),
  asn: new Uint32Array(ipCount),
  roleMask: new Uint8Array(ipCount),
  source: new Uint8Array(ipCount),
  precision: new Uint8Array(ipCount),
  lon: new Float32Array(ipCount),
  lat: new Float32Array(ipCount),
  count: new Uint32Array(ipCount),
  first: new Uint32Array(ipCount),
  last: new Uint32Array(ipCount),
};
ipRows.forEach((row, i) => {
  ipColumns.ip[i] = row.ip;
  ipColumns.asn[i] = row.asn;
  ipColumns.roleMask[i] = row.roleMask;
  ipColumns.source[i] = row.source;
  ipColumns.precision[i] = row.precision;
  ipColumns.lon[i] = row.lon;
  ipColumns.lat[i] = row.lat;
  ipColumns.count[i] = row.count;
  ipColumns.first[i] = row.first;
  ipColumns.last[i] = row.last;
});
await writeFile(
  dataFile('globe-ips.zcl'),
  encodeColumns({
    rows: ipCount,
    columns: ipColumns,
    lists: { roles: ['peer', 'next-hop'], sources: ['mrt header', 'RIS peer index', 'inferred from peer AS'], precisions: ['unknown', 'network country', 'network facility'] },
    meta: { rrc, start, minutes, source: 'RIS MRT BGP4MP peer, local and NEXT_HOP addresses' },
  }),
);
console.log(`wrote globe-ips.zcl: ${ipCount.toLocaleString()} observed BGP-speaking IPs`);

const routeRows = [...routeObservations.values()].sort((a, b) => a.originAs - b.originAs || a.nextHop - b.nextHop || a.addr - b.addr || a.len - b.len);
const routeCount = routeRows.length;
const ipRouteColumns = {
  origin_as: new Uint32Array(routeCount),
  peer_as: new Uint32Array(routeCount),
  next_hop: new Uint32Array(routeCount),
  prefix_addr: new Uint32Array(routeCount),
  prefix_len: new Uint8Array(routeCount),
  pathCode: new Uint32Array(routeCount),
  count: new Uint32Array(routeCount),
  first: new Uint32Array(routeCount),
  last: new Uint32Array(routeCount),
};
routeRows.forEach((row, i) => {
  ipRouteColumns.origin_as[i] = row.originAs;
  ipRouteColumns.peer_as[i] = row.peerAs;
  ipRouteColumns.next_hop[i] = row.nextHop;
  ipRouteColumns.prefix_addr[i] = row.addr;
  ipRouteColumns.prefix_len[i] = row.len;
  ipRouteColumns.pathCode[i] = pathCodes.get(row.path)!;
  ipRouteColumns.count[i] = row.count;
  ipRouteColumns.first[i] = row.first;
  ipRouteColumns.last[i] = row.last;
});
await writeFile(
  dataFile('globe-ip-routes.zcl'),
  encodeColumns({
    rows: routeCount,
    columns: ipRouteColumns,
    lists: { paths },
    meta: { rrc, start, minutes, source: 'RIS MRT BGP4MP announcements grouped by path and next hop' },
  }),
);
console.log(`wrote globe-ip-routes.zcl: ${routeCount.toLocaleString()} observed advertised paths`);
