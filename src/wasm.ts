// The `zamda/wasm` entry point: the optional WASM accelerator (spec v4, "Public API").
//
//   import { wasmEngine } from 'zamda/wasm';
//   const engine = await wasmEngine();            // a Web Worker in browsers, this thread elsewhere
//   const big = await engine.load(Users, rows);   // resident in engine memory
//   const out = await plan.execute(big, { signal });
//
// The same compiled plan runs on a JS table and on an engine table, with the same results. Everything
// here sits on top of src/backends/wasm/ and adds no behaviour of its own: the failure model is managed.ts,
// the worker protocol is worker-link.ts. This module is outside the core budget; src/index.ts never imports it.

import { PlanError } from './errors';
import type { Fields, Schema } from './schema';
import type { TableInput } from './backends/js';
import type { WasmStats } from './backends/wasm';
import type { EngineRunHost } from './backends/wasm/host';
import { hostOf, loadEngine } from './backends/wasm/load';
import { createManagedBackend, inThreadLink } from './backends/wasm/managed';
import type { ManagedBackend, ManagedSession, ManagedTable, ManagedTableOptions } from './backends/wasm/managed';
import { createWorkerBackend } from './backends/wasm/worker-link';
import type { WorkerLike } from './backends/wasm/worker-link';
import type { EngineSource } from './backends/wasm/worker-protocol';

export type { ManagedBackend, ManagedSession, ManagedTable, ManagedTableOptions } from './backends/wasm/managed';
export type { WasmStats } from './backends/wasm';
export type { WorkerLike } from './backends/wasm/worker-link';

export interface WasmEngineOptions {
  // Where the engine module is: a URL (string or URL), its bytes, or a compiled module. Default: the
  // `zamda-engine.wasm` shipped next to this file in the package.
  readonly wasm?: string | URL | ArrayBuffer | ArrayBufferView | WebAssembly.Module;
  // Run the engine in a Web Worker (the default where `Worker` exists and this is a page), on this thread
  // (`false`), or in a worker you start yourself (a function; use it when your bundler needs the worker's
  // URL spelled out, or to run the worker built from source).
  readonly worker?: boolean | (() => WorkerLike);
  // A byte limit for engine memory; past it a load or run raises MemoryError and the engine stays healthy.
  // 0 or absent: no limit. At most 4 GiB (wasm32).
  readonly memoryLimitBytes?: number;
  // Worker only: how long an aborted run may hold the worker before it is terminated and replaced (ms).
  readonly stallMs?: number;
  /** @internal Tests: make the engine host directly instead of loading WASM (native library through FFI). */
  readonly host?: () => Promise<EngineRunHost>;
  /** @internal Tests: what the worker loads instead of `wasm`. */
  readonly workerEngine?: EngineSource;
}

export interface WasmEngine {
  // Copy rows or columns into engine memory once (C-LIVE: the table can grow with append()).
  load<F extends Fields>(schema: Schema<F>, data: TableInput<F>, options?: ManagedTableOptions): Promise<ManagedTable<F>>;
  // Where the engine runs, for the record: 'worker' or 'thread'.
  readonly mode: 'worker' | 'thread';
  // The backend behind the tables, for advanced use (sessions, stats, the memory limit).
  readonly backend: ManagedBackend;
  // Group the runs of one interaction so they share filter work (pass as `session` to execute()).
  session(): ManagedSession;
  stats(): Promise<WasmStats>;
  setMemoryLimit(bytes: number): Promise<void>;
  memoryLive(): Promise<number>;
  // Stop the engine. Its tables are gone; using them raises an error.
  terminate(): void;
  [Symbol.dispose](): void;
}

function defaultWasmUrl(): URL {
  // Purpose: the engine module shipped beside the built entry point (dist/zamda-engine.wasm)
  return new URL('./zamda-engine.wasm', import.meta.url);
}

