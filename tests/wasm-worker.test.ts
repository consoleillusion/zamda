// T-409: the engine in a worker. These tests run in a Bun worker with the native engine library (the same
// worker code runs in a browser Web Worker with the WASM module; bench:browser checks that).

import { afterEach, describe, expect, test } from 'bun:test';
import { AbortError, EngineCrashError, MemoryError, count, pipe, schema, t, table } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { createManagedBackend } from '../src/backends/wasm/managed';
import type { ManagedBackend } from '../src/backends/wasm/managed';
import { createWorkerBackend, workerLink } from '../src/backends/wasm/worker-link';
import type { WorkerLike } from '../src/backends/wasm/worker-link';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { nativeHost } from './engine-host';

const base = nativeHost();
if (base === null) console.warn('worker tests skipped: the engine library is not built (needs cargo)');
const maybe = base === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: i % 7, v: i }));
const columns = (n: number) => ({ columns: { k: Int32Array.from({ length: n }, (_, i) => i % 7), v: Int32Array.from({ length: n }, (_, i) => (i * 2654435761) % 1_000_003) } });
const groups = pipe(S).groupBy(c => ({ k: c.k })).agg(c => ({ n: count(), s: c.v.sum() })).compile();
const total = pipe(S).agg(c => ({ n: count(), s: c.v.sum() })).compile();
const sorted = pipe(S).sort(c => [c.v.asc(), c.k.asc()]).compile();

const hostModule = (name: string): string => new URL(`./${name}.ts`, import.meta.url).href;
const spawn = (): WorkerLike => new Worker(new URL('../src/backends/wasm/worker-entry.ts', import.meta.url).href) as unknown as WorkerLike;

const rejectsWith = async (promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> => {
  // Purpose: assert a rejection with a plain await; bun's expect().rejects runs a nested event loop that never delivers worker messages
  let caught: unknown = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(type);
};

const open: ManagedBackend[] = [];
const start = async (module = 'native-host-module', memoryLimitBytes?: number, hostArg?: string): Promise<ManagedBackend> => {
  const backend = await createWorkerBackend({ spawn, engine: { hostModule: hostModule(module), ...(hostArg === undefined ? {} : { hostArg }) }, ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }) });
  open.push(backend);
  return backend;
};

