// The expression DSL. Each method builds an IR expression and type-checks it
// immediately through the registry, so a mistake throws at the line that made it.
// Expressions never see data.

import { ExpressionError, TypeCheckError } from './errors';
import type { IrAggregate, IrExpr, IrSortKey } from './ir';
import { lookup } from './registry';
import type { DataType, FloatName, JsOf, NumericName, StringName, UnsignedName } from './types';
import { BIGINT_RANGES, INT_RANGES, isBigInt, isFloat, isInt, isNumeric, isString } from './types';

type Bool = DataType<'bool'>;

// A value accepted where an expression of type D is expected.
export type Operand<D extends DataType> = Expr<D> | JsOf<D>;

// The expression class the DSL exposes for a column of type D.
export type ExprFor<D extends DataType> =
  D extends DataType<NumericName> ? NumExpr<D>
  : D extends Bool ? BoolExpr
  : D extends DataType<StringName> ? StrExpr<D>
  : OrdExpr<D>;

// Result type of sum(): see docs/CONTRACT.md, C-AGG-TYPES.
export type SumType<D extends DataType> =
  D extends DataType<FloatName> ? DataType<'float64'>
  : D extends DataType<UnsignedName> ? DataType<'uint64'>
  : DataType<'int64'>;

function describe(value: unknown): string {
  // Purpose: name a JS value's kind for error messages
  if (value === null) return 'null';
  if (value instanceof Expr) return 'an expression';
  return typeof value;
}

export function literalNode(value: unknown, type: DataType): IrExpr {
  // Purpose: turn a JS value into a typed literal, rejecting values the type cannot hold
  const fail = function (): never {
    // Purpose: raise the type error for a value that does not fit
    throw new TypeCheckError(`Expected a ${type.name} value, got ${describe(value)} (${String(value)})`);
  };
  if (type.name === 'bool') {
    if (typeof value !== 'boolean') fail();
    return { kind: 'literal', value: value as boolean, type };
  }
  if (isInt(type)) {
    const [lo, hi] = INT_RANGES[type.name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) fail();
    return { kind: 'literal', value: value as number, type };
  }
  if (isBigInt(type)) {
    const [lo, hi] = BIGINT_RANGES[type.name];
    let big: bigint;
    if (typeof value === 'bigint') big = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) big = BigInt(value);
    else return fail();
    if (big < lo || big > hi) fail();
    return { kind: 'literal', value: big, type };
  }
  if (isFloat(type)) {
    if (typeof value !== 'number') fail();
    return { kind: 'literal', value: value as number, type };
  }
  if (isString(type)) {
    if (typeof value !== 'string') fail();
    return { kind: 'literal', value: value as string, type };
  }
  // date32 and timestamp literals: docs/TASKS.md, T-108.
  throw new TypeCheckError(`Literals of type ${type.name} are not supported yet`);
}

export function callNode(fn: string, args: readonly IrExpr[]): IrExpr {
  // Purpose: build a type-checked function call node
  const type = lookup(fn).returns(
    args.map(function (a) {
      return a.type;
    }),
  );
  return { kind: 'call', fn, args, type };
}

function operand(value: unknown, type: DataType): IrExpr {
  // Purpose: accept either an expression or a JS literal as an argument
  return value instanceof Expr ? value.node : literalNode(value, type);
}

export class Expr<D extends DataType = DataType> {
  readonly node: IrExpr;

  constructor(node: IrExpr) {
    // Purpose: wrap an IR expression in the DSL
    this.node = node;
  }

  get type(): D {
    // Purpose: the expression's data type
    return this.node.type as D;
  }

  eq(other: Operand<D>): BoolExpr {
    // Purpose: equality; null if either side is null
    return new BoolExpr(callNode('eq', [this.node, operand(other, this.node.type)]));
  }

  neq(other: Operand<D>): BoolExpr {
    // Purpose: inequality; null if either side is null
    return new BoolExpr(callNode('neq', [this.node, operand(other, this.node.type)]));
  }

  isNull(): BoolExpr {
    // Purpose: true where the value is null; never null itself
    return new BoolExpr(callNode('is_null', [this.node]));
  }

  count(): AggExpr<DataType<'uint32'>> {
    // Purpose: aggregate counting the non-null values of this expression
    return new AggExpr('count', this.node);
  }

  [Symbol.toPrimitive](): never {
    // Purpose: fail loudly when an expression is used with a JS operator
    throw new ExpressionError(
      'A zamda expression was used with a JavaScript operator (+, >, ==, a template string). ' +
        'Use methods instead: .add(), .gt(), .eq(), .and().',
    );
  }
}

export class BoolExpr extends Expr<Bool> {
  and(other: BoolExpr | boolean): BoolExpr {
    // Purpose: three-valued logical AND
    return new BoolExpr(callNode('and', [this.node, operand(other, this.node.type)]));
  }

  or(other: BoolExpr | boolean): BoolExpr {
    // Purpose: three-valued logical OR
    return new BoolExpr(callNode('or', [this.node, operand(other, this.node.type)]));
  }

