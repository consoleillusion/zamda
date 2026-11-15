// The JS reference executor. It walks the IR node table in order; each node
// turns its input batch into an output batch.
//
// Current shape: every node processes the whole table as one batch, and the
// abort signal is checked between nodes. Milestone 2 replaces this with chunked,
// resumable execution that yields to the event loop (docs/TASKS.md, T-201).
// The operator functions below are written so that change stays local.

import type { BackendOptions, ResultData } from '../../backend';
import type { AnyCells, Column } from '../../column';
import { allocate, head, makeColumn, nums, take } from '../../column';
import { AbortError, PlanError } from '../../errors';
import type { IrExpr, IrPlan, LiteralValue } from '../../ir';
import type { DataType } from '../../types';
import { KERNELS } from './kernels';

interface Batch {
  readonly columns: readonly Column[];
  readonly rowCount: number;
}

function broadcast(value: LiteralValue, type: DataType, n: number): Column {
  // Purpose: a column holding the same literal in every row
  const values = allocate(type, n);
  const stored = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  (values as unknown as AnyCells & { fill(v: unknown): void }).fill(stored);
  return makeColumn(type, values, null);
}

function evaluate(expr: IrExpr, batch: Batch, options: BackendOptions): Column {
  // Purpose: evaluate one expression over a batch, returning a column
  switch (expr.kind) {
    case 'field':
      return batch.columns[expr.index]!;
    case 'literal':
      return broadcast(expr.value, expr.type, batch.rowCount);
    case 'param': {
      const value = options.params.get(expr.name);
      if (value === undefined) throw new PlanError(`Missing parameter "${expr.name}"`);
      return broadcast(value, expr.type, batch.rowCount);
    }
    case 'call': {
      const kernel = KERNELS.get(expr.fn);
      if (!kernel) throw new PlanError(`JS backend: function "${expr.fn}" is not implemented yet`);
      const args = expr.args.map(function (arg) {
        return evaluate(arg, batch, options);
      });
      return kernel(args, expr.type, batch.rowCount);
    }
  }
}

function filter(batch: Batch, predicate: Column): Batch {
  // Purpose: C-FILTER: keep rows where the predicate is true; null and false are dropped
  const keep = nums(predicate);
  const selected = new Uint32Array(batch.rowCount);
  let count = 0;
  for (let i = 0; i < batch.rowCount; i++) {
    if (keep[i] && (!predicate.valid || predicate.valid[i])) selected[count++] = i;
  }
  const indices = selected.subarray(0, count);
  return {
    columns: batch.columns.map(function (column) {
      return take(column, indices);
    }),
    rowCount: count,
  };
}

export function executeJs(
  plan: IrPlan,
  columns: readonly Column[],
  rowCount: number,
  options: BackendOptions,
): ResultData {
  // Purpose: run a validated plan over JS columns and return the root node's output
  const batches: Batch[] = [];
  for (let i = 0; i < plan.nodes.length; i++) {
    if (options.signal?.aborted) throw new AbortError();
    const node = plan.nodes[i]!;
    switch (node.op) {
      case 'scan':
        batches.push({ columns, rowCount });
        break;
      case 'filter': {
        const input = batches[node.input]!;
        batches.push(filter(input, evaluate(node.predicate, input, options)));
        break;
      }
      case 'project': {
        const input = batches[node.input]!;
        batches.push({
          columns: node.exprs.map(function (expr) {
            return evaluate(expr, input, options);
          }),
          rowCount: input.rowCount,
        });
        break;
      }
      case 'limit': {
        const input = batches[node.input]!;
        const count = Math.min(node.count, input.rowCount);
        batches.push({
          columns: input.columns.map(function (column) {
            return head(column, count);
          }),
          rowCount: count,
        });
        break;
      }
      case 'aggregate':
        // docs/TASKS.md, T-103.
        throw new PlanError('JS backend: aggregate is not implemented yet (T-103)');
      case 'sort':
        // docs/TASKS.md, T-104.
        throw new PlanError('JS backend: sort is not implemented yet (T-104)');
    }
  }
  const root = batches[plan.root]!;
  return { schema: plan.output, columns: root.columns, rowCount: root.rowCount };
}
