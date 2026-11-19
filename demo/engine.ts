// The demo's engine seam: one routes file becomes a JS table for the charts and
// the same columns become a table in the WASM engine, held in a Web Worker. The
// worker and the engine bytes are served by demo/server.ts; if either is missing
// the page says so and stays on the JS reference engine.

import type { Table, TableInput } from '../src';
import { Routes } from '../scripts/bgp/file';
import type { RouteArrays } from '../scripts/bgp/file';
import type { ManagedBackend } from '../src/backends/wasm/managed';
import { createWorkerBackend } from '../src/backends/wasm/worker-link';
import type { WorkerLike } from '../src/backends/wasm/worker-link';

export interface EngineSession {
  readonly backend: ManagedBackend;
  readonly table: Table<typeof Routes.fields>;
  readonly engineUrl: string;
}

export function routeColumns(arrays: RouteArrays): TableInput<typeof Routes.fields> {
  // Purpose: the decoded routes file as one column per field, for either backend
  return {
    columns: {
      prefix_addr: arrays.prefix_addr,
      prefix_len: arrays.prefix_len,
      origin_as: arrays.origin_as,
      as_name: arrays.as_name,
      path_len: arrays.path_len,
      rir: arrays.rir,
    },
  };
}

function spawnWorker(): WorkerLike {
  // Purpose: a module worker whose code is built and served by the demo server
  return new Worker('/worker-entry.js', { type: 'module' }) as unknown as WorkerLike;
}

export async function startEngine(
  arrays: RouteArrays,
  onStatus: (message: string) => void,
): Promise<EngineSession> {
  // Purpose: check for the engine, start it in a worker, and build its routes table
  const engineUrl = new URL('/engine.wasm', location.href).href;
  onStatus('checking engine module…');
  const check = await fetch(engineUrl, { method: 'HEAD' });
  if (!check.ok) {
    throw new Error(`No WASM engine at /engine.wasm (${check.status}); run \`bun run wasm:build\` first`);
  }
  onStatus('starting worker…');
  const backend = await createWorkerBackend({ spawn: spawnWorker, engine: { url: engineUrl } });
  try {
    onStatus('copying routes into engine memory…');
    const table = await backend.table(Routes, routeColumns(arrays));
    onStatus(`worker ready · ${table.rowCount.toLocaleString()} rows`);
    return { backend, table, engineUrl };
  } catch (error) {
    backend.terminate();
    throw error;
  }
}
