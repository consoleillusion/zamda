// Tests for the reference dataset pipeline (docs/TASKS.md, T-205), against MRT
// bytes built here by hand from RFC 6396, since the workspace that wrote these
// tests could not download a real dump.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, pipe } from '../src';
import { Routes, encodeRoutes, formatPrefix, loadRoutes } from '../scripts/bgp/file';
import type { RibGraphRecord, RibRecord } from '../scripts/bgp/mrt';
import { MrtFormatError, MrtReader } from '../scripts/bgp/mrt';
import { parseAsNames, parseRirRanges, rirLookup } from '../scripts/bgp/registry';
import { GraphBuilder } from '../scripts/bgp/graph';
import { GraphEdges, decodeGraph, encodeGraph, loadGraph } from '../scripts/bgp/graph-file';
import { RouteBuilder } from '../scripts/bgp/routes';
import { cachePath, dumpUrl, parseArgs, prepare } from '../scripts/prep-bgp';

// ---------------------------------------------------------------------------
// An MRT writer, just enough for the fixtures
// ---------------------------------------------------------------------------

class Bytes {
  private readonly out: number[] = [];

  u8(v: number): this {
    // Purpose: append one byte
    this.out.push(v & 255);
    return this;
  }

  u16(v: number): this {
    // Purpose: append a big-endian 16-bit value
    return this.u8(v >>> 8).u8(v);
  }

  u32(v: number): this {
    // Purpose: append a big-endian 32-bit value
    return this.u16(v >>> 16).u16(v & 0xffff);
  }

  raw(bytes: readonly number[] | Uint8Array): this {
    // Purpose: append bytes as they are
    for (const b of bytes) this.out.push(b);
    return this;
  }

  get length(): number {
    // Purpose: bytes written so far
    return this.out.length;
  }

  done(): Uint8Array {
    // Purpose: the bytes written
    return Uint8Array.from(this.out);
  }
}

function record(type: number, subtype: number, body: Uint8Array): Uint8Array {
  // Purpose: an MRT record: common header (timestamp, type, subtype, length) then the body
  return new Bytes().u32(1_763_337_600).u16(type).u16(subtype).u32(body.length).raw(body).done();
}

function peerIndex(peers: { v6?: boolean; as4?: boolean; asn: number }[]): Uint8Array {
  // Purpose: a TABLE_DUMP_V2 PEER_INDEX_TABLE record
  const body = new Bytes().u32(0xc0000201).u16(4).raw([...'test'].map(c => c.charCodeAt(0))).u16(peers.length);
  for (const peer of peers) {
    body.u8((peer.v6 ? 1 : 0) | (peer.as4 ? 2 : 0)).u32(0x0a000001);
    if (peer.v6) body.raw(new Array(16).fill(0x20));
    else body.raw([192, 0, 2, peers.indexOf(peer)]);
    if (peer.as4) body.u32(peer.asn);
    else body.u16(peer.asn);
  }
  return record(13, 1, body.done());
}

type Segment = [type: number, asns: number[]];

function asPath(segments: Segment[], extended = false): Uint8Array {
  // Purpose: an AS_PATH path attribute with 4-byte AS numbers
  const value = new Bytes();
  for (const [type, asns] of segments) {
    value.u8(type).u8(asns.length);
    for (const asn of asns) value.u32(asn);
  }
  const bytes = value.done();
  const attr = new Bytes().u8(extended ? 0x50 : 0x40).u8(2);
  if (extended) attr.u16(bytes.length);
  else attr.u8(bytes.length);
  return attr.raw(bytes).done();
}

const ORIGIN_IGP = [0x40, 1, 1, 0];
const SEQ = 2;
const SET = 1;
const CONFED_SEQ = 3;

