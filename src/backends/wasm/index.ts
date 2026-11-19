// The WASM backend (T-408): tables live in the engine's memory and plans run in
// the engine, in time slices on the calling thread. Strings stay on this side
// (D-060, D-063, D-066): the engine sees canonical string ids and lookup tables.
// A plan the engine cannot run (an operation or function it does not have yet)
// runs on the JS executor over the same snapshot, and gives the same result
// (D-067).

import type { Backend, BackendOptions, ResultData, RunSession, Table } from '../../backend';
import { AbortError, ExecutionError, MemoryError, PlanError } from '../../errors';
import type { IrPlan } from '../../ir';
import { encodeParams, encodePlan, TYPE_NAMES } from '../../ir-binary';
import type { Fields, Schema } from '../../schema';
import type { Column } from '../../column';
import type { IrExpr, LiteralValue } from '../../ir';
import { nodeExprs, walkExpr } from '../../ir';
import { makeColumn } from '../../column';
import { isString } from '../../types';
import { DEFAULT_CHUNK_ROWS, DEFAULT_SLICE_MS, executeJs, neededColumns, pause } from '../js/exec';
import type { TableInput, TableOptions } from '../js';
import { buildCanon } from './canon';
import type { Canon } from './canon';
import { byteWidth, segmentsOf, stringColumn, typedValues } from './convert';
import { buildLookupTable, deriveLookups, foldConstants } from './derive';
import type { LookupSpec, LookupTable } from './derive';
import type { EngineRunHost } from './host';
import { EngineTable } from './store';

// Engine run error codes (engine/src/eval_abi.rs).
const OVERFLOW = 301;
const DIVIDE_BY_ZERO = 302;
const UNSUPPORTED = 303;
// Names of the operations an arithmetic error can name, in the engine's order.
const WHATS = ['add', 'sub', 'mul', 'div', 'intDiv', 'mod', 'neg', 'abs', 'cast', 'sum'];

export interface WasmStats {
  // Runs the engine executed.
  engine: number;
  // Runs that used the JS executor because the engine lacked something.
  fallback: number;
  // Wall time of engine runs by phase, in ms, summed over runs: preparing the plan and parameters, the string
  // numbering and lookup tables, starting the run, the steps, and reading the result out.
  phasesMs: { prepare: number; tables: number; start: number; steps: number; read: number };
  // Boolean subexpressions the engine answered from a session's cache, and lookups that missed (T-416).
  cache: { hits: number; misses: number };
}

export interface WasmBackend extends Backend {
  readonly stats: WasmStats;
  // Open a session: runs started with it as their `session` option share the engine's cache of boolean subexpressions (T-416). Closing drops the cache and folds the hit and miss counts into `stats.cache`.
  session(): WasmSession;
}

export interface WasmSession extends RunSession {
  readonly kind: 'zamda/wasm-session';
  // Idempotent: closing twice does nothing.
  close(): void;
}

interface SessionHandle extends WasmSession {
  readonly handle: number;
  closed: boolean;
}

// Canonical string ids for some columns of a set of segments, and the lookup tables built over them
// for particular expressions and parameter values. Segments never change once added, so an entry stays
// right until the table adds or drops a segment, which changes the key.
interface StringCache {
  readonly canon: Canon;
  readonly tables: Map<string, LookupTable>;
}

const MAX_CACHES = 8;
const MAX_TABLES = 64;

const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? `${value}n` : value);

function cacheFor(table: WasmTable, snapshot: ReturnType<EngineTable['snapshot']>, columns: readonly number[]): StringCache {
  // Purpose: the string ids for these columns of this snapshot, built once while the table's segments stay as they are
  const key = `${columns.join(',')}|${snapshot.segments.map(s => s.id).join(',')}`;
  let entry = table.caches.get(key);
  if (entry === undefined) {
    if (table.caches.size >= MAX_CACHES) table.caches.clear();
    entry = { canon: buildCanon(snapshot, columns), tables: new Map() };
    table.caches.set(key, entry);
  }
  return entry;
}