maybe('engine in a worker', () => {
  afterEach(() => {
    for (const b of open.splice(0)) b.terminate();
    base!.memoryLimit(0);
  });

  test('answers equal the JS backend, from rows and from columns', async () => {
    const backend = await start();
    const fromRows = await backend.table(S, rows(20_000));
    const fromColumns = await backend.table(S, columns(20_000));
    expect((await groups.execute(fromRows as never)).toArray()).toEqual((await groups.execute(table(S, rows(20_000)))).toArray());
    expect((await groups.execute(fromColumns as never)).toArray()).toEqual((await groups.execute(table(S, columns(20_000)))).toArray());
    expect((await sorted.execute(fromColumns as never)).toArray().slice(0, 50)).toEqual((await sorted.execute(table(S, columns(20_000)))).toArray().slice(0, 50));
  });

  test('transfer moves the columns (they are detached here); without it they are copied', async () => {
    const backend = await start();
    const kept = columns(1000);
    await backend.table(S, kept);
    expect(kept.columns.v.byteLength).toBe(4000);
    const moved = columns(1000);
    const wasm = await backend.table(S, moved, { transfer: true });
    expect(moved.columns.v.byteLength).toBe(0);
    expect(wasm.rowCount).toBe(1000);
    const more = columns(500);
    await wasm.append(more, { transfer: true });
    expect(more.columns.k.byteLength).toBe(0);
    expect((await total.execute(wasm as never)).toArray()[0]!.n).toBe(1500);
  });

  test('the page stays responsive while the engine works in the worker', async () => {
    const N = 2_000_000;
    const data = columns(N);
    const backend = await start();
    const wasm = await backend.table(S, data);
    // Time between ticks of a 1 ms timer on this thread, measured while a run is going on.
    const stall = async (during: () => Promise<unknown>): Promise<{ longest: number; took: number }> => {
      let last = performance.now();
      let longest = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 1);
      const began = performance.now();
      await during();
      const took = performance.now() - began;
      clearInterval(timer);
      return { longest, took };
    };
    const inWorker = await stall(() => sorted.execute(wasm as never));
    const local = createWasmBackend(base!);
    const here = local.table(S, columns(N));
    const inThread = await stall(() => sorted.execute(here));
    expect(inWorker.took).toBeGreaterThan(50);
    expect(inWorker.longest).toBeLessThan(inWorker.took / 4);
    // The same plan in this thread blocks it for most of the run, so the measurement can tell the two apart.
    expect(inThread.longest).toBeGreaterThan(inWorker.longest * 2);
  });

  test('progress arrives by message and ends at the table size', async () => {
    const backend = await start();
    const wasm = await backend.table(S, columns(300_000));
    const seen: number[] = [];
    await groups.execute(wasm as never, { chunkRows: 10_000, sliceMs: 0, onProgress: p => seen.push(p.rowsScanned) });
    expect(seen.length).toBeGreaterThan(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(300_000);
  });

  test('abort rejects at once with AbortError, and the worker stays usable', async () => {
    const backend = await start();
    const wasm = await backend.table(S, columns(1_500_000));
    const controller = new AbortController();
    const began = performance.now();
    const run = groups.execute(wasm as never, { chunkRows: 2000, sliceMs: 0, signal: controller.signal, onProgress: p => void (p.rowsScanned >= 20_000 && controller.abort()) });
    await rejectsWith(run, AbortError);
    expect(performance.now() - began).toBeLessThan(2000);
    expect(backend.replacements).toBe(0);
    expect((await total.execute(wasm as never)).toArray()[0]!.n).toBe(1_500_000);
    const stopped = new AbortController();
    stopped.abort();
    await rejectsWith(total.execute(wasm as never, { signal: stopped.signal }), AbortError);
  });

  test('abort stops the run inside the worker: the engine never finishes the aborted run', async () => {
    const backend = await start();
    const wasm = await backend.table(S, columns(1_000_000));
    // chunkRows 5 with sliceMs 0 makes a full run take about a second (200000 slices); an aborted one stops at once.
    // The worker answers other calls while a run is paused, so latency cannot show a run that carries on:
    // the engine's own count of finished runs does.
    const controller = new AbortController();
    const run = groups.execute(wasm as never, { chunkRows: 5, sliceMs: 0, signal: controller.signal, onProgress: p => void (p.rowsScanned >= 500 && controller.abort()) });
    await rejectsWith(run, AbortError);
    await new Promise(resolve => setTimeout(resolve, 2200));
    expect((await backend.stats()).engine).toBe(0);
    expect((await total.execute(wasm as never)).toArray()[0]!.n).toBe(1_000_000);
    expect((await backend.stats()).engine).toBe(1);
  });

  test('a trap in the worker: typed error, a new module, the table rebuilt from reload, nothing partial', async () => {
    const marker = `${tmpdir()}/zamda-fault-${process.pid}-${Date.now()}`;
    const backend = await start('faulty-host-module', undefined, marker);
    const wasm = await backend.table(S, rows(5000), { reload: () => rows(5000) });
    await rejectsWith(groups.execute(wasm as never), EngineCrashError);
    await backend.settled();
    expect(backend.replacements).toBe(1);
    expect((await groups.execute(wasm as never)).toArray()).toEqual((await groups.execute(table(S, rows(5000)))).toArray());
    rmSync(marker, { force: true });
  });

  test('a worker that dies fails what is waiting on it and is replaced', async () => {
    let current: { crash(): void } | null = null;
    const crashing = (): WorkerLike => {
      const real = spawn();
      const errors: ((e: { message?: string }) => void)[] = [];
      current = { crash: () => errors.forEach(f => f({ message: 'boom' })) };
      return {
        postMessage: (m, tr) => real.postMessage(m, tr),
        addEventListener: ((type: string, f: (e: never) => void) => (type === 'error' ? errors.push(f as never) : real.addEventListener(type as 'message', f as never))) as WorkerLike['addEventListener'],
        terminate: () => real.terminate(),
      };
    };
    const backend = await createManagedBackend(workerLink({ spawn: crashing, engine: { hostModule: hostModule('native-host-module') } }));
    open.push(backend);
    const wasm = await backend.table(S, columns(1_000_000), { reload: () => columns(1_000_000) });
    let crashed = false;
    const running = groups.execute(wasm as never, { chunkRows: 1000, sliceMs: 0, onProgress: () => { if (!crashed) { crashed = true; current!.crash(); } } });
    await rejectsWith(running, EngineCrashError);
    await backend.settled();
    expect(backend.replacements).toBe(1);
    expect((await total.execute(wasm as never)).toArray()[0]!.n).toBe(1_000_000);
  });

  test('a memory limit crosses to the worker and comes back as MemoryError, leaving the worker usable', async () => {
    const backend = await start('native-host-module', base!.memoryLive() + 12_000_000);
    const small = await backend.table(S, columns(10_000));
    await rejectsWith(backend.table(S, columns(3_000_000)), MemoryError);
    expect(backend.replacements).toBe(0);
    expect((await total.execute(small as never)).toArray()[0]!.n).toBe(10_000);
  });
});
