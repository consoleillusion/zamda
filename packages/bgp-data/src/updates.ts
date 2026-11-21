// BGP UPDATE messages from RIS update dumps (MRT BGP4MP, RFC 6396 section 4.4, and BGP-4, RFC 4271
// section 4.3). One update can withdraw some IPv4 prefixes and announce others with one AS path; this
// turns each into one row per prefix, which is what the replay, the live view and the physical-IP view need.
//
// Only IPv4 unicast in the message body is read (withdrawn routes and NLRI). IPv6 (MP_REACH/MP_UNREACH),
// state changes and 2-byte-AS messages are skipped; RIS writes 4-byte-AS messages (subtype 4).

import { decodeAsPath, emptyPath, MrtFormatError } from './mrt';

export const MRT_BGP4MP = 16;
export const MRT_BGP4MP_ET = 17;
export const BGP4MP_MESSAGE_AS4 = 4;

const BGP_HEADER_BYTES = 19;
const BGP_UPDATE = 2;
const AFI_IPV4 = 1;
const ATTR_AS_PATH = 2;
const ATTR_NEXT_HOP = 3;
const FLAG_EXTENDED_LENGTH = 0x10;

export interface Prefix {
  readonly addr: number;
  readonly length: number;
}

export interface UpdateMessage {
  // Seconds since the Unix epoch (the MRT record's timestamp).
  readonly time: number;
  // The RIS peer the message came from.
  readonly peerAs: number;
  // The exact BGP-speaking addresses in the MRT header. These are the IPs we can place on the globe.
  readonly peerIp: string;
  readonly localIp: string;
  // The forwarding address from the NEXT_HOP path attribute, or null when the UPDATE has none.
  readonly nextHop: string | null;
  // The complete AS_PATH as text, including sets and confederations (empty for withdrawals).
  readonly asPath: string;
  readonly withdrawn: readonly Prefix[];
  readonly announced: readonly Prefix[];
  // Of the announced prefixes: null when the path is empty or ends in an AS_SET.
  readonly originAs: number | null;
  readonly pathLength: number;
}

function readPrefixes(view: DataView, start: number, end: number, out: Prefix[]): void {
  // Purpose: decode packed IPv4 prefixes (a length in bits, then only the bytes it needs)
  let at = start;
  while (at < end) {
    const length = view.getUint8(at);
    if (length > 32) throw new MrtFormatError(`IPv4 prefix length ${length} is over 32`);
    const bytes = (length + 7) >> 3;
    if (at + 1 + bytes > end) throw new MrtFormatError('A prefix runs past its field');
    let addr = 0;
    for (let i = 0; i < 4; i++) addr = addr * 256 + (i < bytes ? view.getUint8(at + 1 + i) : 0);
    // Bits past the length are not part of the prefix; clear them so equal prefixes compare equal.
    const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
    out.push({ addr: (addr & mask) >>> 0, length });
    at += 1 + bytes;
  }
}

function ipAt(view: DataView, start: number): string {
  // Purpose: the four bytes of an IPv4 address as dotted-quad text
  return [view.getUint8(start), view.getUint8(start + 1), view.getUint8(start + 2), view.getUint8(start + 3)].join('.');
}

export function decodeBgp4mp(view: DataView, time: number, subtype: number, start: number, end: number): UpdateMessage | null {
  // Purpose: one BGP4MP record body as an update, or null when it is not an IPv4 4-byte-AS UPDATE
  if (subtype !== BGP4MP_MESSAGE_AS4) return null;
  if (start + 20 > end) throw new MrtFormatError('BGP4MP header runs past the record');
  const peerAs = view.getUint32(start);
  const afi = view.getUint16(start + 10);
  if (afi !== AFI_IPV4) return null;
  const peerIp = ipAt(view, start + 12);
  const localIp = ipAt(view, start + 16);
  let at = start + 12 + 8; // peer AS, local AS, interface index, AFI, peer and local IPv4 addresses
  if (at + BGP_HEADER_BYTES > end) throw new MrtFormatError('BGP message header runs past the record');
  const length = view.getUint16(at + 16);
  const type = view.getUint8(at + 18);
  if (type !== BGP_UPDATE) return null;
  const messageEnd = at + length;
  if (messageEnd > end || length < BGP_HEADER_BYTES + 4) throw new MrtFormatError('BGP message runs past the record');
  at += BGP_HEADER_BYTES;
  const withdrawnLength = view.getUint16(at);
  const withdrawnEnd = at + 2 + withdrawnLength;
  if (withdrawnEnd + 2 > messageEnd) throw new MrtFormatError('Withdrawn routes run past the message');
  const withdrawn: Prefix[] = [];
  readPrefixes(view, at + 2, withdrawnEnd, withdrawn);
  const attrsLength = view.getUint16(withdrawnEnd);
  const attrsStart = withdrawnEnd + 2;
  const attrsEnd = attrsStart + attrsLength;
  if (attrsEnd > messageEnd) throw new MrtFormatError('Path attributes run past the message');
  const announced: Prefix[] = [];
  readPrefixes(view, attrsEnd, messageEnd, announced);
  let path = emptyPath();
  let nextHop: string | null = null;
  for (let a = attrsStart; a < attrsEnd; ) {
    if (a + 3 > attrsEnd) throw new MrtFormatError('Path attribute header runs past the attributes');
    const flags = view.getUint8(a);
    const attrType = view.getUint8(a + 1);
    const extended = (flags & FLAG_EXTENDED_LENGTH) !== 0;
    const valueLength = extended ? view.getUint16(a + 2) : view.getUint8(a + 2);
    const valueStart = a + (extended ? 4 : 3);
    const valueEnd = valueStart + valueLength;
    if (valueEnd > attrsEnd) throw new MrtFormatError('Path attribute runs past the attributes');
    if (attrType === ATTR_AS_PATH) path = decodeAsPath(view, valueStart, valueEnd, true);
    if (attrType === ATTR_NEXT_HOP && valueLength >= 4) nextHop = ipAt(view, valueStart);
    a = valueEnd;
  }
  if (withdrawn.length === 0 && announced.length === 0) return null;
  return {
    time,
    peerAs,
    peerIp,
    localIp,
    nextHop,
    asPath: path.text,
    withdrawn,
    announced,
    originAs: announced.length > 0 ? path.originAs : null,
    pathLength: path.pathLength,
  };
}
