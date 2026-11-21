// A managed engine (T-409, T-410): the WASM backend behind a link, with the failure model around it.
//
// The link is the engine somewhere: in this thread (`inThreadLink`) or in a worker (worker-link.ts). The
// managed backend gives every table an id, keeps what it needs to rebuild a table, and watches for the one
// failure that ends an engine module: a trap (a bug, or an allocation past the byte limit that could not be
// refused cleanly). A trapped module cannot be trusted, so it is thrown away:
//   - every run in flight on it fails with a typed error (EngineCrashError, or MemoryError when the engine
//     had refused an allocation for the limit) and delivers nothing;
//   - a new module is made, and each table that was given a `reload` function is rebuilt from it; a table
//     without one is marked lost and raises HandleError when used;
//   - runs and appends that come after wait for that to finish.
// Nothing a trapped run built is ever returned: a result exists only after the engine finished the run.

import type { BackendOptions, ResultData, Table } from '../../backend';
import { AbortError, EngineCrashError, HandleError, MemoryError, PlanError, ZamdaError } from '../../errors';
import type { IrPlan } from '../../ir';
import type { Fields, Schema } from '../../schema';
import type { TableInput, TableOptions } from '../js';
import type { Segment } from '../js/exec';
import type { SegmentEdit } from './store';
import { KeyedTable } from '../../keyed';
import type { KeyedStore, KeyedTableOptions, KeyFields } from '../../keyed';
import type { Backend } from '../../backend';
import type { EngineRunHost } from './host';
import { createWasmBackend } from './index';
import type { WasmSession, WasmStats, WasmTable } from './index';

// What a link reports about a table after an operation.
export interface TableState {
  readonly rowCount: number;
  readonly rowsDropped: number;
}

// One run, as it crosses a link.
export interface RunRequest {
  readonly runId: number;
  readonly plan: IrPlan;
  readonly tableId: number;
  readonly params: BackendOptions['params'];
  readonly chunkRows?: number;
  readonly sliceMs?: number;
  readonly sessionId?: number;
}

export interface RunHooks {
  readonly onProgress?: BackendOptions['onProgress'];
  readonly onTiming?: BackendOptions['onTiming'];
  readonly signal?: AbortSignal;
}

// Thrown by a link when its engine module is gone (trapped, or its worker died). `error` is what the caller sees.
export class EngineLinkFailure extends Error {
  readonly error: ZamdaError;
  constructor(error: ZamdaError) {
    // Purpose: the engine behind a link is lost; carries the typed error the caller gets
    super(error.message);
    this.error = error;
  }
}

export interface EngineLink {
  // Make a fresh engine module (the first one, or the replacement for a lost one) with a memory limit (0 = none).
  start(memoryLimitBytes: number): Promise<void>;
  setMemoryLimit(bytes: number): Promise<void>;
  createTable(id: number, schema: Schema, data: TableInput<Fields>, options: TableOptions, transfer: boolean): Promise<TableState>;
  // Keyed tables: a table of ready segments, and in-place segment edits (all or nothing).
  createBlocks(id: number, schema: Schema, segments: readonly Segment[]): Promise<TableState>;
  editBlocks(id: number, edits: readonly SegmentEdit[]): Promise<TableState>;
  append(id: number, data: TableInput<Fields>, transfer: boolean): Promise<TableState>;
  dropTable(id: number): Promise<void>;
  openSession(id: number): Promise<void>;
  closeSession(id: number): Promise<void>;
  run(request: RunRequest, hooks: RunHooks): Promise<ResultData>;
  stats(): Promise<WasmStats>;
  // Memory the engine holds now, in bytes.
  memoryLive(): Promise<number>;
  terminate(): void;
}

export function classify(error: unknown, limit: number, refused: boolean): ZamdaError {
  // Purpose: the typed error for something that was not a ZamdaError coming out of the engine: a trap
  const what = error instanceof Error ? error.message : String(error);
  if (refused) return new MemoryError(`The engine passed its memory limit${limit > 0 ? ` of ${limit} bytes` : ''} and had to be replaced (${what})`);
  return new EngineCrashError(`The engine stopped with an unexpected failure and was replaced (${what})`);
}

