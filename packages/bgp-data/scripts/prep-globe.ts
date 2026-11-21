// Builds the globe demo's data from the outputs of prep-bgp plus RIS update dumps:
//
//   data/globe-as.zcl       one row per AS: asn, name, country, registry, lon/lat and how precise it is
//   data/globe-routes.zcl   the routing table at the dump's time: one route per IPv4 prefix
//   data/globe-updates.zcl  every IPv4 announcement and withdrawal seen in the next N minutes, one row per
//                           prefix, in time order: the replay
//   data/globe-ips.zcl      every BGP-speaking IP observed in those updates and in the RIS peer index,
//                           geolocated by DB-IP (operator geofeeds as fallback)
//   data/globe-ip-routes.zcl  observed announcements aggregated by origin prefix, next hop and collector,
//                           with a physical path snapped to the public cable graph where inferable
//   data/globe-as-ips.zcl   geolocated address blocks per AS, from RIB prefixes and operator geofeeds
//
//   bun run prep:globe                     60 minutes of updates after the routes dump
//   bun run prep:globe --minutes 30        fewer minutes (a smaller replay)
//
// Run `bun run prep` first (it writes routes.bin and graph.bin). Update dumps are 5-minute files
// (data.ris.ripe.net/<rrc>/<YYYY.MM>/updates.<date>.<HHMM>.gz), downloaded once into data/ and reused.
// The RIS peer index, DB-IP City Lite, geofeed, city gazetteer and cable geometry are also downloaded
// once into data/. They are enrichment inputs only: the browser reads no external service at runtime.

import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
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

// Enrichment inputs. DB-IP supplies city-level IP locations (CC BY 4.0), RIPEstat supplies the RIS
// peer addresses that are actually speaking BGP, operator geofeeds supply address-block locations,
// and the cable lines are public geometry. All are cached in data/ and never fetched by the browser.
const GEOFEED_URL = 'https://github.com/daviante-org/dgip-data/releases/latest/download/dgip-geofeed.csv.gz';
const CITIES_URL = 'https://raw.githubusercontent.com/lutangar/cities.json/master/cities.json';
const CABLES_URL = 'https://raw.githubusercontent.com/hadistlm/submarine-cable-map/master/data/cable-geo.json';
const RIS_PEERS_URL = 'https://stat.ripe.net/data/ris-peers/data.json?data_overload_limit=ignore';
const DBIP_URL = `https://download.db-ip.com/free/dbip-city-lite-${new Date().toISOString().slice(0, 7)}.csv.gz`;

const minutes = Number(flag('minutes', '60'));
if (!Number.isInteger(minutes) || minutes < 5 || minutes % 5 !== 0) throw new Error('--minutes must be a multiple of 5');

await download(RIS_PEERS_URL, dataFile('ris-peers.json'));

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
const ROLE_COLLECTOR = 4;
// Lower numbers mean a more exact attribution; a header IP beats an inferred next hop.
const SOURCE_MRT_HEADER = 0;
const SOURCE_PEER_INDEX = 1;
const SOURCE_NEXT_HOP_INFERRED = 2;
const SOURCE_COLLECTOR = 3;
const ROUTE_SOURCE_UPDATE = 0;
const ROUTE_SOURCE_RIB = 1;

