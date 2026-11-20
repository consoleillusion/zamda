// Build the publishable package into dist/:
//   dist/index.js        the core (`zamda`), no WASM
//   dist/wasm.js         the accelerator (`zamda/wasm`)
//   dist/zamda-worker.js the engine's Web Worker, self-contained; wasm.js starts it
//   dist/zamda-engine.wasm the engine module, kept from `bun run wasm:build` (a warning if it is missing)
//   dist/*.d.ts          declarations

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const ENGINE = 'dist/zamda-engine.wasm';
const engine = existsSync(ENGINE) ? readFileSync(ENGINE) : null;

await rm('dist', { recursive: true, force: true });

async function build(config: Parameters<typeof Bun.build>[0], what: string): Promise<string[]> {
  // Purpose: run one Bun build and fail loudly with its log
  const result = await Bun.build(config);
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error(`${what} build failed`);
  }
  return result.outputs.map(output => output.path);
}

const outputs = [
  ...(await build(
    {
      entrypoints: ['src/index.ts', 'src/wasm.ts'],
      outdir: 'dist',
      format: 'esm',
      target: 'browser',
      splitting: true,
      minify: false,
      sourcemap: 'linked',
      naming: { entry: '[name].[ext]', chunk: 'chunk-[hash].[ext]' },
      // wasm.ts reads node:fs only for file: URLs, behind a dynamic import.
      external: ['node:fs/promises'],
    },
    'ESM',
  )),
  ...(await build(
    {
      entrypoints: ['src/backends/wasm/worker-entry.ts'],
      outdir: 'dist',
      format: 'esm',
      target: 'browser',
      minify: true,
      sourcemap: 'linked',
      naming: 'zamda-worker.[ext]',
    },
    'Worker',
  )),
];

if (engine !== null) writeFileSync(ENGINE, engine);
else console.warn(`warning: ${ENGINE} is missing, so zamda/wasm has no engine to load; run \`bun run wasm:build\` before publishing`);

const declarations = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
});

if (declarations.exitCode !== 0) throw new Error('Declaration build failed');

console.log(`built ${outputs.join(', ')}${engine !== null ? `, ${ENGINE}` : ''} and declarations`);