// wasm32 addresses 4 GiB; the engine takes the limit as a 32-bit size, so a larger number would wrap.
const MAX_LIMIT = 2 ** 32 - 1;

function checkLimit(what: string, bytes: number): void {
  // Purpose: refuse a byte limit the engine cannot hold, instead of letting it wrap to a small one
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_LIMIT) {
    throw new PlanError(`${what} must be an integer from 0 (no limit) to ${MAX_LIMIT} bytes, got ${bytes}`);
  }
}

export function inThreadLink(load: () => Promise<EngineRunHost>): EngineLink {
  // Purpose: a link to an engine loaded in this thread
  let host: EngineRunHost | null = null;
  let backend: ReturnType<typeof createWasmBackend> | null = null;
  let limit = 0;
  const tables = new Map<number, WasmTable>();
  const sessions = new Map<number, WasmSession>();
  const guard = async function <T>(f: () => T | Promise<T>): Promise<T> {
    // Purpose: run an engine call; a ZamdaError is the call's own result, anything else means the module is lost
    if (host === null || backend === null) throw new EngineLinkFailure(new EngineCrashError('The engine is not running'));
    try {
      return await f();
    } catch (e) {
      if (e instanceof ZamdaError) throw e;
      const refused = (() => {
        try {
          return host.memoryRefused();
        } catch {
          return false;
        }
      })();
      host = null;
      backend = null;
      tables.clear();
      sessions.clear();
      throw new EngineLinkFailure(classify(e, limit, refused));
    }
  };
  const state = (table: WasmTable): TableState => ({ rowCount: table.rowCount, rowsDropped: table.rowsDropped });
  const find = (id: number): WasmTable => {
    const table = tables.get(id);
    if (table === undefined) throw new HandleError(`The engine has no table ${id}`);
    return table;
  };
  return {
    async start(bytes) {
      // Purpose: load a new engine module
      host = null;
      backend = null;
      tables.clear();
      sessions.clear();
      limit = bytes;
      const h = await load();
      h.memoryLimit(bytes);
      host = h;
      backend = createWasmBackend(h);
    },
    async setMemoryLimit(bytes) {
      // Purpose: change the byte limit of the running module
      await guard(() => {
        limit = bytes;
        host!.memoryLimit(bytes);
      });
    },
    createTable: (id, schema, data, options) =>
      guard(() => {
        const table = backend!.table(schema, data, options);
        tables.set(id, table);
        return state(table);
      }),
    createBlocks: (id, schema, segments) =>
      guard(() => {
        const table = backend!.blocks(schema, segments);
        tables.set(id, table);
        return state(table);
      }),
    editBlocks: (id, edits) =>
      guard(() => {
        const table = find(id);
        table.edit(edits);
        return state(table);
      }),
    append: (id, data) =>
      guard(() => {
        const table = find(id);
        table.append(data);
        return state(table);
      }),
    dropTable: id =>
      guard(() => {
        tables.get(id)?.dispose();
        tables.delete(id);
      }),
    openSession: id =>
      guard(() => {
        sessions.set(id, backend!.backend.session());
      }),
    closeSession: id =>
      guard(() => {
        sessions.get(id)?.close();
        sessions.delete(id);
      }),
    run: (request, hooks) =>
      guard(() => {
        const session = request.sessionId === undefined ? undefined : sessions.get(request.sessionId);
        if (request.sessionId !== undefined && session === undefined) throw new PlanError('options.session is not open in the engine');
        return backend!.backend.execute(request.plan, find(request.tableId), {
          params: request.params,
          ...(request.chunkRows === undefined ? {} : { chunkRows: request.chunkRows }),
          ...(request.sliceMs === undefined ? {} : { sliceMs: request.sliceMs }),
          ...(hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress }),
          ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
          ...(session === undefined ? {} : { session }),
        });
      }),
    stats: () => guard(() => ({ ...backend!.backend.stats, phasesMs: { ...backend!.backend.stats.phasesMs }, cache: { ...backend!.backend.stats.cache } })),
    memoryLive: () => guard(() => host!.memoryLive()),
    terminate() {
      // Purpose: drop the module (the engine memory goes with it)
      host = null;
      backend = null;
      tables.clear();
      sessions.clear();
    },
  };
}

