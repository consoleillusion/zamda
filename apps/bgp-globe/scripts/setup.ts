// Prepares public/ for the dev server and the build:
//   public/data      a link to the repository's data/ (globe-*.zcl from `bun run prep-globe`), including
//                    the physical-IP tables globe-ips.zcl and globe-ip-routes.zcl
//   public/engine    a link to the WASM engine build (packages/zamda/dist/zamda-engine.wasm)
//   public/countries.geojson  Natural Earth 1:110m countries (public domain), downloaded once
//   public/terrain   low-resolution Terrarium elevation tiles (z=1..3), downloaded once
//                    the browser turns these into a neutral relief texture at runtime
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

// Low-resolution global elevation: 4 + 16 + 64 Terrarium tiles, about 8 MB in total.
// Served locally because the public S3 bucket does not send CORS headers. The app
// derives a multiplier texture from them, so the ocean and land keep their base colour.
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const terrainDir = join(pub, 'terrain');
// The versioned marker forces a re-check of the tile set when the zoom range changes.
const terrainReady = join(terrainDir, '.ready-v1');
if (!existsSync(terrainReady)) {
  console.log('downloading elevation tiles (z=1..3)');
  const jobs: (() => Promise<void>)[] = [];
  for (let z = 1; z <= 3; z++) {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        jobs.push(async () => {
          const dir = join(terrainDir, String(z), String(x));
          mkdirSync(dir, { recursive: true });
          const at = join(dir, `${y}.png`);
          if (existsSync(at)) return;
          const url = `${TERRARIUM}/${z}/${x}/${y}.png`;
          const response = await fetch(url);
          if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
          await writeFile(at, Buffer.from(await response.arrayBuffer()));
        });
      }
    }
  }
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map(job => job()));
  }
  await writeFile(terrainReady, '');
}

const missing = ['globe-as.zcl', 'globe-routes.zcl', 'globe-updates.zcl'].filter(f => !existsSync(join(repo, 'data', f)));
if (missing.length > 0) console.warn(`missing data/${missing.join(', data/')}: run \`bun run prep-bgp\` and \`bun run prep-globe\` at the repository root`);
const missingPhysical = ['globe-ips.zcl', 'globe-ip-routes.zcl'].filter(f => !existsSync(join(repo, 'data', f)));
if (missingPhysical.length > 0) console.warn(`missing data/${missingPhysical.join(', data/')}: re-run \`bun run prep-globe\` for the observed-IP layer (the globe still runs without it)`);
if (!existsSync(join(repo, 'packages/zamda/dist/zamda-engine.wasm'))) console.warn('no WASM engine yet: run `bun run build` at the repository root (the page falls back to JS)');
