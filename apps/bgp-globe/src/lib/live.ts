// Live BGP updates: RIPE RIS Live over a WebSocket, or, when it cannot be reached, the recorded hour
// played back at real speed. Either way the page receives batches of update rows once a second.
//
// RIS Live sends one JSON message per BGP UPDATE that a RIS peer sent to a collector: the AS path, the
// announced prefixes (grouped by next hop) and the withdrawn prefixes. Each IPv4 prefix becomes a row.

import type { UpdateColumns } from './data';

export const RIS_LIVE_URL = 'wss://ris-live.ripe.net/v1/ws/?client=zamda-bgp-globe';

export interface LiveRow {
  second: number;
  kind: 0 | 1;
  prefix_addr: number;
  prefix_len: number;
  // For a withdrawal the message carries no path: 0 until the page fills it from the routing table.
  origin_as: number;
  peer_as: number;
  path_len: number;
}

export type FeedSource = 'ris-live' | 'recorded';

export interface Feed {
  readonly source: FeedSource;
  stop(): void;
}

export interface FeedHandlers {
  onBatch(rows: LiveRow[]): void;
  onStatus(source: FeedSource, message: string): void;
}

export function parsePrefix(text: unknown): { addr: number; len: number } | null {
  // Purpose: an IPv4 CIDR string as a network address and length, or null for IPv6 or anything malformed
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (m === null) return null;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const len = Number(m[5]);
  if (octets.some(o => o > 255) || len > 32) return null;
  const addr = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { addr: (addr & mask) >>> 0, len };
}

function asn(value: unknown): number | null {
  // Purpose: a valid 32-bit AS number, or null (an AS set arrives as an array)
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

export function parseRisMessage(raw: string): LiveRow[] {
  // Purpose: one RIS Live message as rows: one per IPv4 prefix announced or withdrawn
  let message: { type?: unknown; data?: Record<string, unknown> };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    return [];
  }
  if (message.type !== 'ris_message' || message.data?.type !== 'UPDATE') return [];
  const data = message.data;
  const second = typeof data.timestamp === 'number' ? Math.floor(data.timestamp) : null;
  const peer = asn(Number(data.peer_asn));
  if (second === null || peer === null) return [];
  const path = Array.isArray(data.path) ? data.path : [];
  const origin = path.length > 0 ? asn(path[path.length - 1]) : null;
  const rows: LiveRow[] = [];
  if (Array.isArray(data.withdrawals)) {
    for (const text of data.withdrawals) {
      const p = parsePrefix(text);
      if (p !== null) rows.push({ second, kind: 1, prefix_addr: p.addr, prefix_len: p.len, origin_as: 0, peer_as: peer, path_len: 0 });
    }
  }
  if (origin !== null && Array.isArray(data.announcements)) {
    for (const group of data.announcements as { prefixes?: unknown }[]) {
      if (!Array.isArray(group?.prefixes)) continue;
      for (const text of group.prefixes) {
        const p = parsePrefix(text);
        if (p !== null) rows.push({ second, kind: 0, prefix_addr: p.addr, prefix_len: p.len, origin_as: origin, peer_as: peer, path_len: Math.min(255, path.length) });
      }
    }
  }
  return rows;
}

function connectRisLive(handlers: FeedHandlers, onFail: () => void): Feed {
  // Purpose: subscribe to RIS Live (one collector, IPv4 and IPv6 updates; IPv6 is dropped here)
  let buffer: LiveRow[] = [];
  let opened = false;
  let stopped = false;
  const socket = new WebSocket(RIS_LIVE_URL);
  const timeout = setTimeout(() => {
    if (!opened) {
      socket.close();
      onFail();
    }
  }, 6000);
  socket.onopen = () => {
    opened = true;
    clearTimeout(timeout);
    socket.send(JSON.stringify({ type: 'ris_subscribe', data: { type: 'UPDATE', host: 'rrc00', socketOptions: { includeRaw: false } } }));
    handlers.onStatus('ris-live', 'connected to RIPE RIS Live (collector rrc00)');
  };
  socket.onmessage = event => {
    for (const row of parseRisMessage(String(event.data))) buffer.push(row);
  };
  socket.onclose = () => {
    clearTimeout(timeout);
    if (!stopped && opened) handlers.onStatus('ris-live', 'RIS Live closed the connection');
    if (!stopped && !opened) onFail();
  };
  socket.onerror = () => undefined;
  const tick = setInterval(() => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    handlers.onBatch(batch);
  }, 1000);
  return {
    source: 'ris-live',
    stop() {
      // Purpose: close the socket
      stopped = true;
      clearInterval(tick);
      clearTimeout(timeout);
      socket.close();
    },
  };
}

export function playRecorded(updates: UpdateColumns, handlers: FeedHandlers): Feed {
  // Purpose: the recorded hour as a live feed: each second's rows arrive at that second of wall time, looping
  const c = updates.columns;
  const offset = Math.floor(Date.now() / 1000);
  let second = 0;
  let row = 0;
  handlers.onStatus('recorded', `playing back RIS updates recorded at ${new Date(updates.start * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC as if live`);
  const tick = setInterval(() => {
    const batch: LiveRow[] = [];
    while (row < updates.rows && c.second[row]! <= second) {
      batch.push({
        second: offset + second,
        kind: c.kind[row] as 0 | 1,
        prefix_addr: c.prefix_addr[row]!,
        prefix_len: c.prefix_len[row]!,
        origin_as: c.origin_as[row]!,
        peer_as: c.peer_as[row]!,
        path_len: c.path_len[row]!,
      });
      row++;
    }
    second++;
    if (row >= updates.rows) {
      row = 0;
      second = 0;
    }
    if (batch.length > 0) handlers.onBatch(batch);
  }, 1000);
  return {
    source: 'recorded',
    stop() {
      // Purpose: stop the playback
      clearInterval(tick);
    },
  };
}

export function startFeed(updates: UpdateColumns, handlers: FeedHandlers, prefer: FeedSource = 'ris-live'): Feed {
  // Purpose: RIS Live if it answers, otherwise the recorded hour
  if (prefer === 'recorded' || typeof WebSocket === 'undefined') return playRecorded(updates, handlers);
  let current: Feed | null = null;
  const live = connectRisLive(handlers, () => {
    handlers.onStatus('recorded', 'RIS Live did not answer; switching to the recorded hour');
    current = playRecorded(updates, handlers);
  });
  current = live;
  return {
    get source() {
      return current!.source;
    },
    stop() {
      // Purpose: stop whichever feed is running
      live.stop();
      current?.stop();
    },
  } as Feed;
}
