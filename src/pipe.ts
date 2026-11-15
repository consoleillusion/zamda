// The pipeline builder. A Pipeline is immutable: every method returns a new one
// with one more IR node. compile() turns it into a validated Plan.

import { ExpressionError, PlanError } from './errors';
import { AggExpr, BoolExpr, Expr, SortKey, wrap } from './expr';
import type { ExprFor } from './expr';
import type { IrExpr, IrNode, IrPlan } from './ir';
import { IR_VERSION, nodeExprs, walkExpr } from './ir';
import { optimize } from './optimize';
import { Plan } from './plan';
import type { Field, Fields, Schema } from './schema';
import { schemaFromList } from './schema';
import type { DataType } from './types';
import { sameType } from './types';
import { validate } from './validate';

// The accessor object a callback receives: one typed expression per column.
export type Cols<F extends Fields> = { readonly [K in keyof F]: ExprFor<F[K]> };

// The schema produced by an object of expressions or aggregates.
export type FieldsOf<O> = {
  [K in keyof O]: O[K] extends Expr<infer D extends DataType> ? D
  : O[K] extends AggExpr<infer A extends DataType> ? A
  : never;
};

interface Access<F extends Fields> {
  readonly cols: Cols<F>;
  // Indexes of the columns the callback read.
  readonly touched: Set<number>;
}

function accessor<F extends Fields>(schema: Schema<F>): Access<F> {
  // Purpose: build the proxy a DSL callback reads columns from, recording each read
  const touched = new Set<number>();
  const index = new Map<string, number>();
  schema.list.forEach(function (field, i) {
    index.set(field.name, i);
  });
  const cols = new Proxy(
    {},
    {
      get(_target, prop) {
        // Purpose: return a typed column expression, or fail for an unknown name
        if (typeof prop !== 'string') return undefined;
        const i = index.get(prop);
        if (i === undefined) {
          throw new ExpressionError(
            `Unknown column "${prop}". Available: ${[...index.keys()].join(', ')}`,
          );
        }
        touched.add(i);
        return wrap({ kind: 'field', index: i, type: schema.list[i]!.type });
      },
    },
  ) as Cols<F>;
  return { cols, touched };
}

function checkUsed(schema: Schema, touched: Set<number>, exprs: readonly IrExpr[], where: string): void {
  // Purpose: catch `c.a && c.b` and `!c.a`, where JS silently drops a column
  const used = new Set<number>();
  for (const expr of exprs) {
    walkExpr(expr, function (e) {
      if (e.kind === 'field') used.add(e.index);
    });
  }
  for (const i of touched) {
    if (!used.has(i)) {
      throw new ExpressionError(
        `${where}: column "${schema.list[i]!.name}" was read but is not part of the result. ` +
          'JavaScript operators such as &&, ||, ! and === do not work on expressions; ' +
          'use .and(), .or(), .not() and .eq().',
      );
    }
  }
}