export interface ManagedTableOptions extends TableOptions {
  // Called to rebuild the table (its rows as they should be now, appended rows included) after the engine
  // module was lost. Without it the table is lost with the module.
  readonly reload?: () => TableInput<Fields> | Promise<TableInput<Fields>>;
  /** @internal Keyed tables: rebuild from the current blocks instead. */
  readonly reloadBlocks?: () => readonly Segment[];
  // Move the columns of typed arrays to the engine (they are detached here) instead of copying them. Only a
  // link that crosses threads moves anything; for an in-thread link it changes nothing.
  readonly transfer?: boolean;
}

export interface ManagedSession {
  readonly kind: 'zamda/managed-session';
  close(): void;
}

interface SessionRecord extends ManagedSession {
  readonly id: number;
  readonly generation: number;
  closed: boolean;
}

export class ManagedTable<F extends Fields = Fields> implements Table<F> {
  readonly schema: Schema<F>;
  readonly backend: ManagedBackend;
  /** @internal */
  readonly id: number;
  /** @internal */
  readonly options: ManagedTableOptions;
  /** @internal */
  state: TableState;
  /** @internal */
  lost = false;
  /** @internal */
  disposed = false;

  constructor(backend: ManagedBackend, id: number, schema: Schema<F>, options: ManagedTableOptions, state: TableState) {
    // Purpose: a table held by a managed engine
    this.schema = schema;
    this.backend = backend;
    this.id = id;
    this.options = options;
    this.state = state;
  }

  get rowCount(): number {
    // Purpose: rows in the table as of the last operation that finished
    return this.state.rowCount;
  }

  get rowsDropped(): number {
    // Purpose: rows removed so far by the retain window, as of the last operation that finished
    return this.state.rowsDropped;
  }

  append(data: TableInput<F>, options: { transfer?: boolean } = {}): Promise<void> {
    // Purpose: C-LIVE: add rows; runs started before this finishes do not see them, runs started after do
    return this.backend.appendTo(this, data as TableInput<Fields>, options.transfer ?? this.options.transfer ?? false);
  }

  dispose(): Promise<void> {
    // Purpose: free the table in the engine
    return this.backend.disposeTable(this);
  }

  [Symbol.asyncDispose](): Promise<void> {
    // Purpose: `await using t = await engine.load(...)` frees the table at the end of the block
    return this.dispose();
  }

  [Symbol.dispose](): void {
    // Purpose: `using t = ...` starts freeing the table at the end of the block (the engine frees it shortly after)
    void this.dispose();
  }
}

export interface ManagedBackend extends Backend {
  readonly name: 'wasm-managed';
  // Times the engine module was replaced after a trap.
  readonly replacements: number;
  table<F extends Fields>(schema: Schema<F>, data: TableInput<F>, options?: ManagedTableOptions): Promise<ManagedTable<F>>;
  // A keyed live table (C-LIVE-KEY) held in the engine; mutations are posted in order and runs started after
  // a mutation see it. It is rebuilt from its own blocks if the engine has to be replaced.
  keyedTable<F extends Fields>(schema: Schema<F>, keyFields: KeyFields<F>, data: TableInput<F>, options?: KeyedTableOptions): Promise<KeyedTable<F>>;
  session(): ManagedSession;
  stats(): Promise<WasmStats>;
  setMemoryLimit(bytes: number): Promise<void>;
  memoryLive(): Promise<number>;
  // Resolves once the engine is healthy again after a loss (at once if it is).
  settled(): Promise<void>;
  terminate(): void;
  /** @internal */
  appendTo(table: ManagedTable, data: TableInput<Fields>, transfer: boolean): Promise<void>;
  /** @internal */
  disposeTable(table: ManagedTable): Promise<void>;
}

