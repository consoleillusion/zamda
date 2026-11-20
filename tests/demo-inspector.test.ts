// T-512: the pure logic behind the deck's route table, path river and concept
// cards. DOM wiring and engine answers are checked in the browser.

import { describe, expect, test } from 'bun:test';
import {
  FLOW_GROUPS,
  MAX_RIVER_ORIGINS,
  TABLE_ROWS,
  conceptFor,
  flowRows,
  riverLayout,
  routeRows,
  windowRows,
} from '../demo/inspector';

const routes = [
  { prefix_addr: 0x01000000, prefix_len: 24, origin_as: 13335, as_name: 'CLOUDFLARENET', path_len: 2, rir: 'APNIC' },
  { prefix_addr: 0x01010100, prefix_len: 24, origin_as: 13335, as_name: 'CLOUDFLARENET', path_len: 3, rir: 'APNIC' },
  { prefix_addr: 0x08080800, prefix_len: 24, origin_as: 15169, as_name: 'GOOGLE', path_len: 2, rir: 'ARIN' },
  { prefix_addr: 0x0a000000, prefix_len: 8, origin_as: 64512, as_name: null, path_len: 5, rir: null },
];

describe('route table rows', () => {
  test('addresses become readable prefixes and names keep their null state', () => {
    expect(routeRows(routes)).toEqual([
      { addr: 0x01000000, prefix: '1.0.0.0/24', origin: 13335, name: 'CLOUDFLARENET', rir: 'APNIC', pathLen: 2 },
      { addr: 0x01010100, prefix: '1.1.1.0/24', origin: 13335, name: 'CLOUDFLARENET', rir: 'APNIC', pathLen: 3 },
      { addr: 0x08080800, prefix: '8.8.8.0/24', origin: 15169, name: 'GOOGLE', rir: 'ARIN', pathLen: 2 },
      { addr: 0x0a000000, prefix: '10.0.0.0/8', origin: 64512, name: null, rir: null, pathLen: 5 },
    ]);
  });

  test('the table is bounded to the first matching routes, not the whole table', () => {
    const many = Array.from({ length: TABLE_ROWS + 10 }, (_, i) => ({ ...routes[0]!, prefix_addr: i }));
    expect(routeRows(many)).toHaveLength(TABLE_ROWS);
  });

  test('windowing draws a stable neighbourhood of the scroll position', () => {
    const rows = routeRows(routes);
    const top = windowRows(rows, 0, 40, 20);
    expect(top.start).toBe(0);
    expect(top.visible.map(r => r.prefix)).toEqual(['1.0.0.0/24', '1.1.1.0/24', '8.8.8.0/24']);
    expect(top.padTop).toBe(0);
    expect(top.padBottom).toBe(20);

    const low = windowRows(rows, 25, 40, 20);
    expect(low.start).toBe(0);
    expect(low.visible).toHaveLength(4);

    const high = windowRows(rows, 10_000, 40, 20);
    expect(high.end).toBe(rows.length);
    expect(high.visible).toEqual([]);
    expect(high.padTop).toBe(rows.length * 20);
  });
});

describe('path river', () => {
  const flows = [
    { origin_as: 13335, as_name: 'CLOUDFLARENET', path_len: 2, routes: 30 },
    { origin_as: 13335, as_name: 'CLOUDFLARENET', path_len: 3, routes: 10 },
    { origin_as: 15169, as_name: 'GOOGLE', path_len: 2, routes: 20 },
    { origin_as: 64512, as_name: null, path_len: 5, routes: 5 },
  ];

  test('flow rows are strongest first, named, and bounded', () => {
    expect(flowRows(flows)).toEqual([
      { origin: 13335, name: 'CLOUDFLARENET', pathLen: 2, routes: 30 },
      { origin: 15169, name: 'GOOGLE', pathLen: 2, routes: 20 },
      { origin: 13335, name: 'CLOUDFLARENET', pathLen: 3, routes: 10 },
      { origin: 64512, name: null, pathLen: 5, routes: 5 },
    ]);
    const noisy = Array.from({ length: FLOW_GROUPS + 5 }, (_, i) => ({ ...flows[0]!, origin_as: i + 1, routes: i + 1 }));
    expect(flowRows(noisy)).toHaveLength(FLOW_GROUPS);
  });

  test('the river has one node per origin and hop count, with a ribbon per flow', () => {
    const layout = riverLayout(flowRows(flows), 480, 180);
    expect(layout.origins.map(n => n.id)).toEqual(['AS13335', 'AS15169', 'AS64512']);
    expect(layout.paths.map(n => n.id)).toEqual(['2', '3', '5']);
    expect(layout.ribbons).toHaveLength(4);
    expect(layout.maxRoutes).toBe(30);
    expect(layout.ribbons[0]).toMatchObject({ origin: 13335, pathLen: 2, routes: 30 });
    expect(layout.ribbons[0]!.d).toMatch(/^M [\d.]+ [\d.]+ C /);
    expect(layout.ribbons[0]!.width).toBeGreaterThan(1);
    for (const node of layout.origins) expect(node.y + node.height).toBeLessThanOrEqual(180);
    for (const node of layout.paths) expect(node.y + node.height).toBeLessThanOrEqual(180);
  });

  test('the river never exceeds its origin budget', () => {
    const many = Array.from({ length: MAX_RIVER_ORIGINS + 8 }, (_, i) => ({
      origin_as: 100 + i,
      as_name: null,
      path_len: 2,
      routes: 20 - i,
    }));
    const layout = riverLayout(flowRows(many), 480, 180);
    expect(layout.origins).toHaveLength(MAX_RIVER_ORIGINS);
    expect(layout.ribbons).toHaveLength(MAX_RIVER_ORIGINS);
    expect(layout.droppedOrigins).toBe(8);
  });
});

describe('concept cards', () => {
  test('the overview and table cards explain what the engine is doing', () => {
    expect(conceptFor('overview').body).toContain('compiled');
    expect(conceptFor('table').body).toContain(String(TABLE_ROWS));
  });

  test('the river card admits the snapshot has no hop identities', () => {
    expect(conceptFor('river').body).toContain('not the sequence');
  });

  test('a traced AS names the caveat about adjacency and circuits', () => {
    const card = conceptFor('trace', 13335);
    expect(card.title).toContain('AS13335');
    expect(card.body).toContain('not physical circuits');
  });
});