function rib(
  sequence: number,
  prefix: [number, number, number, number],
  length: number,
  entries: { peer: number; attributes: Uint8Array }[],
  subtype = 2,
): Uint8Array {
  // Purpose: a TABLE_DUMP_V2 RIB_IPV4_UNICAST record (or another RIB subtype, for skipping)
  const body = new Bytes().u32(sequence).u8(length).raw(prefix.slice(0, Math.ceil(length / 8))).u16(entries.length);
  for (const entry of entries) body.u16(entry.peer).u32(1_763_000_000).u16(entry.attributes.length).raw(entry.attributes);
  return record(13, subtype, body.done());
}

function attrs(...parts: (readonly number[] | Uint8Array)[]): Uint8Array {
  // Purpose: path attributes laid end to end
  const out = new Bytes();
  for (const part of parts) out.raw(part);
  return out.done();
}

function concat(parts: Uint8Array[]): Uint8Array {
  // Purpose: join byte arrays
  const out = new Bytes();
  for (const part of parts) out.raw(part);
  return out.done();
}

const DUMP = concat([
  peerIndex([{ asn: 65001 }, { as4: true, asn: 4200000000 }, { v6: true, as4: true, asn: 65003 }]),
  // Shortest path wins: origin 13335, length 2.
  rib(0, [1, 0, 0, 0], 24, [
    { peer: 1, attributes: attrs(ORIGIN_IGP, asPath([[SEQ, [65002, 65003, 13335]]])) },
    { peer: 0, attributes: attrs(ORIGIN_IGP, asPath([[SEQ, [65001, 13335]]])) },
  ]),
  // A tie on length goes to the lowest peer index: origin 64512.
  rib(1, [8, 8, 8, 0], 24, [
    { peer: 1, attributes: asPath([[SEQ, [100, 15169]]]) },
    { peer: 0, attributes: asPath([[SEQ, [200, 64512]]]) },
  ]),
  // Not a TABLE_DUMP_V2 record: skipped.
  record(16, 4, new Uint8Array(20)),
  // Ends in an AS_SET: no single origin, skipped.
  rib(2, [10, 0, 0, 0], 8, [{ peer: 0, attributes: asPath([[SEQ, [174]], [SET, [1, 2, 3]]]) }]),
  // /23 has a 3-byte prefix; extended-length attribute; prepends count; confederation does not.
  rib(3, [192, 0, 2, 0], 23, [
    { peer: 2, attributes: attrs(ORIGIN_IGP, asPath([[CONFED_SEQ, [64600, 64601]], [SEQ, [3356, 3356, 3356]]], true)) },
  ]),
  // An IPv6 RIB record: skipped.
  rib(4, [0x20, 0x01, 0x0d, 0xb8], 32, [{ peer: 2, attributes: asPath([[SEQ, [1]]]) }], 4),
  // No AS_PATH attribute at all: empty path, skipped.
  rib(5, [0, 0, 0, 0], 0, [{ peer: 0, attributes: Uint8Array.from(ORIGIN_IGP) }]),
  // A 4-byte origin AS.
  rib(6, [203, 0, 113, 0], 24, [{ peer: 1, attributes: asPath([[SEQ, [4200000000, 4200000001]]]) }]),
]);

function readAll(bytes: Uint8Array, pieceSize: number): {
  records: (RibRecord & { paths: RibGraphRecord['paths'] })[];
  peers: number;
  reader: MrtReader;
} {
  // Purpose: run the reader over bytes pushed in pieces of a given size, keeping both views of each record
  const records: RibRecord[] = [];
  const pathsByPrefix = new Map<number, RibGraphRecord['paths']>();
  let peers = 0;
  const reader = new MrtReader({
    onRib: r => records.push(r),
    onPeers: p => (peers = p.length),
    onRibPaths: r => pathsByPrefix.set(r.prefix, r.paths),
  });
  for (let at = 0; at < bytes.length; at += pieceSize) reader.push(bytes.subarray(at, at + pieceSize));
  reader.finish();
  return { records: records.map(r => ({ ...r, paths: pathsByPrefix.get(r.prefix) ?? [] })), peers, reader };
}

