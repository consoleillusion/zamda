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
import { allocate, bigs, cells, concat, emptyColumn, makeColumn, nums, slice, stringColumn, take, texts } from '../../column';
import { AbortError, PlanError } from '../../errors';
import type { IrExpr, IrNode, IrPlan, IrSortKey, LiteralValue, WindowFnName } from '../../ir';
import { nodeExprs, walkExpr } from '../../ir';
import type { Field } from '../../schema';
import type { DataType } from '../../types';
import { isBigInt, isString, t } from '../../types';
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
export type Needed = Set<number> | null;

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
type JoinNode = Extract<IrNode, { op: 'join' }>;
type WindowNode = Extract<IrNode, { op: 'window' }>;

// ---------------------------------------------------------------------------
// Plan analysis
// ---------------------------------------------------------------------------

function chainOf(plan: IrPlan): number[] {
  // Purpose: node indexes from the scan to the root, following each node's input;
  // a join's right scan is an extra source and is deliberately not followed here
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

export function extraScanIndexes(plan: IrPlan): number[] {
  // Purpose: indexes of the plan's scan nodes after the primary one, in IR order
  const out: number[] = [];
  for (let i = 1; i < plan.nodes.length; i++) {
    if (plan.nodes[i]!.op === 'scan') out.push(i);
  }
  return out;
}

function mergeNeeded(current: Needed | undefined, wants: Needed): Needed {
  // Purpose: combine the column requirements two consumers place on one node
  if (wants === null || current === null) return null;
  if (current === undefined) return wants;
  for (const index of wants) current.add(index);
  return current;
}

export function neededColumns(plan: IrPlan): Needed[] {
  // Purpose: work out, for each node, which of its output columns are read downstream
  const needed: (Needed | undefined)[] = new Array(plan.nodes.length);
  needed[plan.root] = null;
  for (let i = plan.nodes.length - 1; i > 0; i--) {
    const node = plan.nodes[i]!;
    if (node.op === 'scan') continue;
    const own = needed[i];
    // A node nothing reads contributes no requirements.
    if (own === undefined) continue;
    if (node.op === 'join') {
      // C-JOIN: the join reads its key columns on both sides, and passes the
      // remaining columns of each side through to whatever comes next. The
      // right scan is an extra source, not part of the root chain.
      const leftWidth = plan.nodes[node.input]!.schema.length;
      let leftWants: Needed = new Set<number>(node.leftKeys);
      let rightWants: Needed = new Set<number>(node.rightKeys);
      if (own !== null) {
        for (const index of own) {
          if (index < leftWidth) (leftWants as Set<number>).add(index);
          else (rightWants as Set<number>).add(index - leftWidth);
        }
      } else {
        leftWants = null;
        rightWants = null;
      }
      needed[node.input] = mergeNeeded(needed[node.input], leftWants);
      needed[node.right] = mergeNeeded(needed[node.right], rightWants);
      continue;
    }
    const wants = new Set<number>();
    for (const expr of nodeExprs(node)) {
      walkExpr(expr, function (e) {
        if (e.kind === 'field') wants.add(e.index);
      });
    }
    let pass: Needed = wants;
    // A window evaluates its partition and order keys over every input row, so
    // those columns are needed even when no later node reads them. All input
    // columns pass through; only the appended function columns are new.
    if (node.op === 'window') {
      const inputWidth = plan.nodes[node.input]!.schema.length;
      if (own === null) pass = null;
      else {
        for (const index of own) if (index < inputWidth) wants.add(index);
        pass = wants;
      }
    }
    // filter, sort and limit pass their input columns through unchanged, but
    // their own expressions must still be evaluated before that pruning.
    if (node.op === 'filter' || node.op === 'sort' || node.op === 'limit') {
      if (own === null) pass = null;
      else {
        for (const index of own) wants.add(index);
        pass = wants;
      }
    }
    const current = needed[node.input];
    if (pass === null || current === null) needed[node.input] = null;
    else if (current === undefined) needed[node.input] = pass;
    else for (const index of pass) current.add(index);
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

  // eslint-disable-next-line require-yield -- kept a generator so every Sink finishes the same way (the sort sink yields rows)
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

  // eslint-disable-next-line require-yield -- kept a generator so every Sink finishes the same way (the sort sink yields rows)
  *finish(): Generator<void, Stage> {
    // Purpose: the groups and their aggregates
    const batch = this.aggregator.finish();
    return { batch, selection: null, rowCount: batch.rowCount, needed: null };
  }
}

// One chunk of a sort's input, kept by reference. Its columns are not gathered
// before the sort: the row numbers in `order` are positions in the concatenation
// of these pieces, and a piece's own selection resolves one to a source row.
interface SortPiece {
  readonly batch: Batch;
  readonly selection: Uint32Array | null;
  readonly offset: number;
  readonly rowCount: number;
}

interface GatherReader {
  readonly values: AnyCells;
  readonly valid: Uint8Array | null;
  readonly selection: Uint32Array | null;
  readonly offset: number;
}

// Rows gathered between two yields, so a large gather can still be aborted.
const GATHER_BLOCK_ROWS = 65536;

function* gatherColumn(
  type: DataType,
  readers: readonly GatherReader[],
  pieceOf: Uint32Array,
  order: Uint32Array,
): Generator<void, Column> {
  // Purpose: read one output column straight from the sort's source pieces, in sorted order
  const textual = type.name === 'utf8' || type.name === 'dictionary';
  const values = textual ? new Array<string>(order.length) : allocate(type, order.length);
  const dst = values as unknown as AnyCells;
  let anyNull = false;
  for (const reader of readers) {
    if (reader.valid) {
      anyNull = true;
      break;
    }
  }
  const valid = anyNull ? new Uint8Array(order.length) : null;
  for (let i = 0; i < order.length; i++) {
    const row = order[i]!;
    const piece = readers[pieceOf[row]!]!;
    const local = piece.selection ? piece.selection[row - piece.offset]! : row - piece.offset;
    dst[i] = piece.values[local]!;
    if (valid) valid[i] = piece.valid ? piece.valid[local]! : 1;
    if ((i + 1) % GATHER_BLOCK_ROWS === 0) yield;
  }
  // Pieces can carry different dictionaries, so gather dictionary rows as strings and re-encode.
  if (type.name === 'dictionary') return stringColumn(type, values as string[], valid);
  return makeColumn(type, values, valid);
}

function* gatherRows(
  schema: readonly Field[],
  needed: Needed,
  pieces: readonly SortPiece[],
  order: Uint32Array,
): Generator<void, Batch> {
  // Purpose: gather only the sorted rows, once, from the pieces the sort read its keys from
  let total = 0;
  for (const piece of pieces) total += piece.rowCount;
  const pieceOf = new Uint32Array(total);
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p]!;
    pieceOf.fill(p, piece.offset, piece.offset + piece.rowCount);
  }
  const columns: (Column | undefined)[] = [];
  for (let c = 0; c < schema.length; c++) {
    if (!wanted(needed, c)) {
      columns.push(undefined);
      continue;
    }
    const type = schema[c]!.type;
    const textual = type.name === 'utf8' || type.name === 'dictionary';
    const readers = pieces.map(function (piece): GatherReader {
      const column = piece.batch.columns[c]!;
      return {
        values: textual ? (texts(column) as unknown as AnyCells) : cells(column),
        valid: column.valid,
        selection: piece.selection,
        offset: piece.offset,
      };
    });
    columns.push(yield* gatherColumn(type, readers, pieceOf, order));
  }
  return { columns, rowCount: order.length };
}

