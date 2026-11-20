// Checks that the MRT reader gives the same answer however a dump is split into
// pieces. It reads one saved dump several times, each time feeding the reader
// pieces of a different, randomly varying size, and compares the results.
//
//   bun run scripts/check-dump.ts data/rrc00-bview.20261116.0000.gz
//
// If every pass agrees, a failure seen while downloading was not caused by how
// the bytes happened to be split.

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { MrtReader } from '../src/mrt';

interface Pass {
  records: number;
  ribs: number;
  entries: number;
  malformed: number;
  // Order-sensitive digest of every decoded prefix and entry.
  digest: number;
  firstError: string | null;
}

function random(seed: number): () => number {
  // Purpose: deterministic PRNG (mulberry32), so a failing split can be reproduced
  let state = seed;
  return function () {
    // Purpose: next number in [0, 1)
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(hash: number, value: number): number {
  // Purpose: fold one 32-bit value into a running FNV-style digest
  return Math.imul(hash ^ (value >>> 0), 16777619) >>> 0;
}

async function pass(path: string, seed: number | null): Promise<Pass> {
  // Purpose: read the whole dump once; with a seed, re-split every chunk into random pieces of 1 byte to 1 MB
  const result: Pass = { records: 0, ribs: 0, entries: 0, malformed: 0, digest: 2166136261, firstError: null };
  const reader = new MrtReader({
    onRib(record) {
      // Purpose: count and digest each decoded IPv4 record
      result.ribs++;
      result.digest = mix(mix(result.digest, record.prefix), record.prefixLength);
      for (const e of record.entries) {
        result.entries++;
        result.digest = mix(mix(mix(result.digest, e.peerIndex), e.pathLength), e.originAs ?? 0xffffffff);
      }
    },
    onMalformedEntry(entry) {
      // Purpose: count undecodable entries
      result.malformed++;
      if (!result.firstError) result.firstError = `${entry.prefix} peer ${entry.peerIndex}: ${entry.reason}`;
    },
  });
  const next = seed === null ? null : random(seed);
  try {
    for await (const chunk of createReadStream(path).pipe(createGunzip())) {
      const bytes = chunk as Uint8Array;
      if (!next) {
        reader.push(bytes);
        continue;
      }
      for (let at = 0; at < bytes.length; ) {
        // Mostly small pieces, sometimes large, so boundaries land everywhere.
        const size = next() < 0.5 ? 1 + Math.floor(next() * 64) : 1 + Math.floor(next() * (1 << 20));
        reader.push(bytes.subarray(at, at + size));
        at += size;
      }
    }
    reader.finish();
  } catch (error) {
    result.firstError = `fatal: ${(error as Error).message}`;
  }
  result.records = reader.recordCount;
  return result;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: bun run scripts/check-dump.ts <dump.gz>');
    process.exit(1);
  }
  const seeds: (number | null)[] = [null, 1, 2, 3];
  const passes: Pass[] = [];
  for (const seed of seeds) {
    const started = performance.now();
    const result = await pass(path, seed);
    passes.push(result);
    const label = seed === null ? 'as read' : `random split ${seed}`;
    console.log(
      `${label.padEnd(15)} ${result.ribs.toLocaleString()} IPv4 records, ${result.entries.toLocaleString()} entries, ` +
        `${result.malformed} malformed, digest ${result.digest.toString(16).padStart(8, '0')}, ` +
        `${((performance.now() - started) / 1000).toFixed(0)} s` +
        (result.firstError ? `\n                ${result.firstError}` : ''),
    );
  }
  const same = passes.every(function (p) {
    return p.digest === passes[0]!.digest && p.firstError === passes[0]!.firstError;
  });
  console.log(same ? 'All passes agree.' : 'PASSES DISAGREE: the reader depends on how the bytes are split.');
  process.exit(same ? 0 : 1);
}