describe('MRT reader', () => {
  test('decodes peers and IPv4 RIB records, and skips the rest', () => {
    const { records, peers, reader } = readAll(DUMP, DUMP.length);
    expect(peers).toBe(3);
    expect(reader.recordCount).toBe(9);
    expect(records.map(r => formatPrefix(r.prefix, r.prefixLength))).toEqual([
      '1.0.0.0/24',
      '8.8.8.0/24',
      '10.0.0.0/8',
      '192.0.2.0/23',
      '0.0.0.0/0',
      '203.0.113.0/24',
    ]);
    expect(records[3]!.entries).toEqual([{ peerIndex: 2, pathLength: 3, originAs: 3356 }]);
    expect(records[2]!.entries).toEqual([{ peerIndex: 0, pathLength: 2, originAs: null }]);
    expect(records[4]!.entries).toEqual([{ peerIndex: 0, pathLength: 0, originAs: null }]);
  });

  test('gives the same result however the bytes are split', () => {
    const whole = readAll(DUMP, DUMP.length).records;
    for (const size of [1, 7, 12, 13, 64]) expect(readAll(DUMP, size).records).toEqual(whole);
  });

  test('a truncated dump is an error', () => {
    expect(() => readAll(DUMP.subarray(0, DUMP.length - 5), 100)).toThrow(MrtFormatError);
  });

  test('an entry with undecodable attributes is skipped and reported; the rest of the record is kept', () => {
    // Peer 0's AS_PATH claims 9 ASNs but holds 2; peer 1's entry is fine.
    const good = asPath([[SEQ, [7018, 13335]]]);
    const bad = asPath([[SEQ, [1, 2]]]).slice();
    bad[4] = 9;
    // Peer 2's ORIGIN attribute claims 200 bytes inside a 4-byte entry.
    const overrun = Uint8Array.from([0x40, 1, 200, 0]);
    const dump = concat([
      rib(0, [1, 1, 1, 0], 24, [
        { peer: 0, attributes: bad },
        { peer: 1, attributes: good },
        { peer: 2, attributes: overrun },
      ]),
      rib(1, [2, 2, 2, 0], 24, [{ peer: 0, attributes: overrun }]),
    ]);
    const malformed: { prefix: string; peerIndex: number; reason: string; attributesHex: string; recordOffset: number }[] = [];
    const records: RibRecord[] = [];
    const reader = new MrtReader({ onRib: r => records.push(r), onMalformedEntry: e => malformed.push(e) });
    for (let at = 0; at < dump.length; at += 5) reader.push(dump.subarray(at, at + 5));
    reader.finish();
    expect(records.map(r => r.entries)).toEqual([[{ peerIndex: 1, pathLength: 2, originAs: 13335 }], []]);
    expect(reader.malformedEntryCount).toBe(3);
    expect(malformed.map(m => [m.prefix, m.peerIndex])).toEqual([
      ['1.1.1.0/24', 0],
      ['1.1.1.0/24', 2],
      ['2.2.2.0/24', 0],
    ]);
    expect(malformed[0]!.reason).toContain('AS_PATH segment');
    expect(malformed[1]!.attributesHex).toBe('40 01 c8 00');
    expect(malformed[0]!.recordOffset).toBe(0);
    expect(malformed[2]!.recordOffset).toBe(dump.length - rib(1, [2, 2, 2, 0], 24, [{ peer: 0, attributes: overrun }]).length);
  });

  test('an entry that runs past its record is still a fatal error', () => {
    const record = rib(9, [1, 2, 3, 0], 24, [{ peer: 0, attributes: asPath([[SEQ, [1, 2]]]) }]).slice();
    // Raise the entry's attribute length (bytes 28-29: after the 12-byte header, sequence,
    // prefix length, 3 prefix bytes, entry count, peer index and originated time) past the record's end.
    record[28] = 0x01;
    expect(() => readAll(record, record.length)).toThrow(MrtFormatError);
  });
});