function ipNumber(text: string | null | undefined): number | null {
  // Purpose: a dotted-quad IP as an unsigned number, or null when it is not IPv4
  if (typeof text !== 'string') return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(p => Number(p));
  if (octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

// RIS peers are the BGP-speaking interfaces RIPE can actually see. They give the country focus
// real router IPs (including next hops in other countries), not just AS-centre placeholders.
const risPeersFile = JSON.parse(await readFile(dataFile('ris-peers.json'), 'utf8')) as {
  data: { peers: Record<string, { asn: string; ip: string; v4_prefix_count: number }[]> };
};
const peerIpsByAsn = new Map<number, number[]>();
const risPeerRows: { asn: number; ip: number }[] = [];
for (const peers of Object.values(risPeersFile.data.peers)) {
  for (const peer of peers) {
    const ip = ipNumber(peer.ip);
    const asn = Number(peer.asn);
    if (ip === null || !Number.isInteger(asn) || asn === 0 || Number(peer.v4_prefix_count) === 0) continue;
    risPeerRows.push({ asn, ip });
    let list = peerIpsByAsn.get(asn);
    if (list === undefined) peerIpsByAsn.set(asn, list = []);
    if (!list.includes(ip)) list.push(ip);
  }
}
console.log(`RIS peers: ${risPeerRows.length} IPv4 addresses in ${peerIpsByAsn.size} ASes`);

interface GeoPoint {
  readonly lon: number;
  readonly lat: number;
  readonly city: string;
  readonly country: string;
}

await download(GEOFEED_URL, dataFile('geofeed.csv.gz'));
await download(CITIES_URL, dataFile('cities.json'));
await download(CABLES_URL, dataFile('cables.geojson'));
await download(DBIP_URL, dataFile('dbip-city.csv.gz'));

// Only names the prepared files actually use go into the output; the full gazetteer is an input.
const cityList: string[] = [''];
const cityCodes = new Map<string, number>([['', 0]]);
function cityCode(name: string): number {
  // Purpose: intern one location name into the small string list written with the columns
  if (name === '') return 0;
  let code = cityCodes.get(name);
  if (code === undefined) {
    code = cityList.length;
    cityList.push(name);
    cityCodes.set(name, code);
  }
  return code;
}

// City names from the geofeed become coordinates through a small GeoNames-derived gazetteer.
const cityPoints = new Map<string, GeoPoint>();
const gazetteer = JSON.parse(await readFile(dataFile('cities.json'), 'utf8')) as { name: string; lat: string; lng: string; country: string }[];
for (const city of gazetteer) {
  const key = `${city.country}|${city.name.toLowerCase()}`;
  if (cityPoints.has(key)) continue;
  cityPoints.set(key, { lon: Number(city.lng), lat: Number(city.lat), city: city.name, country: city.country });
}

// Geofeed prefixes by length: looking up one address is at most 25 map probes.
const geofeeds = new Map<number, Map<number, GeoPoint>>();
const geofeedCsv = gunzipSync(await readFile(dataFile('geofeed.csv.gz'))).toString('utf8');
for (const line of geofeedCsv.split('\n').slice(1)) {
  const [prefix, country, , city] = line.split(',');
  if (prefix === undefined || city === undefined || city === '' || !prefix.includes('.')) continue;
  const point = cityPoints.get(`${country}|${city.toLowerCase()}`);
  if (point === undefined) continue;
  const [address, lengthText] = prefix.split('/');
  const base = ipNumber(address);
  const length = Number(lengthText);
  if (base === null || !Number.isInteger(length) || length < 8 || length > 32) continue;
  let byLength = geofeeds.get(length);
  if (byLength === undefined) geofeeds.set(length, byLength = new Map());
  byLength.set(base, point);
}
function locateGeofeed(address: number): GeoPoint | null {
  // Purpose: the most specific operator-published location for one IP
  for (let length = 32; length >= 8; length--) {
    const byLength = geofeeds.get(length);
    if (byLength === undefined) continue;
    const mask = length === 32 ? 0xffffffff : (0xffffffff << (32 - length)) >>> 0;
    const point = byLength.get((address & mask) >>> 0);
    if (point !== undefined) return point;
  }
  return null;
}

// DB-IP City Lite is sorted by first address, so the ranges can be binary-searched without sorting
// 7.7 million records. It is read as a stream: the decompressed CSV is hundreds of megabytes.
const countryCodeOf = new Map(countries.map((code, i) => [code, i]));
let dbCap = 1 << 20;
let dbStart = new Uint32Array(dbCap);
let dbEnd = new Uint32Array(dbCap);
let dbLat = new Float32Array(dbCap);
let dbLon = new Float32Array(dbCap);
let dbCity = new Uint32Array(dbCap);
let dbCountry = new Uint8Array(dbCap);
let dbRows = 0;
function growDb(): void {
  // Purpose: double the DB-IP range arrays while streaming the CSV
  dbCap *= 2;
  const next = {
    start: new Uint32Array(dbCap), end: new Uint32Array(dbCap),
    lat: new Float32Array(dbCap), lon: new Float32Array(dbCap),
    city: new Uint32Array(dbCap), country: new Uint8Array(dbCap),
  };
  next.start.set(dbStart);
  next.end.set(dbEnd);
  next.lat.set(dbLat);
  next.lon.set(dbLon);
  next.city.set(dbCity);
  next.country.set(dbCountry);
  ({ start: dbStart, end: dbEnd, lat: dbLat, lon: dbLon, city: dbCity, country: dbCountry } = next);
}
function csvFields(line: string): string[] {
  // Purpose: split one CSV row, honouring quoted city names that contain commas
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}
function addDbRow(line: string): void {
  // Purpose: keep one usable DB-IP address range for later binary search
  const f = csvFields(line);
  if (f.length < 8) return;
  const start = ipNumber(f[0]!);
  const end = ipNumber(f[1]!);
  const country = f[3]!;
  const lat = Number(f[6]);
  const lon = Number(f[7]);
  if (start === null || end === null || country === 'ZZ' || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (lat === 0 && lon === 0) return;
  if (dbRows > 0 && start < dbStart[dbRows - 1]!) throw new Error('DB-IP ranges are not sorted');
  if (dbRows === dbCap) growDb();
  dbStart[dbRows] = start;
  dbEnd[dbRows] = end;
  dbLat[dbRows] = lat;
  dbLon[dbRows] = lon;
  dbCity[dbRows] = cityCode(f[5] ?? '');
  dbCountry[dbRows] = countryCodeOf.get(country) ?? NONE;
  dbRows++;
}
const decoder = new TextDecoder();
let pending = '';
for await (const chunk of createReadStream(dataFile('dbip-city.csv.gz')).pipe(createGunzip())) {
  pending += decoder.decode(chunk as Uint8Array, { stream: true });
  let lineEnd = pending.indexOf('\n');
  while (lineEnd !== -1) {
    const line = pending.slice(0, lineEnd).replace(/\r$/, '');
    pending = pending.slice(lineEnd + 1);
    if (line.length > 0) addDbRow(line);
    lineEnd = pending.indexOf('\n');
  }
}
pending += decoder.decode();
if (pending.length > 0) addDbRow(pending.replace(/\r$/, ''));
function locateDbip(address: number): GeoPoint | null {
  // Purpose: the DB-IP city and country for one IPv4 address
  let low = 0;
  let high = dbRows - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (dbStart[mid]! <= address) { found = mid; low = mid + 1; }
    else high = mid - 1;
  }
  if (found === -1 || address > dbEnd[found]!) return null;
  return {
    lon: dbLon[found]!,
    lat: dbLat[found]!,
    city: cityList[dbCity[found]!] ?? '',
    country: countries[dbCountry[found]!] ?? '',
  };
}
console.log(`geolocation: ${dbRows.toLocaleString()} DB-IP ranges, ${cityList.length.toLocaleString()} cities, ${[...geofeeds.values()].reduce((sum, m) => sum + m.size, 0).toLocaleString()} geofeed prefixes`);

interface IpObservation {
  ip: number;
  asn: number;
  roleMask: number;
  source: number;
  precision: number;
  city: string;
  country: string;
  lon: number;
  lat: number;
  count: number;
  first: number;
  last: number;
}

interface RouteObservation {
  originAs: number;
  peerAs: number;
  peerIp: number;
  localIp: number;
  nextHop: number;
  // 0 = an UPDATE header really carried this hop; 1 = a RIB prefix with the AS's RIS peer as next hop.
  source: number;
  // The distinct prefixes seen on one observed next hop, and one representative AS path for the tooltip.
  prefixKeys: Set<string>;
  path: string;
  count: number;
  first: number;
  last: number;
}

const ipObservations = new Map<number, IpObservation>();
const routeObservations = new Map<string, RouteObservation>();
const peerAsByIp = new Map<number, number>();

function asnPosition(asn: number): { lon: number; lat: number; precision: number } {
  // Purpose: the prepared display position of an AS, used until interface-level geolocation is available
  const i = asIndex.get(asn);
  if (i === undefined) return { lon: 0, lat: 0, precision: 0 };
  return { lon: as.lon[i]!, lat: as.lat[i]!, precision: as.precision[i]! };
}

function observeIp(ip: number, asn: number, role: number, source: number, second: number, override?: { lon: number; lat: number; precision: number }): void {
  // Purpose: merge every sighting of one IP into a single point with roles, attribution and a time range
  const locate = (): { lon: number; lat: number; precision: number } => override ?? asnPosition(asn);
  let row = ipObservations.get(ip);
  if (row === undefined) {
    const at = locate();
    row = { ip, asn, roleMask: 0, source, precision: at.precision, lon: at.lon, lat: at.lat, city: '', country: '', count: 0, first: second, last: second };
    ipObservations.set(ip, row);
  }
  if (source < row.source) {
    row.source = source;
    row.asn = asn;
    const at = locate();
    row.precision = at.precision;
    row.lon = at.lon;
    row.lat = at.lat;
  }
  row.roleMask |= role;
  row.count++;
  row.first = Math.min(row.first, second);
  row.last = Math.max(row.last, second);
}

function observeRoute(originAs: number, peerAs: number, peerIp: number, localIp: number, nextHop: number, addr: number, len: number, path: string, second: number, source = ROUTE_SOURCE_UPDATE): void {
  // Purpose: merge announcements sharing an observed next hop into one row; the map draws one line per hop pair
  const key = `${originAs}|${peerAs}|${peerIp}|${localIp}|${nextHop}`;
  let row = routeObservations.get(key);
  if (row === undefined) {
    row = { originAs, peerAs, peerIp, localIp, nextHop, source, prefixKeys: new Set(), path, count: 0, first: second, last: second };
    routeObservations.set(key, row);
  }
  if (source < row.source) row.source = source;
  row.prefixKeys.add(`${addr}/${len}`);
  row.count++;
  row.first = Math.min(row.first, second);
  row.last = Math.max(row.last, second);
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
const originAtDump = new Map<number, number>();
for (let i = 0; i < r; i++) {
  routeCols.cc[i] = ccOf(routes.origin_as[i]!);
  const region = routes.rir[i];
  routeCols.rir[i] = region === null ? NONE : Math.max(0, rirs.indexOf(region === 'RIPE' ? 'RIPE NCC' : region));
  originAtDump.set(routes.prefix_addr[i]! * 64 + routes.prefix_len[i]!, routes.origin_as[i]!);
}
// The dump's collector and time come from its URL (…/rrc00/2026.11/bview.20261119.0000.gz).
const dumpMatch = /\/(rrc\d\d)\/\d{4}\.\d{2}\/bview\.(\d{8})\.(\d{4})\.gz$/.exec(source.dump ?? '');
if (dumpMatch === null) throw new Error(`routes.bin does not name a RIS dump (${String(source.dump)}); run prep-bgp without --mrt`);
const [, rrc, date, time] = dumpMatch as unknown as [string, string, string, string];
// RIS collector cities, used only for the collector-side IP in the MRT header. Country-level at best.
const collectorCities: Readonly<Record<string, { lon: number; lat: number }>> = {
  rrc00: { lon: 4.9, lat: 52.37 }, rrc01: { lon: -0.12, lat: 51.5 }, rrc02: { lon: 2.35, lat: 48.86 },
  rrc03: { lon: 4.9, lat: 52.37 }, rrc04: { lon: 6.14, lat: 46.2 }, rrc05: { lon: 16.37, lat: 48.21 },
  rrc06: { lon: 139.69, lat: 35.69 }, rrc07: { lon: 18.07, lat: 59.33 }, rrc08: { lon: 139.69, lat: 35.69 },
  rrc09: { lon: 8.68, lat: 50.11 }, rrc10: { lon: 9.19, lat: 45.46 }, rrc11: { lon: -74.01, lat: 40.71 },
  rrc12: { lon: -80.19, lat: 25.76 }, rrc13: { lon: 28.05, lat: -26.2 }, rrc14: { lon: -122.03, lat: 37.39 },
  rrc15: { lon: 151.21, lat: -33.87 }, rrc16: { lon: 174.76, lat: -36.85 }, rrc17: { lon: 126.98, lat: 37.57 },
  rrc18: { lon: -46.63, lat: -23.55 }, rrc19: { lon: 73.86, lat: 18.52 }, rrc20: { lon: 37.62, lat: 55.75 },
  rrc21: { lon: 15.98, lat: 45.81 }, rrc22: { lon: 26.1, lat: 44.43 }, rrc23: { lon: 103.82, lat: 1.35 },
  rrc24: { lon: 153.03, lat: -27.47 }, rrc25: { lon: -43.17, lat: -22.91 }, rrc26: { lon: -99.13, lat: 19.43 },
};
function collectorLocation(): { lon: number; lat: number; precision: number } {
  // Purpose: a coarse location for the collector-side IP named in the MRT header
  const city = collectorCities[rrc];
  return city === undefined ? { lon: 0, lat: 0, precision: 0 } : { lon: city.lon, lat: city.lat, precision: 1 };
}
for (const peer of risPeerRows) observeIp(peer.ip, peer.asn, ROLE_PEER, SOURCE_PEER_INDEX, 0);
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

function observeUpdate(second: number, originAs: number, peer: number, addr: number, len: number, update: { peerIp: string; localIp: string; nextHop: string | null; asPath: string }): void {
  // Purpose: retain the physical addresses and the advertised path that the replay columns discard
  const peerIp = ipNumber(update.peerIp);
  const localIp = ipNumber(update.localIp);
  if (peerIp !== null) observeIp(peerIp, peer, ROLE_PEER, SOURCE_MRT_HEADER, second);
  if (localIp !== null) observeIp(localIp, 0, ROLE_COLLECTOR, SOURCE_COLLECTOR, second, collectorLocation());
  const nextHop = ipNumber(update.nextHop);
  if (nextHop === null) return;
  let asn = peerAsByIp.get(nextHop) ?? peer;
  let source = SOURCE_NEXT_HOP_INFERRED;
  if (nextHop === peerIp) {
    asn = peer;
    source = SOURCE_MRT_HEADER;
  } else if (peerAsByIp.has(nextHop)) source = SOURCE_PEER_INDEX;
  observeIp(nextHop, asn, ROLE_NEXT_HOP, source, second);
  if (originAs > 0 && peerIp !== null && localIp !== null) observeRoute(originAs, peer, peerIp, localIp, nextHop, addr, len, update.asPath, second);
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

// Replace AS-centre placeholders with the real geolocation of each BGP-speaking interface. The
// collector address keeps its known RIS city: DB-IP locates networks, not collector machines.
let geolocatedIps = 0;
for (const row of ipObservations.values()) {
  if (row.source === SOURCE_COLLECTOR) continue;
  const at = locateDbip(row.ip) ?? locateGeofeed(row.ip);
  if (at === null) continue;
  row.lon = at.lon;
  row.lat = at.lat;
  row.precision = at.city === '' ? 1 : 3;
  row.city = at.city;
  row.country = at.country;
  geolocatedIps++;
}
console.log(`geolocated ${geolocatedIps} of ${ipObservations.size} observed IPs from DB-IP / geofeeds`);

const ipRows = [...ipObservations.values()].sort((a, b) => a.ip - b.ip);
const ipCount = ipRows.length;
const ipColumns = {
  ip: new Uint32Array(ipCount),
  asn: new Uint32Array(ipCount),
  roleMask: new Uint8Array(ipCount),
  source: new Uint8Array(ipCount),
  cityCode: new Uint32Array(ipCount),
  countryCode: new Uint8Array(ipCount),
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
  ipColumns.cityCode[i] = cityCode(row.city);
  ipColumns.countryCode[i] = countryCodeOf.get(row.country) ?? NONE;
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
    lists: { roles: ['peer', 'next-hop', 'collector'], sources: ['mrt header', 'RIS peer index', 'inferred from peer AS', 'RIS collector city'], cities: cityList, countries, precisions: ['unknown', 'network country', 'network facility', 'city'] },
    meta: { rrc, start, minutes, source: 'RIS MRT BGP4MP headers, RIS peers and NEXT_HOP addresses; city locations by DB-IP (CC BY 4.0) and operator geofeeds' },
  }),
);
console.log(`wrote globe-ips.zcl: ${ipCount.toLocaleString()} observed BGP-speaking IPs`);

// The AS's own address space: geolocated RIB prefixes and operator geofeeds. These are the circles
// shown for a selected country or AS, not just addresses that happened to appear in one UPDATE.
interface AsIpPoint {
  readonly asn: number;
  readonly addr: number;
  readonly len: number;
  readonly lon: number;
  readonly lat: number;
  readonly city: string;
  readonly country: string;
  count: number;
}
const asIpMap = new Map<string, AsIpPoint>();
function addAsIp(asn: number, addr: number, len: number, at: GeoPoint): void {
  // Purpose: aggregate one AS's prefixes at one location so country focus stays renderable
  const key = `${asn}|${at.country}|${at.city}`;
  const existing = asIpMap.get(key);
  if (existing !== undefined) { existing.count++; return; }
  asIpMap.set(key, { asn, addr, len, lon: at.lon, lat: at.lat, city: at.city, country: at.country, count: 1 });
}
for (const [length, byLength] of geofeeds) {
  for (const [base, point] of byLength) {
    const asn = originAtDump.get(base * 64 + length);
    if (asn !== undefined) addAsIp(asn, base, length, point);
  }
}
let locatedPrefixes = 0;
for (let i = 0; i < r; i++) {
  const asn = routes.origin_as[i]!;
  if (asn === 0) continue;
  const at = locateDbip(routes.prefix_addr[i]!) ?? locateGeofeed(routes.prefix_addr[i]!);
  if (at === null) continue;
  locatedPrefixes++;
  addAsIp(asn, routes.prefix_addr[i]!, routes.prefix_len[i]!, at);
}
console.log(`located ${locatedPrefixes.toLocaleString()} RIB prefixes for AS address points`);
const asIpPoints = [...asIpMap.values()].sort((a, b) => a.asn - b.asn || a.addr - b.addr);
const asIpColumns = {
  asn: new Uint32Array(asIpPoints.length),
  addr: new Uint32Array(asIpPoints.length),
  len: new Uint8Array(asIpPoints.length),
  lon: new Float32Array(asIpPoints.length),
  lat: new Float32Array(asIpPoints.length),
  cityCode: new Uint32Array(asIpPoints.length),
  countryCode: new Uint8Array(asIpPoints.length),
  count: new Uint32Array(asIpPoints.length),
};
asIpPoints.forEach((point, i) => {
  asIpColumns.asn[i] = point.asn;
  asIpColumns.addr[i] = point.addr;
  asIpColumns.len[i] = point.len;
  asIpColumns.lon[i] = point.lon;
  asIpColumns.lat[i] = point.lat;
  asIpColumns.cityCode[i] = cityCode(point.city);
  asIpColumns.countryCode[i] = countryCodeOf.get(point.country) ?? NONE;
  asIpColumns.count[i] = point.count;
});
await writeFile(
  dataFile('globe-as-ips.zcl'),
  encodeColumns({
    rows: asIpPoints.length,
    columns: asIpColumns,
    lists: { cities: cityList, countries },
    meta: { rrc, start, minutes, source: 'RIB prefixes and DGIP geofeeds geolocated by DB-IP (CC BY 4.0), grouped per AS and city' },
  }),
);
console.log(`wrote globe-as-ips.zcl: ${asIpPoints.length.toLocaleString()} geolocated address blocks for ${new Set(asIpPoints.map(p => p.asn)).size.toLocaleString()} ASes`);

// A physical route is inferred, never observed: connect the two geolocated IP endpoints to the
// nearest public cable landing and run the shortest path over the cable graph. This single path is
// the legacy field in the table; the app now derives every candidate path for each adjacent AS hop
// from the same local cable geometry, so no runtime tile or routing service is needed.
interface CableNode { readonly lon: number; readonly lat: number; readonly edges: { to: number; weight: number }[] }
const cableGeo = JSON.parse(await readFile(dataFile('cables.geojson'), 'utf8')) as { features: { geometry: { coordinates: number[][][] } }[] };
const cableNodes: CableNode[] = [];
const cableIndex = new Map<string, number>();
function cableNode(lon: number, lat: number): number {
  const key = `${lon.toFixed(3)}|${lat.toFixed(3)}`;
  let at = cableIndex.get(key);
  if (at === undefined) {
    at = cableNodes.length;
    cableIndex.set(key, at);
    cableNodes.push({ lon, lat, edges: [] });
  }
  return at;
}
function distanceKm(a: CableNode | GeoPoint, b: CableNode | GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
}
function linkCables(a: number, b: number): void {
  if (a === b) return;
  const weight = distanceKm(cableNodes[a]!, cableNodes[b]!);
  cableNodes[a]!.edges.push({ to: b, weight });
  cableNodes[b]!.edges.push({ to: a, weight });
}
for (const feature of cableGeo.features) {
  for (const line of feature.geometry.coordinates ?? []) {
    if (line.length < 2) continue;
    let previous = cableNode(line[0]![0]!, line[0]![1]!);
    for (let i = 1; i < line.length; i++) {
      const current = cableNode(line[i]![0]!, line[i]![1]!);
      linkCables(previous, current);
      previous = current;
    }
  }
}
// Separate cable lines meet at landings a few kilometres apart; join them so a path can change cable.
const cableCells = new Map<string, number[]>();
cableNodes.forEach((node, i) => {
  const cell = `${Math.floor(node.lon)},${Math.floor(node.lat)}`;
  let list = cableCells.get(cell);
  if (list === undefined) cableCells.set(cell, list = []);
  list.push(i);
});
cableNodes.forEach((node, i) => {
  const cx = Math.floor(node.lon);
  const cy = Math.floor(node.lat);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const j of cableCells.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (j > i && distanceKm(node, cableNodes[j]!) < 80) linkCables(i, j);
      }
    }
  }
});
console.log(`cable graph: ${cableNodes.length} nodes, ${cableNodes.reduce((sum, node) => sum + node.edges.length, 0) / 2 | 0} edges`);

