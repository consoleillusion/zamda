// Builds the reference dataset (docs/ROADMAP.md, "Reference dashboard"): one
// IPv4 route per prefix from a RIPE RIS routing table dump, labelled with each
// origin network's name and regional registry, written to data/routes.bin, plus
// the AS-adjacency graph derived from the same dump in data/graph.bin.
//
//   bun run prep-bgp                         latest full day: yesterday 00:00 UTC, collector rrc00
//   bun run prep-bgp --date 20261101         a given day
//   bun run prep-bgp --rrc rrc01 --time 0800 another collector and dump time (0000, 0800, 1600)
//   bun run prep-bgp --mrt dump.gz --names asn.txt --stats nro-delegated-stats --countries countries.json
//                     --facilities facilities.json --netfac netfac.json
//                                            local files instead of downloads
//   bun run prep-bgp --graph-out data/x.bin  write the graph somewhere else
//
// A downloaded dump is kept as data/<rrc>-bview.<date>.<time>.gz and reused on the next run.
//
// Nothing is redistributed with zamda: the data comes from RIPE NCC each time.

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { encodeRoutes } from './bgp/file';
import { GraphBuilder } from './bgp/graph';
import { encodeGraph } from './bgp/graph-file';
import type { NodePoint } from './bgp/graph-file';
import { MrtReader } from './bgp/mrt';
import { parseFacilities, parseNetFacilities } from './bgp/peeringdb';
import { parseAsCountries, parseAsNames, parseCountryCentres, parseRirRanges, rirLookup } from './bgp/registry';
import { RouteBuilder } from './bgp/routes';

const ASN_NAMES_URL = 'https://ftp.ripe.net/ripe/asnames/asn.txt';
const NRO_STATS_URL = 'https://ftp.ripe.net/pub/stats/ripencc/nro-stats/latest/nro-delegated-stats';
const COUNTRIES_URL =
  'https://raw.githubusercontent.com/mledoze/countries/5d15c0ff8c87ef2f1f8e944093522d4b2de2dd5b/countries.json';
const FACILITIES_URL = 'https://www.peeringdb.com/api/fac?fields=id,latitude,longitude,status&limit=0&sourceapp=zamda-demo';
const NETFAC_URL = 'https://www.peeringdb.com/api/netfac?fields=local_asn,fac_id,status&limit=0&sourceapp=zamda-demo';

export interface Options {
  rrc: string;
  date: string;
  time: string;
  mrt: string | null;
  names: string | null;
  stats: string | null;
  countries: string | null;
  facilities: string | null;
  netfac: string | null;
  out: string;
  graphOut: string;
}