describe('route builder', () => {
  test('one route per prefix: shortest path, then lowest peer; no-origin prefixes skipped', () => {
    const builder = new RouteBuilder();
    for (const r of readAll(DUMP, DUMP.length).records) builder.add(r);
    const routes = builder.finish();
    const rows = Array.from({ length: routes.rowCount }, (_, i) => [
      formatPrefix(routes.prefixAddr[i]!, routes.prefixLen[i]!),
      routes.originAs[i],
      routes.pathLen[i],
    ]);
    expect(rows).toEqual([
      ['1.0.0.0/24', 13335, 2],
      ['8.8.8.0/24', 64512, 2],
      ['192.0.2.0/23', 3356, 3],
      ['203.0.113.0/24', 4200000001, 2],
    ]);
    expect(builder.stats).toEqual({ prefixesSeen: 6, skippedNoOrigin: 2, pathsClamped: 0 });
  });
});

describe('AS adjacency graph', () => {
  test('the MRT reader keeps sequence ASNs only when a graph handler is present', () => {
    const records = readAll(DUMP, DUMP.length).records;
    expect(records[0]!.entries).toEqual([{ peerIndex: 1, pathLength: 3, originAs: 13335 }, { peerIndex: 0, pathLength: 2, originAs: 13335 }]);

    const paths: { peerIndex: number; pathLength: number; originAs: number | null; sequences: readonly (readonly number[])[] }[] = [];
    const reader = new MrtReader({ onRibPaths(record) { for (const path of record.paths) paths.push(path); } });
    for (let at = 0; at < DUMP.length; at += 7) reader.push(DUMP.subarray(at, at + 7));
    reader.finish();
    expect(paths.map(p => [p.peerIndex, p.pathLength, p.originAs, p.sequences])).toEqual([
      [1, 3, 13335, [[65002, 65003, 13335]]],
      [0, 2, 13335, [[65001, 13335]]],
      [1, 2, 15169, [[100, 15169]]],
      [0, 2, 64512, [[200, 64512]]],
      [0, 2, null, [[174]]],
      [2, 3, 3356, [[3356, 3356, 3356]]],
      [0, 0, null, []],
      [1, 2, 4200000001, [[4200000000, 4200000001]]],
    ]);
  });

  test('builds weighted directed edges from the chosen route per prefix', () => {
    const builder = new GraphBuilder();
    for (const r of readAll(DUMP, DUMP.length).records) {
      builder.add({ prefix: r.prefix, prefixLength: r.prefixLength, paths: r.paths });
    }
    const graph = builder.finish();
    const edges = Array.from({ length: graph.edges.rowCount }, (_, i) => [
      graph.edges.from_as[i],
      graph.edges.to_as[i],
      graph.edges.prefixes[i],
    ]);
    expect(edges).toEqual([
      [65001, 13335, 1],
      [200, 64512, 1],
      [4200000000, 4200000001, 1],
    ]);
    const nodes = new Map(
      Array.from({ length: graph.nodes.rowCount }, (_, i) => [graph.nodes.asn[i], graph.nodes.paths[i]]),
    );
    expect([...nodes]).toEqual([
      [65001, 1],
      [13335, 1],
      [200, 1],
      [64512, 1],
      [3356, 1],
      [4200000000, 1],
      [4200000001, 1],
    ]);
    expect(builder.stats).toEqual({
      prefixesSeen: 6,
      skippedNoOrigin: 2,
      routesWithoutEdges: 1,
      duplicatePrefixedPairs: 0,
    });
  });

  test('AS_SETs break a path, and prepends or repeated hops count once per prefix', () => {
    const builder = new GraphBuilder();
    builder.add({
      prefix: 1,
      prefixLength: 24,
      paths: [
        {
          peerIndex: 0,
          pathLength: 7,
          originAs: 5,
          sequences: [[1, 2], [3, 4], [2, 2, 5, 5], [2, 2, 5, 5]],
        },
        { peerIndex: 1, pathLength: 1, originAs: 9, sequences: [[9]] },
      ],
    });
    // The shortest path, a single AS, wins and produces no edge.
    expect(builder.finish().edges.rowCount).toBe(0);

    const second = new GraphBuilder();
    second.add({
      prefix: 1,
      prefixLength: 24,
      paths: [{ peerIndex: 0, pathLength: 7, originAs: 5, sequences: [[1, 2], [3, 4], [2, 2, 5, 5], [2, 2, 5, 5]] }],
    });
    const graph = second.finish();
    expect(Array.from({ length: graph.edges.rowCount }, (_, i) => [
      graph.edges.from_as[i],
      graph.edges.to_as[i],
      graph.edges.prefixes[i],
    ])).toEqual([
      [1, 2, 1],
      [3, 4, 1],
      [2, 5, 1],
    ]);
    expect(second.stats.duplicatePrefixedPairs).toBe(1);
  });

  test('graph.bin round-trips labels and frozen coordinates, and loads an edges table', async () => {
    const builder = new GraphBuilder();
    for (const r of readAll(DUMP, DUMP.length).records) {
      builder.add({ prefix: r.prefix, prefixLength: r.prefixLength, paths: r.paths });
    }
    const names = parseAsNames(ASN_TXT);
    const rir = rirLookup(parseRirRanges(NRO_STATS));
    const labels = {
      asName: (asn: number) => names.get(asn) ?? null,
      rir,
    };
    const encoded = encodeGraph(builder.finish(), labels, { collector: 'fixture' });
    const { arrays, header } = decodeGraph(encoded);
    expect(header.nodeCount).toBe(7);
    expect(header.edgeCount).toBe(3);
    expect(header.source).toEqual({ collector: 'fixture' });
    const byAsn = new Map(Array.from(arrays.asn, (asn, i) => [asn, i] as const));
    expect(arrays.name[byAsn.get(13335)!]).toBe('CLOUDFLARENET');
    expect(arrays.rir[byAsn.get(3356)!]).toBe('ARIN');
    expect(arrays.rir[byAsn.get(64512)!]).toBeNull();
    expect(arrays.x.every(Number.isFinite) && arrays.y.every(Number.isFinite)).toBe(true);
    expect(arrays.x.every(v => Math.abs(v) <= 1) && arrays.y.every(v => Math.abs(v) <= 1)).toBe(true);
    let closest = Infinity;
    for (let i = 0; i < arrays.x.length; i++) {
      for (let j = i + 1; j < arrays.x.length; j++) {
        closest = Math.min(closest, Math.hypot(arrays.x[i]! - arrays.x[j]!, arrays.y[i]! - arrays.y[j]!));
      }
    }
    expect(closest).toBeGreaterThan(0.2);
    expect(decodeGraph(encodeGraph(builder.finish(), labels, { collector: 'fixture' })).arrays.x).toEqual(arrays.x);

    const loaded = loadGraph(encoded);
    expect(loaded.edges.rowCount).toBe(3);
    const rows = await pipe(GraphEdges)
      .select(c => ({ from: c.from_as, to: c.to_as, weight: c.prefixes }))
      .compile()
      .execute(loaded.edges);
    expect(rows.toArray()).toEqual([
      { from: 65001, to: 13335, weight: 1 },
      { from: 200, to: 64512, weight: 1 },
      { from: 4200000000, to: 4200000001, weight: 1 },
    ]);
  });
});

