// The expression DSL. Each method builds an IR expression and type-checks it
// immediately through the registry, so a mistake throws at the line that made it.
// Expressions never see data.

import { toStorage } from './convert';
import { ExpressionError, TypeCheckError } from './errors';
import type { IrAggregate, IrExpr, IrSortKey, LiteralValue } from './ir';
import { PROMOTION } from './promotion';
import { canCast, lookup } from './registry';
import type {
  DataType,
  FloatName,
  IntegerName,
  JsOf,
  NumericName,
  StringName,
  TemporalName,
  UnsignedName,
} from './types';
import { compatibleTypes, isFloat, isNumeric, isString, isTemporal, sameType, t } from './types';

type Bool = DataType<'bool'>;
type Num = DataType<NumericName>;

// True when D may hold strings. The general Expr<DataType> counts, so a
// specific string expression stays assignable to it (T-211).
type MayBeString<D extends DataType> = [Extract<D['name'], StringName>] extends [never] ? false : true;

// Any string expression is acceptable wherever one string storage type is
// expected. For non-string D this is never, so the old signatures are unchanged.
type MixedStringExpr<D extends DataType> = MayBeString<D> extends true ? Expr<DataType<StringName>> : never;

// The list-parameter counterpart of MixedStringExpr.
type MixedStringList<D extends DataType> = MayBeString<D> extends true ? ListParam<DataType<StringName>> : never;

// A value accepted where an expression of type D is expected.
export type Operand<D extends DataType> = Expr<D> | MixedStringExpr<D> | JsOf<D>;

// The expression class the DSL exposes for a column of type D.
export type ExprFor<D extends DataType> =
  D extends Num ? NumExpr<D>
  : D extends Bool ? BoolExpr
  : D extends DataType<StringName> ? StrExpr<D>
  : D extends DataType<TemporalName> ? TimeExpr<D>
  : OrdExpr<D>;

type PromotedName<A extends NumericName, B extends NumericName> = (typeof PROMOTION)[A][B];

// C-PROMOTION at the type level: the common type of two numeric types.
export type Promoted<A extends Num, B extends Num> =
  PromotedName<A['name'], B['name']> extends infer R ? (R extends NumericName ? DataType<R> : never) : never;

interface CastRequired {
  readonly 'these two types have no common type: use cast()': never;
}

// Makes an argument unassignable when the two types cannot be promoted.
type Compatible<A extends Num, B extends Num> =
  null extends PromotedName<A['name'], B['name']> ? CastRequired : unknown;

// The operand of a binary arithmetic method is unusable when no common type exists.
type Checked<D extends Num, O> = O extends NumExpr<infer E extends Num> ? Compatible<D, E> : unknown;

// Result of add, sub, mul and mod: promoted for an expression operand, unchanged for a literal.
export type Arith<D extends Num, O> =
  O extends NumExpr<infer E extends Num> ? NumExpr<Promoted<D, E>> : NumExpr<D>;

// Result of div.
export type Divided<D extends Num, O> =
  O extends NumExpr<infer E extends Num> ? NumExpr<DivType<Promoted<D, E>>> : NumExpr<DivType<D>>;

// C-DIV: integer division yields float64; float division keeps its type.
export type DivType<D extends Num> = D extends DataType<FloatName> ? D : DataType<'float64'>;

// Result type of sum(): see docs/CONTRACT.md, C-AGG-TYPES.
export type SumType<D extends DataType> =
  D extends DataType<FloatName> ? DataType<'float64'>
  : D extends DataType<UnsignedName> ? DataType<'uint64'>
  : DataType<'int64'>;

export type DateUnit = 'year' | 'month' | 'day';
export type TimeUnit = DateUnit | 'hour' | 'minute' | 'second';
export type UnitFor<D extends DataType> = D extends DataType<'date32'> ? DateUnit : TimeUnit;

const DATE_UNITS: readonly string[] = ['year', 'month', 'day'];
const TIME_UNITS: readonly string[] = [...DATE_UNITS, 'hour', 'minute', 'second'];

function describe(value: unknown): string {
  // Purpose: name a JS value's kind for error messages
  if (value === null) return 'null';
  if (value instanceof Expr) return 'an expression';
  if (value instanceof Date) return 'a Date';
  return typeof value;
}

export function literalValue(value: unknown, type: DataType): LiteralValue {
  // Purpose: check a JS value against a type and return its literal form
  const stored = toStorage(value, type);
  if (stored === undefined) {
    throw new TypeCheckError(`Expected a ${type.name} value, got ${describe(value)} (${String(value)})`);
  }
  return type.name === 'bool' ? stored === 1 : stored;
}

