// The pipeline builder. A Pipeline is immutable: every method returns a new one
// with one more IR node. compile() turns it into a validated Plan.

import { ExpressionError, PlanError } from './errors';
import { AggExpr, BoolExpr, Expr, ListParam, SortKey, paramExpr, wrap } from './expr';
import type { ExprFor } from './expr';
import type { IrAggregate, IrExpr, IrNode, IrParam, IrPlan } from './ir';
import { IR_VERSION, walkExpr } from './ir';
import { optimize } from './optimize';
import { Plan } from './plan';
import type { Field, Fields, Schema } from './schema';
import { schemaFromList } from './schema';
import type { DataType, JsOf } from './types';
import { validate } from './validate';

// The accessor object a callback receives: one typed expression per column.
export type Cols<F extends Fields> = { readonly [K in keyof F]: ExprFor<F[K]> };

// The schema produced by an object of expressions or aggregates.
export type FieldsOf<O> = {
  [K in keyof O]: O[K] extends Expr<infer D extends DataType> ? D
  : O[K] extends AggExpr<infer A extends DataType> ? A
  : never;
};

// --- parameters ---

// A list parameter declaration, made with list().
export interface ListDecl<D extends DataType = DataType> {
  readonly list: D;
}

// Parameters are declared up front: a map of name to type, or to list(type).
export type ParamDecls = Record<string, DataType | ListDecl>;

// What a callback receives as its second argument.
export type ParamExprs<P extends ParamDecls> = {
  readonly [K in keyof P]: P[K] extends ListDecl<infer D> ? ListParam<D>
  : P[K] extends DataType ? ExprFor<P[K]>
  : never;
};

// What execute() expects as `params`.
export type ParamValues<P extends ParamDecls> = {
  readonly [K in keyof P]: P[K] extends ListDecl<infer D> ? readonly JsOf<D>[]
  : P[K] extends DataType ? JsOf<P[K]>
  : never;
};

// Nothing declared.
export type NoParams = Record<never, never>;

export function list<D extends DataType>(type: D): ListDecl<D> {
  // Purpose: declare a list parameter, for use with isIn()
  return { list: type };
}

function isListDecl(decl: DataType | ListDecl): decl is ListDecl {
  // Purpose: tell a list declaration from a scalar one
  return 'list' in decl;
}

// --- rename and withColumns result types ---

export type Merge<A, B> = Omit<A, keyof B> & B;