function defaultWorker(): WorkerLike {
  // Purpose: the worker shipped beside the built entry point; written inline so bundlers can find it
  return new Worker(new URL('./zamda-worker.js', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

function inPage(): boolean {
  // Purpose: true in a browser page (main thread), where a plan on this thread would block rendering
  return typeof Worker !== 'undefined' && typeof document !== 'undefined';
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  // Purpose: the module's bytes from a URL; file: URLs are read from disk (Node's fetch cannot read them)
  if (url.protocol === 'file:') {
    const fs = 'node:fs/promises';
    const { readFile } = (await import(/* @vite-ignore */ fs)) as typeof import('node:fs/promises');
    const data = await readFile(url).catch((error: unknown) => {
      throw new PlanError(`The zamda engine could not be read from ${url.href} (${error instanceof Error ? error.message : String(error)}); build it with \`bun run wasm:build\` or pass { wasm }`);
    });
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new PlanError(`The zamda engine could not be fetched from ${url.href} (HTTP ${response.status}); build it with \`bun run wasm:build\` or pass { wasm }`);
  }
  return response.arrayBuffer();
}

function hostLoader(wasm: WasmEngineOptions['wasm']): () => Promise<EngineRunHost> {
  // Purpose: a function that makes a fresh engine instance (called again after a trap)
  if (wasm instanceof WebAssembly.Module) {
    return async () => hostOf(await WebAssembly.instantiate(wasm, {}));
  }
  if (wasm instanceof ArrayBuffer || ArrayBuffer.isView(wasm)) {
    const bytes = wasm;
    return () => loadEngine(bytes as BufferSource);
  }
  const url = wasm === undefined ? defaultWasmUrl() : new URL(String(wasm), typeof location === 'undefined' ? undefined : location.href);
  let compiled: Promise<WebAssembly.Module> | null = null;
  return async () => {
    // Compile once; every replacement instance after a trap reuses the module.
    compiled ??= fetchBytes(url)
      .then(bytes => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        compiled = null; // a failed fetch is retried on the next start, not cached
        throw error;
      });
    return hostOf(await WebAssembly.instantiate(await compiled, {}));
  };
}

function workerSource(wasm: WasmEngineOptions['wasm']): EngineSource {
  // Purpose: what the worker loads: a compiled module or bytes move with postMessage, a URL is fetched there
  if (wasm instanceof WebAssembly.Module) return { module: wasm };
  if (wasm instanceof ArrayBuffer) return { bytes: wasm };
  if (ArrayBuffer.isView(wasm)) return { bytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer };
  const url = wasm === undefined ? defaultWasmUrl() : new URL(String(wasm), typeof location === 'undefined' ? undefined : location.href);
  return { url: url.href };
}

export async function wasmEngine(options: WasmEngineOptions = {}): Promise<WasmEngine> {
  // Purpose: start the WASM engine, in a worker in browsers and on this thread elsewhere
  const limit = options.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: options.memoryLimitBytes };
  const useWorker = options.worker ?? inPage();
  let backend: ManagedBackend;
  if (useWorker === false) {
    backend = await createManagedBackend(inThreadLink(options.host ?? hostLoader(options.wasm)), limit);
  } else {
    backend = await createWorkerBackend({
      spawn: typeof useWorker === 'function' ? useWorker : defaultWorker,
      engine: options.workerEngine ?? workerSource(options.wasm),
      ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
      ...limit,
    });
  }
  const engine: WasmEngine = {
    mode: useWorker === false ? 'thread' : 'worker',
    backend,
    load: (schema, data, tableOptions) => backend.table(schema, data, tableOptions),
    session: () => backend.session(),
    stats: () => backend.stats(),
    setMemoryLimit: bytes => backend.setMemoryLimit(bytes),
    memoryLive: () => backend.memoryLive(),
    terminate: () => backend.terminate(),
    [Symbol.dispose]: () => backend.terminate(),
  };
  return engine;
}