const nearestCache = new Map<string, { node: number; km: number }>();
function nearestCable(point: GeoPoint): { node: number; km: number } {
  const key = `${point.lon.toFixed(2)}|${point.lat.toFixed(2)}`;
  const cached = nearestCache.get(key);
  if (cached !== undefined) return cached;
  let node = 0;
  let km = Infinity;
  cableNodes.forEach((candidate, i) => {
    const d = distanceKm(point, candidate);
    if (d < km) { km = d; node = i; }
  });
  const result = { node, km };
  nearestCache.set(key, result);
  return result;
}
function cablePath(from: number, to: number): number[] | null {
  // A* over the cable graph, with great-circle distance as an admissible heuristic.
  if (from === to) return [from];
  const g = new Float64Array(cableNodes.length).fill(Infinity);
  const previous = new Int32Array(cableNodes.length).fill(-1);
  const heap: { at: number; f: number }[] = [];
  const push = (at: number, f: number): void => {
    heap.push({ at, f });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.f <= heap[i]!.f) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): { at: number; f: number } | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined || heap.length === 0) return top;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < heap.length && heap[l]!.f < heap[small]!.f) small = l;
      if (r < heap.length && heap[r]!.f < heap[small]!.f) small = r;
      if (small === i) break;
      [heap[small], heap[i]] = [heap[i]!, heap[small]!];
      i = small;
    }
    return top;
  };
  g[from] = 0;
  push(from, distanceKm(cableNodes[from]!, cableNodes[to]!));
  while (heap.length > 0) {
    const current = pop()!;
    if (current.at === to) break;
    for (const edge of cableNodes[current.at]!.edges) {
      const next = g[current.at]! + edge.weight;
      if (next >= g[edge.to]!) continue;
      g[edge.to] = next;
      previous[edge.to] = current.at;
      push(edge.to, next + distanceKm(cableNodes[edge.to]!, cableNodes[to]!));
    }
  }
  if (previous[to] === -1 && from !== to) return null;
  const path: number[] = [];
  for (let at = to; at !== -1; at = previous[at]!) path.unshift(at);
  return path;
}
const ipPositions = new Map<number, GeoPoint>();
for (const row of ipObservations.values()) ipPositions.set(row.ip, { lon: row.lon, lat: row.lat, city: row.city, country: row.country });
const physicalPaths: string[] = [''];
const physicalCache = new Map<string, number>();
function physicalPathCode(source: GeoPoint, destination: GeoPoint): number {
  const a = nearestCable(source);
  const b = nearestCable(destination);
  // Only claim a physical route when both ends are plausibly on the cable network.
  if (a.km > 800 || b.km > 800) return 0;
  const cacheKey = `${a.node}|${b.node}`;
  const cached = physicalCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const nodes = cablePath(a.node, b.node);
  if (nodes === null) return 0;
  const points = [source, ...nodes.map(i => cableNodes[i]!), destination]
    .map(p => `${p.lon.toFixed(2)},${p.lat.toFixed(2)}`)
    .join(';');
  const code = physicalPaths.length;
  physicalPaths.push(points);
  physicalCache.set(cacheKey, code);
  return code;
}