class SortSink implements Sink {
  private readonly pieces: SortPiece[] = [];
  private rowCount = 0;
  private readonly keyFields = new Set<number>();
  private readonly keyPieces: Column[][];

  constructor(
    private readonly node: SortNode,
    private readonly needed: Needed,
    private readonly limit: number | null,
    private readonly options: BackendOptions,
  ) {
    // Purpose: hold the sort's source rows as a selection and evaluate its keys in chunks
    for (const key of node.keys) {
      walkExpr(key.expr, e => {
        if (e.kind === 'field') this.keyFields.add(e.index);
      });
    }
    this.keyPieces = node.keys.map(function () {
      return [];
    });
  }

  consume(stage: Stage): void {
    // Purpose: keep this chunk's source rows and gather only the columns the keys need
    if (stage.rowCount === 0) return;
    this.pieces.push({
      batch: stage.batch,
      selection: stage.selection,
      offset: this.rowCount,
      rowCount: stage.rowCount,
    });
    this.rowCount += stage.rowCount;
    const keyStage: Stage = {
      batch: stage.batch,
      selection: stage.selection,
      rowCount: stage.rowCount,
      needed: this.keyFields,
    };
    const batch = dense(keyStage);
    this.node.keys.forEach((key, k) => {
      this.keyPieces[k]!.push(evaluate(key.expr, batch, this.options));
    });
  }

