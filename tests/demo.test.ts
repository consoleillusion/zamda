// Tests for the reference dashboard's logic (docs/TASKS.md, T-206): linked
// filters, parameter values, address ranges, and RIS Live message parsing.
// The page itself is checked by rendering it in a browser.

import { describe, expect, test } from 'bun:test';
import { table } from '../src';
import { Routes } from '../scripts/bgp/file';
import {
  EMPTY_SELECTION,
  affectedBy,
  compilePlans,
  nameIndex,
  paramsFor,
  parseAddressRange,
  summariseNetworks,
} from '../demo/dashboard';
import type { Selection } from '../demo/dashboard';
import { compileLivePlans, createUpdatesTable, parseRisMessage, subscribeMessage } from '../demo/live';

const routes = table(Routes, [
  { prefix_addr: 0x01000000, prefix_len: 24, origin_as: 13335, as_name: 'CLOUDFLARENET', path_len: 2, rir: 'APNIC' },
  { prefix_addr: 0x01010100, prefix_len: 24, origin_as: 13335, as_name: 'CLOUDFLARENET', path_len: 3, rir: 'APNIC' },
  { prefix_addr: 0x08080800, prefix_len: 24, origin_as: 15169, as_name: 'GOOGLE', path_len: 2, rir: 'ARIN' },
  { prefix_addr: 0x0a000000, prefix_len: 8, origin_as: 64512, as_name: null, path_len: 5, rir: null },
  { prefix_addr: 0xc0000200, prefix_len: 23, origin_as: 3356, as_name: 'LEVEL3', path_len: 4, rir: 'ARIN' },
]);

const plans = compilePlans();

async function totals(selection: Selection, chart: 'networks' | 'prefixLen' = 'networks') {
  // Purpose: matching routes for a selection, as the totals line or one chart sees it
  if (chart === 'prefixLen') {
    const rows = (await plans.prefixLen.execute(routes, { params: paramsFor(selection, 'prefixLen') })).toArray();
    return rows.reduce((sum, r) => sum + r.routes!, 0);
  }
  return summariseNetworks(await plans.networks.execute(routes, { params: paramsFor(selection, 'networks') })).routes;
}

describe('linked filters', () => {
  test('with nothing selected every route counts, including ones with no name or region', async () => {
    expect(await totals(EMPTY_SELECTION)).toBe(5);
  });

  test('each control filters', async () => {
    expect(await totals({ ...EMPTY_SELECTION, prefixLen: [24, 24] })).toBe(3);
    expect(await totals({ ...EMPTY_SELECTION, pathLen: [3, 5] })).toBe(3);
    expect(await totals({ ...EMPTY_SELECTION, regions: ['ARIN'] })).toBe(2);
    expect(await totals({ ...EMPTY_SELECTION, regions: [] })).toBe(0);
    expect(await totals({ ...EMPTY_SELECTION, search: '  Cloud ' })).toBe(2);
    expect(await totals({ ...EMPTY_SELECTION, addr: [0x01000000, 0x01ffffff] })).toBe(2);
  });

  test('a chart ignores its own selection but applies the others', async () => {
    const selection: Selection = { ...EMPTY_SELECTION, prefixLen: [8, 8], regions: ['APNIC', 'ARIN'] };
    // The prefix-length chart ignores [8, 8] but keeps the region filter: 4 routes.
    expect(await totals(selection, 'prefixLen')).toBe(4);
    // Everything else applies both: the /8 has no region, so nothing matches.
    expect(await totals(selection)).toBe(0);
  });

  test('the top networks chart and the totals line come from one result', async () => {
    const summary = summariseNetworks(await plans.networks.execute(routes, { params: paramsFor(EMPTY_SELECTION, 'networks') }));
    expect(summary.top[0]).toEqual({ origin: 13335, name: 'CLOUDFLARENET', routes: 2 });
    expect(summary.top.length).toBe(4);
    expect(summary.networks).toBe(4);
    expect(summary.routes).toBe(5);
    // Ties on route count go to the lower AS number; a missing name stays null.
    expect(summary.top.map(r => r.origin)).toEqual([13335, 3356, 15169, 64512]);
    expect(summary.top[3]!.name).toBeNull();
  });

  test('the top list keeps only the requested number, best first', async () => {
    const result = await plans.networks.execute(routes, { params: paramsFor(EMPTY_SELECTION, 'networks') });
    const two = summariseNetworks(result, 2);
    expect(two.top.map(r => r.origin)).toEqual([13335, 3356]);
    // Totals still cover every network, not just the ones listed.
    expect(two.routes).toBe(5);
    expect(two.networks).toBe(4);
  });

  test('touching a chart re-runs every chart except that one', () => {
    expect(affectedBy('prefixLen')).toEqual(['networks', 'pathLen', 'regions']);
    expect(affectedBy('search')).toEqual(['networks', 'prefixLen', 'pathLen', 'regions']);
  });

  test('network names for the live panel', async () => {
    const names = nameIndex(await plans.networks.execute(routes, { params: paramsFor(EMPTY_SELECTION, 'networks') }));
    expect(names.get(15169)).toBe('GOOGLE');
    expect(names.has(64512)).toBe(false);
  });
});