function yesterday(): string {
  // Purpose: yesterday's date in UTC as YYYYMMDD; today's dumps may not be published yet
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

export function parseArgs(argv: readonly string[]): Options {
  // Purpose: read the command-line options, rejecting anything unknown
  const options: Options = {
    rrc: 'rrc00',
    date: yesterday(),
    time: '0000',
    mrt: null,
    names: null,
    stats: null,
    countries: null,
    facilities: null,
    netfac: null,
    out: 'data/routes.bin',
    graphOut: 'data/graph.bin',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--rrc') options.rrc = value;
    else if (flag === '--date') options.date = value;
    else if (flag === '--time') options.time = value;
    else if (flag === '--mrt') options.mrt = value;
    else if (flag === '--names') options.names = value;
    else if (flag === '--stats') options.stats = value;
    else if (flag === '--countries') options.countries = value;
    else if (flag === '--facilities') options.facilities = value;
    else if (flag === '--netfac') options.netfac = value;
    else if (flag === '--out') options.out = value;
    else if (flag === '--graph-out') options.graphOut = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!/^\d{8}$/.test(options.date)) throw new Error(`--date must be YYYYMMDD, got ${options.date}`);
  if (!/^(0000|0800|1600)$/.test(options.time)) throw new Error('--time must be 0000, 0800 or 1600');
  if (!/^rrc\d\d$/.test(options.rrc)) throw new Error(`--rrc must look like rrc00, got ${options.rrc}`);
  return options;
}

export function dumpUrl(rrc: string, date: string, time: string): string {
  // Purpose: the RIS URL of one full routing table dump (a "bview")
  return `https://data.ris.ripe.net/${rrc}/${date.slice(0, 4)}.${date.slice(4, 6)}/bview.${date}.${time}.gz`;
}

async function fetchOk(url: string): Promise<Response> {
  // Purpose: fetch a URL, failing with a clear message on an HTTP error
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function text(path: string | null, url: string): Promise<string> {
  // Purpose: a registry file's text, from a local path or downloaded
  if (path) return await Bun.file(path).text();
  console.log(`downloading ${url}`);
  return await (await fetchOk(url)).text();
}

export function cachePath(options: Options): string {
  // Purpose: where a downloaded dump is kept, next to the output file
  return `${dirname(options.out)}/${options.rrc}-bview.${options.date}.${options.time}.gz`;
}

async function* dumpBytes(options: Options): AsyncGenerator<Uint8Array> {
  // Purpose: the decompressed bytes of the MRT dump, from a local file, the download cache, or RIS.
  // A download is saved to the cache as it streams, and kept only if it completes.
  let compressed: Readable;
  let gzip = true;
  let saving: { part: string; done: Promise<void> } | null = null;
  const cached = cachePath(options);
  if (options.mrt) {
    compressed = createReadStream(options.mrt);
    gzip = options.mrt.endsWith('.gz');
  } else if (existsSync(cached)) {
    console.log(`using ${cached} (delete it to download again)`);
    compressed = createReadStream(cached);
  } else {
    const url = dumpUrl(options.rrc, options.date, options.time);
    console.log(`downloading ${url}, saving to ${cached}`);
    const response = await fetchOk(url);
    compressed = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    await mkdir(dirname(cached), { recursive: true });
    const part = `${cached}.part`;
    const file = createWriteStream(part);
    compressed.pipe(file);
    saving = {
      part,
      done: new Promise(function (resolve, reject) {
        // Purpose: settle when the saved copy is fully written
        file.on('finish', resolve);
        file.on('error', reject);
      }),
    };
  }
  const stream = gzip ? compressed.pipe(createGunzip()) : compressed;
  for await (const chunk of stream) yield chunk as Uint8Array;
  if (saving) {
    await saving.done;
    await rename(saving.part, cached);
  }
}

export async function prepare(options: Options): Promise<void> {
  // Purpose: read the dump and registry files, build one route and one graph per prefix, and write both files
  const started = performance.now();
  const [namesText, statsText, countriesText, facilitiesText, netfacText] = await Promise.all([
    text(options.names, ASN_NAMES_URL),
    text(options.stats, NRO_STATS_URL),
    text(options.countries, COUNTRIES_URL),
    text(options.facilities, FACILITIES_URL),
    text(options.netfac, NETFAC_URL),
  ]);
  const names = parseAsNames(namesText);
  const countries = parseAsCountries(namesText);
  const centres = parseCountryCentres(countriesText);
  const facilities = parseFacilities(facilitiesText);
  const peering = parseNetFacilities(netfacText, facilities);
  const rir = rirLookup(parseRirRanges(statsText));
  const labels = {
    asName: function (asn: number): string | null {
      // Purpose: the network's name, if asn.txt has it
      return names.get(asn) ?? null;
    },
    country: function (asn: number): string | null {
      // Purpose: the registered country, if asn.txt has it
      return countries.get(asn) ?? null;
    },
    location: function (asn: number): NodePoint | null {
      // Purpose: a PeeringDB facility centroid, then the registered country's centre
      const found = peering.get(asn);
      if (found) return { lat: found.lat, lon: found.lon, precision: 2 };
      const country = countries.get(asn);
      const centre = country === undefined ? undefined : centres.get(country);
      return centre ? { lat: centre.lat, lon: centre.lon, precision: 1 } : null;
    },
    rir,
  };

  const builder = new RouteBuilder();
  const graphBuilder = new GraphBuilder();
  let peers = 0;
  const malformedSamples: string[] = [];
  const reader = new MrtReader({
    onMalformedEntry(entry) {
      // Purpose: keep the first few skipped entries, with their raw bytes, for the report
      if (malformedSamples.length < 3) {
        malformedSamples.push(
          `    ${entry.prefix} from peer ${entry.peerIndex} (record at byte ${entry.recordOffset}): ${entry.reason}\n` +
            `      attributes: ${entry.attributesHex}`,
        );
      }
    },
    onPeers(list) {
      // Purpose: note how many peers the collector has
      peers = list.length;
    },
    onRib(record) {
      // Purpose: add each IPv4 prefix's chosen route
      builder.add(record);
    },
    onRibPaths(record) {
      // Purpose: add the same prefix's chosen path to the AS graph
      graphBuilder.add(record);
    },
  });
  let bytes = 0;
  let nextReport = 256 << 20;
  for await (const chunk of dumpBytes(options)) {
    reader.push(chunk);
    bytes += chunk.length;
    if (bytes >= nextReport) {
      console.log(`  ${(bytes / 2 ** 20).toFixed(0)} MB read, ${builder.stats.prefixesSeen.toLocaleString()} prefixes`);
      nextReport += 256 << 20;
    }
  }
  reader.finish();

  const routes = builder.finish();
  const graph = graphBuilder.finish();
  let peeringNodes = 0;
  let countryNodes = 0;
  let unmappedNodes = 0;
  for (let i = 0; i < graph.nodes.rowCount; i++) {
    const point = labels.location(graph.nodes.asn[i]!);
    if (point === null) unmappedNodes++;
    else if (point.precision === 2) peeringNodes++;
    else countryNodes++;
  }
  const source = {
    collector: options.mrt ? 'local file' : options.rrc,
    dump: options.mrt ?? dumpUrl(options.rrc, options.date, options.time),
    peers,
    generated: new Date().toISOString(),
  };
  const file = encodeRoutes(routes, labels, source);
  const graphFile = encodeGraph(graph, labels, centres, {
    ...source,
    layout: 'peeringdb-facility-v1',
    span: 'mapped-point-haversine-v1',
    locations: `peeringdb facility points for ${peeringNodes.toLocaleString()} ${peeringNodes === 1 ? 'AS' : 'ASes'}, ${countryNodes.toLocaleString()} at country centres, ${unmappedNodes.toLocaleString()} unmapped`,
    facilities: FACILITIES_URL,
    netfac: NETFAC_URL,
    centres: COUNTRIES_URL,
  });
  const directory = dirname(options.out);
  await mkdir(directory, { recursive: true });
  await writeFile(options.out, file);
  const graphDirectory = dirname(options.graphOut);
  if (graphDirectory !== directory) await mkdir(graphDirectory, { recursive: true });
  await writeFile(options.graphOut, graphFile);

  const s = builder.stats;
  const g = graphBuilder.stats;
  console.log(`wrote ${options.out}: ${routes.rowCount.toLocaleString()} routes, ${(file.length / 2 ** 20).toFixed(1)} MB`);
  console.log(
    `wrote ${options.graphOut}: ${graph.nodes.rowCount.toLocaleString()} ASes, ` +
      `${graph.edges.rowCount.toLocaleString()} directed edges, ${(graphFile.length / 2 ** 20).toFixed(1)} MB`,
  );
  console.log(`  ${s.prefixesSeen.toLocaleString()} IPv4 prefixes from ${peers} peers`);
  console.log(`  ${s.skippedNoOrigin.toLocaleString()} skipped: no single origin AS (empty path or AS_SET)`);
  console.log(`  ${g.routesWithoutEdges.toLocaleString()} chosen routes with no AS adjacency after prepends were collapsed`);
  if (reader.malformedEntryCount > 0) {
    console.log(`  ${reader.malformedEntryCount.toLocaleString()} peer entries skipped: path attributes could not be decoded. First ones:`);
    for (const sample of malformedSamples) console.log(sample);
  }
  if (s.pathsClamped) console.log(`  ${s.pathsClamped} path lengths over 255 stored as 255`);
  console.log(`  ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (import.meta.main) {
  try {
    await prepare(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`prep-bgp: ${(error as Error).message}`);
    console.error('If downloads are blocked, fetch the files yourself and pass --mrt, --names, --stats, --countries, --facilities and --netfac.');
    process.exit(1);
  }
}
