// A streaming reader for MRT routing table dumps (RFC 6396), as published by
// RIPE RIS and RouteViews. Only what the reference dataset needs is decoded:
// TABLE_DUMP_V2 PEER_INDEX_TABLE and RIB_IPV4_UNICAST records, and the AS_PATH
// attribute of each RIB entry. Every other record type is skipped.
//
// Data arrives in arbitrary pieces (from a gunzip stream), so the reader buffers
// bytes and decodes each record once it is complete.

import { decodeBgp4mp, MRT_BGP4MP, MRT_BGP4MP_ET } from './updates';
import type { UpdateMessage } from './updates';

export const MRT_TABLE_DUMP_V2 = 13;
export const PEER_INDEX_TABLE = 1;
export const RIB_IPV4_UNICAST = 2;

const HEADER_BYTES = 12;
const ATTR_AS_PATH = 2;
const FLAG_EXTENDED_LENGTH = 0x10;
const SEGMENT_AS_SET = 1;
const SEGMENT_AS_SEQUENCE = 2;

export interface Peer {
  readonly asn: number;
  readonly address: string;
}

export interface RibEntry {
  readonly peerIndex: number;
  // AS_PATH length by the BGP rule: each AS in a sequence counts, a set counts once,
  // confederation segments do not count.
  readonly pathLength: number;
  // The last AS of the path, or null when the path is empty or ends in an AS_SET.
  readonly originAs: number | null;
}

// One peer's path, kept whole for the graph. Only AS_SEQUENCE segments carry
// adjacency: a set or a confederation segment breaks the path rather than
// inventing a hop across it.
export interface RibPath {
  readonly peerIndex: number;
  readonly pathLength: number;
  readonly originAs: number | null;
  readonly sequences: readonly (readonly number[])[];
}

export interface RibRecord {
  // IPv4 network address as an unsigned 32-bit number.
  readonly prefix: number;
  readonly prefixLength: number;
  readonly entries: readonly RibEntry[];
}

// The graph view of one RIB record. Separate from RibRecord so a reader with
// no graph handler keeps decoding only the route dataset's fields.
export interface RibGraphRecord {
  readonly prefix: number;
  readonly prefixLength: number;
  readonly paths: readonly RibPath[];
}

// One RIB entry whose path attributes could not be decoded. The entry's own
// length field still marks where it ends, so the reader skips it and carries on.
export interface MalformedEntry {
  readonly prefix: string;
  readonly peerIndex: number;
  readonly reason: string;
  // The entry's attribute bytes as hex, cut at 256 bytes.
  readonly attributesHex: string;
  // Byte offset of the record in the decompressed dump.
  readonly recordOffset: number;
}

export interface MrtHandlers {
  onPeers?(peers: readonly Peer[]): void;
  onRib?(record: RibRecord): void;
  onRibPaths?(record: RibGraphRecord): void;
  onMalformedEntry?(entry: MalformedEntry): void;
  // BGP4MP update dumps (updates.ts): one call per IPv4 UPDATE message.
  onUpdate?(update: UpdateMessage): void;
}

export class MrtFormatError extends Error {
  constructor(message: string) {
    // Purpose: a record that does not follow RFC 6396
    super(message);
    this.name = 'MrtFormatError';
  }
}

export interface AsPathSegment {
  readonly type: number;
  readonly asns: readonly number[];
}

export interface PathInfo {
  readonly pathLength: number;
  readonly originAs: number | null;
  readonly sequences: readonly (readonly number[])[];
  // Every segment in wire order, so callers can show the full path, not just its origin.
  readonly segments: readonly AsPathSegment[];
  readonly text: string;
}

export function emptyPath(): PathInfo {
  // Purpose: the path info for an entry without an AS_PATH attribute
  return { pathLength: 0, originAs: null, sequences: [], segments: [], text: '' };
}

function segmentText(segment: AsPathSegment): string {
  // Purpose: display braces for sets and angle brackets for confederations, so a path stays unambiguous
  const list = segment.asns.join(' ');
  if (segment.type === SEGMENT_AS_SET) return `{${list}}`;
  if (segment.type === 3 || segment.type === 4) return `<${list}>`;
  return list;
}

