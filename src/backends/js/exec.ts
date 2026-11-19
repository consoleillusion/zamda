// The JS reference executor: chunked, resumable execution (docs/TASKS.md, T-201).
//
// A plan is a chain of nodes from the scan to the root. It is cut into PHASES
// at the blocking operators (aggregate, sort, and the final result):
//
//   table --chunks--> [filter | project | limit]* --> aggregate
//         --chunks--> [filter | project | limit]* --> sort
//         --chunks--> [filter | project | limit]* --> result
//
// In each phase the source is read one chunk at a time. A chunk runs through the
// phase's streaming nodes and is folded into the sink. When the source is
// exhausted the sink finishes, in bounded steps, and its output is the next
// phase's source.
//
// The whole run is a generator that yields after every chunk and every sort
// step. The driver resumes it until a time slice is used up, then returns to
// the event loop so the page stays responsive and an abort can be seen. Tables
// are never modified, so an aborted run leaves nothing to clean up.
//
// Two things keep copying down:
//   - filter and sort produce a SELECTION (a list of row indexes) over their
//     input instead of new columns. Rows are copied only when a later node
//     needs dense columns, and aggregate reads straight through the selection.
//   - a column no later node reads is never copied at all.

import type { BackendOptions, ResultData } from '../../backend';
import type { AnyCells, Column } from '../../column';
import { allocate, concat, emptyColumn, makeColumn, nums, slice, take } from '../../column';
import { AbortError, PlanError } from '../../errors';
import type { IrExpr, IrNode, IrPlan, LiteralValue } from '../../ir';
import { nodeExprs, walkExpr } from '../../ir';
import type { Field } from '../../schema';
import type { DataType } from '../../types';
import { Aggregator } from './aggregate';
import { KERNELS } from './kernels';
import { castColumn } from './kernels-arith';
import { inList } from './kernels-misc';
import type { SortColumn } from './sort';
import { sortSteps } from './sort';
import { isConstant, markConstant } from './kernel-util';

export const DEFAULT_CHUNK_ROWS = 65536;
export const DEFAULT_SLICE_MS = 8;

export interface Batch {
  // A column no later node reads is left undefined instead of being copied.
  readonly columns: readonly (Column | undefined)[];
  readonly rowCount: number;
}

// Column indexes of a node's output that later nodes read; null means all of them.
type Needed = Set<number> | null;

// Rows flowing between nodes: `batch` read directly, or through `selection` when set.
interface Stage {
  readonly batch: Batch;
  readonly selection: Uint32Array | null;
  readonly rowCount: number;
  readonly needed: Needed;
  // The selection applied to the needed columns, built on first use.
  materialized?: Batch;
}

type AggregateNode = Extract<IrNode, { op: 'aggregate' }>;
type SortNode = Extract<IrNode, { op: 'sort' }>;

// ---------------------------------------------------------------------------
// Plan analysis
// ---------------------------------------------------------------------------

function chainOf(plan: IrPlan): number[] {
  // Purpose: node indexes from the scan to the root, following each node's input
  const chain: number[] = [];
  let at = plan.root;
  for (;;) {
    chain.push(at);
    const node = plan.nodes[at]!;
    if (node.op === 'scan') break;
    at = node.input;
  }
  return chain.reverse();
}

function neededColumns(plan: IrPlan): Needed[] {
  // Purpose: work out, for each node, which of its output columns are read downstream
  const needed: (Needed | undefined)[] = new Array(plan.nodes.length);
  needed[plan.root] = null;
  for (let i = plan.nodes.length - 1; i > 0; i--) {
    const node = plan.nodes[i]!;
    if (node.op === 'scan') continue;
    const own = needed[i];
    // A node nothing reads contributes no requirements.
    if (own === undefined) continue;
    let wants: Needed = new Set<number>();
    for (const expr of nodeExprs(node)) {
      walkExpr(expr, function (e) {
        if (e.kind === 'field') (wants as Set<number>).add(e.index);
      });
    }
    // filter, sort and limit pass their input columns through unchanged.
    if (node.op === 'filter' || node.op === 'sort' || node.op === 'limit') {
      if (own === null) wants = null;
      else for (const index of own) wants.add(index);
    }
    const current = needed[node.input];
    if (wants === null || current === null) needed[node.input] = null;
    else if (current === undefined) needed[node.input] = wants;
    else for (const index of wants) current.add(index);
  }
  return needed.map(function (n) {
    return n === undefined ? new Set<number>() : n;
  });
}

