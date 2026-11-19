// Generates the demo's committed map layer from Natural Earth 1:50m land
// polygons. The output is plain TypeScript data, so the browser never fetches a
// GeoJSON file and the map uses the same equirectangular square as graph.bin.
//
//   bun run gen:map

import { writeFile } from 'node:fs/promises';

const URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson';
const OUTPUT = 'demo/world-map.ts';
const SCALE = 0.88;
const TOLERANCE = 0.00008; // below one pixel at the overview camera ratio

type Point = readonly [number, number];
type Ring = readonly number[];

interface ApiRecord {
  readonly [key: string]: unknown;
}

function finite(value: unknown): number | null {
  // Purpose: a finite coordinate from the GeoJSON, or null when the source is malformed
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round4(value: number): number {
  // Purpose: keep the generated table readable without changing the rendered shape
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function project(coordinates: unknown): Point | null {
  // Purpose: one GeoJSON coordinate pair in the graph's square; longitude comes first
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = finite(coordinates[0]);
  const lat = finite(coordinates[1]);
  if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [round4((lon / 180) * SCALE), round4((lat / 90) * SCALE)];
}

function distance(point: Point, start: Point, end: Point): number {
  // Purpose: perpendicular distance from a point to a projected line segment
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function simplify(points: readonly Point[], tolerance: number): Point[] {
  // Purpose: remove vertices that cannot change a pixel with an iterative Ramer-Douglas-Peucker pass
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let farthest = -1;
    let largest = tolerance;
    for (let i = start + 1; i < end; i++) {
      const distanceHere = distance(points[i]!, points[start]!, points[end]!);
      if (distanceHere > largest) {
        largest = distanceHere;
        farthest = i;
      }
    }
    if (farthest === -1) continue;
    keep[farthest] = 1;
    stack.push([start, farthest], [farthest, end]);
  }
  return points.filter((_, i) => keep[i] === 1);
}

function ringsFromGeoJson(text: string): Ring[] {
  // Purpose: project and simplify every land ring in the Natural Earth collection
  const parsed = JSON.parse(text) as { features?: unknown };
  if (!Array.isArray(parsed.features)) throw new Error('Natural Earth GeoJSON has no features array');
  const rings: Ring[] = [];
  for (const feature of parsed.features) {
    if (typeof feature !== 'object' || feature === null) continue;
    const geometry = (feature as ApiRecord).geometry;
    if (typeof geometry !== 'object' || geometry === null) continue;
    const fields = geometry as ApiRecord;
    const polygons: unknown[] = fields.type === 'Polygon'
      ? [fields.coordinates]
      : fields.type === 'MultiPolygon' && Array.isArray(fields.coordinates)
        ? fields.coordinates
        : [];
    for (const polygon of polygons) {
      if (!Array.isArray(polygon)) continue;
      for (const coordinates of polygon) {
        if (!Array.isArray(coordinates) || coordinates.length < 4) continue;
        const projected: Point[] = [];
        for (const pair of coordinates) {
          const point = project(pair);
          if (point) projected.push(point);
        }
        if (projected.length < 4) continue;
        const closed = projected[0]![0] === projected[projected.length - 1]![0] &&
          projected[0]![1] === projected[projected.length - 1]![1];
        const open = closed ? projected.slice(0, -1) : projected;
        const kept = simplify(open, TOLERANCE);
        if (kept.length < 3) continue;
        const flat: number[] = [];
        for (const point of kept) flat.push(point[0], point[1]);
        flat.push(kept[0]![0], kept[0]![1]);
        rings.push(flat);
      }
    }
  }
  return rings;
}

async function main(): Promise<void> {
  // Purpose: download the pinned-resolution outline and write the generated module
  const response = await fetch(URL);
  if (!response.ok || !response.body) throw new Error(`${URL}: HTTP ${response.status}`);
  const rings = ringsFromGeoJson(await response.text());
  const points = rings.reduce((sum, ring) => sum + ring.length / 2, 0);
  const lines = [
    '// Natural Earth 1:50m land outlines, projected to the same equirectangular',
    '// square as graph.bin (lon / 180 * 0.88, lat / 90 * 0.88).',
    '// Source: public-domain Natural Earth vector data, ne_50m_land.geojson.',
    `// Generated by \`bun run gen:map\` from ${URL}`,
    `// ${rings.length.toLocaleString()} rings, ${points.toLocaleString()} points; do not edit by hand.`,
    '',
    'export const WORLD_LAND: readonly (readonly number[])[] = [',
    ...rings.map(ring => `  [${ring.join(',')}],`),
    '];',
    '',
  ];
  await writeFile(OUTPUT, lines.join('\n'));
  console.log(`wrote ${OUTPUT}: ${rings.length.toLocaleString()} rings, ${points.toLocaleString()} points`);
}

await main();