export function decodeAsPath(view: DataView, start: number, end: number, includeSequences = false): PathInfo {
  // Purpose: path length, origin AS and full segment list from an AS_PATH attribute value
  let at = start;
  let pathLength = 0;
  let originAs: number | null = null;
  const sequences: number[][] = [];
  const segments: AsPathSegment[] = [];
  while (at < end) {
    if (at + 2 > end) throw new MrtFormatError('AS_PATH segment header runs past the attribute');
    const type = view.getUint8(at);
    const count = view.getUint8(at + 1);
    at += 2;
    if (at + count * 4 > end) throw new MrtFormatError('AS_PATH segment runs past the attribute');
    const asns: number[] = [];
    for (let i = 0; i < count; i++) asns.push(view.getUint32(at + i * 4));
    if (type === SEGMENT_AS_SEQUENCE) {
      pathLength += count;
      if (includeSequences && count > 0) sequences.push(asns);
      originAs = count > 0 ? asns[count - 1]! : originAs;
    } else if (type === SEGMENT_AS_SET) {
      pathLength += 1;
      // The origin is ambiguous when the path ends in a set.
      originAs = null;
    }
    // Confederation segments (3 and 4) count for nothing and do not change the origin.
    segments.push({ type, asns });
    at += count * 4;
  }
  return { pathLength, originAs, sequences, segments, text: segments.map(segmentText).join(' ') };
}

function findAsPath(view: DataView, start: number, end: number, includeSequences: boolean): PathInfo {
  // Purpose: scan BGP path attributes for AS_PATH; an entry without one has an empty path
  let at = start;
  while (at < end) {
    if (at + 3 > end) throw new MrtFormatError('Path attribute header runs past the entry');
    const flags = view.getUint8(at);
    const type = view.getUint8(at + 1);
    const extended = (flags & FLAG_EXTENDED_LENGTH) !== 0;
    const length = extended ? view.getUint16(at + 2) : view.getUint8(at + 2);
    const valueStart = at + (extended ? 4 : 3);
    const valueEnd = valueStart + length;
    if (valueEnd > end) throw new MrtFormatError('Path attribute runs past the entry');
    if (type === ATTR_AS_PATH) return decodeAsPath(view, valueStart, valueEnd, includeSequences);
    at = valueEnd;
  }
  return emptyPath();
}

function decodePeers(view: DataView, start: number, end: number): Peer[] {
  // Purpose: decode a PEER_INDEX_TABLE record body into its peer list
  let at = start + 4; // collector BGP identifier
  const nameLength = view.getUint16(at);
  at += 2 + nameLength;
  const count = view.getUint16(at);
  at += 2;
  const peers: Peer[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 5 > end) throw new MrtFormatError('Peer entry runs past the peer index table');
    const type = view.getUint8(at);
    const ipv6 = (type & 1) !== 0;
    const fourByteAs = (type & 2) !== 0;
    at += 1 + 4; // peer type, peer BGP identifier
    let address: string;
    if (ipv6) {
      const parts: string[] = [];
      for (let p = 0; p < 8; p++) parts.push(view.getUint16(at + p * 2).toString(16));
      address = parts.join(':');
      at += 16;
    } else {
      address = [0, 1, 2, 3].map(b => view.getUint8(at + b)).join('.');
      at += 4;
    }
    const asn = fourByteAs ? view.getUint32(at) : view.getUint16(at);
    at += fourByteAs ? 4 : 2;
    peers.push({ asn, address });
  }
  if (at > end) throw new MrtFormatError('Peer index table runs past its record');
  return peers;
}

function hex(view: DataView, start: number, end: number): string {
  // Purpose: bytes as hex, cut at 256 bytes, for reporting a malformed entry
  const parts: string[] = [];
  for (let i = start; i < Math.min(end, start + 256); i++) parts.push(view.getUint8(i).toString(16).padStart(2, '0'));
  return parts.join(' ') + (end - start > 256 ? ' ...' : '');
}

interface DecodedRib extends RibRecord {
  readonly paths: readonly RibPath[];
}

