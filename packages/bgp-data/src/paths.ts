// Where the BGP data files live: the repository's top-level data/ directory (git-ignored), shared by the
// prep scripts, the benchmarks and the demo. ZAMDA_DATA overrides it.

import { join } from 'node:path';

export const DATA_DIR: string = process.env.ZAMDA_DATA ?? new URL('../../../data/', import.meta.url).pathname.replace(/\/$/, '');

export function dataFile(name: string): string {
  // Purpose: the absolute path of one file in the data directory
  return join(DATA_DIR, name);
}
