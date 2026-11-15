import type { Table } from './backend';
import { AbortError, PlanError } from './errors';
import { literalNode } from './expr';
import type { IrExpr, IrNode, IrPlan, LiteralValue } from './ir';
import { Result } from './result';
import type { Fields } from './schema';
import { checkCompatible } from './schema';

export interface ExecuteOptions {
  // Values for every param() in the plan.
  readonly params?: Readonly<Record<string, unknown>>;
  // Aborting rejects the run with AbortError and leaves the table intact.
  readonly signal?: AbortSignal;
}

function formatExpr(expr: IrExpr): string {
  // Purpose: render an expression for explain()
  switch (expr.kind) {
    case 'field':
      return `$${expr.index}`;
    case 'literal':
      return typeof expr.value === 'string' ? JSON.stringify(expr.value) : String(expr.value);
    case 'param':
      return `:${expr.name}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(formatExpr).join(', ')})`;
  }
}

function formatNode(node: IrNode): string {
  // Purpose: render one node's operation and arguments for explain()
  switch (node.op) {
    case 'scan':
      return 'scan';
    case 'filter':
      return `filter ${formatExpr(node.predicate)}`;
    case 'project':
      return `project ${node.exprs.map(formatExpr).join(', ')}`;
    case 'aggregate': {
      const aggs = node.aggs.map(function (a) {
        return `${a.fn}(${a.arg ? formatExpr(a.arg) : ''})`;
      });
      return `aggregate keys=[${node.keys.map(formatExpr).join(', ')}] aggs=[${aggs.join(', ')}]`;
    }
    case 'sort': {
      const keys = node.keys.map(function (k) {
        return `${formatExpr(k.expr)} ${k.descending ? 'desc' : 'asc'}${k.nullsFirst ? ' nulls first' : ''}`;
      });
      return `sort ${keys.join(', ')}`;
    }
    case 'limit':
      return `limit ${node.count}`;
  }
}

export class Plan<In extends Fields, Out extends Fields> {
  readonly ir: IrPlan;

  constructor(ir: IrPlan) {
    // Purpose: hold a validated IR plan; reusable across tables with a matching schema
    this.ir = ir;
  }

  async execute(table: Table<In>, options: ExecuteOptions = {}): Promise<Result<Out>> {
    // Purpose: run the plan on the backend that owns the table
    checkCompatible(this.ir.input, table.schema.list);
    const given = options.params ?? {};
    const params = new Map<string, LiteralValue>();
    for (const field of this.ir.params) {
      if (!(field.name in given)) throw new PlanError(`Missing parameter "${field.name}"`);
      const node = literalNode(given[field.name], field.type);
      if (node.kind === 'literal') params.set(field.name, node.value);
    }
    for (const name of Object.keys(given)) {
      if (!params.has(name)) throw new PlanError(`Unknown parameter "${name}"`);
    }
    if (options.signal?.aborted) throw new AbortError();
    const data = await table.backend.execute(this.ir, table, { params, signal: options.signal });
    return new Result<Out>(data);
  }

  explain(): string {
    // Purpose: human-readable logical plan, one node per line
    return this.ir.nodes
      .map(function (node, i) {
        const columns = node.schema.map(function (f) {
          return `${f.name}:${f.type.name}`;
        });
        return `#${i} ${formatNode(node)} -> [${columns.join(', ')}]`;
      })
      .join('\n');
  }
}
