import type { ResultData, RunSession, Table } from './backend';
import { AbortError, PlanError, TypeCheckError } from './errors';
import { literalValue } from './expr';
import type { IrExpr, IrNode, IrPlan, LiteralValue } from './ir';
import type { NoParams, ParamDecls, ParamValues } from './pipe';
import { Result } from './result';
import type { Fields } from './schema';
import { checkCompatible } from './schema';

export interface ExecuteOptions<P extends ParamDecls = NoParams> {
  // Values for every declared parameter.
  readonly params?: ParamValues<P>;
  // Aborting rejects the run with AbortError and leaves the table intact.
  // The run notices within one time slice.
  readonly signal?: AbortSignal;
  // Called between time slices and once at the end, with how much of the table has been read.
  readonly onProgress?: (progress: { rowsScanned: number; rowsTotal: number }) => void;
  // Rows processed per chunk. Default 65,536. Results never depend on it.
  readonly chunkRows?: number;
  // How long to work before returning to the event loop, in milliseconds. Default 8.
  readonly sliceMs?: number;
  // An opaque handle grouping runs that share work; only the backend that made it understands it.
  readonly session?: RunSession;
}

// `options` is required exactly when the plan declares parameters.
export type ExecuteArgs<P extends ParamDecls> =
  keyof P extends never
    ? [options?: ExecuteOptions<P>]
    : [options: ExecuteOptions<P> & { readonly params: ParamValues<P> }];

function formatLiteral(value: LiteralValue): string {
  // Purpose: render a literal for explain()
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function formatExpr(expr: IrExpr): string {
  // Purpose: render an expression for explain()
  switch (expr.kind) {
    case 'field':
      return `$${expr.index}`;
    case 'literal':
      return formatLiteral(expr.value);
    case 'param':
      return `:${expr.name}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(formatExpr).join(', ')})`;
    case 'cast':
      return `cast(${formatExpr(expr.arg)} as ${expr.type.name})`;
    case 'in':
      return `in(${formatExpr(expr.arg)}, ${expr.param !== null ? `:${expr.param}` : `[${expr.values!.map(formatLiteral).join(', ')}]`})`;
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
    case 'join':
      return `join ${node.how} right=#${node.right} leftKeys=[${node.leftKeys.join(', ')}] rightKeys=[${node.rightKeys.join(', ')}]`;
    case 'window': {
      const partitions = node.partitions.map(formatExpr).join(', ');
      const sorts = node.sorts.map(function (k) {
        return `${formatExpr(k.expr)} ${k.descending ? 'desc' : 'asc'}${k.nullsFirst ? ' nulls first' : ''}`;
      });
      const functions = node.functions.map(function (f) {
        return f.fn;
      });
      return `window partitionBy=[${partitions}] orderBy=[${sorts}] functions=[${functions.join(', ')}]`;
    }
  }
}

function extraScanIndexes(plan: IrPlan): number[] {
  // Purpose: indexes of the plan's scan nodes after the primary one, in IR order
  const out: number[] = [];
  for (let i = 1; i < plan.nodes.length; i++) {
    if (plan.nodes[i]!.op === 'scan') out.push(i);
  }
  return out;
}

export class Plan<In extends Fields, Out extends Fields, P extends ParamDecls = NoParams> {
  readonly ir: IrPlan;
  // Right-hand tables bound when the plan was compiled, in extra-scan order (D-076).
  readonly sources: readonly Table[];

  constructor(ir: IrPlan, sources: readonly Table[] = []) {
    // Purpose: hold a validated IR plan and the tables its extra scans read
    this.ir = ir;
    this.sources = sources;
  }

  async execute(table: Table<In>, ...args: ExecuteArgs<P>): Promise<Result<Out>> {
    // Purpose: run the plan on the backend that owns the table (C-PARAM for parameters)
    const options: ExecuteOptions<P> = args[0] ?? {};
    checkCompatible(this.ir.input, table.schema.list);
    const scans = extraScanIndexes(this.ir);
    if (this.sources.length !== scans.length) {
      throw new PlanError(
        `Plan binds ${scans.length} extra scan${scans.length === 1 ? '' : 's'} but found ${this.sources.length} source${this.sources.length === 1 ? '' : 's'}`,
      );
    }
    for (let i = 0; i < scans.length; i++) {
      checkCompatible(this.ir.nodes[scans[i]!]!.schema, this.sources[i]!.schema.list);
    }
    const given = (options.params ?? {}) as Readonly<Record<string, unknown>>;
    const params = new Map<string, LiteralValue | readonly LiteralValue[]>();
    for (const param of this.ir.params) {
      if (!(param.name in given)) throw new PlanError(`Missing parameter "${param.name}"`);
      const value = given[param.name];
      if (!param.list) {
        params.set(param.name, literalValue(value, param.type));
        continue;
      }
      if (!Array.isArray(value)) {
        throw new TypeCheckError(`Parameter "${param.name}" must be an array of ${param.type.name} values`);
      }
      params.set(
        param.name,
        value.map(function (v) {
          return literalValue(v, param.type);
        }),
      );
    }
    for (const name of Object.keys(given)) {
      if (!params.has(name)) throw new PlanError(`Unknown parameter "${name}"`);
    }
    const { chunkRows, sliceMs } = options;
    if (chunkRows !== undefined && (!Number.isInteger(chunkRows) || chunkRows < 1)) {
      throw new PlanError(`chunkRows must be a positive integer, got ${chunkRows}`);
    }
    if (sliceMs !== undefined && !(sliceMs >= 0)) {
      throw new PlanError(`sliceMs must be zero or more, got ${sliceMs}`);
    }
    if (options.signal?.aborted) throw new AbortError();
    const tables: readonly Table[] = [table, ...this.sources];
    for (const bound of tables) bound.backend.retain?.(bound);
    let data: ResultData;
    try {
      const target = table.backend.unwrap?.(table) ?? table;
      const sources = this.sources.map(function (source) {
        return source.backend.unwrap?.(source) ?? source;
      });
      data = await table.backend.execute(this.ir, target, {
        params,
        signal: options.signal,
        chunkRows,
        sliceMs,
        onProgress: options.onProgress,
        session: options.session,
        sources,
      });
    } finally {
      for (let i = tables.length - 1; i >= 0; i--) tables[i]!.backend.release?.(tables[i]!);
    }
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
