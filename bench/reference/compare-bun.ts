import { dataFile } from '@zamda/bgp-data/paths';
// Bun side of the runtime comparison (T-223): bun run bench:compare [--rows 1000000] [--runs 7] [--data data/routes.bin]
// Prints markdown and writes bench/results/compare-bun.json. The browser side is `bun run bench:browser`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeRoutes } from '@zamda/bgp-data/file';
import { comparisonMarkdown, runComparison } from './compare';

const args = process.argv.slice(2);
const get = (name: string, fallback: string): string => {
  // Purpose: the value after --name, or the fallback
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1]!;
};
const { arrays } = decodeRoutes(new Uint8Array(readFileSync(get('data', dataFile('routes.bin')))));
const result = await runComparison(arrays, Number(get('rows', '1000000')), Number(get('runs', '7')), `Bun ${Bun.version} (JavaScriptCore)`, console.log);
mkdirSync('bench/results', { recursive: true });
writeFileSync('bench/results/compare-bun.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n${comparisonMarkdown(result)}`);