export function literalNode(value: unknown, type: DataType): IrExpr {
  // Purpose: turn a JS value into a typed literal, rejecting values the type cannot hold
  return { kind: 'literal', value: literalValue(value, type), type };
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

export function commonType(a: DataType, b: DataType): DataType {
  // Purpose: C-PROMOTION at runtime: the smallest numeric type that holds both
  const name = PROMOTION[a.name as NumericName][b.name as NumericName];
  if (name === null) {
    throw new TypeCheckError(`${a.name} and ${b.name} have no common type; use cast()`);
  }
  return t[name];
}

function castNode(node: IrExpr, type: DataType): IrExpr {
  // Purpose: wrap a node in a cast unless it already has the target type
  if (sameType(node.type, type)) return node;
  if (!canCast(node.type, type)) {
    throw new TypeCheckError(`Cannot cast ${node.type.name} to ${type.name}`);
  }
  return { kind: 'cast', arg: node, type };
}

function binary(fn: string, left: IrExpr, other: unknown): IrExpr {
  // Purpose: build a binary call; a JS literal takes the left type, two numeric expressions are promoted
  let a = left;
  let b = other instanceof Expr ? other.node : literalNode(other, left.type);
  if (isNumeric(a.type) && isNumeric(b.type) && !sameType(a.type, b.type)) {
    const type = commonType(a.type, b.type);
    a = castNode(a, type);
    b = castNode(b, type);
  }
  return callNode(fn, [a, b]);
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
    return new BoolExpr(binary('eq', this.node, other));
  }

  neq(other: Operand<D>): BoolExpr {
    // Purpose: inequality; null if either side is null
    return new BoolExpr(binary('neq', this.node, other));
  }

  isNull(): BoolExpr {
    // Purpose: true where the value is null; never null itself
    return new BoolExpr(callNode('is_null', [this.node]));
  }

  isIn(values: readonly JsOf<D>[] | ListParam<D> | MixedStringList<D>): BoolExpr {
    // Purpose: C-IN: true where the value equals any list entry; null where the value is null
    if (values instanceof ListParam) {
      if (!compatibleTypes(values.type, this.node.type)) {
        throw new TypeCheckError(
          `isIn: list parameter "${values.name}" is ${values.type.name}, the column is ${this.node.type.name}`,
        );
      }
      return new BoolExpr({ kind: 'in', arg: this.node, values: null, param: values.name, type: t.bool });
    }
    if (!Array.isArray(values)) throw new ExpressionError('isIn: expected an array or a list parameter');
    const type = this.node.type;
    const list = values.map(function (v) {
      return literalValue(v, type);
    });
    return new BoolExpr({ kind: 'in', arg: this.node, values: list, param: null, type: t.bool });
  }

  coalesce(other: Operand<D>): this {
    // Purpose: this value, or `other` where this value is null
    return wrap<D>(binary('coalesce', this.node, other)) as unknown as this;
  }

  count(): AggExpr<DataType<'uint32'>> {
    // Purpose: aggregate counting the non-null values of this expression
    return new AggExpr('count', this.node);
  }

  countDistinct(): AggExpr<DataType<'uint32'>> {
    // Purpose: aggregate counting the distinct non-null values of this expression
    return new AggExpr('count_distinct', this.node);
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
    return new BoolExpr(binary('and', this.node, other));
  }

  or(other: BoolExpr | boolean): BoolExpr {
    // Purpose: three-valued logical OR
    return new BoolExpr(binary('or', this.node, other));
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
    return new BoolExpr(binary('lt', this.node, other));
  }

  lte(other: Operand<D>): BoolExpr {
    // Purpose: less than or equal
    return new BoolExpr(binary('lte', this.node, other));
  }

  gt(other: Operand<D>): BoolExpr {
    // Purpose: greater than
    return new BoolExpr(binary('gt', this.node, other));
  }

  gte(other: Operand<D>): BoolExpr {
    // Purpose: greater than or equal
    return new BoolExpr(binary('gte', this.node, other));
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

export class NumExpr<D extends Num = Num> extends OrdExpr<D> {
  // Comparisons accept any numeric expression; operands are promoted (C-PROMOTION).
  override eq(other: Operand<D> | NumExpr): BoolExpr {
    // Purpose: equality with numeric promotion
    return new BoolExpr(binary('eq', this.node, other));
  }

  override neq(other: Operand<D> | NumExpr): BoolExpr {
    // Purpose: inequality with numeric promotion
    return new BoolExpr(binary('neq', this.node, other));
  }

  override lt(other: Operand<D> | NumExpr): BoolExpr {
    // Purpose: less than, with numeric promotion
    return new BoolExpr(binary('lt', this.node, other));
  }

  override lte(other: Operand<D> | NumExpr): BoolExpr {
    // Purpose: less than or equal, with numeric promotion
    return new BoolExpr(binary('lte', this.node, other));
  }

  override gt(other: Operand<D> | NumExpr): BoolExpr {
    // Purpose: greater than, with numeric promotion
    return new BoolExpr(binary('gt', this.node, other));
  }

  override gte(other: Operand<D> | NumExpr): BoolExpr {
    // Purpose: greater than or equal, with numeric promotion
    return new BoolExpr(binary('gte', this.node, other));
  }

  add<O extends JsOf<D> | NumExpr>(other: O & Checked<D, O>): Arith<D, O> {
    // Purpose: checked addition
    return new NumExpr(binary('add', this.node, other)) as unknown as Arith<D, O>;
  }

  sub<O extends JsOf<D> | NumExpr>(other: O & Checked<D, O>): Arith<D, O> {
    // Purpose: checked subtraction
    return new NumExpr(binary('sub', this.node, other)) as unknown as Arith<D, O>;
  }

  mul<O extends JsOf<D> | NumExpr>(other: O & Checked<D, O>): Arith<D, O> {
    // Purpose: checked multiplication
    return new NumExpr(binary('mul', this.node, other)) as unknown as Arith<D, O>;
  }

  div<O extends JsOf<D> | NumExpr>(other: O & Checked<D, O>): Divided<D, O> {
    // Purpose: C-DIV: division; integers yield float64, and integer divide by zero raises
    return new NumExpr(binary('div', this.node, other)) as unknown as Divided<D, O>;
  }

  mod<O extends JsOf<D> | NumExpr>(other: O & Checked<D, O>): Arith<D, O> {
    // Purpose: remainder with the sign of the dividend; integer modulo zero raises
    return new NumExpr(binary('mod', this.node, other)) as unknown as Arith<D, O>;
  }

  intDiv(this: NumExpr<DataType<IntegerName>>, other: Operand<D>): NumExpr<D> {
    // Purpose: integer division truncating toward zero; divide by zero raises
    return new NumExpr(binary('int_div', this.node, other));
  }

  wrappingAdd(this: NumExpr<DataType<IntegerName>>, other: Operand<D>): NumExpr<D> {
    // Purpose: integer addition that wraps on overflow instead of raising
    return new NumExpr(binary('wrapping_add', this.node, other));
  }

  wrappingSub(this: NumExpr<DataType<IntegerName>>, other: Operand<D>): NumExpr<D> {
    // Purpose: integer subtraction that wraps on overflow instead of raising
    return new NumExpr(binary('wrapping_sub', this.node, other));
  }

  wrappingMul(this: NumExpr<DataType<IntegerName>>, other: Operand<D>): NumExpr<D> {
    // Purpose: integer multiplication that wraps on overflow instead of raising
    return new NumExpr(binary('wrapping_mul', this.node, other));
  }

  neg(): NumExpr<D> {
    // Purpose: checked negation; not defined for unsigned types
    return new NumExpr(callNode('neg', [this.node]));
  }

  abs(): NumExpr<D> {
    // Purpose: checked absolute value
    return new NumExpr(callNode('abs', [this.node]));
  }

  floor(this: NumExpr<DataType<FloatName>>): NumExpr<D> {
    // Purpose: round toward negative infinity
    return new NumExpr(callNode('floor', [this.node]));
  }

  ceil(this: NumExpr<DataType<FloatName>>): NumExpr<D> {
    // Purpose: round toward positive infinity
    return new NumExpr(callNode('ceil', [this.node]));
  }

  round(this: NumExpr<DataType<FloatName>>): NumExpr<D> {
    // Purpose: C-ROUND: round to the nearest integer, ties to even
    return new NumExpr(callNode('round', [this.node]));
  }

  isNaN(this: NumExpr<DataType<FloatName>>): BoolExpr {
    // Purpose: true where a float value is NaN
    return new BoolExpr(callNode('is_nan', [this.node]));
  }

  cast<T extends Num>(type: T): NumExpr<T> {
    // Purpose: C-CAST: checked conversion to another numeric type
    return new NumExpr(castNode(this.node, type));
  }

  bin(width: JsOf<D>, origin?: JsOf<D>): NumExpr<D> {
    // Purpose: C-BIN: the lower edge of the bin [origin + k*width, origin + (k+1)*width) holding the value
    const type = this.node.type;
    const zero = literalNode(0, type);
    const w = literalNode(width, type);
    const o = origin === undefined ? zero : literalNode(origin, type);
    if (w.kind === 'literal' && !((w.value as number | bigint) > 0)) {
      throw new ExpressionError('bin: width must be greater than zero');
    }
    const shifted = callNode('sub', [this.node, o]);
    if (isFloat(type)) {
      const k = callNode('floor', [callNode('div', [shifted, w])]);
      return new NumExpr(callNode('add', [callNode('mul', [k, w]), o]));
    }
    // Integers: value minus the floored remainder, built from mod and if_else.
    const m = callNode('mod', [shifted, w]);
    const floored = callNode('if_else', [callNode('lt', [m, zero]), callNode('add', [m, w]), m]);
    return new NumExpr(callNode('sub', [this.node, floored]));
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

export class StrExpr<D extends DataType<StringName> = DataType<StringName>> extends OrdExpr<D> {
  lower(): StrExpr<DataType<'utf8'>> {
    // Purpose: C-STR-CASE: locale-independent lower case
    return new StrExpr(callNode('lower', [this.node]));
  }

  upper(): StrExpr<DataType<'utf8'>> {
    // Purpose: C-STR-CASE: locale-independent upper case
    return new StrExpr(callNode('upper', [this.node]));
  }

  length(): NumExpr<DataType<'int32'>> {
    // Purpose: C-STR-LENGTH: length in Unicode code points
    return new NumExpr(callNode('length', [this.node]));
  }

  startsWith(other: Operand<D>): BoolExpr {
    // Purpose: true where the string starts with `other`
    return new BoolExpr(binary('starts_with', this.node, other));
  }

  endsWith(other: Operand<D>): BoolExpr {
    // Purpose: true where the string ends with `other`
    return new BoolExpr(binary('ends_with', this.node, other));
  }

  contains(other: Operand<D>): BoolExpr {
    // Purpose: true where the string contains `other` as a literal substring
    return new BoolExpr(binary('contains', this.node, other));
  }
}

function unitNode(unit: string, type: DataType, where: string): IrExpr {
  // Purpose: validate a date or time unit and return it as a utf8 literal
  const allowed = type.name === 'date32' ? DATE_UNITS : TIME_UNITS;
  if (!allowed.includes(unit)) {
    throw new ExpressionError(`${where}: unit "${unit}" is not valid for ${type.name}; use ${allowed.join(', ')}`);
  }
  return { kind: 'literal', value: unit, type: t.utf8 };
}

export class TimeExpr<D extends DataType<TemporalName> = DataType<TemporalName>> extends OrdExpr<D> {
  dateTrunc(unit: UnitFor<D>): TimeExpr<D> {
    // Purpose: C-TIME: round down to the start of the unit, in UTC
    return new TimeExpr(callNode('date_trunc', [unitNode(unit, this.node.type, 'dateTrunc'), this.node]));
  }

  extract(unit: UnitFor<D>): NumExpr<DataType<'int32'>> {
    // Purpose: C-TIME: one calendar field of the value, in UTC; month and day start at 1
    return new NumExpr(callNode('extract', [unitNode(unit, this.node.type, 'extract'), this.node]));
  }
}

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

// A declared list parameter, usable only in isIn().
export class ListParam<D extends DataType = DataType> {
  readonly name: string;
  readonly type: D;

  constructor(name: string, type: D) {
    // Purpose: hold a list parameter's name and element type
    this.name = name;
    this.type = type;
  }
}

export function wrap<D extends DataType>(node: IrExpr): ExprFor<D> {
  // Purpose: pick the DSL class that matches an IR expression's type
  let expr: Expr;
  if (node.type.name === 'bool') expr = new BoolExpr(node);
  else if (isNumeric(node.type)) expr = new NumExpr(node);
  else if (isString(node.type)) expr = new StrExpr(node);
  else if (isTemporal(node.type)) expr = new TimeExpr(node);
  else expr = new OrdExpr(node);
  return expr as unknown as ExprFor<D>;
}

export function lit<D extends DataType>(value: JsOf<D>, type: D): ExprFor<D> {
  // Purpose: an explicit typed literal
  return wrap<D>(literalNode(value, type));
}

export function paramExpr<D extends DataType>(name: string, type: D): ExprFor<D> {
  // Purpose: the expression for a declared scalar parameter (internal; see pipe())
  return wrap<D>({ kind: 'param', name, type });
}

export function count(): AggExpr<DataType<'uint32'>> {
  // Purpose: aggregate counting rows in each group
  return new AggExpr('count', null);
}

export function ifElse<D extends DataType>(
  condition: BoolExpr,
  whenTrue: Expr<D>,
  otherwise: Operand<D>,
): ExprFor<D> {
  // Purpose: C-IF: `whenTrue` where the condition is true, `otherwise` where it is false or null
  if (!(condition instanceof BoolExpr) || !(whenTrue instanceof Expr)) {
    throw new ExpressionError('ifElse: expected a boolean expression and a value expression');
  }
  const other = otherwise instanceof Expr ? otherwise.node : literalNode(otherwise, whenTrue.node.type);
  return wrap<D>(callNode('if_else', [condition.node, whenTrue.node, other]));
}