function entriesOf(value: unknown, where: string): [string, unknown][] {
  // Purpose: read a callback's returned object as name/value pairs
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExpressionError(`${where}: the callback must return an object of named expressions`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new ExpressionError(`${where}: the returned object is empty`);
  return entries;
}

export class Pipeline<In extends Fields, Cur extends Fields> {
  /** @internal */ readonly _input: Schema<In>;
  /** @internal */ readonly _current: Schema<Cur>;
  /** @internal */ readonly _nodes: readonly IrNode[];

  constructor(input: Schema<In>, current: Schema<Cur>, nodes: readonly IrNode[]) {
    // Purpose: hold the input schema, the schema at this stage, and the nodes so far
    this._input = input;
    this._current = current;
    this._nodes = nodes;
  }

  /** @internal */
  _push<N extends Fields>(node: IrNode, schema: Schema<N>): Pipeline<In, N> {
    // Purpose: return a new pipeline with one more node
    return new Pipeline(this._input, schema, [...this._nodes, node]);
  }

  /** @internal */
  _last(): number {
    // Purpose: index of the node the next node reads from
    return this._nodes.length - 1;
  }

  filter(fn: (c: Cols<Cur>) => BoolExpr): Pipeline<In, Cur> {
    // Purpose: keep rows where the predicate is true (null and false are dropped)
    const access = accessor(this._current);
    const predicate = fn(access.cols);
    if (!(predicate instanceof BoolExpr)) {
      throw new ExpressionError('filter: the callback must return a boolean expression');
    }
    checkUsed(this._current, access.touched, [predicate.node], 'filter');
    return this._push(
      { op: 'filter', input: this._last(), predicate: predicate.node, schema: this._current.list },
      this._current,
    );
  }

  select<O extends Record<string, Expr>>(fn: (c: Cols<Cur>) => O): Pipeline<In, FieldsOf<O>> {
    // Purpose: project to a new set of named columns
    const access = accessor(this._current);
    const fields: Field[] = [];
    const exprs: IrExpr[] = [];
    for (const [name, value] of entriesOf(fn(access.cols), 'select')) {
      if (!(value instanceof Expr)) {
        throw new ExpressionError(`select: "${name}" is not an expression; wrap constants in lit()`);
      }
      fields.push({ name, type: value.node.type });
      exprs.push(value.node);
    }
    checkUsed(this._current, access.touched, exprs, 'select');
    const schema = schemaFromList(fields) as Schema<FieldsOf<O>>;
    return this._push({ op: 'project', input: this._last(), exprs, schema: schema.list }, schema);
  }

  sort(fn: (c: Cols<Cur>) => SortKey | readonly SortKey[]): Pipeline<In, Cur> {
    // Purpose: stable sort by one or more keys built with .asc() or .desc()
    const access = accessor(this._current);
    const result = fn(access.cols);
    const keys = result instanceof SortKey ? [result] : [...result];
    if (keys.length === 0) throw new ExpressionError('sort: at least one key is required');
    for (const key of keys) {
      if (!(key instanceof SortKey)) {
        throw new ExpressionError('sort: keys must be built with .asc() or .desc()');
      }
    }
    const irKeys = keys.map(function (k) {
      return k.key;
    });
    checkUsed(
      this._current,
      access.touched,
      irKeys.map(function (k) {
        return k.expr;
      }),
      'sort',
    );
    return this._push(
      { op: 'sort', input: this._last(), keys: irKeys, schema: this._current.list },
      this._current,
    );
  }

  limit(count: number): Pipeline<In, Cur> {
    // Purpose: keep the first `count` rows
    if (!Number.isInteger(count) || count < 0) {
      throw new PlanError(`limit: expected a non-negative integer, got ${count}`);
    }
    return this._push(
      { op: 'limit', input: this._last(), count, schema: this._current.list },
      this._current,
    );
  }

  groupBy<K extends Record<string, Expr>>(fn: (c: Cols<Cur>) => K): Grouped<In, Cur, FieldsOf<K>> {
    // Purpose: start a grouped aggregation; keys are named expressions
    const access = accessor(this._current);
    const fields: Field[] = [];
    const keys: IrExpr[] = [];
    for (const [name, value] of entriesOf(fn(access.cols), 'groupBy')) {
      if (!(value instanceof Expr)) throw new ExpressionError(`groupBy: "${name}" is not an expression`);
      fields.push({ name, type: value.node.type });
      keys.push(value.node);
    }
    checkUsed(this._current, access.touched, keys, 'groupBy');
    return new Grouped(this, fields, keys);
  }

  compile(): Plan<In, Cur> {
    // Purpose: assemble, optimize and validate the IR, returning a reusable plan
    const params = new Map<string, Field>();
    for (const node of this._nodes) {
      for (const expr of nodeExprs(node)) {
        walkExpr(expr, function (e) {
          if (e.kind !== 'param') return;
          const seen = params.get(e.name);
          if (seen && !sameType(seen.type, e.type)) {
            throw new PlanError(`Parameter "${e.name}" is used with two different types`);
          }
          params.set(e.name, { name: e.name, type: e.type });
        });
      }
    }
    const plan: IrPlan = {
      version: IR_VERSION,
      input: this._input.list,
      nodes: this._nodes,
      root: this._last(),
      output: this._current.list,
      params: [...params.values()],
    };
    return new Plan(validate(optimize(plan)));
  }
}

export class Grouped<In extends Fields, Cur extends Fields, KeyFields extends Fields> {
  private readonly parent: Pipeline<In, Cur>;
  private readonly keyFields: readonly Field[];
  private readonly keys: readonly IrExpr[];

  constructor(parent: Pipeline<In, Cur>, keyFields: readonly Field[], keys: readonly IrExpr[]) {
    // Purpose: hold the group keys until agg() supplies the aggregates
    this.parent = parent;
    this.keyFields = keyFields;
    this.keys = keys;
  }

  agg<A extends Record<string, AggExpr>>(
    fn: (c: Cols<Cur>) => A,
  ): Pipeline<In, KeyFields & FieldsOf<A>> {
    // Purpose: finish the aggregation; output is the keys followed by the aggregates
    const access = accessor(this.parent._current);
    const fields: Field[] = [...this.keyFields];
    const aggs = [];
    const args: IrExpr[] = [];
    for (const [name, value] of entriesOf(fn(access.cols), 'agg')) {
      if (!(value instanceof AggExpr)) {
        throw new ExpressionError(`agg: "${name}" is not an aggregate such as count() or c.x.sum()`);
      }
      fields.push({ name, type: value.agg.type });
      aggs.push(value.agg);
      if (value.agg.arg) args.push(value.agg.arg);
    }
    checkUsed(this.parent._current, access.touched, args, 'agg');
    const schema = schemaFromList(fields) as Schema<KeyFields & FieldsOf<A>>;
    return this.parent._push(
      { op: 'aggregate', input: this.parent._last(), keys: this.keys, aggs, schema: schema.list },
      schema,
    );
  }
}

export function pipe<F extends Fields>(schema: Schema<F>): Pipeline<F, F> {
  // Purpose: start a pipeline over tables with the given schema
  return new Pipeline(schema, schema, [{ op: 'scan', schema: schema.list }]);
}
