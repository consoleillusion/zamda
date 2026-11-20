// The public `zamda/wasm` entry (src/wasm.ts), the worker stall backstop (spec v4, "Chunked execution"),
// the memory-limit range check and latest()'s listener cleanup. The engine is the native library here
// (no wasm32 target in CI); the stall test uses a stand-in worker that never answers an aborted run.

import { afterEach, describe, expect, test } from 'bun:test';
import { AbortError, PlanError, count, keyedTable, latest, pipe, schema, t, table } from '../src';
import { wasmEngine } from '../src/wasm';
import type { WasmEngine } from '../src/wasm';
import { createWorkerBackend } from '../src/backends/wasm/worker-link';
import type { WorkerLike } from '../src/backends/wasm/worker-link';
import type { Request } from '../src/backends/wasm/worker-protocol';
import { nativeHost } from './engine-host';

const base = nativeHost();
if (base === null) console.warn('wasm entry tests skipped: the engine library is not built (needs cargo)');
const maybe = base === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: i % 5, v: i }));
const groups = pipe(S).groupBy(c => ({ k: c.k })).agg(c => ({ n: count(), s: c.v.sum() })).compile();

const rejected = async (promise: Promise<unknown>): Promise<unknown> => {
  // Purpose: the rejection of a promise, with a plain await (bun's expect().rejects never delivers worker messages)
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return null;
};

const open: WasmEngine[] = [];
afterEach(() => {
  for (const e of open.splice(0)) e.terminate();
});

maybe('wasmEngine()', () => {
  test('on this thread: load, execute, same answer as the JS backend, then dispose', async () => {
    const engine = await wasmEngine({ worker: false, host: async () => base! });
    open.push(engine);
    expect(engine.mode).toBe('thread');
    const big = await engine.load(S, rows(50_000));
    expect(big.rowCount).toBe(50_000);
    const expected = (await groups.execute(table(S, rows(50_000)))).toArray();
    expect((await groups.execute(big)).toArray()).toEqual(expected);
    expect((await engine.stats()).engine).toBe(1);
    await big[Symbol.asyncDispose]();
    expect((await rejected(groups.execute(big)))?.constructor.name).toBe('HandleError');
  });

  test('in a worker: the same plan gives the same answer', async () => {
    const engine = await wasmEngine({
      worker: () => new Worker(new URL('../src/backends/wasm/worker-entry.ts', import.meta.url).href) as unknown as WorkerLike,
      workerEngine: { hostModule: new URL('./native-host-module.ts', import.meta.url).href },
    });
    open.push(engine);
    expect(engine.mode).toBe('worker');
    const big = await engine.load(S, rows(30_000));
    expect((await groups.execute(big)).toArray()).toEqual((await groups.execute(table(S, rows(30_000)))).toArray());
  });

  test('keyed tables in a worker: mutations are seen by later runs, not by runs in flight', async () => {
    const engine = await wasmEngine({
      worker: () => new Worker(new URL('../src/backends/wasm/worker-entry.ts', import.meta.url).href) as unknown as WorkerLike,
      workerEngine: { hostModule: new URL('./native-host-module.ts', import.meta.url).href },
    });
    open.push(engine);
    const K = schema({ id: t.int32, tag: t.dictionary, n: t.int32 });
    const all = pipe(K).select(c => ({ id: c.id, tag: c.tag, n: c.n })).compile();
    const counts = pipe(K).groupBy(c => ({ tag: c.tag })).agg(() => ({ n: count() })).compile();
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: i, tag: `t${i % 3}`, n: i }));
    const kt = await engine.loadKeyed(K, ['id'], rows, { blockRows: 1000 });
    const inFlight = all.execute(kt, { chunkRows: 500, sliceMs: 0 });
    kt.upsert([{ id: 7, tag: 'new', n: -7 }, { id: 40_000, tag: 'new', n: 1 }]);
    expect(kt.delete([[0], [1], [99_999]])).toBe(2);
    const before = (await inFlight).toArray();
    expect(before.length).toBe(30_000);
    expect(before[7]).toEqual({ id: 7, tag: 't1', n: 7 });
    const after = (await all.execute(kt)).toArray();
    expect(after.length).toBe(29_999);
    expect(after[5]).toEqual({ id: 7, tag: 'new', n: -7 });
    expect(after.at(-1)).toEqual({ id: 40_000, tag: 'new', n: 1 });
    const js = keyedTable(K, ['id'], rows);
    js.upsert([{ id: 7, tag: 'new', n: -7 }, { id: 40_000, tag: 'new', n: 1 }]);
    js.delete([[0], [1]]);
    expect((await counts.execute(kt)).toArray()).toEqual((await counts.execute(js)).toArray());
    await kt.flush();
  });

  test('a memory limit above 4 GiB is refused instead of wrapping to a small one', async () => {
    expect(await rejected(wasmEngine({ worker: false, host: async () => base!, memoryLimitBytes: 5e9 }))).toBeInstanceOf(PlanError);
    const engine = await wasmEngine({ worker: false, host: async () => base! });
    open.push(engine);
    expect(await rejected(engine.setMemoryLimit(2 ** 32))).toBeInstanceOf(PlanError);
    await engine.setMemoryLimit(0);
  });
});