// ---------------------------------------------------------------------------
// Stages and expressions
// ---------------------------------------------------------------------------

function wanted(needed: Needed, column: number): boolean {
  // Purpose: true if a later node reads this column
  return needed === null || needed.has(column);
}

function dense(stage: Stage): Batch {
  // Purpose: a stage's rows as plain columns, applying its selection to the needed columns once
  const selection = stage.selection;
  if (!selection) return stage.batch;
  if (!stage.materialized) {
    stage.materialized = {
      columns: stage.batch.columns.map(function (column, c) {
        return column && wanted(stage.needed, c) ? take(column, selection) : undefined;
      }),
      rowCount: stage.rowCount,
    };
  }
  return stage.materialized;
}

function chunkOf(source: Stage, start: number, end: number): Stage {
  // Purpose: rows [start, end) of a stage, without copying numeric data
  if (source.selection) {
    return {
      batch: source.batch,
      selection: source.selection.subarray(start, end),
      rowCount: end - start,
      needed: source.needed,
    };
  }
  if (start === 0 && end === source.rowCount) return source;
  const batch = {
    columns: source.batch.columns.map(function (column, c) {
      return column && wanted(source.needed, c) ? slice(column, start, end) : undefined;
    }),
    rowCount: end - start,
  };
  return { batch, selection: null, rowCount: end - start, needed: source.needed };
}

function broadcast(value: LiteralValue, type: DataType, n: number): Column {
  // Purpose: a column holding the same literal in every row
  if (type.name === 'dictionary') {
    // Every code is 0, pointing at the single dictionary entry.
    return markConstant(makeColumn(type, new Int32Array(n), null, [value as string]));
  }
  const values = allocate(type, n);
  const stored = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  (values as unknown as AnyCells & { fill(v: unknown): void }).fill(stored);
  return markConstant(makeColumn(type, values, null));
}

// Functions that never raise an error, whatever their input. Only expressions
// built from these may be evaluated over dictionary entries that no row in the
// batch uses (see dictionaryShortcut).
export const NEVER_FAILS = new Set([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_nan', 'coalesce', 'if_else', 'and', 'or', 'not',
  'lower', 'upper', 'length', 'starts_with', 'ends_with', 'contains',
]);

// Results of dictionaryShortcut, per dictionary, keyed by expression and parameter values.
const perEntryResults = new WeakMap<readonly string[], Map<string, Column>>();

function jsonKey(value: unknown): string {
  // Purpose: a cache key for an expression or parameter value, bigints included
  return JSON.stringify(value, function (_key, v: unknown) {
    return typeof v === 'bigint' ? `${v}n` : v;
  });
}

function dictionaryShortcut(expr: IrExpr, batch: Batch, options: BackendOptions): Column | null {
  // Purpose: evaluate an expression over a dictionary column once per distinct value, then look rows up by code
  // Applies when the expression reads exactly one column, that column is a
  // dictionary, and nothing in it can fail. Scalar functions are row-wise, so
  // the answer for a row depends only on its value: computing it per dictionary
  // entry (plus one null entry) and gathering by code gives the same column.
  let field = -1;
  let ok = true;
  const params: unknown[] = [];
  walkExpr(expr, function (e) {
    if (!ok) return;
    if (e.kind === 'field') {
      if (field !== -1 && field !== e.index) ok = false;
      field = e.index;
    } else if (e.kind === 'call') {
      if (!NEVER_FAILS.has(e.fn)) ok = false;
    } else if (e.kind === 'cast') {
      ok = false;
    } else if (e.kind === 'param') {
      params.push(options.params.get(e.name));
    } else if (e.kind === 'in' && e.param !== null) {
      params.push(options.params.get(e.param));
    }
  });
  if (!ok || field === -1) return null;
  const column = batch.columns[field];
  const dictionary = column?.dictionary;
  if (!column || !dictionary) return null;
  const n = batch.rowCount;
  const d = dictionary.length;
  let cache = perEntryResults.get(dictionary);
  const key = `${jsonKey(expr)}|${jsonKey(params)}`;
  let perValue = cache?.get(key);
  if (!perValue) {
    // Not worth it for a large dictionary seen once; a cached result always is.
    if (d > 2 * n) return null;
    const codes = new Int32Array(d + 1);
    for (let i = 0; i < d; i++) codes[i] = i;
    const valid = new Uint8Array(d + 1).fill(1);
    valid[d] = 0;
    const columns: (Column | undefined)[] = [];
    columns[field] = makeColumn(column.type, codes, valid, dictionary);
    perValue = evaluateRows(expr, { columns, rowCount: d + 1 }, options);
    if (!cache) {
      cache = new Map();
      perEntryResults.set(dictionary, cache);
    }
    if (cache.size >= 64) cache.clear();
    cache.set(key, perValue);
  }
  const rowCodes = nums(column);
  const rowValid = column.valid;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = rowValid && !rowValid[i] ? d : rowCodes[i]!;
  return take(perValue, indices);
}

