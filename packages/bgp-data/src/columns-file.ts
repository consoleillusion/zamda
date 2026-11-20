// A small columnar container for the demo's data files: typed-array columns plus a JSON header with
// string lists and free-form metadata. It loads into zamda tables (or anything else) without parsing a
// value, in Bun and in the browser alike (no Node imports).
//
// Layout:
//   bytes 0-3   magic "ZCL1"
//   bytes 4-7   header length H, uint32 little-endian
//   bytes 8..   header, UTF-8 JSON (ColumnsHeader), padded to a multiple of 8
//   then        one buffer per column, each starting on a multiple of 8

const MAGIC = 'ZCL1';

export type ColumnKind = 'u8' | 'u16' | 'u32' | 'i32' | 'f32' | 'f64';

export type ColumnArray = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

const MAKERS: Readonly<Record<ColumnKind, { new (buffer: ArrayBuffer, offset: number, length: number): ColumnArray; BYTES_PER_ELEMENT: number }>> = {
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

function kindOf(array: ColumnArray): ColumnKind {
  // Purpose: the kind name of a typed array
  if (array instanceof Uint8Array) return 'u8';
  if (array instanceof Uint16Array) return 'u16';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Int32Array) return 'i32';
  if (array instanceof Float32Array) return 'f32';
  return 'f64';
}

export interface ColumnsHeader {
  readonly rows: number;
  readonly columns: readonly { readonly name: string; readonly kind: ColumnKind; readonly offset: number }[];
  // String lists that code columns index into (names, countries, ...).
  readonly lists: Readonly<Record<string, readonly string[]>>;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface ColumnsFile {
  readonly rows: number;
  readonly columns: Readonly<Record<string, ColumnArray>>;
  readonly lists: Readonly<Record<string, readonly string[]>>;
  readonly meta: Readonly<Record<string, unknown>>;
}

const pad8 = (n: number): number => (n + 7) & ~7;

export function encodeColumns(file: ColumnsFile): Uint8Array {
  // Purpose: write columns of equal length, string lists and metadata into one buffer
  const names = Object.keys(file.columns);
  for (const name of names) {
    if (file.columns[name]!.length !== file.rows) throw new Error(`Column ${name} has ${file.columns[name]!.length} rows, expected ${file.rows}`);
  }
  let offset = 0;
  const columns = names.map(name => {
    const entry = { name, kind: kindOf(file.columns[name]!), offset };
    offset = pad8(offset + file.columns[name]!.byteLength);
    return entry;
  });
  const header = new TextEncoder().encode(JSON.stringify({ rows: file.rows, columns, lists: file.lists, meta: file.meta } satisfies ColumnsHeader));
  const headerBytes = pad8(header.length);
  const out = new Uint8Array(8 + headerBytes + offset);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  const base = 8 + headerBytes;
  columns.forEach((entry, i) => {
    const array = file.columns[names[i]!]!;
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), base + entry.offset);
  });
  return out;
}

export function decodeColumns(input: Uint8Array): ColumnsFile {
  // Purpose: read a columns file; the columns are views into one aligned copy of the data
  if (new TextDecoder().decode(input.subarray(0, 4)) !== MAGIC) throw new Error('Not a zamda columns file (bad magic)');
  const headerLength = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(input.subarray(8, 8 + headerLength))) as ColumnsHeader;
  const base = 8 + pad8(headerLength);
  // One aligned copy, so every column can be a typed-array view whatever the input's alignment.
  const body = input.slice(base).buffer;
  const columns: Record<string, ColumnArray> = {};
  for (const entry of header.columns) {
    const make = MAKERS[entry.kind];
    if (entry.offset + header.rows * make.BYTES_PER_ELEMENT > body.byteLength) throw new Error(`Column ${entry.name} runs past the file`);
    columns[entry.name] = new make(body, entry.offset, header.rows);
  }
  return { rows: header.rows, columns, lists: header.lists, meta: header.meta };
}
