// The same tables on two zamda backends: the JS reference executor on this thread, and the WASM engine
// in a Web Worker. The switch picks which one answers; both are kept identical (every live update goes
// to both), so switching shows the speed difference on the same data and the same compiled plans.

import { keyedTable, table } from 'zamda';
import type { KeyedTable, Plan, Result, RunSession, Table } from 'zamda';
import { wasmEngine } from 'zamda/wasm';
import type { WasmEngine, WorkerLike } from 'zamda/wasm';
import type { RouteColumns, UpdateColumns } from './data';
import { Routes, Updates } from './schemas';

export type EngineName = 'js' | 'wasm';

type RoutesT = typeof Routes.fields;
type UpdatesT = typeof Updates.fields;

export interface EngineTables {
  readonly routes: KeyedTable<RoutesT>;
  readonly replay: Table<UpdatesT>;
  readonly live: Table<UpdatesT> & { append(data: { columns: Record<string, ArrayLike<number>> }): void | Promise<void> };
}

export const LIVE_ROWS = 600_000;
// Small blocks keep each live upsert cheap: a batch rewrites only the blocks its prefixes fall in.
// With 1.17 M routes and ~1 k changed prefixes per second, 4096-row blocks meant almost every block
// in the table was copied to the worker on every batch. 128 rows bounds that to about 128 changed rows
// per touched prefix while keeping the segment count reasonable for the engine's route queries.
const BLOCK_ROWS = 128;

function emptyUpdates(): { columns: Record<keyof UpdatesT, ArrayLike<number>> } {
  // Purpose: column input with no rows
  return { columns: { second: new Uint32Array(0), kind: new Uint8Array(0), prefix_addr: new Uint32Array(0), prefix_len: new Uint8Array(0), origin_as: new Uint32Array(0), peer_as: new Uint32Array(0), path_len: new Uint8Array(0), cc: new Uint8Array(0), pkey: new Float64Array(0) } };
}

function spawnWorker(): WorkerLike {
  // Purpose: the engine's worker, bundled by Vite from zamda's source
  return new Worker(new URL('../../../../packages/zamda/src/backends/wasm/worker-entry.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

export interface Timing {
  readonly ms: number;
  readonly engine: EngineName;
}

export class Engines {
  readonly js: EngineTables;
  wasm: EngineTables | null = null;
  wasmError: string | null = null;
  private engine: WasmEngine | null = null;
  private readonly lanes = new Map<string, AbortController>();

  private constructor(js: EngineTables) {
    // Purpose: hold the JS tables; the WASM ones arrive later
    this.js = js;
  }

  static createJs(routes: RouteColumns, replay: UpdateColumns): Engines {
    // Purpose: the JS backend's tables, built at once from the downloaded columns (no copy)
    return new Engines({
      routes: keyedTable(Routes, ['prefix_addr', 'prefix_len'], { columns: routes.columns }, { blockRows: BLOCK_ROWS }),
      replay: table(Updates, { columns: replay.columns }),
      live: table(Updates, emptyUpdates(), { retain: { rows: LIVE_ROWS } }) as unknown as EngineTables['live'],
    });
  }

  async startWasm(routes: RouteColumns, replay: UpdateColumns, onStatus: (text: string) => void): Promise<void> {
    // Purpose: start the WASM engine in a worker and copy the same tables into it
    try {
      const check = await fetch('/engine/zamda-engine.wasm', { method: 'HEAD' });
      if (!check.ok) throw new Error('no WASM engine was built (run `bun run build` at the repository root)');
      onStatus('starting the WASM engine in a worker');
      const engine = await wasmEngine({ wasm: '/engine/zamda-engine.wasm', worker: spawnWorker });
      this.engine = engine;
      onStatus('copying 1.2 M routes into WASM memory');
      const routesTable = await engine.loadKeyed(Routes, ['prefix_addr', 'prefix_len'], { columns: routes.columns }, { blockRows: BLOCK_ROWS });
      onStatus('copying the update log into WASM memory');
      const replayTable = await engine.load(Updates, { columns: replay.columns });
      const liveTable = await engine.load(Updates, emptyUpdates(), { retain: { rows: LIVE_ROWS } });
      this.wasm = { routes: routesTable, replay: replayTable, live: liveTable as unknown as EngineTables['live'] };
    } catch (error) {
      this.wasmError = error instanceof Error ? error.message : String(error);
      this.wasm = null;
    }
  }

  tables(name: EngineName): EngineTables {
    // Purpose: the tables of one engine (JS when WASM is not available)
    return name === 'wasm' && this.wasm !== null ? this.wasm : this.js;
  }

  session(name: EngineName): (RunSession & { close(): void }) | undefined {
    // Purpose: a WASM session lets one frame's queries share their filter work; JS needs none
    return name === 'wasm' && this.engine !== null ? this.engine.session() : undefined;
  }

  async run<T extends readonly Job[]>(lane: string, name: EngineName, jobs: T): Promise<{ results: { [K in keyof T]: Result<never> }; ms: number } | null> {
    // Purpose: run a set of plans together on one engine; a newer call on the same lane aborts this one (null)
    this.lanes.get(lane)?.abort();
    const controller = new AbortController();
    this.lanes.set(lane, controller);
    const session = this.session(name);
    const started = performance.now();
    try {
      const results = await Promise.all(
        jobs.map(job =>
          (job.plan as Plan<never, never, never>).execute(job.table(this.tables(name)) as never, { params: job.params, signal: controller.signal, ...(session ? { session } : {}) } as never),
        ),
      );
      return { results: results as never, ms: performance.now() - started };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null;
      throw error;
    } finally {
      session?.close();
      if (this.lanes.get(lane) === controller) this.lanes.delete(lane);
    }
  }

  async appendLive(columns: Record<keyof UpdatesT, ArrayLike<number>>): Promise<void> {
    // Purpose: add one batch of live updates to both engines
    this.js.live.append({ columns });
    if (this.wasm !== null) await this.wasm.live.append({ columns });
  }

  applyRoutes(upserts: Record<keyof RoutesT, ArrayLike<number>> | null, deletes: readonly [number, number][]): void {
    // Purpose: apply a batch of route changes to both engines' routing tables (keyed: upsert and delete)
    for (const tables of [this.js, this.wasm]) {
      if (tables === null) continue;
      if (upserts !== null) tables.routes.upsert({ columns: upserts } as never);
      if (deletes.length > 0) tables.routes.delete(deletes);
    }
  }
}

export interface Job {
  readonly plan: unknown;
  readonly table: (tables: EngineTables) => Table;
  readonly params?: unknown;
}