const ASN_TXT = [
  '13335 CLOUDFLARENET, US',
  '15169 GOOGLE, US',
  '3356 LEVEL3, US',
  '64512 PRIVATE, ZZ',
  '4200000001 EXAMPLE-NET, NZ',
  'not-a-number ignored',
  '9999 Name, with a comma, AU',
  '',
].join('\n');

const NRO_STATS = [
  '2.3|nro|20261116|999|19830705|20261116|+0000',
  'arin|*|asn|*|100|summary',
  'arin|US|asn|3356|1|20000101|assigned|x',
  'arin|US|asn|13335|1|20100101|assigned|x',
  'arin|US|asn|15169|1|20000101|assigned|x',
  'apnic|NZ|asn|4200000000|10|20200101|assigned|x',
  'ripencc|NL|ipv4|1.0.0.0|256|20100101|allocated|x',
  'iana|ZZ|asn|64512|1023|19900101|reserved|x',
].join('\n');

describe('registry files', () => {
  test('asn.txt: name without the trailing country', () => {
    const names = parseAsNames(ASN_TXT);
    expect(names.get(13335)).toBe('CLOUDFLARENET');
    expect(names.get(4200000001)).toBe('EXAMPLE-NET');
    expect(names.get(9999)).toBe('Name, with a comma');
    expect(names.size).toBe(6);
  });

  test('NRO stats: AS ranges by registry, IANA and summary lines skipped', () => {
    const lookup = rirLookup(parseRirRanges(NRO_STATS));
    expect(lookup(3356)).toBe('ARIN');
    expect(lookup(4200000005)).toBe('APNIC');
    expect(lookup(4200000010)).toBeNull();
    expect(lookup(64512)).toBeNull();
    expect(lookup(1)).toBeNull();
  });
});