export function evaluateRows(expr: IrExpr, batch: Batch, options: BackendOptions): Column {
  // Purpose: evaluate a call row by row, without the dictionary shortcut (which would recurse)
  if (expr.kind !== 'call') return evaluate(expr, batch, options);
  const kernel = KERNELS.get(expr.fn);
  if (!kernel) throw new PlanError(`JS backend: function "${expr.fn}" is not implemented yet`);
  const args = expr.args.map(function (arg) {
    return evaluate(arg, batch, options);
  });
  return kernel(args, expr.type, batch.rowCount);
}

function constantBool(expr: IrExpr, options: BackendOptions): boolean | null | undefined {
  // Purpose: the value of a boolean literal or parameter, or undefined when the expression depends on rows
  if (expr.kind === 'literal') return expr.value === null ? null : Boolean(expr.value);
  if (expr.kind === 'param') {
    const value = options.params.get(expr.name);
    return typeof value === 'boolean' ? value : value === null ? null : undefined;
  }
  return undefined;
}

function logicalShortcut(
  fn: 'and' | 'or',
  left: IrExpr,
  right: IrExpr,
  type: DataType,
  batch: Batch,
  options: BackendOptions,
): Column | null {
  // Purpose: C-NULL-LOGIC: when one side of and/or is a known constant, skip the other side where Kleene logic allows
  // "x or true" is true and "x and false" is false for every x, null included;
  // "x or false" and "x and true" are just x. A null constant decides nothing.
  const decisive = fn === 'or';
  for (const [constant, other] of [
    [left, right],
    [right, left],
  ] as const) {
    const value = constantBool(constant, options);
    if (value === undefined || value === null) continue;
    if (value === decisive) return broadcast(decisive, type, batch.rowCount);
    return evaluate(other, batch, options);
  }
  return null;
}

export function evaluate(expr: IrExpr, batch: Batch, options: BackendOptions): Column {
  // Purpose: evaluate one expression over a batch, returning a column
  switch (expr.kind) {
    case 'field': {
      const column = batch.columns[expr.index];
      if (!column) throw new PlanError(`JS backend: column ${expr.index} was pruned but is still read`);
      return column;
    }
    case 'literal':
      return broadcast(expr.value, expr.type, batch.rowCount);
    case 'param': {
      const value = options.params.get(expr.name);
      if (value === undefined || Array.isArray(value)) {
        throw new PlanError(`Missing value for parameter "${expr.name}"`);
      }
      return broadcast(value as LiteralValue, expr.type, batch.rowCount);
    }
    case 'call': {
      if ((expr.fn === 'and' || expr.fn === 'or') && expr.args.length === 2) {
        const shortcut = logicalShortcut(expr.fn, expr.args[0]!, expr.args[1]!, expr.type, batch, options);
        if (shortcut) return shortcut;
      }
      const perEntry = dictionaryShortcut(expr, batch, options);
      if (perEntry) return perEntry;
      const kernel = KERNELS.get(expr.fn);
      if (!kernel) throw new PlanError(`JS backend: function "${expr.fn}" is not implemented yet`);
      const args = expr.args.map(function (arg) {
        return evaluate(arg, batch, options);
      });
      return kernel(args, expr.type, batch.rowCount);
    }
    case 'cast':
      return castColumn(evaluate(expr.arg, batch, options), expr.type, batch.rowCount);
    case 'in': {
      const values = expr.param !== null ? options.params.get(expr.param) : expr.values;
      if (!Array.isArray(values)) throw new PlanError(`Missing list for parameter "${expr.param}"`);
      return inList(evaluate(expr.arg, batch, options), values, batch.rowCount);
    }
  }
}

