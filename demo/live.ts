// The live panel's data: BGP updates from RIPE RIS Live, appended to a zamda
// table with a rolling window (docs/TASKS.md, T-204).
//
// RIS Live sends JSON over a WebSocket. An UPDATE message carries the AS path,
// a list of announced prefixes grouped by next hop, and a list of withdrawn
// prefixes. Each IPv4 prefix becomes one row here.

import { count, pipe, schema, t, table } from '../src';
import type { JsTable } from '../src';

export const RIS_LIVE_URL = 'wss://ris-live.ripe.net/v1/ws/?client=zamda-demo';

export const Updates = schema({
  second: t.uint32,
  kind: t.dictionary,
  prefix_len: t.uint8,
  origin_as: t.uint32,
  peer_asn: t.uint32,
});

export type UpdateRow = {
  second: number;
  kind: 'announce' | 'withdraw';
  prefix_len: number;
  origin_as: number | null;
  peer_asn: number;
};

export type UpdatesTable = JsTable<typeof Updates.fields>;

// How many updates the live table keeps.
export const LIVE_WINDOW_ROWS = 200_000;
// How many seconds the activity chart covers, and its bucket width.
export const ACTIVITY_SECONDS = 300;
export const ACTIVITY_BUCKET = 5;

function ipv4Length(prefix: unknown): number | null {
  // Purpose: the length of an IPv4 CIDR prefix, or null for IPv6 or anything malformed
  if (typeof prefix !== 'string' || prefix.includes(':')) return null;
  const slash = prefix.indexOf('/');
  if (slash === -1) return null;
  const length = Number(prefix.slice(slash + 1));
  return Number.isInteger(length) && length >= 0 && length <= 32 ? length : null;
}

function originOf(path: unknown): number | null {
  // Purpose: the last AS of the path, or null when the path is missing or ends in an AS set
  if (!Array.isArray(path) || path.length === 0) return null;
  const last: unknown = path[path.length - 1];
  return typeof last === 'number' && Number.isInteger(last) && last >= 0 && last <= 4294967295 ? last : null;
}

export function parseRisMessage(raw: string): UpdateRow[] {
  // Purpose: one row per IPv4 prefix announced or withdrawn in a RIS Live UPDATE; anything else gives no rows
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return [];
  }
  const m = message as { type?: unknown; data?: Record<string, unknown> };
  if (m.type !== 'ris_message' || !m.data || m.data.type !== 'UPDATE') return [];
  const data = m.data;
  const second = typeof data.timestamp === 'number' ? Math.floor(data.timestamp) : null;
  const peer = Number(data.peer_asn);
  if (second === null || second < 0 || !Number.isInteger(peer) || peer < 0 || peer > 4294967295) return [];
  const rows: UpdateRow[] = [];
  const origin = originOf(data.path);
  if (Array.isArray(data.announcements)) {
    for (const group of data.announcements as { prefixes?: unknown }[]) {
      if (!group || !Array.isArray(group.prefixes)) continue;
      for (const prefix of group.prefixes) {
        const length = ipv4Length(prefix);
        if (length !== null) rows.push({ second, kind: 'announce', prefix_len: length, origin_as: origin, peer_asn: peer });
      }
    }
  }
  if (Array.isArray(data.withdrawals)) {
    for (const prefix of data.withdrawals) {
      const length = ipv4Length(prefix);
      // A withdrawal carries no path, so it has no origin.
      if (length !== null) rows.push({ second, kind: 'withdraw', prefix_len: length, origin_as: null, peer_asn: peer });
    }
  }
  return rows;
}

export function subscribeMessage(host: string): string {
  // Purpose: the RIS Live subscription for UPDATE messages from one collector
  return JSON.stringify({ type: 'ris_subscribe', data: { host, type: 'UPDATE' } });
}

export function createUpdatesTable(): UpdatesTable {
  // Purpose: an empty live table that keeps the most recent updates
  return table(Updates, [], { retain: { rows: LIVE_WINDOW_ROWS } });
}

