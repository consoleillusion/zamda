// The routes file: the reference dataset in a compact columnar form that loads
// into a zamda table without parsing each value.
//
// Layout:
//   bytes 0-3   magic "ZRT1"
//   bytes 4-7   header length H, uint32 little-endian
//   bytes 8..   header, UTF-8 JSON (RoutesHeader), padded to a multiple of 4
//   then        one buffer per column, each starting on a multiple of 4
//
// as_name and rir are stored as codes into the header's `names` and `rirs` lists;
// the "no value" code is 0xFFFFFFFF for names and 255 for regions.

import { schema, t, table } from '../../src';
import type { JsTable } from '../../src';
import type { RouteColumns } from './routes';

export const Routes = schema({
  prefix_addr: t.uint32,
  prefix_len: t.uint8,
  origin_as: t.uint32,
  as_name: t.dictionary,
  path_len: t.uint8,
  rir: t.dictionary,
});

const MAGIC = 'ZRT1';
const NO_NAME = 0xffffffff;
const NO_RIR = 255;

interface ColumnRef {
  readonly offset: number;
  readonly bytes: number;
}

export interface RoutesHeader {
  readonly version: 1;
  readonly rowCount: number;
  // Where the data came from, for display and reproducibility.
  readonly source: Readonly<Record<string, string | number>>;
  readonly names: readonly string[];
  readonly rirs: readonly string[];
  readonly columns: Readonly<Record<'prefix_addr' | 'prefix_len' | 'origin_as' | 'path_len' | 'as_name' | 'rir', ColumnRef>>;
}

export interface Labels {
  readonly asName: (asn: number) => string | null;
  readonly rir: (asn: number) => string | null;
}

function align4(n: number): number {
  // Purpose: round up to a multiple of 4
  return (n + 3) & ~3;
}

export function encodeRoutes(
  routes: RouteColumns,
  labels: Labels,
  source: Readonly<Record<string, string | number>>,
): Uint8Array {
  // Purpose: label every route with its network name and region, and write the routes file
  const n = routes.rowCount;
  const names: string[] = [];
  const nameCodes = new Map<string, number>();
  const rirs: string[] = [];
  const rirCodes = new Map<string, number>();
  const asName = new Uint32Array(n);
  const rir = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const asn = routes.originAs[i]!;
    const name = labels.asName(asn);
    if (name === null) asName[i] = NO_NAME;
    else {
      let code = nameCodes.get(name);
      if (code === undefined) {
        code = names.length;
        nameCodes.set(name, code);
        names.push(name);
      }
      asName[i] = code;
    }
    const region = labels.rir(asn);
    if (region === null) rir[i] = NO_RIR;
    else {
      let code = rirCodes.get(region);
      if (code === undefined) {
        code = rirs.length;
        rirCodes.set(region, code);
        rirs.push(region);
      }
      rir[i] = code;
    }
  }

  const buffers: [keyof RoutesHeader['columns'], Uint8Array][] = [
    ['prefix_addr', new Uint8Array(routes.prefixAddr.buffer, routes.prefixAddr.byteOffset, n * 4)],
    ['prefix_len', routes.prefixLen.subarray(0, n)],
    ['origin_as', new Uint8Array(routes.originAs.buffer, routes.originAs.byteOffset, n * 4)],
    ['path_len', routes.pathLen.subarray(0, n)],
    ['as_name', new Uint8Array(asName.buffer, 0, n * 4)],
    ['rir', rir],
  ];

  // The header holds the column offsets, which depend on the header's own length;
  // lay out with placeholder offsets, then again until the length settles.
  let headerBytes = new Uint8Array(0);
  let columns: Record<string, ColumnRef> = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    let at = align4(8 + headerBytes.length);
    columns = {};
    for (const [name, bytes] of buffers) {
      columns[name] = { offset: at, bytes: bytes.length };
      at = align4(at + bytes.length);
    }
    const header: RoutesHeader = { version: 1, rowCount: n, source, names, rirs, columns: columns as RoutesHeader['columns'] };
    const next = new TextEncoder().encode(JSON.stringify(header));
    const settled = next.length === headerBytes.length;
    // Keep the header that holds THESE offsets; on the last pass its length matches the layout.
    headerBytes = next;
    if (settled) break;
    if (attempt === 3) throw new Error('Routes file header length did not settle');
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

export function readHeader(bytes: Uint8Array): RoutesHeader {
  // Purpose: check the magic number and decode the header
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('Not a zamda routes file (bad magic number)');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as RoutesHeader;
  if (header.version !== 1) throw new Error(`Unsupported routes file version ${String(header.version)}`);
  return header;
}

export interface RouteArrays {
  readonly rowCount: number;
  readonly prefix_addr: Uint32Array;
  readonly prefix_len: Uint8Array;
  readonly origin_as: Uint32Array;
  readonly as_name: (string | null)[];
  readonly path_len: Uint8Array;
  readonly rir: (string | null)[];
}

export function decodeRoutes(input: Uint8Array): { arrays: RouteArrays; header: RoutesHeader } {
  // Purpose: the routes file's columns as plain arrays; the number columns are views of the input, not copies
  // Typed-array views need 4-byte alignment; copy if the input buffer does not provide it.
  const bytes = input.byteOffset % 4 === 0 ? input : input.slice();
  const header = readHeader(bytes);
  const n = header.rowCount;
  const col = header.columns;
  const u32 = function (ref: ColumnRef): Uint32Array {
    // Purpose: a Uint32Array view of one column
    return new Uint32Array(bytes.buffer, bytes.byteOffset + ref.offset, n);
  };
  const u8 = function (ref: ColumnRef): Uint8Array {
    // Purpose: a Uint8Array view of one column
    return new Uint8Array(bytes.buffer, bytes.byteOffset + ref.offset, n);
  };
  const nameCodes = u32(col.as_name);
  const rirCodes = u8(col.rir);
  const asName: (string | null)[] = new Array(n);
  const rir: (string | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const name = nameCodes[i]!;
    asName[i] = name === NO_NAME ? null : header.names[name]!;
    const region = rirCodes[i]!;
    rir[i] = region === NO_RIR ? null : header.rirs[region]!;
  }
  const arrays: RouteArrays = {
    rowCount: n,
    prefix_addr: u32(col.prefix_addr),
    prefix_len: u8(col.prefix_len),
    origin_as: u32(col.origin_as),
    as_name: asName,
    path_len: u8(col.path_len),
    rir,
  };
  return { arrays, header };
}

export function loadRoutes(input: Uint8Array): { table: JsTable<typeof Routes.fields>; header: RoutesHeader } {
  // Purpose: build a zamda table from a routes file; the number columns are used without copying
  const { arrays, header } = decodeRoutes(input);
  const routes = table(Routes, {
    columns: {
      prefix_addr: arrays.prefix_addr,
      prefix_len: arrays.prefix_len,
      origin_as: arrays.origin_as,
      as_name: arrays.as_name,
      path_len: arrays.path_len,
      rir: arrays.rir,
    },
  });
  return { table: routes, header };
}

export function formatPrefix(addr: number, length: number): string {
  // Purpose: dotted-quad text for a prefix, for display
  return `${addr >>> 24}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}/${length}`;
}