  *finish(): Generator<void, Stage> {
    // Purpose: sort a selection over the source in steps, then gather the chosen rows once
    const keys: SortColumn[] = this.node.keys.map((key, k) => ({
      column: concat(key.expr.type, this.keyPieces[k]!),
      descending: key.descending,
      nullsFirst: key.nullsFirst,
    }));
    const order = yield* sortSteps(keys, this.rowCount, this.limit);
    const batch = yield* gatherRows(this.node.schema, this.needed, this.pieces, order);
    return { batch, selection: null, rowCount: order.length, needed: this.needed };
  }
}

// --- joins and windows: blocking sinks over one or two sources ---

interface KeySpec {
  // Null keys form one group for grouping and sorting; in a join they never match.
  readonly nullsGroup: boolean;
  // NaN is one group for grouping (C-NAN-ORDER); a predicate never matches it (C-NAN-PREDICATE).
  readonly nanGroup: boolean;
}

const JOIN_KEYS: KeySpec = { nullsGroup: false, nanGroup: false };
const GROUP_KEYS: KeySpec = { nullsGroup: true, nanGroup: true };

function keyPart(column: Column, row: number, spec: KeySpec): string | null {
  // Purpose: one typed key component, or null when the row cannot take part in a key
  if (column.valid && !column.valid[row]) return spec.nullsGroup ? 'z' : null;
  if (isString(column.type)) return `s:${texts(column)[row]!}`;
  if (isBigInt(column.type)) return `b:${bigs(column)[row]!}`;
  const value = nums(column)[row]!;
  if (Number.isNaN(value)) return spec.nanGroup ? 'n:NaN' : null;
  return `n:${String(value)}`;
}

function rowKey(columns: readonly Column[], row: number, spec: KeySpec): string | null {
  // Purpose: a collision-free encoding of one row's key components
  const parts: string[] = [];
  for (const column of columns) {
    const part = keyPart(column, row, spec);
    if (part === null) return null;
    parts.push(`${part.length}:${part}`);
  }
  return parts.join('');
}

function keyColumns(indexes: readonly number[], batch: Batch, where: string): Column[] {
  // Purpose: the key columns of one join side, refusing a column that was pruned
  return indexes.map(function (index) {
    const column = batch.columns[index];
    if (!column) throw new PlanError(`JS backend: ${where} key column ${index} was pruned`);
    return column;
  });
}

type KeyIndex = Map<string, number[]>;

function* buildRightIndex(columns: readonly Column[], rows: number): Generator<void, KeyIndex> {
  // Purpose: hash the right rows by their key, keeping right order inside each bucket
  const index: KeyIndex = new Map();
  for (let row = 0; row < rows; row++) {
    const key = rowKey(columns, row, JOIN_KEYS);
    if (key === null) continue;
    let bucket = index.get(key);
    if (!bucket) {
      bucket = [];
      index.set(key, bucket);
    }
    bucket.push(row);
    if ((row + 1) % GATHER_BLOCK_ROWS === 0) yield;
  }
  return index;
}

