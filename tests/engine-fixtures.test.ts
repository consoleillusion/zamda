import { expect, test } from 'bun:test';
import { corpusText, signaturesRs } from '../scripts/engine-fixtures';

// Purpose: the committed Rust signature table must equal what the registry generates now
test('engine/src/signatures.rs is up to date', async () => {
  const committed = await Bun.file('engine/src/signatures.rs').text();
  expect(committed, 'run `bun run gen:engine`').toBe(signaturesRs());
});

// Purpose: the committed plan corpus must equal what the generator writes now
test('engine/tests/data/plan-corpus.txt is up to date', async () => {
  const committed = await Bun.file('engine/tests/data/plan-corpus.txt').text();
  expect(committed === corpusText(), 'run `bun run gen:engine`').toBe(true);
});