// A worker stand-in: answers everything at once, except that a run is never answered (a stuck engine).
function stuckWorker(log: { spawned: number; terminated: number }): () => WorkerLike {
  // Purpose: a spawn function whose workers hang on every run
  return () => {
    log.spawned++;
    const listeners: ((event: { data: unknown }) => void)[] = [];
    const reply = (data: unknown) => queueMicrotask(() => listeners.forEach(l => l({ data })));
    return {
      postMessage(message: unknown) {
        const request = message as Request;
        if (request.type === 'run' || request.type === 'abort') return;
        const value =
          request.type === 'createTable' ? { rowCount: 3, rowsDropped: 0 } : request.type === 'stats' ? { engine: 0, fallback: 0, phasesMs: {}, cache: {} } : undefined;
        reply({ id: request.id, ok: true, value });
      },
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        if (type === 'message') listeners.push(listener);
      },
      terminate() {
        log.terminated++;
      },
    } as WorkerLike;
  };
}

describe('worker stall backstop', () => {
  test('an aborted run that never gives the worker back: the worker is terminated and the engine replaced', async () => {
    const log = { spawned: 0, terminated: 0 };
    const backend = await createWorkerBackend({ spawn: stuckWorker(log), engine: { url: 'unused' }, stallMs: 30 });
    const tbl = await backend.table(S, rows(3), { reload: () => rows(3) });
    const controller = new AbortController();
    const run = groups.execute(tbl as never, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect(await rejected(run)).toBeInstanceOf(AbortError);
    expect(log.terminated).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(log.terminated).toBe(1);
    // The next call finds the worker gone: a typed error, then a new worker with the table rebuilt.
    expect((await rejected(backend.stats()))?.constructor.name).toBe('EngineCrashError');
    await backend.settled();
    expect(log.spawned).toBe(2);
    expect(backend.replacements).toBe(1);
    await backend.stats();
    backend.terminate();
  });

  test('stallMs 0 turns the backstop off', async () => {
    const log = { spawned: 0, terminated: 0 };
    const backend = await createWorkerBackend({ spawn: stuckWorker(log), engine: { url: 'unused' }, stallMs: 0 });
    const tbl = await backend.table(S, rows(3));
    const controller = new AbortController();
    const run = groups.execute(tbl as never, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect(await rejected(run)).toBeInstanceOf(AbortError);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(log.terminated).toBe(0);
    backend.terminate();
  });

  test('a negative stallMs is refused', async () => {
    expect(await rejected(createWorkerBackend({ spawn: stuckWorker({ spawned: 0, terminated: 0 }), engine: { url: 'unused' }, stallMs: -1 }))).toBeInstanceOf(PlanError);
  });
});

describe('latest()', () => {
  test('removes its listener from a long-lived outer signal once each run settles', async () => {
    const outer = new AbortController();
    let added = 0;
    let removed = 0;
    const add = outer.signal.addEventListener.bind(outer.signal);
    const remove = outer.signal.removeEventListener.bind(outer.signal);
    outer.signal.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add;
    outer.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (removed++, remove(...a))) as typeof remove;
    const run = latest(groups);
    const data = table(S, rows(1000));
    for (let i = 0; i < 20; i++) await run(data, { signal: outer.signal });
    expect(added).toBe(20);
    expect(removed).toBe(20);
  });
});

describe('error names survive bundling', () => {
  test('a minified bundle still reports PlanError, not a renamed class', async () => {
    // Purpose: bundlers rename classes; error.name must stay the documented one
    const built = await Bun.build({ entrypoints: [new URL('../src/errors.ts', import.meta.url).pathname], minify: true, format: 'esm' });
    const url = `data:text/javascript;base64,${Buffer.from(await built.outputs[0]!.text()).toString('base64')}`;
    const errors = (await import(url)) as Record<string, new (m: string) => Error>;
    const names = Object.entries(errors).filter(([k]) => k !== 'ZamdaError').map(([k, E]) => [k, new E('x').name]);
    for (const [exported, name] of names) expect(name).toBe(exported);
  });
});