  not(): BoolExpr {
    // Purpose: logical NOT; null stays null
    return new BoolExpr(callNode('not', [this.node]));
  }
}

// Types with an ordering: numbers, strings, dates and timestamps.
export class OrdExpr<D extends DataType = DataType> extends Expr<D> {
  lt(other: Operand<D>): BoolExpr {
    // Purpose: less than
    return new BoolExpr(callNode('lt', [this.node, operand(other, this.node.type)]));
  }

  lte(other: Operand<D>): BoolExpr {
    // Purpose: less than or equal
    return new BoolExpr(callNode('lte', [this.node, operand(other, this.node.type)]));
  }

  gt(other: Operand<D>): BoolExpr {
    // Purpose: greater than
    return new BoolExpr(callNode('gt', [this.node, operand(other, this.node.type)]));
  }

  gte(other: Operand<D>): BoolExpr {
    // Purpose: greater than or equal
    return new BoolExpr(callNode('gte', [this.node, operand(other, this.node.type)]));
  }

  between(low: Operand<D>, high: Operand<D>): BoolExpr {
    // Purpose: inclusive range test; sugar for gte(low).and(lte(high))
    return this.gte(low).and(this.lte(high));
  }

  asc(): SortKey {
    // Purpose: ascending sort key, nulls last
    return new SortKey({ expr: this.node, descending: false, nullsFirst: false });
  }

  desc(): SortKey {
    // Purpose: descending sort key, nulls last
    return new SortKey({ expr: this.node, descending: true, nullsFirst: false });
  }

  min(): AggExpr<D> {
    // Purpose: aggregate minimum, skipping nulls
    return new AggExpr('min', this.node);
  }

  max(): AggExpr<D> {
    // Purpose: aggregate maximum, skipping nulls
    return new AggExpr('max', this.node);
  }
}

export class NumExpr<D extends DataType<NumericName> = DataType<NumericName>> extends OrdExpr<D> {
  add(other: Operand<D>): NumExpr<D> {
    // Purpose: checked addition
    return new NumExpr(callNode('add', [this.node, operand(other, this.node.type)]));
  }

  sub(other: Operand<D>): NumExpr<D> {
    // Purpose: checked subtraction
    return new NumExpr(callNode('sub', [this.node, operand(other, this.node.type)]));
  }

  mul(other: Operand<D>): NumExpr<D> {
    // Purpose: checked multiplication
    return new NumExpr(callNode('mul', [this.node, operand(other, this.node.type)]));
  }

  sum(): AggExpr<SumType<D>> {
    // Purpose: aggregate sum, skipping nulls
    return new AggExpr('sum', this.node);
  }

  avg(): AggExpr<DataType<'float64'>> {
    // Purpose: aggregate mean, skipping nulls
    return new AggExpr('avg', this.node);
  }
}

// String functions (lower, upper, contains, ...) are added in docs/TASKS.md, T-105.
export class StrExpr<D extends DataType<StringName> = DataType<StringName>> extends OrdExpr<D> {}

export class AggExpr<D extends DataType = DataType> {
  readonly agg: IrAggregate;

  constructor(fn: string, arg: IrExpr | null) {
    // Purpose: build a type-checked aggregate call
    const def = lookup(fn);
    if (def.kind !== 'aggregate') throw new ExpressionError(`${fn} is not an aggregate`);
    this.agg = { fn, arg, type: def.returns(arg ? [arg.type] : []) };
  }

  get type(): D {
    // Purpose: the aggregate's result type
    return this.agg.type as D;
  }
}

export class SortKey {
  readonly key: IrSortKey;

  constructor(key: IrSortKey) {
    // Purpose: hold one sort key and its direction
    this.key = key;
  }

  nullsFirst(): SortKey {
    // Purpose: place nulls before all values for this key
    return new SortKey({ ...this.key, nullsFirst: true });
  }
}

export function wrap<D extends DataType>(node: IrExpr): ExprFor<D> {
  // Purpose: pick the DSL class that matches an IR expression's type
  let expr: Expr;
  if (node.type.name === 'bool') expr = new BoolExpr(node);
  else if (isNumeric(node.type)) expr = new NumExpr(node);
  else if (isString(node.type)) expr = new StrExpr(node);
  else expr = new OrdExpr(node);
  return expr as unknown as ExprFor<D>;
}

export function lit<D extends DataType>(value: JsOf<D>, type: D): ExprFor<D> {
  // Purpose: an explicit typed literal
  return wrap<D>(literalNode(value, type));
}

export function param<D extends DataType>(name: string, type: D): ExprFor<D> {
  // Purpose: a typed placeholder bound at execute() time
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new ExpressionError(`Invalid parameter name "${name}"`);
  }
  return wrap<D>({ kind: 'param', name, type });
}

export function count(): AggExpr<DataType<'uint32'>> {
  // Purpose: aggregate counting rows in each group
  return new AggExpr('count', null);
}
