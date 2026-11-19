// The page's side of a worker that holds the engine (T-409): an EngineLink whose calls are messages. A plan
// runs in the worker, so it never blocks this thread: the page only posts a message and gets progress and
// the result back by message. Abort is a message too, and the run is rejected here at once, without waiting
// for the worker (a sort, or an aggregate's last pass, is one step that cannot be interrupted; the worker
// finishes it and drops the result). Use createWorkerBackend, which puts the failure model of managed.ts on top.

import type { ResultData } from '../../backend';
import { AbortError, EngineCrashError } from '../../errors';
import { createManagedBackend, EngineLinkFailure } from './managed';
import type { EngineLink, ManagedBackend, RunHooks, RunRequest, TableState } from './managed';
import type { WasmStats } from './index';
import { buffersOf, fromWire, resultOf } from './worker-protocol';
import type { EngineSource, Reply, Request } from './worker-protocol';

// The part of a Worker this code uses (a Web Worker, a Bun worker, or a stand-in in a test).
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onProgress?: RunHooks['onProgress'];
}

export function workerLink(options: { spawn: () => WorkerLike; engine: EngineSource }): EngineLink {
  // Purpose: a link to an engine in a worker made by `spawn`; a new worker is made when the engine is replaced
  let worker: WorkerLike | null = null;
  let pending = new Map<number, Pending>();
  let next = 1;

  const failAll = (message: string): void => {
    // Purpose: the worker is gone: every call waiting on it fails with a lost-engine error
    const waiting = pending;
    pending = new Map();
    for (const p of waiting.values()) p.reject(new EngineLinkFailure(new EngineCrashError(message)));
  };
  const attach = (w: WorkerLike): void => {
    // Purpose: listen to one worker
    w.addEventListener('message', event => {
      const reply = event.data as Reply;
      const p = pending.get(reply.id);
      if (p === undefined) return;
      if ('progress' in reply) {
        p.onProgress?.(reply.progress);
        return;
      }
      pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.value);
      else if (reply.lost) p.reject(new EngineLinkFailure(fromWire(reply.error)));
      else p.reject(fromWire(reply.error));
    });
    w.addEventListener('error', event => {
      if (worker === w) failAll(`The worker stopped (${event.message ?? 'no message'}) and was replaced`);
    });
    w.addEventListener('messageerror', () => {
      if (worker === w) failAll('A message to or from the worker could not be read');
    });
  };
  const call = function <T>(request: (id: number) => Request, transfer: Transferable[] = [], hooks: RunHooks = {}): { id: number; promise: Promise<T> } {
    // Purpose: post one request and wait for its reply
    if (worker === null) return { id: 0, promise: Promise.reject(new EngineLinkFailure(new EngineCrashError('The engine worker is not running'))) };
    const id = next++;
    const promise = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress }) });
    });
    try {
      worker.postMessage(request(id), transfer);
    } catch (e) {
      pending.delete(id);
      return { id, promise: Promise.reject(e) };
    }
    return { id, promise };
  };
  const plain = <T>(request: (id: number) => Request, transfer?: Transferable[]): Promise<T> => call<T>(request, transfer).promise;

  return {
    async start(memoryLimitBytes) {
      // Purpose: a new worker with a fresh engine (the old worker, if any, is stopped)
      const old = worker;
      worker = null;
      failAll('The engine worker was replaced');
      old?.terminate();
      const w = options.spawn();
      worker = w;
      attach(w);
      await plain<void>(id => ({ id, type: 'start', engine: options.engine, memoryLimitBytes }));
    },
    setMemoryLimit: bytes => plain<void>(id => ({ id, type: 'limit', bytes })),
    createTable: (tableId, schema, data, tableOptions, transfer) => {
      const { reload: _reload, transfer: _transfer, ...cloneable } = tableOptions as Record<string, unknown>;
      void _reload;
      void _transfer;
      return plain<TableState>(id => ({ id, type: 'createTable', tableId, schema, data, options: cloneable }), transfer ? buffersOf(data) : []);
    },
    append: (tableId, data, transfer) => plain<TableState>(id => ({ id, type: 'append', tableId, data }), transfer ? buffersOf(data) : []),
    dropTable: tableId => plain<void>(id => ({ id, type: 'drop', tableId })),
    openSession: sessionId => plain<void>(id => ({ id, type: 'openSession', sessionId })),
    closeSession: sessionId => plain<void>(id => ({ id, type: 'closeSession', sessionId })),
    run(request: RunRequest, hooks: RunHooks): Promise<ResultData> {
      // Purpose: run a plan in the worker; progress arrives as messages, abort rejects here at once
      const { id, promise } = call<unknown>(i => ({ id: i, type: 'run', request }), [], hooks);
      const signal = hooks.signal;
      if (signal === undefined) return promise.then(resultOf);
      return new Promise<ResultData>((resolve, reject) => {
        const onAbort = (): void => {
          pending.delete(id);
          worker?.postMessage({ id: next++, type: 'abort', target: id } satisfies Request);
          reject(new AbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          value => {
            signal.removeEventListener('abort', onAbort);
            resolve(resultOf(value));
          },
          error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
    stats: () => plain<WasmStats>(id => ({ id, type: 'stats' })),
    memoryLive: () => plain<number>(id => ({ id, type: 'memoryLive' })),
    terminate() {
      // Purpose: stop the worker and everything in it
      const w = worker;
      worker = null;
      failAll('The engine worker was stopped');
      w?.terminate();
    },
  };
}

export function createWorkerBackend(options: { spawn: () => WorkerLike; engine: EngineSource; memoryLimitBytes?: number }): Promise<ManagedBackend> {
  // Purpose: the WASM engine in a worker, with the memory limit and the failure model of managed.ts
  return createManagedBackend(workerLink({ spawn: options.spawn, engine: options.engine }), options.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: options.memoryLimitBytes });
}
