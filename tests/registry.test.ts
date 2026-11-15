// Structural rules every registry entry must satisfy.

import { expect, test } from 'bun:test';
import { KERNELS } from '../src/backends/js/kernels';
import { REGISTRY } from '../src/registry';

test('every function has a Substrait mapping', () => {
  for (const def of REGISTRY.values()) {
    expect(def.substrait).toMatch(/^functions_[a-z_]+:[a-z_]+$/);
  }
});

test('every function is deterministic (non-deterministic functions are excluded from the MVP)', () => {
  for (const def of REGISTRY.values()) expect(def.deterministic).toBe(true);
});

test('every scalar function has a JS kernel', () => {
  const missing = [...REGISTRY.values()]
    .filter(def => def.kind === 'scalar' && !KERNELS.has(def.name))
    .map(def => def.name);
  expect(missing).toEqual([]);
});

test('every JS kernel is registered', () => {
  for (const name of KERNELS.keys()) expect(REGISTRY.has(name)).toBe(true);
});
