// The page's side of a worker that holds the engine (T-409): an EngineLink whose calls are messages. A plan
// runs in the worker, so it never blocks this thread: the page only posts a message and gets progress and
// the result back by message. Abort is a message too, and the run is rejected here at once, without waiting
// for the worker (a sort, or an aggregate's last pass, is one step that cannot be interrupted; the worker
// finishes it and drops the result). Use createWorkerBackend, which puts the failure model of managed.ts on top.

import type { ResultData } from '../../backend';
import { AbortError, EngineCrashError, PlanError } from '../../errors';
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
  onTiming?: RunHooks['onTiming'];
}

// How long an aborted run may keep the worker busy before the worker is treated as stuck, by default.
// Only a bug should get near it: the longest single step (a sort of every row) takes well under a second.
export const DEFAULT_STALL_MS = 5000;

export interface WorkerLinkOptions {
  readonly spawn: () => WorkerLike;
  readonly engine: EngineSource;
  // The backstop of the failure model: after abort(), if the worker has not answered the aborted run within
  // this many milliseconds, it is terminated and the engine is replaced (tables without `reload` are lost).
  // 0 turns the backstop off.
  readonly stallMs?: number;
}

export function workerLink(options: WorkerLinkOptions): EngineLink {
  // Purpose: a link to an engine in a worker made by `spawn`; a new worker is made when the engine is replaced
  let worker: WorkerLike | null = null;
  let pending = new Map<number, Pending>();
  // Aborted runs the worker has not answered yet, each with its stall timer.
  const draining = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  if (!(stallMs >= 0)) throw new PlanError(`stallMs must be zero or more, got ${stallMs}`);

  const stopDraining = (): void => {
    // Purpose: forget the stall timers of a worker that is gone
    for (const timer of draining.values()) clearTimeout(timer);
    draining.clear();
  };

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
      const timer = draining.get(reply.id);
      if (timer !== undefined && !('progress' in reply)) {
        // The worker answered an aborted run: it is not stuck, and the answer is dropped.
        clearTimeout(timer);
        draining.delete(reply.id);
        return;
      }
      const p = pending.get(reply.id);
      if (p === undefined) return;
      if ('progress' in reply) {
        p.onProgress?.(reply.progress);
        return;
      }
      pending.delete(reply.id);
      if (reply.ok) {
        if (reply.took !== undefined) p.onTiming?.(reply.took);
        p.resolve(reply.value);
      }
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
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress }), ...(hooks.onTiming === undefined ? {} : { onTiming: hooks.onTiming }) });
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
      stopDraining();
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
    createBlocks: (tableId, schema, segments) => plain<TableState>(id => ({ id, type: 'createBlocks', tableId, schema, segments })),
    editBlocks: (tableId, edits) => plain<TableState>(id => ({ id, type: 'editBlocks', tableId, edits })),
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
          const w = worker;
          if (w !== null) {
            w.postMessage({ id: next++, type: 'abort', target: id } satisfies Request);
            if (stallMs > 0) {
              draining.set(
                id,
                setTimeout(() => {
                  // The aborted run never gave the worker back: terminate it. The next call finds no worker,
                  // which the managed backend treats as a lost engine and replaces (C-FAIL backstop).
                  draining.delete(id);
                  if (worker !== w) return;
                  worker = null;
                  stopDraining();
                  failAll(`The engine worker did not stop within ${stallMs} ms of an abort and was terminated`);
                  w.terminate();
                }, stallMs),
              );
            }
          }
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
      stopDraining();
      failAll('The engine worker was stopped');
      w?.terminate();
    },
  };
}

export async function createWorkerBackend(options: WorkerLinkOptions & { memoryLimitBytes?: number }): Promise<ManagedBackend> {
  // Purpose: the WASM engine in a worker, with the memory limit and the failure model of managed.ts
  const { memoryLimitBytes, ...link } = options;
  return createManagedBackend(workerLink(link), memoryLimitBytes === undefined ? {} : { memoryLimitBytes });
}