function tableFor(cache: StringCache, spec: LookupSpec, params: BackendOptions['params']): LookupTable {
  // Purpose: the lookup table for an expression under these parameter values, built once per distinct (expression, values)
  const used: [string, LiteralValue | readonly LiteralValue[] | undefined][] = [];
  walkExpr(spec.expr, function (e: IrExpr) {
    if (e.kind === 'param') used.push([e.name, params.get(e.name)]);
    if (e.kind === 'in' && e.param !== null) used.push([e.param, params.get(e.param)]);
  });
  const key = JSON.stringify([spec.field, spec.expr, used], bigintSafe);
  let built = cache.tables.get(key);
  if (built === undefined) {
    if (cache.tables.size >= MAX_TABLES) cache.tables.clear();
    built = buildLookupTable(spec, cache.canon.strings, params);
    cache.tables.set(key, built);
  }
  return built;
}

export class WasmTable<F extends Fields = Fields> implements Table<F> {
  readonly schema: Schema<F>;
  readonly backend: WasmBackend;
  /** @internal */
  readonly engine: EngineTable<F>;
  // What the last runs needed that depends only on the table's strings, kept while the table's segments are unchanged.
  /** @internal */
  readonly caches = new Map<string, StringCache>();

  constructor(backend: WasmBackend, host: EngineRunHost, schema: Schema<F>, data: TableInput<F>, options: TableOptions) {
    // Purpose: create the engine table and load its first rows
    this.schema = schema;
    this.backend = backend;
    this.engine = new EngineTable(host, schema, data, options);
  }

  get rowCount(): number {
    // Purpose: rows in the table now
    return this.engine.rowCount;
  }

  get rowsDropped(): number {
    // Purpose: rows removed so far by the retain window
    return this.engine.rowsDropped;
  }

  append(data: TableInput<F>): void {
    // Purpose: C-LIVE: add rows; runs already started do not see them
    this.engine.append(data);
  }

  dispose(): void {
    // Purpose: free the table's memory in the engine
    this.caches.clear();
    this.engine.dispose();
  }
}

export function createWasmBackend(host: EngineRunHost): { backend: WasmBackend; table: <F extends Fields>(schema: Schema<F>, data: TableInput<F>, options?: TableOptions) => WasmTable<F> } {
  // Purpose: a backend over one engine instance, and the function that creates its tables
  const stats: WasmStats = { engine: 0, fallback: 0, phasesMs: { prepare: 0, tables: 0, start: 0, steps: 0, read: 0 }, cache: { hits: 0, misses: 0 } };
  // The sessions this backend has handed out and not closed (foreign sessions are rejected when a plan runs with one).
  const liveSessions = new Set<SessionHandle>();
  const session: WasmBackend['session'] = () => {
    // Purpose: open a session over this engine instance
    const handle = host.sessionBegin();
    const s: SessionHandle = {
      kind: 'zamda/wasm-session',
      handle,
      closed: false,
      close(): void {
        // Purpose: drop the session's cache and fold its counts into the backend's stats
        if (s.closed) return;
        s.closed = true;
        liveSessions.delete(s);
        stats.cache.hits += host.sessionHits(handle);
        stats.cache.misses += host.sessionMisses(handle);
        host.sessionEnd(handle);
      },
    };
    liveSessions.add(s);
    return s;
  };
  const sessionHandleOf = (option: RunSession | undefined): number => {
    // Purpose: the engine handle for a session option; 0 when there is none; misuse is a PlanError, never a silent pass-through
    if (option === undefined) return 0;
    const s = option as Partial<SessionHandle> | undefined;
    if (s === undefined || s.kind !== 'zamda/wasm-session') {
      throw new PlanError('options.session is not an open session of this WASM backend; open one with backend.session()');
    }
    if (s.closed) throw new PlanError('options.session is closed; a session is single-use, open a new one');
    if (!liveSessions.has(s as SessionHandle)) {
      throw new PlanError('options.session is not an open session of this WASM backend; open one with backend.session()');
    }
    return s.handle!;
  };
  const backend: WasmBackend = {
    name: 'wasm',
    stats,
    session,
    async execute(plan: IrPlan, table: Table, options: BackendOptions): Promise<ResultData> {
      // Purpose: run a plan on a table owned by this backend, as the table stood when the run started
      if (!(table instanceof WasmTable) || table.backend !== backend) {
        throw new PlanError('The WASM backend can only run plans on tables it created');
      }
      const sessionHandle = sessionHandleOf(options.session);
      if (options.signal?.aborted) throw new AbortError();
      const snapshot = table.engine.snapshot();
      try {
        const done = await runInEngine(host, plan, table, snapshot, options, stats, sessionHandle);
        if (done !== null) {
          stats.engine++;
          return done;
        }
        stats.fallback++;
        return await executeJs(plan, segmentsOf(host, snapshot, table.schema), options);
      } finally {
        snapshot.release();
      }
    },
  };
  function table<F extends Fields>(schema: Schema<F>, data: TableInput<F>, options: TableOptions = {}): WasmTable<F> {
    // Purpose: create a table in this engine from rows or columns
    return new WasmTable(backend, host, schema, data, options);
  }
  return { backend, table };
}

