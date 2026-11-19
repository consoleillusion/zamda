// The map outline is generated data, but it is still part of the demo's contract:
// the synced land layer must use the detailed source and the graph's projection.

import { describe, expect, test } from 'bun:test';
import { WORLD_LAND } from '../demo/world-map';

describe('world map outline', () => {
  test('the 1:50m land data is projected into the graph square', () => {
    // Purpose: a coarser outline or a projection change would silently break the map layer
    expect(WORLD_LAND.length).toBeGreaterThan(500);
    let points = 0;
    for (const ring of WORLD_LAND) {
      expect(ring.length % 2).toBe(0);
      expect(ring.length).toBeGreaterThanOrEqual(8);
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i]!;
        const y = ring[i + 1]!;
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(Math.abs(x)).toBeLessThanOrEqual(0.88);
        expect(Math.abs(y)).toBeLessThanOrEqual(0.88);
        points++;
      }
    }
    expect(points).toBeGreaterThan(20_000);
  });
});
