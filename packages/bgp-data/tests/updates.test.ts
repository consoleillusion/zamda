// BGP4MP update decoding (updates.ts) and the columns file (columns-file.ts).

import { describe, expect, test } from 'bun:test';
import { decodeColumns, encodeColumns } from '../src/columns-file';
import { MrtReader } from '../src/mrt';
import type { UpdateMessage } from '../src/updates';

function bgp4mpRecord(time: number, peerAs: number, withdrawn: [number, number][], announced: [number, number][], path: number[]): Uint8Array {
  // Purpose: one MRT BGP4MP MESSAGE_AS4 record holding an IPv4 UPDATE, built byte by byte
  const prefix = ([addr, len]: [number, number]): number[] => {
    const bytes = [(addr >>> 24) & 255, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255];
    return [len, ...bytes.slice(0, (len + 7) >> 3)];
  };
  const wd = withdrawn.flatMap(prefix);
  const nlri = announced.flatMap(prefix);
  const asPath = path.length === 0 ? [] : [2, path.length, ...path.flatMap(a => [(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255])];
  // ORIGIN (type 1), AS_PATH (type 2) and NEXT_HOP (type 3), all well-known transitive.
  const nextHop = [0x40, 3, 4, 192, 0, 2, 1];
  const attrs = [0x40, 1, 1, 0, ...(asPath.length === 0 ? [] : [0x40, 2, asPath.length, ...asPath]), ...nextHop];
  const body = [0, wd.length, ...wd, (attrs.length >> 8) & 255, attrs.length & 255, ...attrs, ...nlri];
  const message = [...new Array(16).fill(255), 0, 0, 2, ...body];
  message[16] = (message.length >> 8) & 255;
  message[17] = message.length & 255;
  const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const mrtBody = [...be32(peerAs), ...be32(12654), 0, 0, 0, 1, ...be32(0x0a000001), ...be32(0x0a000002), ...message];
  return Uint8Array.from([...be32(time), 0, 16, 0, 4, ...be32(mrtBody.length), ...mrtBody]);
}

describe('BGP4MP updates', () => {
  test('withdrawals and announcements become prefixes with the path origin, across any split of the bytes', () => {
    const records = [
      bgp4mpRecord(1000, 64500, [[0x0a000000, 8]], [[0xc0a80000, 16], [0xcb007100, 24]], [64500, 3356, 13335]),
      bgp4mpRecord(1001, 64501, [[0x01020300, 24]], [], []),
    ];
    const bytes = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of records) {
      bytes.set(r, at);
      at += r.length;
    }
    for (const split of [1, 7, 50, bytes.length]) {
      const seen: UpdateMessage[] = [];
      const reader = new MrtReader({ onUpdate: u => seen.push(u) });
      for (let i = 0; i < bytes.length; i += split) reader.push(bytes.subarray(i, i + split));
      reader.finish();
      expect(seen).toEqual([
        {
          time: 1000,
          peerAs: 64500,
          peerIp: '10.0.0.1',
          localIp: '10.0.0.2',
          nextHop: '192.0.2.1',
          asPath: '64500 3356 13335',
          withdrawn: [{ addr: 0x0a000000, length: 8 }],
          announced: [{ addr: 0xc0a80000, length: 16 }, { addr: 0xcb007100, length: 24 }],
          originAs: 13335,
          pathLength: 3,
        },
        {
          time: 1001,
          peerAs: 64501,
          peerIp: '10.0.0.1',
          localIp: '10.0.0.2',
          nextHop: '192.0.2.1',
          asPath: '',
          withdrawn: [{ addr: 0x01020300, length: 24 }],
          announced: [],
          originAs: null,
          pathLength: 0,
        },
      ]);
    }
  });

  test('a prefix longer than 32 bits is a format error', () => {
    const bad = bgp4mpRecord(1, 1, [], [[0, 24]], [1]);
    bad[bad.length - 4] = 40; // the NLRI length byte
    expect(() => new MrtReader({ onUpdate: () => undefined }).push(bad)).toThrow('over 32');
  });
});

describe('columns file', () => {
  test('round trips typed columns, lists and metadata', () => {
    const file = {
      rows: 3,
      columns: { a: Uint32Array.of(1, 2, 3), b: Uint8Array.of(7, 8, 9), c: Float32Array.of(0.5, -1, 2) },
      lists: { names: ['x', 'y'] },
      meta: { start: 123 },
    };
    const back = decodeColumns(encodeColumns(file));
    expect(back.rows).toBe(3);
    expect([...back.columns.a!]).toEqual([1, 2, 3]);
    expect([...back.columns.b!]).toEqual([7, 8, 9]);
    expect([...back.columns.c!]).toEqual([0.5, -1, 2]);
    expect(back.lists).toEqual({ names: ['x', 'y'] });
    expect(back.meta).toEqual({ start: 123 });
  });

  test('refuses a file with a column of the wrong length or bad magic', () => {
    expect(() => encodeColumns({ rows: 2, columns: { a: Uint8Array.of(1) }, lists: {}, meta: {} })).toThrow('expected 2');
    expect(() => decodeColumns(new Uint8Array(16))).toThrow('bad magic');
  });
});
