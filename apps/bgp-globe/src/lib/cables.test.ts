import { expect, test } from 'bun:test';
import { asPathAsns, asPathHops, buildCableGraph, collectPhysicalRoutes, physicalAlternatives } from './cables';

test('an AS path yields origin-to-peer hops without inventing links across a set', () => {
  expect(asPathHops('20 30 40')).toEqual([[40, 30], [30, 20]]);
  expect(asPathHops('20 30 30 40')).toEqual([[40, 30], [30, 20]]);
  expect(asPathHops('20 30 {50 60} 40')).toEqual([[30, 20]]);
  expect(asPathHops('')).toEqual([]);
  expect(asPathAsns('20 30 {50 60} 40')).toEqual([20, 30, 40]);
});

test('physical alternatives include distinct cable paths between the same places', () => {
  // Two parallel lines from A to D: A-B-D and A-C-D. The router endpoints sit next to A and D.
  const graph = buildCableGraph({
    features: [
      { geometry: { coordinates: [[[0, 0], [1, 0], [1, 1]]] } },
      { geometry: { coordinates: [[[0, 0], [0, 1], [1, 1]]] } },
    ],
  });
  const paths = physicalAlternatives(graph, { lon: 0.01, lat: 0.01 }, { lon: 0.99, lat: 0.99 });
  expect(paths.length).toBeGreaterThan(1);
  const keys = new Set(paths.map(path => path.map(([lon, lat]) => `${lon.toFixed(2)},${lat.toFixed(2)}`).join(';')));
  expect(keys.size).toBe(paths.length);
  expect(paths.some(path => path.some(([lon, lat]) => lon === 1 && lat === 0))).toBe(true);
  expect(paths.some(path => path.some(([lon, lat]) => lon === 0 && lat === 1))).toBe(true);
});

test('every AS-hop alternative is drawn once and co-located routes merge into it', () => {
  const graph = buildCableGraph({
    features: [
      { geometry: { coordinates: [[[0, 0], [1, 0], [1, 1]]] } },
      { geometry: { coordinates: [[[0, 0], [0, 1], [1, 1]]] } },
    ],
  });
  const route = {
    originAs: 40, peerAs: 20, nextHop: 1234, path: '20 30 40',
    originLon: 0.01, originLat: 0.01, prefixes: 3, count: 5,
  };
  const lookup = {
    asnPoint: (asn: number) => asn === 30 ? { lon: 0.5, lat: 0.5 } : null,
    ipPoint: (_ip: number) => ({ lon: 0.99, lat: 0.99 }),
  };
  const groups = collectPhysicalRoutes(graph, [route, { ...route, count: 2, prefixes: 1 }], lookup);
  expect(new Set(groups.map(group => `${group.fromAs}>${group.toAs}`))).toEqual(new Set(['40>30', '30>20']));
  expect(groups.every(group => group.count === 7 && group.prefixes === 4 && group.routes === 2)).toBe(true);
  expect(groups.filter(group => group.fromAs === 40).length).toBeGreaterThan(1);
  expect(groups.filter(group => group.fromAs === 30).length).toBeGreaterThan(1);
});