function runFilter(input: Batch, predicate: Column, needed: Needed): Stage {
  // Purpose: C-FILTER: select rows where the predicate is true; null and false are dropped
  if (input.rowCount > 0 && isConstant(predicate) && !predicate.valid) {
    // The same answer for every row: keep all of them or none, without reading the predicate.
    const all = nums(predicate)[0] === 1;
    return all
      ? { batch: input, selection: null, rowCount: input.rowCount, needed }
      : { batch: input, selection: new Uint32Array(0), rowCount: 0, needed };
  }
  const keep = nums(predicate);
  const valid = predicate.valid;
  const selected = new Uint32Array(input.rowCount);
  let count = 0;
  if (!valid) {
    for (let i = 0; i < input.rowCount; i++) if (keep[i]) selected[count++] = i;
  } else {
    for (let i = 0; i < input.rowCount; i++) if (keep[i] && valid[i]) selected[count++] = i;
  }
  // Every row kept (a filter that is switched off, say): no selection vector to follow.
  if (count === input.rowCount) return { batch: input, selection: null, rowCount: count, needed };
  return { batch: input, selection: selected.subarray(0, count), rowCount: count, needed };
}

function firstRows(stage: Stage, count: number, needed: Needed): Stage {
  // Purpose: the first `count` rows of a stage, for limit
  if (count === stage.rowCount) return stage;
  if (stage.selection) {
    return { batch: stage.batch, selection: stage.selection.subarray(0, count), rowCount: count, needed };
  }
  return chunkOf({ ...stage, needed }, 0, count);
}

// ---------------------------------------------------------------------------
// Sinks: the blocking end of a phase
// ---------------------------------------------------------------------------

interface Sink {
  // Fold one chunk in.
  consume(stage: Stage): void;
  // Produce the sink's output, yielding between bounded steps.
  finish(): Generator<void, Stage>;
}

class Collector {
  // Gathers dense chunks and joins them into one batch.
  private readonly pieces: Column[][];
  private rowCount = 0;

  constructor(
    private readonly schema: readonly Field[],
    private readonly needed: Needed,
  ) {
    // Purpose: prepare one list of pieces per column
    this.pieces = schema.map(function () {
      return [];
    });
  }

  add(batch: Batch): void {
    // Purpose: keep one chunk's needed columns
    if (batch.rowCount === 0) return;
    for (let c = 0; c < this.pieces.length; c++) {
      const column = batch.columns[c];
      if (column && wanted(this.needed, c)) this.pieces[c]!.push(column);
    }
    this.rowCount += batch.rowCount;
  }

  finish(): Batch {
    // Purpose: one column per needed schema field, empty if no chunk arrived
    const columns = this.schema.map((field, c) => {
      if (!wanted(this.needed, c)) return undefined;
      const pieces = this.pieces[c]!;
      return pieces.length === 0 ? emptyColumn(field.type) : concat(field.type, pieces);
    });
    return { columns, rowCount: this.rowCount };
  }
}

class CollectSink implements Sink {
  private readonly collector: Collector;

  constructor(schema: readonly Field[]) {
    // Purpose: the final result: every column of the root node
    this.collector = new Collector(schema, null);
  }

  consume(stage: Stage): void {
    // Purpose: keep this chunk's rows
    this.collector.add(dense(stage));
  }

  *finish(): Generator<void, Stage> {
    // Purpose: the joined result
    const batch = this.collector.finish();
    return { batch, selection: null, rowCount: batch.rowCount, needed: null };
  }
}

class AggregateSink implements Sink {
  private readonly aggregator: Aggregator;
  // Plain column references can be read through a selection without copying.
  private readonly direct: boolean;

  constructor(
    private readonly node: AggregateNode,
    private readonly options: BackendOptions,
  ) {
    // Purpose: set up incremental aggregation for one aggregate node
    const keyTypes = node.keys.map(function (key) {
      return key.type;
    });
    this.aggregator = new Aggregator(keyTypes, node.aggs);
    const exprs = [...node.keys];
    for (const agg of node.aggs) if (agg.arg) exprs.push(agg.arg);
    this.direct = exprs.every(function (expr) {
      return expr.kind === 'field';
    });
  }

