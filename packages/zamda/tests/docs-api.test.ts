// The API reference (docs/API.md) is the public contract for the API surface; this test
// keeps it honest: every symbol exported from src/index.ts must appear in the doc, so the
// reference cannot silently drift behind the code.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Every exported identifier from src/index.ts; the design is in the API doc itself.
function exportedSymbols(): string[] {
  // Purpose: the names exported from the public entry point, in export order
  const source = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
  const names: string[] = [];
  const pattern = /export\s+(?:type\s+)?{([^}]*)}/g;
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  // `t` and the class exports are plain `export { X } from` forms; catch those too.
  const plain = /export\s+{([^}]*)}\s+from/g;
  for (const match of source.matchAll(plain)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

describe('docs/API.md', () => {
  const symbols = exportedSymbols();
  const doc = readFileSync(join(ROOT, 'docs/API.md'), 'utf8');

  test('every public export appears in the API reference', () => {
    const missing = symbols.filter(name => !doc.includes(name));
    expect(missing).toEqual([]);
  });

  test('the pitfalls section names the operators the lint rule flags', () => {
    expect(doc).toContain('no-js-boolean-ops-in-accessor-callbacks');
  });
});