export async function createManagedBackend(link: EngineLink, options: { memoryLimitBytes?: number } = {}): Promise<ManagedBackend> {
  // Purpose: start an engine behind a link and wrap it in the failure model above
  let limit = options.memoryLimitBytes ?? 0;
  checkLimit('memoryLimitBytes', limit);
  await link.start(limit);
  let generation = 0;
  let replacements = 0;
  let healthy: Promise<void> = Promise.resolve();
  let nextTable = 1;
  let nextSession = 1;
  let nextRun = 1;
  const tables = new Map<number, ManagedTable>();
  const sessions = new Set<SessionRecord>();

  const recover = async function (): Promise<void> {
    // Purpose: after a loss: start a new module and rebuild the tables that can be rebuilt
    replacements++;
    await link.start(limit);
    for (const table of tables.values()) {
      if (table.disposed) continue;
      if (table.options.reload === undefined && table.options.reloadBlocks === undefined) {
        table.lost = true;
        continue;
      }
      try {
        if (table.options.reloadBlocks !== undefined) {
          table.state = await link.createBlocks(table.id, table.schema, table.options.reloadBlocks());
          table.lost = false;
          continue;
        }
        const data = await table.options.reload!();
        table.state = await link.createTable(table.id, table.schema, data, table.options, false);
        table.lost = false;
      } catch (e) {
        if (e instanceof EngineLinkFailure) throw e;
        // The rebuild failed for a reason of its own (the data, the limit): the table stays lost, and says so.
        table.lost = true;
      }
    }
  };
  const lose = function (failure: EngineLinkFailure, seen: number): ZamdaError {
    // Purpose: note that the module of generation `seen` is gone (once), and start replacing it
    if (seen === generation) {
      generation++;
      for (const s of sessions) s.closed = true;
      sessions.clear();
      healthy = recover().catch(() => undefined);
    }
    return failure.error;
  };
  const call = async function <T>(f: () => Promise<T>): Promise<T> {
    // Purpose: run a link operation on a healthy engine; a lost engine raises the typed error and starts its replacement
    await healthy;
    const seen = generation;
    try {
      return await f();
    } catch (e) {
      if (e instanceof EngineLinkFailure) throw lose(e, seen);
      throw e;
    }
  };
  const usable = function (table: ManagedTable): void {
    // Purpose: raise if the table cannot be used (disposed, or lost with a module)
    if (table.disposed) throw new HandleError('This table was disposed');
    if (table.lost) throw new HandleError('This table was lost when the engine module was replaced after a failure; it has no reload function');
  };
  const backend: ManagedBackend = {
    name: 'wasm-managed',
    get replacements() {
      return replacements;
    },
    async table(schema, data, tableOptions = {}) {
      // Purpose: create a table in the engine
      const id = nextTable++;
      const state = await call(() => link.createTable(id, schema as Schema, data as TableInput<Fields>, tableOptions, tableOptions.transfer ?? false));
      const table = new ManagedTable(backend, id, schema, tableOptions, state);
      tables.set(id, table as unknown as ManagedTable);
      return table;
    },
    async keyedTable(schema, keyFields, data, keyedOptions = {}) {
      // Purpose: a keyed table whose blocks are segments of one engine table, edited in place
      let latest: readonly Segment[] = [];
      let created: Promise<void> = Promise.resolve();
      let managed: ManagedTable | null = null;
      const store: KeyedStore<typeof schema.fields> = {
        create(blocks) {
          // Purpose: register the engine table now and post its creation; runs queue behind it
          latest = blocks;
          const id = nextTable++;
          const rows = blocks.reduce((n, b) => n + b.rowCount, 0);
          managed = new ManagedTable(backend, id, schema as Schema, { reloadBlocks: () => latest }, { rowCount: rows, rowsDropped: 0 });
          tables.set(id, managed);
          const table = managed;
          created = call(() => link.createBlocks(id, schema as Schema, blocks)).then(state => {
            table.state = state;
          });
          return managed as unknown as Table<typeof schema.fields>;
        },
        edit(current, edits, blocks) {
          // Purpose: post the edit; it reaches the worker before any run started after this call
          latest = blocks;
          const table = current as unknown as ManagedTable;
          return (async () => {
            usable(table);
            table.state = await call(() => link.editBlocks(table.id, edits));
            return current;
          })();
        },
      };
      const keyed = new KeyedTable(schema, keyFields, data, keyedOptions, store);
      try {
        await created;
      } catch (error) {
        if (managed !== null) tables.delete((managed as ManagedTable).id);
        throw error;
      }
      return keyed;
    },
    unwrap(table) {
      // Purpose: the engine table behind a keyed wrapper (C-LIVE-KEY)
      return table instanceof KeyedTable ? table.current() : table;
    },
    async appendTo(table, data, transfer) {
      // Purpose: add rows to a table
      usable(table);
      table.state = await call(() => link.append(table.id, data, transfer));
    },
    async disposeTable(table) {
      // Purpose: free a table
      if (table.disposed) return;
      table.disposed = true;
      tables.delete(table.id);
      if (!table.lost) await call(() => link.dropTable(table.id)).catch(() => undefined);
    },
    session() {
      // Purpose: open a session: runs given it share their filter work in the engine
      const id = nextSession++;
      const record: SessionRecord = {
        kind: 'zamda/managed-session',
        id,
        generation,
        closed: false,
        close() {
          // Purpose: drop the session's cache (once)
          if (record.closed) return;
          record.closed = true;
          sessions.delete(record);
          if (record.generation === generation) void link.closeSession(id).catch(() => undefined);
        },
      };
      sessions.add(record);
      void call(() => link.openSession(id)).catch(() => {
        record.closed = true;
      });
      return record;
    },
    async execute(plan, table, runOptions) {
      // Purpose: run a plan on a table of this backend, as the table stood when the run started
      if (!(table instanceof ManagedTable) || table.backend !== backend) {
        throw new PlanError('The managed WASM backend can only run plans on tables it created');
      }
      usable(table);
      if (runOptions.signal?.aborted) throw new AbortError();
      let sessionId: number | undefined;
      if (runOptions.session !== undefined) {
        const s = runOptions.session as Partial<SessionRecord>;
        if (s.kind !== 'zamda/managed-session' || !sessions.has(s as SessionRecord)) {
          throw new PlanError('options.session is not an open session of this backend; open one with backend.session()');
        }
        if (s.closed) throw new PlanError('options.session is closed; a session is single-use, open a new one');
        sessionId = s.id;
      }
      const runId = nextRun++;
      return call(async () => {
        usable(table);
        if (runOptions.signal?.aborted) throw new AbortError();
        return link.run(
          {
            runId,
            plan,
            tableId: table.id,
            params: runOptions.params,
            ...(runOptions.chunkRows === undefined ? {} : { chunkRows: runOptions.chunkRows }),
            ...(runOptions.sliceMs === undefined ? {} : { sliceMs: runOptions.sliceMs }),
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          { ...(runOptions.onProgress === undefined ? {} : { onProgress: runOptions.onProgress }), ...(runOptions.onTiming === undefined ? {} : { onTiming: runOptions.onTiming }), ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }) },
        );
      });
    },
    stats: () => call(() => link.stats()),
    async setMemoryLimit(bytes) {
      // Purpose: change the byte limit (0 removes it); a replacement module gets the new limit too
      checkLimit('The memory limit', bytes);
      limit = bytes;
      await call(() => link.setMemoryLimit(bytes));
    },
    memoryLive: () => call(() => link.memoryLive()),
    settled: () => healthy,
    terminate() {
      // Purpose: stop the engine; tables and sessions are gone
      link.terminate();
    },
  };
  return backend;
}
