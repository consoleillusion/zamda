// Build the publishable ESM bundle and its TypeScript declarations into dist/.

import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const bundle = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'browser',
  minify: false,
  sourcemap: 'linked',
  naming: '[name].[ext]',
});

if (!bundle.success) {
  for (const message of bundle.logs) console.error(message);
  throw new Error('ESM build failed');
}

const declarations = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
});

if (declarations.exitCode !== 0) throw new Error('Declaration build failed');

console.log(`built ${bundle.outputs.map((output) => output.path).join(', ')} and dist/index.d.ts`);
