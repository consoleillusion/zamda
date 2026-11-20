// Builds the globe demo's data from the outputs of prep-bgp plus RIS update dumps:
//
//   data/globe-as.zcl       one row per AS: asn, name, country, registry, lon/lat and how precise it is
//   data/globe-routes.zcl   the routing table at the dump's time: one route per IPv4 prefix
//   data/globe-updates.zcl  every IPv4 announcement and withdrawal seen in the next N minutes, one row per
//                           prefix, in time order: the replay
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
let skipped = 0;
for (let m = 0; m < minutes; m += 5) {
  const t = new Date((start + m * 60) * 1000);
  const stamp = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1, 2)}${pad(t.getUTCDate(), 2)}.${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}`;
  const path = dataFile(`${rrc}-updates.${stamp}.gz`);
  await download(`https://data.ris.ripe.net/${rrc}/${stamp.slice(0, 4)}.${stamp.slice(4, 6)}/updates.${stamp}.gz`, path);
  const reader = new MrtReader({
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