interface JoinPairs {
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly rightMatched: Uint8Array;
}

function* joinPairs(
  node: JoinNode,
  leftKeys: readonly Column[],
  rightKeys: readonly Column[],
  index: KeyIndex,
  leftRows: number,
  rightRows: number,
): Generator<void, JoinPairs> {
  // Purpose: C-JOIN: matched pairs in left then right order, then unmatched rows in side order
  const outLeft: number[] = [];
  const outRight: number[] = [];
  const rightMatched = new Uint8Array(rightRows);
  const wantLeft = node.how === 'left' || node.how === 'full';
  const wantRight = node.how === 'right' || node.how === 'full';
  for (let left = 0; left < leftRows; left++) {
    const key = rowKey(leftKeys, left, JOIN_KEYS);
    const bucket = key === null ? undefined : index.get(key);
    let matches = 0;
    if (bucket) {
      for (const right of bucket) {
        rightMatched[right] = 1;
        outLeft.push(left);
        outRight.push(right);
        matches++;
      }
    }
    if (matches === 0 && wantLeft) {
      outLeft.push(left);
      outRight.push(-1);
    }
    if ((left + 1) % GATHER_BLOCK_ROWS === 0) yield;
  }
  if (wantRight) {
    for (let right = 0; right < rightRows; right++) {
      if (!rightMatched[right]) {
        outLeft.push(-1);
        outRight.push(right);
      }
      if ((right + 1) % GATHER_BLOCK_ROWS === 0) yield;
    }
  }
  return { left: outLeft, right: outRight, rightMatched };
}

function* gatherSide(type: DataType, column: Column, rows: readonly number[]): Generator<void, Column> {
  // Purpose: gather one output column, decoding and re-encoding strings so two dictionaries can differ
  const text = isString(type);
  const values = text ? new Array<string>(rows.length).fill('') : allocate(type, rows.length);
  const dst = values as unknown as AnyCells;
  let anyNull = false;
  for (const row of rows) {
    if (row < 0 || (column.valid && !column.valid[row])) {
      anyNull = true;
      break;
    }
  }
  const valid = anyNull ? new Uint8Array(rows.length).fill(1) : null;
  const src = text
    ? (texts(column) as unknown as AnyCells)
    : isBigInt(type)
      ? (bigs(column) as unknown as AnyCells)
      : nums(column);
  const zero = isBigInt(type) ? 0n : 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    dst[i] = row < 0 ? (text ? '' : zero) : src[row]!;
    if (valid && (row < 0 || (column.valid && !column.valid[row]))) valid[i] = 0;
    if ((i + 1) % GATHER_BLOCK_ROWS === 0) yield;
  }
  if (text) return stringColumn(type, values as string[], valid);
  return makeColumn(type, values, valid);
}

function sideNeeded(needed: Needed, keys: readonly number[], offset: number): Needed {
  // Purpose: the columns one side of a join must keep: its keys and what downstream reads
  if (needed === null) return null;
  const out = new Set<number>(keys);
  for (const index of needed) if (index >= offset) out.add(index - offset);
  return out;
}

class JoinSink implements Sink {
  private readonly collector: Collector;
  private readonly rightCollector: Collector;

  constructor(
    private readonly node: JoinNode,
    private readonly leftFields: readonly Field[],
    private readonly rightFields: readonly Field[],
    needed: Needed,
    private readonly rightSources: readonly Stage[],
    private readonly chunkRows: number,
  ) {
    // Purpose: collect the left branch and the extra right scans before matching them
    this.collector = new Collector(leftFields, sideNeeded(needed, node.leftKeys, 0));
    this.rightCollector = new Collector(rightFields, sideNeeded(needed, node.rightKeys, leftFields.length));
  }

  consume(stage: Stage): void {
    // Purpose: keep one chunk of the left branch's rows (C-JOIN reads it as it streams)
    if (stage.rowCount === 0) return;
    this.collector.add(dense(stage));
  }

