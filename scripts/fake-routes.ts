// Writes a synthetic routes file shaped like a real full table (about a
// million IPv4 routes), so the dashboard can be run and tested without
// downloading a RIPE dump. Real data: `bun run prep-bgp`.
//
//   bun scripts/fake-routes.ts [--rows 1000000] [--out data/routes.bin]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encodeRoutes } from './bgp/file';

function random(seed: number): () => number {
  // Purpose: small deterministic PRNG (mulberry32)
  let state = seed;
  return function () {
    // Purpose: next number in [0, 1)
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Roughly the real mix of prefix lengths: /24 dominates.
const LENGTHS: [number, number][] = [[24, 0.6], [22, 0.1], [23, 0.07], [21, 0.04], [20, 0.04], [19, 0.03], [16, 0.03], [18, 0.02], [17, 0.02]];
const RIRS = ['ARIN', 'RIPE NCC', 'APNIC', 'LACNIC', 'AFRINIC'];
const RIR_WEIGHTS = [0.32, 0.3, 0.25, 0.1, 0.03];
const WORDS = ['NET', 'TELECOM', 'CLOUD', 'BROADBAND', 'FIBER', 'HOSTING', 'DATA', 'ONLINE', 'COMMS', 'ISP'];

function pick(rand: () => number, weights: readonly number[]): number {
  // Purpose: an index chosen by weight
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function main(): Promise<void> {
  // Purpose: parse flags, generate the routes, write the file
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    // Purpose: the value after --name, or the fallback
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1]!;
  };
  const rows = Number(flag('rows', '1000000'));
  const out = flag('out', 'data/routes.bin');
  const networks = 75_000;
  const rand = random(42);
  const asOf = new Uint32Array(networks);
  for (let i = 0; i < networks; i++) asOf[i] = i % 4 === 0 ? 4_200_000_000 + i : i * 5 + 1;
  const prefixAddr = new Uint32Array(rows);
  const prefixLen = new Uint8Array(rows);
  const originAs = new Uint32Array(rows);
  const pathLen = new Uint8Array(rows);
  const lengthWeights = LENGTHS.map(l => l[1]);
  for (let i = 0; i < rows; i++) {
    const length = LENGTHS[pick(rand, lengthWeights)]![0];
    const size = 2 ** (32 - length);
    prefixLen[i] = length;
    prefixAddr[i] = Math.floor((rand() * 2 ** 32) / size) * size;
    originAs[i] = asOf[Math.floor(networks * rand() ** 3)]!;
    pathLen[i] = 1 + Math.min(14, Math.floor(-Math.log(1 - rand()) * 3));
  }
  const file = encodeRoutes(
    { prefixAddr, prefixLen, originAs, pathLen, rowCount: rows },
    {
      asName: asn => (asn % 97 === 0 ? null : `${WORDS[asn % WORDS.length]}-${asn % 7919}`),
      rir: asn => RIRS[pick(random(asn), RIR_WEIGHTS)]!,
    },
    { synthetic: 'true', rows, generated: new Date().toISOString() },
  );
  return mkdir(dirname(out), { recursive: true })
    .then(() => writeFile(out, file))
    .then(() => console.log(`wrote ${out}: ${rows.toLocaleString()} synthetic routes, ${(file.length / 2 ** 20).toFixed(1)} MB`));
}

await main();