function hasMixedStringTypes(plan: IrPlan): boolean {
  // Purpose: detect expressions that combine utf8 and dictionary operands; the engine's validator rejects them, so the JS reference runs them (T-211)
  for (const node of plan.nodes) {
    for (const expr of nodeExprs(node)) {
      let mixed = false;
      walkExpr(expr, function (e: IrExpr): void {
        if (e.kind === 'call') {
          const names = new Set<string>();
          for (const arg of e.args) if (isString(arg.type)) names.add(arg.type.name);
          if (names.size > 1) mixed = true;
        } else if (e.kind === 'in' && isString(e.arg.type) && e.param !== null) {
          const param = plan.params.find(function (p) {
            return p.name === e.param;
          });
          if (param && isString(param.type) && param.type.name !== e.arg.type.name) mixed = true;
        }
      });
      if (mixed) return true;
    }
  }
  return false;
}

async function runInEngine(
  host: EngineRunHost,
  plan: IrPlan,
  table: WasmTable,
  snapshot: ReturnType<EngineTable['snapshot']>,
  options: BackendOptions,
  stats: WasmStats,
  sessionHandle: number,
): Promise<ResultData | null> {
  // Purpose: run the plan in the engine; null when the engine cannot (the caller then runs it on the JS executor)
  if (hasMixedStringTypes(plan)) return null;
  const clock = performance.now();
  let last = clock;
  const phase = (name: keyof WasmStats['phasesMs']): void => {
    // Purpose: add the time since the last phase ended to this phase's total
    const now = performance.now();
    stats.phasesMs[name] += now - last;
    last = now;
  };
  const derived = deriveLookups(foldConstants(plan, options.params));
  const planHandle = host.planLoad(encodePlan(derived.plan));
  if (planHandle === 0) throw new ExecutionError(`The engine refused a valid plan (error ${host.evalError()}); this is a bug in zamda`);
  let paramsHandle = 0;
  let run = 0;
  try {
    paramsHandle = host.paramsLoad(planHandle, encodeParams(plan.params, options.params));
    if (paramsHandle === 0) throw new ExecutionError(`The engine refused the parameters (error ${host.evalError()}); this is a bug in zamda`);
    phase('prepare');
    // Only the string columns the plan reads need ids (the original plan: walkExpr does not know lookups).
    const needed = neededColumns(plan)[0]!;
    const stringColumns = table.schema.list
      .map((f, i) => (f.type.name === 'utf8' || f.type.name === 'dictionary' ? i : -1))
      .filter(i => i >= 0 && (needed === null || needed.has(i)));
    const cache = cacheFor(table, snapshot, stringColumns);
    const canon = cache.canon;
    for (const spec of derived.lookups) {
      const lookup = tableFor(cache, spec, options.params);
      const status = host.paramsTable(paramsHandle, spec.table, lookup.values, lookup.valid, lookup.entries);
      if (status !== 0) throw new ExecutionError(`The engine refused a lookup table (error ${host.evalError()}); this is a bug in zamda`);
    }
    phase('tables');
    run = host.runNew(planHandle, paramsHandle, snapshot.handle, options.chunkRows ?? DEFAULT_CHUNK_ROWS);
    if (run === 0) {
      const code = host.evalError();
      if (code === UNSUPPORTED) return null;
      throw new ExecutionError(`The engine could not start the plan (error ${code}); this is a bug in zamda`);
    }
    if (sessionHandle !== 0 && host.sessionArm(run, sessionHandle) !== 0) {
      throw new ExecutionError(`The engine refused to arm the run to the session (error ${host.evalError()}); this is a bug in zamda`);
    }
    for (const [segment, byColumn] of canon.maps) {
      for (const [column, map] of byColumn) {
        if (host.runCanon(run, column, segment, map) !== 0) throw new ExecutionError(`The engine refused a string map (error ${host.evalError()}); this is a bug in zamda`);
      }
    }
    phase('start');
    const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    let sliceStart = performance.now();
    for (;;) {
      const status = host.runStep(run);
      if (status === 1) break;
      if (status > 1) throw engineError(host);
      if (performance.now() - sliceStart >= sliceMs) {
        options.onProgress?.({ rowsScanned: host.runScanned(run), rowsTotal: snapshot.rows });
        await pause();
        if (options.signal?.aborted) throw new AbortError();
        sliceStart = performance.now();
      }
    }
    options.onProgress?.({ rowsScanned: host.runScanned(run), rowsTotal: snapshot.rows });
    phase('steps');
    const count = host.runFinish(run);
    if (count !== plan.output.length) throw new ExecutionError('The engine returned the wrong number of columns; this is a bug in zamda');
    const columns: Column[] = [];
    let rowCount = 0;
    for (let c = 0; c < count; c++) {
      const result = host.runColumn(c);
      const type = plan.output[c]!.type;
      const rows = host.resultRows(result);
      if (TYPE_NAMES[host.resultType(result)] !== type.name) throw new ExecutionError('The engine returned a column of the wrong type; this is a bug in zamda');
      const bytes = host.view(host.resultValues(result), rows * byteWidth(type.name));
      const v = host.resultValid(result);
      const valid = v === 0 ? null : host.view(v, rows).slice();
      const values = typedValues(type, bytes);
      columns.push(
        type.name === 'utf8' || type.name === 'dictionary'
          ? stringColumn(type, values as Int32Array, valid, canon.strings)
          : makeColumn(type, values, valid),
      );
      host.resultFree(result);
      rowCount = rows;
    }
    phase('read');
    return { schema: plan.output, columns, rowCount };
  } finally {
    if (run !== 0) host.runFree(run);
    if (paramsHandle !== 0) host.paramsFree(paramsHandle);
    host.planFree(planHandle);
  }
}

function engineError(host: EngineRunHost): Error {
  // Purpose: the error a failed step stands for, worded as the JS backend words it
  const code = host.evalError();
  const what = WHATS[host.evalErrorWhat()] ?? '';
  const type = TYPE_NAMES[host.evalErrorType()] ?? '';
  if (code === OVERFLOW) return new ExecutionError(`Integer overflow in ${what} (${type})`);
  if (code === DIVIDE_BY_ZERO) return new ExecutionError(`Integer divide by zero in ${what}`);
  if (code === 210) return new MemoryError('The engine ran out of memory while running a plan');
  return new ExecutionError(`The engine failed (error ${code}); this is a bug in zamda`);
}