  private *collectRight(): Generator<void, Batch> {
    // Purpose: read the right scans in source order, chunk by chunk, to the same snapshot rules
    for (const source of this.rightSources) {
      for (let start = 0; start < source.rowCount; start += this.chunkRows) {
        const end = Math.min(start + this.chunkRows, source.rowCount);
        this.rightCollector.add(dense(chunkOf(source, start, end)));
        yield;
      }
    }
    return this.rightCollector.finish();
  }

  *finish(): Generator<void, Stage> {
    // Purpose: index the right rows, emit pairs in contract order, then gather both sides' columns
    const left = this.collector.finish();
    const right = yield* this.collectRight();
    const leftKeys = keyColumns(this.node.leftKeys, left, 'left');
    const rightKeys = keyColumns(this.node.rightKeys, right, 'right');
    const index = yield* buildRightIndex(rightKeys, right.rowCount);
    const pairs = yield* joinPairs(this.node, leftKeys, rightKeys, index, left.rowCount, right.rowCount);
    const columns: (Column | undefined)[] = [];
    for (let c = 0; c < this.node.schema.length; c++) {
      const field = this.node.schema[c]!;
      const source = c < this.leftFields.length ? left : right;
      const rows = c < this.leftFields.length ? pairs.left : pairs.right;
      const at = c < this.leftFields.length ? c : c - this.leftFields.length;
      const column = source.columns[at];
      if (!column) throw new PlanError(`JS backend: join output column ${c} (${field.name}) was pruned`);
      columns.push(yield* gatherSide(field.type, column, rows));
      yield;
    }
    return { batch: { columns, rowCount: pairs.left.length }, selection: null, rowCount: pairs.left.length, needed: null };
  }
}

function* sortedPartition(
  rows: readonly number[],
  keys: readonly Column[],
  sorts: readonly IrSortKey[],
): Generator<void, number[]> {
  // Purpose: one partition's rows in contract sort order, reusing the executor's stable sort
  const local = Uint32Array.from(rows);
  const columns: SortColumn[] = keys.map(function (column, k) {
    return {
      column: take(column, local),
      descending: sorts[k]!.descending,
      nullsFirst: sorts[k]!.nullsFirst,
    };
  });
  const order = yield* sortSteps(columns, rows.length, null);
  return Array.from(order, function (i) {
    return rows[i]!;
  });
}

class WindowSink implements Sink {
  private readonly collector: Collector;

  constructor(
    private readonly node: WindowNode,
    private readonly inputFields: readonly Field[],
    private readonly needed: Needed,
    private readonly options: BackendOptions,
  ) {
    // Purpose: keep every input row in original order while the window is computed
    this.collector = new Collector(inputFields, null);
  }

  consume(stage: Stage): void {
    // Purpose: keep one chunk of the window's input
    if (stage.rowCount === 0) return;
    this.collector.add(dense(stage));
  }

