// The runtime comparison with the engine beside the JS backend, in Bun:
//   bun run bench:native   the engine as a native library through bun:ffi (an upper bound for WASM)
//   bun run bench:wasm     the engine as the WebAssembly module `bun run wasm:build` made
// Options: --rows 1000000 --runs 7 --data data/routes.bin, and --wasm path/to/engine.wasm.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createWasmBackend } from '../../src/backends/wasm';
import { decodeRoutes, Routes } from '../../scripts/bgp/file';
import { loadEngine } from '../../src/backends/wasm/load';
import { nativeHost } from '../../tests/engine-host';
import { comparisonMarkdown, runComparison } from './compare';
import { columnInput } from './data';

const args = process.argv.slice(2);
const get = (name: string, fallback: string): string => {
  // Purpose: the value after --name, or the fallback
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1]!;
};
const wasmPath = args.includes('--wasm') ? get('wasm', 'dist/zamda-engine.wasm') : null;
const host = wasmPath === null ? nativeHost() : await loadEngine(readFileSync(wasmPath));
if (host === null) throw new Error('The native engine library is not built (needs cargo): bun run engine:build');
const { backend, table } = createWasmBackend(host);
const { arrays } = decodeRoutes(new Uint8Array(readFileSync(get('data', 'data/routes.bin'))));
const result = await runComparison(arrays, Number(get('rows', '1000000')), Number(get('runs', '7')), wasmPath === null ? `Bun ${Bun.version} with the engine as a native library` : `Bun ${Bun.version} (JavaScriptCore) with the engine as WebAssembly`, console.log, {
  table: a => table(Routes, columnInput(a)),
  stats: () => ({ ...backend.stats }),
  session: () => backend.session(),
});
mkdirSync('bench/results', { recursive: true });
writeFileSync(wasmPath === null ? 'bench/results/compare-native.json' : 'bench/results/compare-wasm-bun.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n${comparisonMarkdown(result)}`);