// RIB prefixes give every RIS-visible AS a route even when no UPDATE for it landed in this hour.
// The next hop is the AS's own RIS peer address — inferred, not observed per prefix — and the
// collector endpoint is the local address seen in the MRT headers.
const collectorIp = [...ipObservations.values()].find(row => row.source === SOURCE_COLLECTOR)?.ip ?? 0;
let ribRoutes = 0;
if (collectorIp !== 0) {
  for (let i = 0; i < r; i++) {
    const originAs = routes.origin_as[i]!;
    const hops = peerIpsByAsn.get(originAs);
    if (originAs === 0 || hops === undefined || hops.length === 0) continue;
    const nextHop = hops[0]!;
    observeRoute(originAs, originAs, nextHop, collectorIp, nextHop, routes.prefix_addr[i]!, routes.prefix_len[i]!, '', start, ROUTE_SOURCE_RIB);
    ribRoutes++;
  }
}
console.log(`added ${ribRoutes.toLocaleString()} RIB routes for ${peerIpsByAsn.size.toLocaleString()} ASes with RIS peer addresses`);

const routeRows = [...routeObservations.values()].sort((a, b) => a.originAs - b.originAs || a.nextHop - b.nextHop);
const routeCount = routeRows.length;
// Only the representative path of each group is read back; paths seen in other announcements
// are dead weight in the file, so rebuild the list from what the final rows actually use.
const usedPaths = [...new Set(routeRows.map(row => row.path))];
const usedPathCode = new Map(usedPaths.map((path, i) => [path, i]));
function routeOrigin(row: RouteObservation): GeoPoint {
  // Purpose: the geolocated origin prefix, falling back to the AS registry position
  const key = row.prefixKeys.values().next().value as string | undefined;
  const addr = ipNumber(key?.split('/')[0]);
  const at = addr === null ? null : (locateDbip(addr) ?? locateGeofeed(addr));
  if (at !== null) return at;
  const i = asIndex.get(row.originAs);
  if (i === undefined) return { lon: 0, lat: 0, city: '', country: '' };
  return {
    lon: as.lon[i]!,
    lat: as.lat[i]!,
    city: '',
    country: as.cc[i] === NONE ? '' : (countries[as.cc[i]!] ?? ''),
  };
}
const ipRouteColumns = {
  origin_as: new Uint32Array(routeCount),
  peer_as: new Uint32Array(routeCount),
  peer_ip: new Uint32Array(routeCount),
  local_ip: new Uint32Array(routeCount),
  next_hop: new Uint32Array(routeCount),
  sourceCode: new Uint8Array(routeCount),
  prefixes: new Uint32Array(routeCount),
  pathCode: new Uint32Array(routeCount),
  physicalPathCode: new Uint32Array(routeCount),
  origin_cityCode: new Uint32Array(routeCount),
  origin_countryCode: new Uint8Array(routeCount),
  origin_lon: new Float32Array(routeCount),
  origin_lat: new Float32Array(routeCount),
  count: new Uint32Array(routeCount),
  first: new Uint32Array(routeCount),
  last: new Uint32Array(routeCount),
};
routeRows.forEach((row, i) => {
  ipRouteColumns.origin_as[i] = row.originAs;
  ipRouteColumns.peer_as[i] = row.peerAs;
  ipRouteColumns.peer_ip[i] = row.peerIp;
  ipRouteColumns.local_ip[i] = row.localIp;
  ipRouteColumns.next_hop[i] = row.nextHop;
  ipRouteColumns.sourceCode[i] = row.source;
  ipRouteColumns.prefixes[i] = row.prefixKeys.size;
  ipRouteColumns.pathCode[i] = usedPathCode.get(row.path)!;
  const origin = routeOrigin(row);
  const nextHop = locateGeofeed(row.nextHop) ?? ipPositions.get(row.nextHop);
  ipRouteColumns.physicalPathCode[i] = nextHop !== undefined ? physicalPathCode(origin, nextHop) : 0;
  ipRouteColumns.origin_cityCode[i] = cityCode(origin.city);
  ipRouteColumns.origin_countryCode[i] = countryCodeOf.get(origin.country) ?? NONE;
  ipRouteColumns.origin_lon[i] = origin.lon;
  ipRouteColumns.origin_lat[i] = origin.lat;
  ipRouteColumns.count[i] = row.count;
  ipRouteColumns.first[i] = row.first;
  ipRouteColumns.last[i] = row.last;
});
await writeFile(
  dataFile('globe-ip-routes.zcl'),
  encodeColumns({
    rows: routeCount,
    columns: ipRouteColumns,
    lists: { paths: usedPaths, physicalPaths, routeSources: ['RIS UPDATE header', 'RIB prefix with RIS peer next hop'], cities: cityList, countries },
    meta: { rrc, start, minutes, source: 'RIS MRT BGP4MP updates and RIB prefixes, aggregated by geolocated origin prefix, next hop and collector; physical paths inferred from the public cable graph' },
  }),
);
console.log(`wrote globe-ip-routes.zcl: ${routeCount.toLocaleString()} paths, ${physicalPaths.length - 1} distinct physical cable paths`);