  consume(stage: Stage): void {
    // Purpose: fold one chunk into the aggregation, reading through its selection when possible
    const through = stage.selection !== null && this.direct;
    // Computed keys or arguments need dense input first.
    const batch = through ? stage.batch : dense(stage);
    const keys = this.node.keys.map((expr) => evaluate(expr, batch, this.options));
    const args = this.node.aggs.map((agg) => (agg.arg ? evaluate(agg.arg, batch, this.options) : null));
    this.aggregator.consume(keys, args, { count: stage.rowCount, sel: through ? stage.selection : null });
  }

  *finish(): Generator<void, Stage> {
    // Purpose: the groups and their aggregates
    const batch = this.aggregator.finish();
    return { batch, selection: null, rowCount: batch.rowCount, needed: null };
  }
}

class SortSink implements Sink {
  private readonly rows: Collector;
  private readonly keyPieces: Column[][];

  constructor(
    private readonly node: SortNode,
    private readonly needed: Needed,
    private readonly limit: number | null,
    private readonly options: BackendOptions,
  ) {
    // Purpose: gather the rows and the evaluated sort keys for one sort node
    this.rows = new Collector(node.schema, needed);
    this.keyPieces = node.keys.map(function () {
      return [];
    });
  }

  consume(stage: Stage): void {
    // Purpose: keep this chunk's rows and evaluate its sort keys
    const batch = dense(stage);
    if (batch.rowCount === 0) return;
    this.node.keys.forEach((key, k) => {
      this.keyPieces[k]!.push(evaluate(key.expr, batch, this.options));
    });
    this.rows.add(batch);
  }

  *finish(): Generator<void, Stage> {
    // Purpose: sort row indexes in steps; the output is a selection over the gathered rows
    const batch = this.rows.finish();
    const keys: SortColumn[] = this.node.keys.map((key, k) => ({
      column: concat(key.expr.type, this.keyPieces[k]!),
      descending: key.descending,
      nullsFirst: key.nullsFirst,
    }));
    const order = yield* sortSteps(keys, batch.rowCount, this.limit);
    return { batch, selection: order, rowCount: order.length, needed: this.needed };
  }
}