export function compileLivePlans() {
  // Purpose: the live panel's queries, all parameterised by the earliest second to include
  const recent = pipe(Updates, { since: t.uint32 }).filter((c, p) => c.second.gte(p.since));
  return {
    activity: recent
      .groupBy(c => ({ bucket: c.second.bin(ACTIVITY_BUCKET), kind: c.kind }))
      .agg(() => ({ updates: count() }))
      .compile(),
    active: recent
      .filter(c => c.kind.eq('announce').and(c.origin_as.isNull().not()))
      .groupBy(c => ({ origin_as: c.origin_as }))
      .agg(() => ({ updates: count() }))
      .sort(c => [c.updates.desc(), c.origin_as.asc()])
      .limit(8)
      .compile(),
    totals: recent
      .groupBy(c => ({ kind: c.kind }))
      .agg(() => ({ updates: count() }))
      .compile(),
  };
}

export type LivePlans = ReturnType<typeof compileLivePlans>;

export interface Feed {
  close(): void;
}

export interface FeedHandlers {
  onRows(rows: UpdateRow[]): void;
  onStatus(status: string): void;
}

export function connectRisLive(host: string, handlers: FeedHandlers): Feed {
  // Purpose: stream updates from RIS Live, reconnecting after a drop
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  const open = function (): void {
    // Purpose: open the WebSocket and subscribe
    handlers.onStatus('connecting to RIS Live...');
    socket = new WebSocket(RIS_LIVE_URL);
    socket.onopen = function () {
      // Purpose: subscribe once connected
      retry = 1000;
      socket!.send(subscribeMessage(host));
      handlers.onStatus(`live from RIS Live, collector ${host}`);
    };
    socket.onmessage = function (event) {
      // Purpose: turn each message into rows
      const rows = parseRisMessage(String(event.data));
      if (rows.length > 0) handlers.onRows(rows);
    };
    socket.onclose = function () {
      // Purpose: reconnect with backoff unless the page closed the feed
      if (closed) return;
      handlers.onStatus(`RIS Live disconnected; retrying in ${retry / 1000} s`);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  };
  open();
  return {
    close() {
      // Purpose: stop the feed for good
      closed = true;
      socket?.close();
    },
  };
}

export function simulateFeed(
  originsNow: () => readonly number[],
  updatesPerSecond: number,
  handlers: FeedHandlers,
): Feed {
  // Purpose: a stand-in feed with RIS-shaped bursts, for offline use and testing (?live=sim)
  handlers.onStatus(`simulated feed, about ${updatesPerSecond} updates per second`);
  let seed = 7;
  const random = function (): number {
    // Purpose: deterministic PRNG so runs look the same
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const timer = setInterval(function () {
    // Purpose: emit a quarter-second of updates, with an occasional burst from one network
    const now = Math.floor(Date.now() / 1000);
    const rows: UpdateRow[] = [];
    // The network list may not exist yet when the feed starts.
    const origins = originsNow();
    const burst = random() < 0.05 ? origins[Math.floor(random() * origins.length)]! : null;
    const n = Math.round((updatesPerSecond / 4) * (0.5 + random()) * (burst ? 6 : 1));
    for (let i = 0; i < n; i++) {
      const withdraw = random() < 0.15;
      const origin = burst !== null && random() < 0.7 ? burst : origins[Math.floor(random() ** 2 * origins.length)]!;
      rows.push({
        second: now,
        kind: withdraw ? 'withdraw' : 'announce',
        prefix_len: random() < 0.6 ? 24 : 16 + Math.floor(random() * 9),
        origin_as: withdraw ? null : origin,
        peer_asn: 1000 + Math.floor(random() * 50),
      });
    }
    handlers.onRows(rows);
  }, 250);
  return {
    close() {
      // Purpose: stop the simulated feed
      clearInterval(timer);
    },
  };
}
