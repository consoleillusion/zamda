// Tests for the standalone BGP topology demo. These are the rules the single
// visualization depends on; the renderer only paints the scene they produce.

import { describe, expect, test } from 'bun:test';
import { table } from '../src';
import type { JsTable } from '../src';
import type { GraphArrays } from '../scripts/bgp/graph-file';
import { GraphEdges } from '../scripts/bgp/graph-file';
import {
  buildScene,
  distanceTo,
  pointOn,
  sceneBounds,
} from '../atlas/layout';
import {
  compileCountPlan,
  compileNeighbourPlan,
  compileOverviewPlan,
} from '../atlas/plans';
import type { AtlasRow } from '../atlas/plans';

function sample(): { arrays: GraphArrays; edges: JsTable<typeof GraphEdges.fields> } {
  // Purpose: a small observed graph with two regions and unequal hop weights
  const arrays: GraphArrays = {
    rowCount: 5,
    edgeCount: 5,
    asn: Uint32Array.from([10, 11, 20, 21, 30]),
    paths: Uint32Array.from([90, 30, 80, 20, 10]),
    origins: Uint32Array.from([9, 3, 8, 2, 1]),
    name: ['ALPHA', null, 'BETA', 'GAMMA', null],
    rir: ['ARIN', 'ARIN', 'RIPE NCC', 'RIPE NCC', 'APNIC'],
    country: ['US', 'CA', 'DE', 'FR', 'JP'],
    location: Uint8Array.from([2, 1, 2, 1, 1]),
    x: Float32Array.from([-0.6, -0.5, 0.3, 0.4, 0.6]),
    y: Float32Array.from([0.2, 0.3, 0.1, 0.2, -0.2]),
    from_as: Uint32Array.from([10, 10, 20, 11, 30]),
    to_as: Uint32Array.from([11, 20, 21, 21, 10]),
    prefixes: Uint32Array.from([12, 900, 5, 2, 1]),
    span_km: Uint16Array.from([300, 7200, 120, 6800, 9000]),
  };
  const edges = table(GraphEdges, {
    columns: {
      from_as: arrays.from_as,
      to_as: arrays.to_as,
      prefixes: arrays.prefixes,
      span_km: arrays.span_km,
    },
  });
  return { arrays, edges };
}

describe('BGP topology demo', () => {
  test('the overview plan selects the strongest observed adjacencies', async () => {
    const { edges } = sample();
    const rows = await compileOverviewPlan(3).execute(edges);
    expect(rows.toArray()).toEqual([
      { from_as: 10, to_as: 20, prefixes: 900, span_km: 7200 },
      { from_as: 10, to_as: 11, prefixes: 12, span_km: 300 },
      { from_as: 20, to_as: 21, prefixes: 5, span_km: 120 },
    ]);
  });

  test('a neighbourhood plan finds both directions around one AS', async () => {
    const { edges } = sample();
    const rows = await compileNeighbourPlan(10).execute(edges, { params: { asns: [10] } });
    expect(rows.toArray()).toEqual([
      { from_as: 10, to_as: 20, prefixes: 900, span_km: 7200 },
      { from_as: 10, to_as: 11, prefixes: 12, span_km: 300 },
      { from_as: 30, to_as: 10, prefixes: 1, span_km: 9000 },
    ]);
  });

  test('the count plan reports the whole file, not the visible sample', async () => {
    const { edges } = sample();
    const rows = await compileCountPlan().execute(edges);
    expect(rows.toArray()).toEqual([{ pairs: 5, observations: 920n }]);
  });

  test('the scene places ASes in regional lanes and routes weighted directed hops', () => {
    const { arrays } = sample();
    const rows: readonly AtlasRow[] = [
      { from_as: 10, to_as: 20, prefixes: 900, span_km: 7200 },
      { from_as: 10, to_as: 11, prefixes: 12, span_km: 300 },
      { from_as: 20, to_as: 21, prefixes: 5, span_km: 120 },
      { from_as: 30, to_as: 10, prefixes: 1, span_km: 9000 },
    ];
    const scene = buildScene(arrays, rows);
    expect(scene.hubs.map(hub => hub.key)).toEqual(['ARIN', 'RIPE', 'APNIC']);
    expect(scene.hubs[1]!.code).toBe('RIPE NCC');
    expect(scene.nodes.map(node => node.asn)).toEqual([10, 11, 20, 21, 30]);
    expect(scene.nodes.map(node => node.hub)).toEqual(['ARIN', 'ARIN', 'RIPE', 'RIPE', 'APNIC']);
    expect(scene.nodes[0]!.x).toBeLessThan(scene.nodes[2]!.x);
    expect(scene.nodes[2]!.x).toBeLessThan(scene.nodes[4]!.x);
    expect(scene.flows.map(flow => flow.key)).toEqual([
      '10:20', '10:11', '20:21', '30:10',
    ]);
    expect(scene.flows[0]!.width).toBeGreaterThan(scene.flows[2]!.width);
    const middle = pointOn(scene.flows[0]!, 0.5);
    expect(distanceTo(scene.flows[0]!, middle)).toBeLessThan(0.001);
    const bounds = sceneBounds(scene);
    expect(bounds.maxX).toBeGreaterThan(bounds.minX);
    expect(bounds.maxY).toBeGreaterThan(bounds.minY);
  });

  test('rows beyond the visible budget become honest region-pair bundles', () => {
    const { arrays } = sample();
    const rows: readonly AtlasRow[] = [
      { from_as: 10, to_as: 20, prefixes: 900, span_km: 7200 },
      { from_as: 10, to_as: 11, prefixes: 12, span_km: 300 },
      { from_as: 20, to_as: 21, prefixes: 5, span_km: 120 },
      { from_as: 30, to_as: 10, prefixes: 1, span_km: 9000 },
    ];
    const scene = buildScene(arrays, rows, 3);
    expect(scene.flows.map(flow => flow.key)).toEqual(['10:20', '10:11', '20:21']);
    expect(scene.beams.map(beam => beam.key)).toEqual(['APNIC>ARIN']);
    expect(scene.beams[0]!.hops).toBe(1);
    expect(scene.beams[0]!.weight).toBe(1);
    expect(scene.tailCount).toBe(1);
    expect(scene.tailWeight).toBe(1);
    expect(scene.visibleCount).toBe(3);
  });
});