function limitAfter(plan: IrPlan, chain: readonly number[], position: number): number | null {
  // Purpose: if the node after this sort is a limit, return its count so the sort can do top-k
  const next = chain[position + 1];
  if (next === undefined) return null;
  const node = plan.nodes[next]!;
  return node.op === 'limit' ? node.count : null;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface Progress {
  // Rows of the table read so far, and the table's row count.
  rowsScanned: number;
  rowsTotal: number;
}

function* runPhase(
  plan: IrPlan,
  sources: readonly Stage[],
  streaming: readonly number[],
  sink: Sink,
  needed: readonly Needed[],
  chunkRows: number,
  options: BackendOptions,
  progress: Progress | null,
): Generator<void, void> {
  // Purpose: read each source in turn, chunk by chunk, through the streaming nodes into the sink
  const remaining = new Map<number, number>();
  for (const index of streaming) {
    const node = plan.nodes[index]!;
    if (node.op === 'limit') remaining.set(index, node.count);
  }
  let done = false;
  let scannedBefore = 0;
  for (const source of sources) {
    for (let start = 0; start < source.rowCount && !done; start += chunkRows) {
      const end = Math.min(start + chunkRows, source.rowCount);
      let stage = chunkOf(source, start, end);
      for (const index of streaming) {
        const node = plan.nodes[index]!;
        if (node.op === 'filter') {
          const input = dense(stage);
          stage = runFilter(input, evaluate(node.predicate, input, options), needed[index]!);
        } else if (node.op === 'project') {
          const input = dense(stage);
          const batch = {
            columns: node.exprs.map(function (expr) {
              return evaluate(expr, input, options);
            }),
            rowCount: input.rowCount,
          };
          stage = { batch, selection: null, rowCount: batch.rowCount, needed: needed[index]! };
        } else if (node.op === 'limit') {
          const left = remaining.get(index)!;
          const count = Math.min(left, stage.rowCount);
          remaining.set(index, left - count);
          stage = firstRows(stage, count, needed[index]!);
          // Once a limit is satisfied, nothing later in the source can matter.
          if (left - count === 0) done = true;
        }
        if (stage.rowCount === 0) break;
      }
      if (stage.rowCount > 0) sink.consume(stage);
      if (progress) progress.rowsScanned = scannedBefore + end;
      yield;
    }
    if (done) break;
    scannedBefore += source.rowCount;
  }
}

// A table is one or more segments: the rows it was created with, then one per append.
export interface Segment {
  readonly columns: readonly Column[];
  readonly rowCount: number;
}

export function* runPlan(
  plan: IrPlan,
  segments: readonly Segment[],
  options: BackendOptions,
  progress: Progress,
): Generator<void, ResultData> {
  // Purpose: run a validated plan over a table's segments in resumable steps, returning the root's output
  const chain = chainOf(plan);
  const needed = neededColumns(plan);
  const chunkRows = options.chunkRows ?? DEFAULT_CHUNK_ROWS;
  let sources: Stage[] = segments.map(function (segment) {
    return { batch: segment, selection: null, rowCount: segment.rowCount, needed: needed[0]! };
  });
  let position = 1;
  let first = true;
  for (;;) {
    const streaming: number[] = [];
    while (position < chain.length) {
      const op = plan.nodes[chain[position]!]!.op;
      if (op === 'aggregate' || op === 'sort') break;
      streaming.push(chain[position++]!);
    }
    const last = position === chain.length;
    let sink: Sink;
    if (last) {
      // A bare scan of a single segment is already the result.
      if (streaming.length === 0 && sources.length === 1) break;
      sink = new CollectSink(plan.output);
    } else {
      const index = chain[position]!;
      const node = plan.nodes[index]!;
      if (node.op === 'aggregate') sink = new AggregateSink(node, options);
      else sink = new SortSink(node as SortNode, needed[index]!, limitAfter(plan, chain, position), options);
      position++;
    }
    yield* runPhase(plan, sources, streaming, sink, needed, chunkRows, options, first ? progress : null);
    sources = [yield* sink.finish()];
    first = false;
    if (last) break;
  }
  // If the table was never scanned chunk by chunk, it was still read in full.
  if (first) progress.rowsScanned = progress.rowsTotal;
  const root = dense(sources[0]!);
  const output = root.columns.map(function (column, c) {
    if (!column) throw new PlanError(`JS backend: result column ${c} was pruned`);
    return column;
  });
  return { schema: plan.output, columns: output, rowCount: root.rowCount };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

function pause(): Promise<void> {
  // Purpose: return to the event loop once, so the page can paint and an abort can arrive.
  // setTimeout(0) is avoided where possible: browsers clamp nested timers to 4 ms.
  const g = globalThis as {
    setImmediate?: (fn: () => void) => unknown;
    scheduler?: { yield?: () => Promise<void> };
    MessageChannel?: typeof MessageChannel;
  };
  if (typeof g.setImmediate === 'function') {
    return new Promise(function (resolve) {
      g.setImmediate!(resolve);
    });
  }
  if (g.scheduler && typeof g.scheduler.yield === 'function') return g.scheduler.yield();
  if (typeof g.MessageChannel === 'function') {
    return new Promise(function (resolve) {
      const channel = new g.MessageChannel!();
      channel.port1.onmessage = function () {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

export async function executeJs(
  plan: IrPlan,
  segments: readonly Segment[],
  options: BackendOptions,
): Promise<ResultData> {
  // Purpose: drive a run in time slices, pausing between them and stopping if the signal aborts
  const signal = options.signal;
  if (signal?.aborted) throw new AbortError();
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
  let rowCount = 0;
  for (const segment of segments) rowCount += segment.rowCount;
  const progress: Progress = { rowsScanned: 0, rowsTotal: rowCount };
  const run = runPlan(plan, segments, options, progress);
  let sliceStart = performance.now();
  for (;;) {
    const step = run.next();
    if (step.done) {
      options.onProgress?.({ ...progress });
      return step.value;
    }
    if (performance.now() - sliceStart >= sliceMs) {
      options.onProgress?.({ ...progress });
      await pause();
      if (signal?.aborted) throw new AbortError();
      sliceStart = performance.now();
    }
  }
}
