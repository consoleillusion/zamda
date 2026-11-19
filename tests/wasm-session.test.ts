// T-416: one interaction's runs share the engine's cache of boolean subexpressions when they run
// in one session (D-056). Results and errors never depend on it, so every comparison here is a
// comparison against runs without a session.

import { describe, expect, test } from 'bun:test';
import { count, lit, pipe, schema, t, table } from '../src';
import type { Fields, Result } from '../src';
import type { Table } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const host = nativeHost();
if (host === null) console.warn('wasm session tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32, d: t.dictionary });
const N = 60_000;
const rows = Array.from({ length: N }, (_, i) => ({
  k: i % 11,
  v: (i * 2654435761) % 1_000_000_000,
  d: i % 7 === 0 ? null : `g${i % 13}`,
}));

// Three charts over the same filter, like the dashboard's: the same subexpressions, different outputs.
type Runnable = { execute(table_: Table<Fields>, options?: { session?: unknown; sliceMs?: number }): Promise<Result<Fields>> };
const charts: Runnable[] = [
  pipe(S).filter(c => c.v.gte(100_000).and(c.d.isIn(['g3']))).groupBy(c => ({ k: c.k })).agg(() => ({ n: count() })).compile(),
  pipe(S).filter(c => c.v.gte(100_000).and(c.d.isIn(['g3']))).agg(c => ({ total: c.v.sum() })).compile(),
  pipe(S).filter(c => c.v.gte(100_000).and(c.d.isIn(['g3']))).groupBy(c => ({ d: c.d })).agg(() => ({ n: count() })).compile(),
];

maybe('wasm sessions', () => {
  const fresh = () => {
    // Purpose: a backend and its table, fresh per test, so cache stats do not leak between tests
    const { backend, table: wasmTable } = createWasmBackend(host!);
    return { backend, wasm: wasmTable(S, rows), js: table(S, rows) };
  };

  test('the charts of one interaction agree with the JS backend, together and one by one', async () => {
    const { backend, wasm, js } = fresh();
    const reference = await Promise.all(charts.map(async plan => (await plan.execute(js)).toArray()));
    const session = backend.session();
    const together = await Promise.all(charts.map(async plan => (await plan.execute(wasm, { session })).toArray()));
    session.close();
    const session2 = backend.session();
    const oneByOne = [] as unknown[];
    for (const plan of charts) oneByOne.push((await plan.execute(wasm, { session: session2 })).toArray());
    session2.close();
    expect(together).toEqual(reference);
    expect(oneByOne).toEqual(reference);
  });

  test('runs in one session share the filter pass', async () => {
    const { backend, wasm } = fresh();
    for (const plan of charts) await plan.execute(wasm);
    expect(backend.stats.cache).toEqual({ hits: 0, misses: 0 });
    const session = backend.session();
    // Sixty thousand rows fit one chunk: the first chart fills the cache, the other two answer from it.
    for (const plan of charts) await plan.execute(wasm, { session, sliceMs: 1e9 });
    session.close();
    // Sixty thousand rows fit one chunk: the first chart fills the cache, the other two answer from it.
    expect(backend.stats.cache.misses).toBe(3);
    expect(backend.stats.cache.hits).toBe(2);
  });

  test('errors are identical with and without a session', async () => {
    const { backend, wasm } = fresh();
    const boom = pipe(S)
      .filter(c => c.k.mod(lit(0, t.int32)).eq(lit(0, t.int32)))
      .agg(() => ({ n: count() }))
      .compile();
    const session = backend.session();
    const withSession = (await boom.execute(wasm, { session }).catch((e: Error) => e)) as Error;
    session.close();
    const without = (await boom.execute(wasm).catch((e: Error) => e)) as Error;
    expect(withSession.constructor).toBe(without.constructor);
    expect(withSession.message).toBe(without.message);
  });

  test('a closed session and a foreign session are both rejected, never silently ignored', async () => {
    const { backend, wasm } = fresh();
    const session = backend.session();
    const plan = charts[0]!;
    session.close();
    await expect(plan.execute(wasm, { session })).rejects.toThrow(/closed/);
    await expect(plan.execute(wasm, { session: { kind: 'zamda/wasm-session' } })).rejects.toThrow(/not an open session/);
    await expect(plan.execute(wasm, {})).resolves.toBeDefined();
  });

  test('the JS backend ignores the session option', async () => {
    const { backend, wasm, js } = fresh();
    const session = backend.session();
    const plan = charts[0]!;
    const onJs = await plan.execute(js, { session });
    const onWasm = await plan.execute(wasm, { session });
    session.close();
    expect(onJs.toArray()).toEqual(onWasm.toArray());
  });

  test('tables appended after a snapshot stay consistent across sessions and plain runs', async () => {
    const { backend, wasm, js } = fresh();
    const session = backend.session();
    const before = await charts[1]!.execute(wasm, { session });
    wasm.append(rows.slice(0, 1000));
    const inSession = await charts[1]!.execute(wasm, { session });
    session.close();
    js.append(rows.slice(0, 1000));
    const after = await charts[1]!.execute(wasm);
    const onJs = await charts[1]!.execute(js);
    expect(inSession.toArray()).toEqual(after.toArray());
    expect(after.toArray()).toEqual(onJs.toArray());
    expect(before.toArray()).not.toEqual(after.toArray());
  });
});