describe('routes file', () => {
  function sampleFile(): Uint8Array {
    // Purpose: the fixture dump turned into a routes file
    const builder = new RouteBuilder();
    for (const r of readAll(DUMP, DUMP.length).records) builder.add(r);
    const names = parseAsNames(ASN_TXT);
    return encodeRoutes(
      builder.finish(),
      { asName: asn => names.get(asn) ?? null, rir: rirLookup(parseRirRanges(NRO_STATS)) },
      { collector: 'fixture' },
    );
  }

  test('round-trips into a zamda table', async () => {
    const { table, header } = loadRoutes(sampleFile());
    expect(header.rowCount).toBe(4);
    expect(header.source).toEqual({ collector: 'fixture' });
    const rows = (await pipe(Routes).select(c => ({ origin: c.origin_as, name: c.as_name, rir: c.rir })).compile().execute(table)).toArray();
    expect(rows).toEqual([
      { origin: 13335, name: 'CLOUDFLARENET', rir: 'ARIN' },
      { origin: 64512, name: 'PRIVATE', rir: null },
      { origin: 3356, name: 'LEVEL3', rir: 'ARIN' },
      { origin: 4200000001, name: 'EXAMPLE-NET', rir: 'APNIC' },
    ]);
  });

  test('loads from a buffer that is not 4-byte aligned', () => {
    const file = sampleFile();
    const shifted = new Uint8Array(file.length + 1);
    shifted.set(file, 1);
    expect(loadRoutes(shifted.subarray(1)).table.rowCount).toBe(4);
  });

  test('rejects a file that is not a routes file', () => {
    expect(() => loadRoutes(new Uint8Array(16))).toThrow('bad magic');
  });

  test('a dashboard query runs on it', async () => {
    const { table } = loadRoutes(sampleFile());
    const byRegion = pipe(Routes)
      .groupBy(c => ({ rir: c.rir }))
      .agg(c => ({ routes: count(), networks: c.origin_as.countDistinct() }))
      .compile();
    expect((await byRegion.execute(table)).toArray()).toEqual([
      { rir: 'ARIN', routes: 2, networks: 2 },
      { rir: null, routes: 1, networks: 1 },
      { rir: 'APNIC', routes: 1, networks: 1 },
    ]);
  });
});

