// The standalone demo's WASM seam. It copies graph.bin's typed columns into a
// WASM engine worker once; every later plan runs on both engines and the WASM
// answer is used only when it matches the JS reference.

import type { Table } from '../src';
import { GraphEdges } from '../scripts/bgp/graph-file';
import type { GraphArrays } from '../scripts/bgp/graph-file';
import type { ManagedBackend } from '../src/backends/wasm/managed';
import { createWorkerBackend } from '../src/backends/wasm/worker-link';
import type { WorkerLike } from '../src/backends/wasm/worker-link';

export interface GraphEngine {
  readonly backend: ManagedBackend;
  readonly table: Table<typeof GraphEdges.fields>;
}

function spawnWorker(): WorkerLike {
  // Purpose: start the module worker built and served by atlas/server.ts
  return new Worker('/worker-entry.js', { type: 'module' }) as unknown as WorkerLike;
}

export async function startGraphEngine(
  arrays: GraphArrays,
  onStatus: (message: string) => void,
): Promise<GraphEngine> {
  // Purpose: check for the engine, start it, and load the graph columns into it
  const url = new URL('/engine.wasm', location.href).href;
  onStatus('checking WASM engine…');
  const check = await fetch(url, { method: 'HEAD' });
  if (!check.ok) throw new Error(`No WASM engine at /engine.wasm (${check.status}); run \`bun run wasm:build\``);
  onStatus('starting worker…');
  const backend = await createWorkerBackend({ spawn: spawnWorker, engine: { url } });
  try {
    onStatus('copying graph columns into WASM memory…');
    const table = await backend.table(GraphEdges, {
      columns: {
        from_as: arrays.from_as,
        to_as: arrays.to_as,
        prefixes: arrays.prefixes,
        span_km: arrays.span_km,
      },
    });
    return { backend, table };
  } catch (error) {
    backend.terminate();
    throw error;
  }
}