  *finish(): Generator<void, Stage> {
    // Purpose: C-WINDOW: rank each partition, then emit input rows in order with the new columns appended
    const input = this.collector.finish();
    const rows = input.rowCount;
    const partitions = this.node.partitions.map(expr => evaluate(expr, input, this.options));
    const sorts = this.node.sorts.map(key => evaluate(key.expr, input, this.options));
    const buckets = new Map<string, number[]>();
    for (let row = 0; row < rows; row++) {
      const key = rowKey(partitions, row, GROUP_KEYS)!;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(row);
      if ((row + 1) % GATHER_BLOCK_ROWS === 0) yield;
    }
    const rowNumber = new BigInt64Array(rows);
    const rank = new BigInt64Array(rows);
    const denseRank = new BigInt64Array(rows);
    for (const bucket of buckets.values()) {
      const order = yield* sortedPartition(bucket, sorts, this.node.sorts);
      let peer: string | null = null;
      let peerRank = 0n;
      let peerDense = 0n;
      let group = 0;
      for (let at = 0; at < order.length; at++) {
        const row = order[at]!;
        const key = rowKey(sorts, row, GROUP_KEYS)!;
        if (key !== peer) {
          peer = key;
          peerRank = BigInt(at + 1);
          peerDense = BigInt(++group);
        }
        rowNumber[row] = BigInt(at + 1);
        rank[row] = peerRank;
        denseRank[row] = peerDense;
        if ((at + 1) % GATHER_BLOCK_ROWS === 0) yield;
      }
      yield;
    }
    const byName = new Map<WindowFnName, BigInt64Array>([
      ['row_number', rowNumber],
      ['rank', rank],
      ['dense_rank', denseRank],
    ]);
    const columns: (Column | undefined)[] = [];
    for (let c = 0; c < this.inputFields.length; c++) {
      if (!wanted(this.needed, c)) {
        columns.push(undefined);
        continue;
      }
      const column = input.columns[c];
      if (!column) throw new PlanError(`JS backend: window input column ${c} (${this.inputFields[c]!.name}) was pruned`);
      columns.push(column);
    }
    for (let f = 0; f < this.node.functions.length; f++) {
      const index = this.inputFields.length + f;
      if (!wanted(this.needed, index)) {
        columns.push(undefined);
        continue;
      }
      const fn = this.node.functions[f]!;
      const values = byName.get(fn.fn);
      if (!values) throw new PlanError(`JS backend: window function "${fn.fn}" is not implemented`);
      columns.push(makeColumn(fn.type, values, null));
    }
    return { batch: { columns, rowCount: rows }, selection: null, rowCount: rows, needed: this.needed };
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
  sourceSegments: readonly (readonly Segment[])[] = [],
): Generator<void, ResultData> {
  // Purpose: run a validated plan over every bound table's segments in resumable steps
  const chain = chainOf(plan);
  const needed = neededColumns(plan);
  const chunkRows = options.chunkRows ?? DEFAULT_CHUNK_ROWS;
  const scans = extraScanIndexes(plan);
  if (sourceSegments.length !== scans.length) {
    throw new PlanError(`JS backend: plan has ${scans.length} extra scans but ${sourceSegments.length} source segment lists`);
  }
  const secondary: Stage[][] = sourceSegments.map(function (pieces, i) {
    return pieces.map(function (segment) {
      return { batch: segment, selection: null, rowCount: segment.rowCount, needed: needed[scans[i]!]! };
    });
  });
  let sources: Stage[] = segments.map(function (segment) {
    return { batch: segment, selection: null, rowCount: segment.rowCount, needed: needed[0]! };
  });
  let position = 1;
  let first = true;
  for (;;) {
    const streaming: number[] = [];
    while (position < chain.length) {
      const op = plan.nodes[chain[position]!]!.op;
      if (op === 'aggregate' || op === 'sort' || op === 'join' || op === 'window') break;
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
      else if (node.op === 'sort') sink = new SortSink(node, needed[index]!, limitAfter(plan, chain, position), options);
      else if (node.op === 'join') {
        const scan = scans.indexOf(node.right);
        if (scan === -1) throw new PlanError(`JS backend: join node ${index} does not read an extra scan node`);
        sink = new JoinSink(
          node,
          plan.nodes[node.input]!.schema,
          plan.nodes[node.right]!.schema,
          needed[index]!,
          secondary[scan]!,
          chunkRows,
        );
      } else if (node.op === 'window') {
        sink = new WindowSink(node, plan.nodes[node.input]!.schema, needed[index]!, options);
      } else {
        throw new PlanError(`JS backend: node ${index} (${node.op}) is not an operator`);
      }
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

export function pause(): Promise<void> {
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
  sourceSegments: readonly (readonly Segment[])[] = [],
): Promise<ResultData> {
  // Purpose: drive a run in time slices, pausing between them and stopping if the signal aborts
  const signal = options.signal;
  if (signal?.aborted) throw new AbortError();
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
  let rowCount = 0;
  for (const segment of segments) rowCount += segment.rowCount;
  const progress: Progress = { rowsScanned: 0, rowsTotal: rowCount };
  const run = runPlan(plan, segments, options, progress, sourceSegments);
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