describe('prep-bgp', () => {
  test('end to end from local files, including a gzipped dump', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zamda-bgp-'));
    const mrt = join(dir, 'bview.gz');
    await writeFile(mrt, Bun.gzipSync(DUMP as Uint8Array<ArrayBuffer>));
    await writeFile(join(dir, 'asn.txt'), ASN_TXT);
    await writeFile(join(dir, 'stats'), NRO_STATS);
    const out = join(dir, 'out', 'routes.bin');
    const graphOut = join(dir, 'out', 'graph.bin');
    const log = console.log;
    console.log = () => {};
    try {
      await prepare(
        parseArgs([
          '--mrt', mrt,
          '--names', join(dir, 'asn.txt'),
          '--stats', join(dir, 'stats'),
          '--out', out,
          '--graph-out', graphOut,
        ]),
      );
    } finally {
      console.log = log;
    }
    const { table, header } = loadRoutes(new Uint8Array(await Bun.file(out).arrayBuffer()));
    expect(table.rowCount).toBe(4);
    expect(header.source.peers).toBe(3);
    const graph = decodeGraph(new Uint8Array(await Bun.file(graphOut).arrayBuffer()));
    expect(graph.header.edgeCount).toBe(3);
    expect(graph.header.nodeCount).toBe(7);
  });

  test('options and URLs', () => {
    expect(dumpUrl('rrc00', '20261101', '0800')).toBe('https://data.ris.ripe.net/rrc00/2026.11/bview.20261101.0800.gz');
    expect(() => parseArgs(['--date', '2026-11-01'])).toThrow('YYYYMMDD');
    expect(() => parseArgs(['--time', '1200'])).toThrow('0000, 0800 or 1600');
    expect(() => parseArgs(['--bogus', 'x'])).toThrow('Unknown option');
    expect(parseArgs([]).out).toBe('data/routes.bin');
    expect(parseArgs([]).graphOut).toBe('data/graph.bin');
  });
});

describe('prep-bgp download cache', () => {
  test('the cache path sits next to the output and names the dump', () => {
    const options = parseArgs(['--date', '20261116', '--out', 'data/routes.bin']);
    expect(cachePath(options)).toBe('data/rrc00-bview.20261116.0000.gz');
  });
});

describe('prep-bgp download', () => {
  test('a download is saved, and the next run reuses it without fetching', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zamda-dl-'));
    await writeFile(join(dir, 'asn.txt'), ASN_TXT);
    await writeFile(join(dir, 'stats'), NRO_STATS);
    const args = [
      '--date', '20261116',
      '--names', join(dir, 'asn.txt'),
      '--stats', join(dir, 'stats'),
      '--out', join(dir, 'routes.bin'),
      '--graph-out', join(dir, 'graph.bin'),
    ];
    const gz = Bun.gzipSync(DUMP as Uint8Array<ArrayBuffer>);
    const realFetch = globalThis.fetch;
    const log = console.log;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      // Deliver the body in small pieces, as a network would.
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let at = 0; at < gz.length; at += 7) controller.enqueue(gz.subarray(at, at + 7));
            controller.close();
          },
        }),
      );
    }) as unknown as typeof fetch;
    console.log = () => {};
    try {
      await prepare(parseArgs(args));
      await prepare(parseArgs(args));
    } finally {
      globalThis.fetch = realFetch;
      console.log = log;
    }
    expect(fetches).toBe(1);
    const saved = new Uint8Array(await Bun.file(cachePath(parseArgs(args))).arrayBuffer());
    expect(saved).toEqual(gz);
    expect(loadRoutes(new Uint8Array(await Bun.file(join(dir, 'routes.bin')).arrayBuffer())).table.rowCount).toBe(4);
    expect(decodeGraph(new Uint8Array(await Bun.file(join(dir, 'graph.bin')).arrayBuffer())).header.edgeCount).toBe(3);
  });
});
