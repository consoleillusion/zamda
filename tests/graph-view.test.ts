// Tests for the graph view's data selection. The renderer in demo/graph-view.ts
// needs a DOM and WebGL; everything that decides what it draws is here.

import { describe, expect, test } from 'bun:test';
import { table } from '../src';
import type { JsTable } from '../src';
import type { GraphArrays } from '../scripts/bgp/graph-file';
import { GraphEdges } from '../scripts/bgp/graph-file';
import {
  allEdges,
  buildViewData,
  compileGraphPlans,
  edgeKey,
  FOCUS_RATIO,
  frameCamera,
  hotKeys,
  neighbourhoodEdges,
  overviewEdges,
} from '../demo/graph-data';

function sample(): { arrays: GraphArrays; edges: JsTable<typeof GraphEdges.fields> } {
  // Purpose: a small chain of ASes with distinct edge weights
  const arrays: GraphArrays = {
    rowCount: 6,
    edgeCount: 6,
    asn: Uint32Array.from([1, 2, 3, 4, 5, 6]),
    paths: Uint32Array.from([100, 90, 80, 70, 60, 50]),
    origins: Uint32Array.from([10, 20, 30, 40, 50, 60]),
    name: ['ONE', null, 'THREE', 'FOUR', 'FIVE', 'SIX'],
    rir: ['ARIN', 'RIPE', 'APNIC', 'ARIN', 'LACNIC', null],
    country: ['US', 'DE', 'JP', 'US', 'BR', null],
    x: Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5]),
    y: Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5]),
    from_as: Uint32Array.from([1, 2, 3, 4, 5, 1]),
    to_as: Uint32Array.from([2, 3, 4, 5, 6, 6]),
    prefixes: Uint32Array.from([10, 9, 8, 7, 6, 1]),
    span_km: Uint16Array.from([100, 200, 300, 400, 500, 9000]),
  };
  const edges = table(GraphEdges, {
    columns: { from_as: arrays.from_as, to_as: arrays.to_as, prefixes: arrays.prefixes, span_km: arrays.span_km },
  });
  return { arrays, edges };
}

describe('graph data selection', () => {
  test('the overview takes the strongest edges first', async () => {
    const { edges } = sample();
    const rows = await overviewEdges(edges, 3);
    expect(rows).toEqual([
      { from_as: 1, to_as: 2, prefixes: 10, span_km: 100 },
      { from_as: 2, to_as: 3, prefixes: 9, span_km: 200 },
      { from_as: 3, to_as: 4, prefixes: 8, span_km: 300 },
    ]);
    const local = await overviewEdges(edges, 10);
    expect(local.length).toBe(5);
    expect(local.some(row => row.from_as === 1 && row.to_as === 6)).toBe(false);
  });

  test('all-data mode returns every edge in file order', async () => {
    const { edges } = sample();
    const rows = await allEdges(edges, compileGraphPlans().all);
    expect(rows.map(r => [r.from_as, r.to_as])).toEqual([
      [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 6],
    ]);
    const view = buildViewData(sample().arrays, rows, { nodeLimit: 6 });
    expect(view.truncated).toBe(0);
    expect(view.edges.length).toBe(6);
  });

  test('a neighbourhood expands two hops and keeps the strongest edges', async () => {
    const { edges } = sample();
    const plans = compileGraphPlans();
    const rows = await neighbourhoodEdges(edges, plans, 3, 10);
    expect(rows).toEqual([
      { from_as: 1, to_as: 2, prefixes: 10, span_km: 100 },
      { from_as: 2, to_as: 3, prefixes: 9, span_km: 200 },
      { from_as: 3, to_as: 4, prefixes: 8, span_km: 300 },
      { from_as: 4, to_as: 5, prefixes: 7, span_km: 400 },
    ]);
  });

  test('live activity keys mark the edge and both endpoints without moving positions', () => {
    const hot = hotKeys([
      { from_as: 1, to_as: 2, updates: 4 },
      { from_as: 2, to_as: 3, updates: 2 },
      { from_as: 1, to_as: 2, updates: 3 },
    ]);
    expect(hot.get(edgeKey(1, 2))).toBe(4);
    expect(hot.get(edgeKey(2, 3))).toBe(2);
    expect(hot.get('1')).toBe(4);
    expect(hot.get('2')).toBe(4);
    expect(hot.get('3')).toBe(2);
    expect(hot.size).toBe(5);
  });

  test('view data keeps only nodes that can draw the chosen edges', async () => {
    const { arrays, edges } = sample();
    const rows = await overviewEdges(edges, 6);
    const view = buildViewData(arrays, rows, { nodeLimit: 4 });
    expect(view.nodes.map(n => n.asn)).toEqual([1, 2, 3, 4]);
    expect(view.nodes[1]).toMatchObject({ asn: 2, name: null, label: 'AS2', rir: 'RIPE', country: 'DE' });
    expect(view.edges.map(e => [e.from, e.to, e.weight, e.spanKm])).toEqual([
      [1, 2, 10, 100],
      [2, 3, 9, 200],
      [3, 4, 8, 300],
    ]);
    expect(view.truncated).toBe(2);
  });

  test('the default view frames closer, and a click focus zooms in further', async () => {
    const { arrays, edges } = sample();
    const world = {
      ...arrays,
      x: Float32Array.from([-0.8, 0.8, -0.8, 0.8, -0.8, 0.8]),
      y: Float32Array.from([-0.8, -0.8, 0.8, 0.8, -0.8, 0.8]),
    };
    const rows = await allEdges(edges);
    const frame = frameCamera(buildViewData(world, rows, { nodeLimit: 6 }));
    expect(frame.ratio).toBeLessThan(1);
    expect(FOCUS_RATIO).toBeLessThan(frame.ratio);
    expect(FOCUS_RATIO).toBeLessThan(1);
  });
});