describe('address ranges', () => {
  test('a prefix covers its block; a bare address is /32; bad input is reported', () => {
    expect(parseAddressRange('10.0.0.0/8')).toEqual([0x0a000000, 0x0affffff]);
    expect(parseAddressRange(' 10.1.2.3/8 ')).toEqual([0x0a000000, 0x0affffff]);
    expect(parseAddressRange('192.0.2.7')).toEqual([0xc0000207, 0xc0000207]);
    expect(parseAddressRange('0.0.0.0/0')).toEqual([0, 4294967295]);
    expect(parseAddressRange('')).toBeNull();
    expect(parseAddressRange('300.1.1.1')).toBe('invalid');
    expect(parseAddressRange('10.0.0.0/33')).toBe('invalid');
    expect(parseAddressRange('example.com')).toBe('invalid');
  });
});

const ANNOUNCE = JSON.stringify({
  type: 'ris_message',
  data: {
    timestamp: 1763337600.42,
    peer: '198.51.100.1',
    peer_asn: '64496',
    host: 'rrc00.ripe.net',
    type: 'UPDATE',
    path: [64496, 3356, 13335],
    announcements: [
      { next_hop: '198.51.100.1', prefixes: ['1.1.1.0/24', '2001:db8::/32'] },
      { next_hop: '198.51.100.2', prefixes: ['104.16.0.0/13'] },
    ],
    withdrawals: ['203.0.113.0/24'],
  },
});

describe('RIS Live messages', () => {
  test('one row per IPv4 prefix; IPv6 dropped; withdrawals have no origin', () => {
    expect(parseRisMessage(ANNOUNCE)).toEqual([
      { second: 1763337600, kind: 'announce', prefix_len: 24, origin_as: 13335, peer_asn: 64496 },
      { second: 1763337600, kind: 'announce', prefix_len: 13, origin_as: 13335, peer_asn: 64496 },
      { second: 1763337600, kind: 'withdraw', prefix_len: 24, origin_as: null, peer_asn: 64496 },
    ]);
  });

  test('a path ending in an AS set has no origin', () => {
    const msg = JSON.parse(ANNOUNCE);
    msg.data.path = [64496, [1, 2]];
    expect(parseRisMessage(JSON.stringify(msg))[0]!.origin_as).toBeNull();
  });

  test('anything that is not a well-formed UPDATE gives no rows', () => {
    expect(parseRisMessage('not json')).toEqual([]);
    expect(parseRisMessage(JSON.stringify({ type: 'ris_subscribe_ok', data: {} }))).toEqual([]);
    expect(parseRisMessage(JSON.stringify({ type: 'ris_message', data: { type: 'KEEPALIVE', timestamp: 1, peer_asn: '1' } }))).toEqual([]);
    const noPeer = JSON.parse(ANNOUNCE);
    delete noPeer.data.peer_asn;
    expect(parseRisMessage(JSON.stringify(noPeer))).toEqual([]);
    const badPrefix = JSON.parse(ANNOUNCE);
    badPrefix.data.announcements = [{ prefixes: ['1.1.1.0/40', 'junk', 7] }];
    badPrefix.data.withdrawals = null;
    expect(parseRisMessage(JSON.stringify(badPrefix))).toEqual([]);
  });

  test('the subscription asks for UPDATE messages from one collector', () => {
    expect(JSON.parse(subscribeMessage('rrc00'))).toEqual({ type: 'ris_subscribe', data: { host: 'rrc00', type: 'UPDATE' } });
  });

  test('live queries over appended updates', async () => {
    const live = createUpdatesTable();
    live.append(parseRisMessage(ANNOUNCE));
    live.append([{ second: 1763337607, kind: 'announce', prefix_len: 24, origin_as: 15169, peer_asn: 1 }]);
    const plans = compileLivePlans();
    const params = { params: { since: 1763337600 } };
    expect((await plans.totals.execute(live, params)).toArray()).toEqual([
      { kind: 'announce', updates: 3 },
      { kind: 'withdraw', updates: 1 },
    ]);
    expect((await plans.active.execute(live, params)).toArray()).toEqual([
      { origin_as: 13335, updates: 2 },
      { origin_as: 15169, updates: 1 },
    ]);
    expect((await plans.activity.execute(live, params)).toArray()).toEqual([
      { bucket: 1763337600, kind: 'announce', updates: 2 },
      { bucket: 1763337600, kind: 'withdraw', updates: 1 },
      { bucket: 1763337605, kind: 'announce', updates: 1 },
    ]);
    expect((await plans.totals.execute(live, { params: { since: 1763337601 } })).toArray()).toEqual([
      { kind: 'announce', updates: 1 },
    ]);
  });
});
