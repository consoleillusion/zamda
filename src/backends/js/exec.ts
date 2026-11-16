// The JS reference executor. It walks the IR node table in order; each node
// turns its input stage into an output stage.
//
// Current shape: every node processes the whole table at once, and the abort
// signal is checked between nodes. Milestone 2 replaces this with chunked,
// resumable execution that yields to the event loop (docs/TASKS.md, T-201).
//
// Two things keep copying down:
//   - filter and sort produce a SELECTION (a list of row indexes) over their
//     input instead of new columns. Rows are copied only when a later node
//     needs dense columns, and aggregate reads straight through the selection.
//   - a column no later node reads is never copied at all.

import type { BackendOptions, ResultData } from '../../backend';
import type { AnyCells, Column } from '../../column';
import { allocate, head, makeColumn, nums, take } from '../../column';
import { AbortError, PlanError } from '../../errors';
import type { IrExpr, IrNode, IrPlan, LiteralValue } from '../../ir';
import { nodeExprs, walkExpr } from '../../ir';
import type { DataType } from '../../types';
import { aggregate } from './aggregate';
import { KERNELS } from './kernels';
import { castColumn } from './kernels-arith';
import { inList } from './kernels-misc';
import { sortIndices } from './sort';

interface Batch {
  // A column no later node reads is left undefined instead of being copied.
  readonly columns: readonly (Column | undefined)[];
  readonly rowCount: number;
}

// Column indexes of a node's output that later nodes read; null means all of them.
type Needed = Set<number> | null;

// A node's output: `batch` read directly, or through `selection` when set.
interface Stage {
  readonly batch: Batch;
  readonly selection: Uint32Array | null;
  readonly rowCount: number;
  readonly needed: Needed;
  // The selection applied to the needed columns, built on first use.
  materialized?: Batch;
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

function dense(stage: Stage): Batch {
  // Purpose: a stage's rows as plain columns, applying its selection to the needed columns once
  const selection = stage.selection;
  if (!selection) return stage.batch;
  if (!stage.materialized) {
    const needed = stage.needed;
    stage.materialized = {
      columns: stage.batch.columns.map(function (column, c) {
        return column && (needed === null || needed.has(c)) ? take(column, selection) : undefined;
      }),
      rowCount: stage.rowCount,
    };
  }
  return stage.materialized;
}

function broadcast(value: LiteralValue, type: DataType, n: number): Column {
  // Purpose: a column holding the same literal in every row
  if (type.name === 'dictionary') {
    // Every code is 0, pointing at the single dictionary entry.
    return makeColumn(type, new Int32Array(n), null, [value as string]);
  }
  const values = allocate(type, n);
  const stored = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  (values as unknown as AnyCells & { fill(v: unknown): void }).fill(stored);
  return makeColumn(type, values, null);
}

function evaluate(expr: IrExpr, batch: Batch, options: BackendOptions): Column {
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
  const keep = nums(predicate);
  const valid = predicate.valid;
  const selected = new Uint32Array(input.rowCount);
  let count = 0;
  if (!valid) {
    for (let i = 0; i < input.rowCount; i++) if (keep[i]) selected[count++] = i;
  } else {
    for (let i = 0; i < input.rowCount; i++) if (keep[i] && valid[i]) selected[count++] = i;
  }
  return { batch: input, selection: selected.subarray(0, count), rowCount: count, needed };
}

function runAggregate(
  node: Extract<IrNode, { op: 'aggregate' }>,
  input: Stage,
  options: BackendOptions,
): Stage {
  // Purpose: run an aggregate node, reading through the input's selection when it can
  const exprs = [...node.keys];
  for (const agg of node.aggs) if (agg.arg) exprs.push(agg.arg);
  const direct = exprs.every(function (expr) {
    return expr.kind === 'field';
  });
  // Plain column references can be read through the selection without copying.
  // Computed keys or arguments need dense input first.
  const batch = input.selection && direct ? input.batch : dense(input);
  const sel = input.selection && direct ? input.selection : null;
  const keys = node.keys.map(function (expr) {
    return evaluate(expr, batch, options);
  });
  const args = node.aggs.map(function (agg) {
    return agg.arg ? evaluate(agg.arg, batch, options) : null;
  });
  const out = aggregate(keys, node.aggs, args, { count: input.rowCount, sel });
  return { batch: out, selection: null, rowCount: out.rowCount, needed: null };
}

function limitAfterSort(plan: IrPlan, sortIndex: number): number | null {
  // Purpose: if a limit is the only reader of this sort, return its count so sort can do top-k
  let reader: IrNode | null = null;
  for (const node of plan.nodes) {
    if (node.op === 'scan' || node.input !== sortIndex) continue;
    if (reader) return null;
    reader = node;
  }
  return reader && reader.op === 'limit' && plan.root !== sortIndex ? reader.count : null;
}

export function executeJs(
  plan: IrPlan,
  columns: readonly Column[],
  rowCount: number,
  options: BackendOptions,
): ResultData {
  // Purpose: run a validated plan over JS columns and return the root node's output
  const stages: Stage[] = [];
  const needed = neededColumns(plan);
  for (let i = 0; i < plan.nodes.length; i++) {
    if (options.signal?.aborted) throw new AbortError();
    const node = plan.nodes[i]!;
    switch (node.op) {
      case 'scan':
        stages.push({ batch: { columns, rowCount }, selection: null, rowCount, needed: needed[i]! });
        break;
      case 'filter': {
        const input = dense(stages[node.input]!);
        stages.push(runFilter(input, evaluate(node.predicate, input, options), needed[i]!));
        break;
      }
      case 'project': {
        const input = dense(stages[node.input]!);
        const out = {
          columns: node.exprs.map(function (expr) {
            return evaluate(expr, input, options);
          }),
          rowCount: input.rowCount,
        };
        stages.push({ batch: out, selection: null, rowCount: out.rowCount, needed: needed[i]! });
        break;
      }
      case 'aggregate':
        stages.push(runAggregate(node, stages[node.input]!, options));
        break;
      case 'sort': {
        const input = dense(stages[node.input]!);
        const keys = node.keys.map(function (key) {
          return {
            column: evaluate(key.expr, input, options),
            descending: key.descending,
            nullsFirst: key.nullsFirst,
          };
        });
        const order = sortIndices(keys, input.rowCount, limitAfterSort(plan, i));
        stages.push({ batch: input, selection: order, rowCount: order.length, needed: needed[i]! });
        break;
      }
      case 'limit': {
        const input = stages[node.input]!;
        const count = Math.min(node.count, input.rowCount);
        if (input.selection) {
          // Limiting a selection is just a shorter selection.
          stages.push({
            batch: input.batch,
            selection: input.selection.subarray(0, count),
            rowCount: count,
            needed: needed[i]!,
          });
        } else {
          const keep = needed[i]!;
          const out = {
            columns: input.batch.columns.map(function (column, c) {
              return column && (keep === null || keep.has(c)) ? head(column, count) : undefined;
            }),
            rowCount: count,
          };
          stages.push({ batch: out, selection: null, rowCount: count, needed: keep });
        }
        break;
      }
    }
  }
  const root = dense(stages[plan.root]!);
  const output = root.columns.map(function (column, c) {
    if (!column) throw new PlanError(`JS backend: result column ${c} was pruned`);
    return column;
  });
  return { schema: plan.output, columns: output, rowCount: root.rowCount };
}
