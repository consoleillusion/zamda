// Bun runner for S-301.
//
//   bun run spike                                  after `bun run spike:build`: the WASM module and the native library
//   bun spike/run.ts --engine native=spike/target/release/libzamda_spike.so \
//                    --engine wasm=spike/target/wasm32-unknown-unknown/release/zamda_spike.wasm \
//                    --rows 100000,1000000 --out spike-sandbox
//
// An engine path ending in .wasm is loaded as WebAssembly; anything else as a native library.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { decodeRoutes } from '../scripts/bgp/file';
import { compareSize, spikeMarkdown, sample } from './compare';
import type { EngineSpec, SpikeSize } from './compare';
import { loadWasm } from './engine';
import { loadNative } from './native';

function args(): { engines: [string, string][]; rows: number[]; data: string; out: string; runs: number } {
  // Purpose: read --engine name=path (repeatable), --rows, --data, --out and --runs
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    // Purpose: the value after --name, or the fallback
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1]!;
  };
  const engines: [string, string][] = [];
  argv.forEach((a, i) => {
    // Purpose: collect each --engine value
    if (a === '--engine') {
      const [name, path] = argv[i + 1]!.split('=');
      engines.push([name!, path!]);
    }
  });
  if (engines.length === 0) {
    // The defaults are what `bun run spike:build` produces.
    const lib = process.platform === 'win32' ? 'zamda_spike.dll' : process.platform === 'darwin' ? 'libzamda_spike.dylib' : 'libzamda_spike.so';
    engines.push(['wasm', 'spike/target/wasm32-unknown-unknown/release/zamda_spike.wasm'], ['native', `spike/target/release/${lib}`]);
  }
  return { engines, rows: get('rows', '100000,1000000').split(',').map(Number), data: get('data', 'data/routes.bin'), out: get('out', 'spike-latest'), runs: Number(get('runs', '7')) };
}

const a = args();
const { arrays, header } = decodeRoutes(new Uint8Array(readFileSync(a.data)));
const source = header.source.synthetic ? 'synthetic routes (scripts/fake-routes.ts)' : `RIPE RIS ${String(header.source.rrc ?? '')} ${String(header.source.date ?? '')}`.trim();
const engines: EngineSpec[] = [];
for (const [name, path] of a.engines) {
  engines.push({ name, kernels: path.endsWith('.wasm') ? await loadWasm(readFileSync(path)) : loadNative(path) });
}
const sizes: SpikeSize[] = [];
for (const rows of a.rows) {
  if (rows > arrays.rowCount) continue;
  console.log(`${rows.toLocaleString()} rows`);
  sizes.push(await compareSize(sample(arrays, rows), engines, a.runs));
}
const meta = { label: a.out, source, runtime: `Bun ${Bun.version}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), date: new Date().toISOString().slice(0, 10) };
mkdirSync('bench/results', { recursive: true });
writeFileSync(`bench/results/${a.out}.json`, `${JSON.stringify({ meta, sizes }, null, 2)}\n`);
const report = spikeMarkdown(meta, sizes);
writeFileSync(`bench/results/${a.out}.md`, `${report}\n`);
console.log(`\n${report}`);
