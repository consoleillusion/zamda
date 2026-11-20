// Prepares public/ for the dev server and the build:
//   public/data      a link to the repository's data/ (globe-*.zcl from `bun run prep-globe`)
//   public/engine    a link to the WASM engine build (packages/zamda/dist/zamda-engine.wasm)
//   public/countries.geojson  Natural Earth 1:110m countries (public domain), downloaded once
// Nothing here is committed: public/ holds only links and downloads.

import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const repo = join(root, '../..');
const pub = join(root, 'public');
mkdirSync(pub, { recursive: true });

function link(name: string, target: string): void {
  // Purpose: a relative symlink in public/ unless it is there already
  const at = join(pub, name);
  if (existsSync(at)) return;
  symlinkSync(relative(dirname(at), target), at);
}

link('data', join(repo, 'data'));
link('engine', join(repo, 'packages/zamda/dist'));

const COUNTRIES = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const countries = join(pub, 'countries.geojson');
if (!existsSync(countries)) {
  console.log(`downloading ${COUNTRIES}`);
  const response = await fetch(COUNTRIES);
  if (!response.ok) throw new Error(`${COUNTRIES}: HTTP ${response.status}`);
  const all = (await response.json()) as { features: { properties: Record<string, unknown>; geometry: unknown }[] };
  // Keep only what the page uses: the ISO code, the name and the shape.
  const slim = {
    type: 'FeatureCollection',
    features: all.features.map(f => ({
      type: 'Feature',
      properties: { iso: String(f.properties.ISO_A2_EH ?? f.properties.ISO_A2), name: String(f.properties.NAME) },
      geometry: f.geometry,
    })),
  };
  await writeFile(countries, JSON.stringify(slim));
}

const missing = ['globe-as.zcl', 'globe-routes.zcl', 'globe-updates.zcl'].filter(f => !existsSync(join(repo, 'data', f)));
if (missing.length > 0) console.warn(`missing data/${missing.join(', data/')}: run \`bun run prep-bgp\` and \`bun run prep-globe\` at the repository root`);
if (!existsSync(join(repo, 'packages/zamda/dist/zamda-engine.wasm'))) console.warn('no WASM engine yet: run `bun run build` at the repository root (the page falls back to JS)');