function decodeRibIpv4(
  view: DataView,
  start: number,
  end: number,
  onMalformed: (entry: Omit<MalformedEntry, 'recordOffset'>) => void,
  includePaths: boolean,
): DecodedRib {
  // Purpose: decode a RIB_IPV4_UNICAST record body: the prefix and every peer's entry for it.
  // An entry whose attributes cannot be decoded is reported and left out; the record's
  // structure (entry boundaries) must still be sound, or the whole record is an error.
  let at = start + 4; // sequence number
  const prefixLength = view.getUint8(at);
  at += 1;
  if (prefixLength > 32) throw new MrtFormatError(`IPv4 prefix length ${prefixLength} is over 32`);
  const prefixBytes = Math.ceil(prefixLength / 8);
  let prefix = 0;
  for (let b = 0; b < 4; b++) prefix = prefix * 256 + (b < prefixBytes ? view.getUint8(at + b) : 0);
  at += prefixBytes;
  const count = view.getUint16(at);
  at += 2;
  const entries: RibEntry[] = [];
  const paths: RibPath[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 8 > end) throw new MrtFormatError('RIB entry runs past its record');
    const peerIndex = view.getUint16(at);
    const attributesLength = view.getUint16(at + 6); // after the 4-byte originated time
    const attributesStart = at + 8;
    const attributesEnd = attributesStart + attributesLength;
    if (attributesEnd > end) throw new MrtFormatError('RIB entry attributes run past its record');
    try {
      const path = findAsPath(view, attributesStart, attributesEnd, includePaths);
      entries.push({ peerIndex, pathLength: path.pathLength, originAs: path.originAs });
      if (includePaths) {
        paths.push({
          peerIndex,
          pathLength: path.pathLength,
          originAs: path.originAs,
          sequences: path.sequences,
        });
      }
    } catch (error) {
      if (!(error instanceof MrtFormatError)) throw error;
      const a = prefix;
      onMalformed({
        prefix: `${a >>> 24}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}/${prefixLength}`,
        peerIndex,
        reason: error.message,
        attributesHex: hex(view, attributesStart, attributesEnd),
      });
    }
    at = attributesEnd;
  }
  return { prefix, prefixLength, entries, paths };
}

export class MrtReader {
  private buffer = new Uint8Array(1 << 20);
  private start = 0;
  private end = 0;
  private records = 0;
  private malformed = 0;
  // Offset in the whole decompressed input of buffer[0].
  private consumed = 0;
  private readonly includePaths: boolean;

  constructor(private readonly handlers: MrtHandlers) {
    // Purpose: decode records from bytes pushed in pieces of any size, collecting sequences only for a graph handler
    this.includePaths = typeof handlers.onRibPaths === 'function';
  }

  get recordCount(): number {
    // Purpose: number of complete records read so far, of every type
    return this.records;
  }

  get malformedEntryCount(): number {
    // Purpose: number of RIB entries skipped because their attributes could not be decoded
    return this.malformed;
  }

  push(bytes: Uint8Array): void {
    // Purpose: add bytes and decode every record that is now complete
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.end);
    this.end += bytes.length;
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    while (this.end - this.start >= HEADER_BYTES) {
      const type = view.getUint16(this.start + 4);
      const subtype = view.getUint16(this.start + 6);
      const length = view.getUint32(this.start + 8);
      const bodyStart = this.start + HEADER_BYTES;
      const bodyEnd = bodyStart + length;
      if (bodyEnd > this.end) {
        // Incomplete record: make sure the buffer can hold all of it, then wait for more bytes.
        this.reserve(bodyEnd - this.end);
        return;
      }
      if ((type === MRT_BGP4MP || type === MRT_BGP4MP_ET) && this.handlers.onUpdate !== undefined) {
        // BGP4MP_ET adds 4 bytes of microseconds before the body.
        const update = decodeBgp4mp(view, view.getUint32(this.start), subtype, bodyStart + (type === MRT_BGP4MP_ET ? 4 : 0), bodyEnd);
        if (update !== null) this.handlers.onUpdate(update);
      } else if (type === MRT_TABLE_DUMP_V2) {
        if (subtype === PEER_INDEX_TABLE) this.handlers.onPeers?.(decodePeers(view, bodyStart, bodyEnd));
        else if (subtype === RIB_IPV4_UNICAST) {
          const recordOffset = this.consumed + this.start;
          const record = decodeRibIpv4(view, bodyStart, bodyEnd, (entry) => {
            this.malformed++;
            this.handlers.onMalformedEntry?.({ ...entry, recordOffset });
          }, this.includePaths);
          this.handlers.onRib?.(record);
          if (this.includePaths) {
            this.handlers.onRibPaths?.({ prefix: record.prefix, prefixLength: record.prefixLength, paths: record.paths });
          }
        }
      }
      this.records++;
      this.start = bodyEnd;
    }
  }

  finish(): void {
    // Purpose: confirm the input ended on a record boundary
    if (this.end !== this.start) {
      throw new MrtFormatError(`Input ended inside a record (${this.end - this.start} bytes left over)`);
    }
  }

  private reserve(extra: number): void {
    // Purpose: make room for `extra` more bytes, first by discarding consumed bytes, then by growing
    if (this.end + extra <= this.buffer.length) return;
    const live = this.end - this.start;
    this.consumed += this.start;
    if (live + extra <= this.buffer.length && this.start > 0) {
      this.buffer.copyWithin(0, this.start, this.end);
    } else {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, live + extra));
      grown.set(this.buffer.subarray(this.start, this.end));
      this.buffer = grown;
    }
    this.start = 0;
    this.end = live;
  }
}
