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
    x: Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5]),
    y: Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5]),
    from_as: Uint32Array.from([1, 2, 3, 4, 5, 1]),
    to_as: Uint32Array.from([2, 3, 4, 5, 6, 6]),
    prefixes: Uint32Array.from([10, 9, 8, 7, 6, 1]),
  };
  const edges = table(GraphEdges, {
    columns: { from_as: arrays.from_as, to_as: arrays.to_as, prefixes: arrays.prefixes },
  });
  return { arrays, edges };
}

describe('graph data selection', () => {
  test('the overview takes the strongest edges first', async () => {
    const { edges } = sample();
    const rows = await overviewEdges(edges, 3);
    expect(rows).toEqual([
      { from_as: 1, to_as: 2, prefixes: 10 },
      { from_as: 2, to_as: 3, prefixes: 9 },
      { from_as: 3, to_as: 4, prefixes: 8 },
    ]);
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
      { from_as: 1, to_as: 2, prefixes: 10 },
      { from_as: 2, to_as: 3, prefixes: 9 },
      { from_as: 3, to_as: 4, prefixes: 8 },
      { from_as: 4, to_as: 5, prefixes: 7 },
    ]);
  });

  test('view data keeps only nodes that can draw the chosen edges', async () => {
    const { arrays, edges } = sample();
    const rows = await overviewEdges(edges, 6);
    const view = buildViewData(arrays, rows, { nodeLimit: 4 });
    expect(view.nodes.map(n => n.asn)).toEqual([1, 2, 3, 4]);
    expect(view.nodes[1]).toMatchObject({ asn: 2, name: null, label: 'AS2', rir: 'RIPE' });
    expect(view.edges.map(e => [e.from, e.to, e.weight])).toEqual([
      [1, 2, 10],
      [2, 3, 9],
      [3, 4, 8],
    ]);
    expect(view.truncated).toBe(3);
  });
});