export type Renamed<F extends Fields, M> = {
  [K in keyof F as K extends keyof M ? (M[K] extends string ? M[K] : K) : K]: F[K];
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

interface Aggregates {
  readonly fields: Field[];
  readonly aggs: IrAggregate[];
}

export class Pipeline<In extends Fields, Cur extends Fields, P extends ParamDecls = NoParams> {
  /** @internal */ readonly _input: Schema<In>;
  /** @internal */ readonly _current: Schema<Cur>;
  /** @internal */ readonly _nodes: readonly IrNode[];
  /** @internal */ readonly _decls: P;
  /** @internal */ readonly _params: ParamExprs<P>;

  constructor(input: Schema<In>, current: Schema<Cur>, nodes: readonly IrNode[], decls: P) {
    // Purpose: hold the input schema, the schema at this stage, the nodes so far and the parameters
    this._input = input;
    this._current = current;
    this._nodes = nodes;
    this._decls = decls;
    const params: Record<string, unknown> = {};
    for (const [name, decl] of Object.entries(decls)) {
      params[name] = isListDecl(decl) ? new ListParam(name, decl.list) : paramExpr(name, decl);
    }
    this._params = Object.freeze(params) as ParamExprs<P>;
  }

  /** @internal */
  _push<N extends Fields>(node: IrNode, schema: Schema<N>): Pipeline<In, N, P> {
    // Purpose: return a new pipeline with one more node
    return new Pipeline(this._input, schema, [...this._nodes, node], this._decls);
  }

  /** @internal */
  _last(): number {
    // Purpose: index of the node the next node reads from
    return this._nodes.length - 1;
  }

  /** @internal */
  _aggregates(fn: (c: Cols<Cur>, p: ParamExprs<P>) => unknown, where: string): Aggregates {
    // Purpose: run an agg callback and collect its named aggregates
    const access = accessor(this._current);
    const fields: Field[] = [];
    const aggs: IrAggregate[] = [];
    const args: IrExpr[] = [];
    for (const [name, value] of entriesOf(fn(access.cols, this._params), where)) {
      if (!(value instanceof AggExpr)) {
        throw new ExpressionError(`${where}: "${name}" is not an aggregate such as count() or c.x.sum()`);
      }
      fields.push({ name, type: value.agg.type });
      aggs.push(value.agg);
      if (value.agg.arg) args.push(value.agg.arg);
    }
    checkUsed(this._current, access.touched, args, where);
    return { fields, aggs };
  }

  /** @internal */
  _project<N extends Fields>(fields: readonly Field[], exprs: readonly IrExpr[]): Pipeline<In, N, P> {
    // Purpose: append a project node with the given output columns
    const schema = schemaFromList(fields) as Schema<N>;
    return this._push({ op: 'project', input: this._last(), exprs, schema: schema.list }, schema);
  }

  filter(fn: (c: Cols<Cur>, p: ParamExprs<P>) => BoolExpr): Pipeline<In, Cur, P> {
    // Purpose: keep rows where the predicate is true (null and false are dropped)
    const access = accessor(this._current);
    const predicate = fn(access.cols, this._params);
    if (!(predicate instanceof BoolExpr)) {
      throw new ExpressionError('filter: the callback must return a boolean expression');
    }
    checkUsed(this._current, access.touched, [predicate.node], 'filter');
    return this._push(
      { op: 'filter', input: this._last(), predicate: predicate.node, schema: this._current.list },
      this._current,
    );
  }

  select<O extends Record<string, Expr>>(
    fn: (c: Cols<Cur>, p: ParamExprs<P>) => O,
  ): Pipeline<In, FieldsOf<O>, P> {
    // Purpose: project to a new set of named columns
    const access = accessor(this._current);
    const fields: Field[] = [];
    const exprs: IrExpr[] = [];
    for (const [name, value] of entriesOf(fn(access.cols, this._params), 'select')) {
      if (!(value instanceof Expr)) {
        throw new ExpressionError(`select: "${name}" is not an expression; wrap constants in lit()`);
      }
      fields.push({ name, type: value.node.type });
      exprs.push(value.node);
    }
    checkUsed(this._current, access.touched, exprs, 'select');
    return this._project(fields, exprs);
  }

  withColumns<O extends Record<string, Expr>>(
    fn: (c: Cols<Cur>, p: ParamExprs<P>) => O,
  ): Pipeline<In, Merge<Cur, FieldsOf<O>>, P> {
    // Purpose: keep every column and add new ones; a new column with an existing name replaces it
    const access = accessor(this._current);
    const added = new Map<string, IrExpr>();
    for (const [name, value] of entriesOf(fn(access.cols, this._params), 'withColumns')) {
      if (!(value instanceof Expr)) {
        throw new ExpressionError(`withColumns: "${name}" is not an expression; wrap constants in lit()`);
      }
      added.set(name, value.node);
    }
    checkUsed(this._current, access.touched, [...added.values()], 'withColumns');
    const fields: Field[] = [];
    const exprs: IrExpr[] = [];
    this._current.list.forEach(function (field, index) {
      const replacement = added.get(field.name);
      const expr: IrExpr = replacement ?? { kind: 'field', index, type: field.type };
      added.delete(field.name);
      fields.push({ name: field.name, type: expr.type });
      exprs.push(expr);
    });
    for (const [name, expr] of added) {
      fields.push({ name, type: expr.type });
      exprs.push(expr);
    }
    return this._project(fields, exprs);
  }

  rename<const M extends { readonly [K in keyof Cur]?: string }>(
    names: M,
  ): Pipeline<In, Renamed<Cur, M>, P> {
    // Purpose: rename columns; `names` maps an existing name to its new name
    const map = names as Readonly<Record<string, string | undefined>>;
    for (const name of Object.keys(map)) {
      if (!(name in this._current.fields)) throw new ExpressionError(`rename: unknown column "${name}"`);
    }
    const fields: Field[] = [];
    const exprs: IrExpr[] = [];
    this._current.list.forEach(function (field, index) {
      fields.push({ name: map[field.name] ?? field.name, type: field.type });
      exprs.push({ kind: 'field', index, type: field.type });
    });
    return this._project(fields, exprs);
  }

  sort(fn: (c: Cols<Cur>, p: ParamExprs<P>) => SortKey | readonly SortKey[]): Pipeline<In, Cur, P> {
    // Purpose: stable sort by one or more keys built with .asc() or .desc()
    const access = accessor(this._current);
    const result = fn(access.cols, this._params);
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

  limit(count: number): Pipeline<In, Cur, P> {
    // Purpose: keep the first `count` rows
    if (!Number.isInteger(count) || count < 0) {
      throw new PlanError(`limit: expected a non-negative integer, got ${count}`);
    }
    return this._push(
      { op: 'limit', input: this._last(), count, schema: this._current.list },
      this._current,
    );
  }

  distinct(): Pipeline<In, Cur, P> {
    // Purpose: unique rows in order of first occurrence; an aggregate with every column as a key
    const keys: IrExpr[] = this._current.list.map(function (field, index) {
      return { kind: 'field', index, type: field.type };
    });
    return this._push(
      { op: 'aggregate', input: this._last(), keys, aggs: [], schema: this._current.list },
      this._current,
    );
  }

  groupBy<K extends Record<string, Expr>>(
    fn: (c: Cols<Cur>, p: ParamExprs<P>) => K,
  ): Grouped<In, Cur, FieldsOf<K>, P> {
    // Purpose: start a grouped aggregation; keys are named expressions
    const access = accessor(this._current);
    const fields: Field[] = [];
    const keys: IrExpr[] = [];
    for (const [name, value] of entriesOf(fn(access.cols, this._params), 'groupBy')) {
      if (!(value instanceof Expr)) throw new ExpressionError(`groupBy: "${name}" is not an expression`);
      fields.push({ name, type: value.node.type });
      keys.push(value.node);
    }
    checkUsed(this._current, access.touched, keys, 'groupBy');
    return new Grouped(this, fields, keys);
  }

  agg<A extends Record<string, AggExpr>>(
    fn: (c: Cols<Cur>, p: ParamExprs<P>) => A,
  ): Pipeline<In, FieldsOf<A>, P> {
    // Purpose: aggregate all rows into exactly one row (C-EMPTY-AGG)
    const { fields, aggs } = this._aggregates(fn, 'agg');
    const schema = schemaFromList(fields) as Schema<FieldsOf<A>>;
    return this._push(
      { op: 'aggregate', input: this._last(), keys: [], aggs, schema: schema.list },
      schema,
    );
  }

  compile(): Plan<In, Cur, P> {
    // Purpose: assemble, optimize and validate the IR, returning a reusable plan
    const params: IrParam[] = Object.entries(this._decls).map(function ([name, decl]) {
      return isListDecl(decl) ? { name, type: decl.list, list: true } : { name, type: decl, list: false };
    });
    const plan: IrPlan = {
      version: IR_VERSION,
      input: this._input.list,
      nodes: this._nodes,
      root: this._last(),
      output: this._current.list,
      params,
    };
    return new Plan(validate(optimize(plan)));
  }
}

export class Grouped<
  In extends Fields,
  Cur extends Fields,
  KeyFields extends Fields,
  P extends ParamDecls = NoParams,
> {
  private readonly parent: Pipeline<In, Cur, P>;
  private readonly keyFields: readonly Field[];
  private readonly keys: readonly IrExpr[];

  constructor(parent: Pipeline<In, Cur, P>, keyFields: readonly Field[], keys: readonly IrExpr[]) {
    // Purpose: hold the group keys until agg() supplies the aggregates
    this.parent = parent;
    this.keyFields = keyFields;
    this.keys = keys;
  }

  agg<A extends Record<string, AggExpr>>(
    fn: (c: Cols<Cur>, p: ParamExprs<P>) => A,
  ): Pipeline<In, KeyFields & FieldsOf<A>, P> {
    // Purpose: finish the aggregation; output is the keys followed by the aggregates
    const { fields, aggs } = this.parent._aggregates(fn, 'agg');
    const schema = schemaFromList([...this.keyFields, ...fields]) as Schema<KeyFields & FieldsOf<A>>;
    return this.parent._push(
      { op: 'aggregate', input: this.parent._last(), keys: this.keys, aggs, schema: schema.list },
      schema,
    );
  }
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function pipe<F extends Fields>(schema: Schema<F>): Pipeline<F, F, NoParams>;
export function pipe<F extends Fields, P extends ParamDecls>(schema: Schema<F>, params: P): Pipeline<F, F, P>;
export function pipe<F extends Fields>(schema: Schema<F>, params: ParamDecls = {}): Pipeline<F, F, ParamDecls> {
  // Purpose: start a pipeline over tables with the given schema, optionally declaring parameters
  for (const name of Object.keys(params)) {
    if (!PARAM_NAME.test(name)) throw new ExpressionError(`Invalid parameter name "${name}"`);
  }
  return new Pipeline(schema, schema, [{ op: 'scan', schema: schema.list }], params);
}
