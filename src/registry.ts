// The function registry: the single list of functions a plan may name.
// Each entry fixes the type rule, null behaviour and Substrait mapping.
// A function without a Substrait mapping is not admitted (tests enforce this).
//
// Substrait names below are the intended mapping and must be verified against
// the pinned Substrait version when export is built (docs/TASKS.md, T-501).
//
// Binary numeric functions take operands of the SAME type: promotion
// (C-PROMOTION) is resolved in the DSL by inserting casts, so kernels and other
// backends never see mixed operand types.

import { PlanError, TypeCheckError } from './errors';
import type { DataType } from './types';
import { isFloat, isInteger, isNumeric, isString, isTemporal, isUnsigned, sameType, t } from './types';

export type NullBehaviour =
  // Result is null when any argument is null.
  | 'propagate'
  // Three-valued (Kleene) logic.
  | 'kleene'
  // Result is never null.
  | 'never-null'
  // Null handling is specific to the function; see its contract rule.
  | 'custom'
  // Aggregate that skips null inputs.
  | 'skip';

export interface FunctionDef {
  readonly name: string;
  readonly kind: 'scalar' | 'aggregate';
  readonly substrait: string;
  readonly nulls: NullBehaviour;
  readonly deterministic: boolean;
  // Returns the result type, or throws TypeCheckError for bad argument types.
  readonly returns: (args: readonly DataType[]) => DataType;
}

type Rule = (args: readonly DataType[]) => DataType;

function names(args: readonly DataType[]): string {
  // Purpose: format argument types for error messages
  return args
    .map(function (a) {
      return a.name;
    })
    .join(', ');
}

function arity(fn: string, args: readonly DataType[], n: number): void {
  // Purpose: check an argument count
  if (args.length !== n) {
    throw new TypeCheckError(`${fn} takes ${n} argument(s), got ${args.length}`);
  }
}

function sameTypes(fn: string, args: readonly DataType[]): void {
  // Purpose: require two arguments of the same type
  arity(fn, args, 2);
  if (!sameType(args[0]!, args[1]!)) {
    throw new TypeCheckError(`${fn} needs two operands of the same type, got (${names(args)})`);
  }
}

function fail(fn: string, need: string, args: readonly DataType[]): never {
  // Purpose: raise the standard "wrong operand type" error
  throw new TypeCheckError(`${fn} needs ${need}, got (${names(args)})`);
}

function equality(fn: string): Rule {
  // Purpose: type rule for eq and neq
  return function (args) {
    sameTypes(fn, args);
    return t.bool;
  };
}

function ordering(fn: string): Rule {
  // Purpose: type rule for lt, lte, gt and gte
  return function (args) {
    sameTypes(fn, args);
    if (args[0]!.name === 'bool') fail(fn, 'ordered operands', args);
    return t.bool;
  };
}

function logical(fn: string, n: number): Rule {
  // Purpose: type rule for and, or and not
  return function (args) {
    arity(fn, args, n);
    for (const a of args) if (a.name !== 'bool') fail(fn, 'bool operands', args);
    return t.bool;
  };
}

function binaryNumeric(fn: string, accept: (type: DataType) => boolean, need: string): Rule {
  // Purpose: type rule for a binary function that returns its operand type
  return function (args) {
    sameTypes(fn, args);
    if (!accept(args[0]!)) fail(fn, need, args);
    return args[0]!;
  };
}

function unary(fn: string, accept: (type: DataType) => boolean, need: string, result?: DataType): Rule {
  // Purpose: type rule for a unary function; returns `result` or the operand type
  return function (args) {
    arity(fn, args, 1);
    if (!accept(args[0]!)) fail(fn, need, args);
    return result ?? args[0]!;
  };
}

function isSigned(type: DataType): boolean {
  // Purpose: true for numeric types that can hold negative values
  return isNumeric(type) && !isUnsigned(type);
}

function stringPair(fn: string): Rule {
  // Purpose: type rule for starts_with, ends_with and contains
  return function (args) {
    sameTypes(fn, args);
    if (!isString(args[0]!)) fail(fn, 'string operands', args);
    return t.bool;
  };
}

function temporal(fn: string, result: DataType | null): Rule {
  // Purpose: type rule for (unit, date or timestamp) functions
  return function (args) {
    arity(fn, args, 2);
    if (args[0]!.name !== 'utf8' || !isTemporal(args[1]!)) fail(fn, 'a unit and a date or timestamp', args);
    return result ?? args[1]!;
  };
}

function scalar(name: string, substrait: string, nulls: NullBehaviour, returns: Rule): FunctionDef {
  // Purpose: build a scalar function definition
  return { name, kind: 'scalar', substrait, nulls, deterministic: true, returns };
}

function agg(name: string, substrait: string, nulls: NullBehaviour, returns: Rule): FunctionDef {
  // Purpose: build an aggregate function definition
  return { name, kind: 'aggregate', substrait, nulls, deterministic: true, returns };
}

const defs: FunctionDef[] = [
  // --- comparison ---
  scalar('eq', 'functions_comparison:equal', 'propagate', equality('eq')),
  scalar('neq', 'functions_comparison:not_equal', 'propagate', equality('neq')),
  scalar('lt', 'functions_comparison:lt', 'propagate', ordering('lt')),
  scalar('lte', 'functions_comparison:lte', 'propagate', ordering('lte')),
  scalar('gt', 'functions_comparison:gt', 'propagate', ordering('gt')),
  scalar('gte', 'functions_comparison:gte', 'propagate', ordering('gte')),
  scalar('is_null', 'functions_comparison:is_null', 'never-null', function (args) {
    arity('is_null', args, 1);
    return t.bool;
  }),
  scalar('is_nan', 'functions_comparison:is_nan', 'propagate', unary('is_nan', isFloat, 'a float operand', t.bool)),
  scalar('coalesce', 'functions_comparison:coalesce', 'custom', function (args) {
    sameTypes('coalesce', args);
    return args[0]!;
  }),
  // Substrait: the IfThen expression, not a function.
  scalar('if_else', 'expression:if_then', 'custom', function (args) {
    arity('if_else', args, 3);
    if (args[0]!.name !== 'bool' || !sameType(args[1]!, args[2]!)) {
      fail('if_else', 'a bool condition and two branches of the same type', args);
    }
    return args[1]!;
  }),

  // --- logic ---
  scalar('and', 'functions_boolean:and', 'kleene', logical('and', 2)),
  scalar('or', 'functions_boolean:or', 'kleene', logical('or', 2)),
  scalar('not', 'functions_boolean:not', 'propagate', logical('not', 1)),

  // --- arithmetic ---
  scalar('add', 'functions_arithmetic:add', 'propagate', binaryNumeric('add', isNumeric, 'numeric operands')),
  scalar('sub', 'functions_arithmetic:subtract', 'propagate', binaryNumeric('sub', isNumeric, 'numeric operands')),
  scalar('mul', 'functions_arithmetic:multiply', 'propagate', binaryNumeric('mul', isNumeric, 'numeric operands')),
  // Substrait: the same functions with overflow: SILENT.
  scalar('wrapping_add', 'functions_arithmetic:add', 'propagate', binaryNumeric('wrapping_add', isInteger, 'integer operands')),
  scalar('wrapping_sub', 'functions_arithmetic:subtract', 'propagate', binaryNumeric('wrapping_sub', isInteger, 'integer operands')),
  scalar('wrapping_mul', 'functions_arithmetic:multiply', 'propagate', binaryNumeric('wrapping_mul', isInteger, 'integer operands')),
  scalar('div', 'functions_arithmetic:divide', 'propagate', function (args) {
    sameTypes('div', args);
    if (!isNumeric(args[0]!)) fail('div', 'numeric operands', args);
    // C-DIV: integer division yields float64.
    return isFloat(args[0]!) ? args[0]! : t.float64;
  }),
  scalar('int_div', 'functions_arithmetic:divide', 'propagate', binaryNumeric('int_div', isInteger, 'integer operands')),
  scalar('mod', 'functions_arithmetic:modulus', 'propagate', binaryNumeric('mod', isNumeric, 'numeric operands')),
  scalar('neg', 'functions_arithmetic:negate', 'propagate', unary('neg', isSigned, 'a signed numeric operand')),
  scalar('abs', 'functions_arithmetic:abs', 'propagate', unary('abs', isNumeric, 'a numeric operand')),
  scalar('floor', 'functions_rounding:floor', 'propagate', unary('floor', isFloat, 'a float operand')),
  scalar('ceil', 'functions_rounding:ceil', 'propagate', unary('ceil', isFloat, 'a float operand')),
  scalar('round', 'functions_rounding:round', 'propagate', unary('round', isFloat, 'a float operand')),

  // --- string ---
  // lower and upper return utf8 even for dictionary input: mapping can merge entries.
  scalar('lower', 'functions_string:lower', 'propagate', unary('lower', isString, 'a string operand', t.utf8)),
  scalar('upper', 'functions_string:upper', 'propagate', unary('upper', isString, 'a string operand', t.utf8)),
  scalar('length', 'functions_string:char_length', 'propagate', unary('length', isString, 'a string operand', t.int32)),
  scalar('starts_with', 'functions_string:starts_with', 'propagate', stringPair('starts_with')),
  scalar('ends_with', 'functions_string:ends_with', 'propagate', stringPair('ends_with')),
  scalar('contains', 'functions_string:contains', 'propagate', stringPair('contains')),

  // --- date and time: first argument is the unit, as a utf8 literal ---
  scalar('date_trunc', 'functions_datetime:round_temporal', 'propagate', temporal('date_trunc', null)),
  scalar('extract', 'functions_datetime:extract', 'propagate', temporal('extract', t.int32)),

  // --- aggregate ---
  // Row count, or count of non-null values when given a column.
  // uint32 so results are plain JS numbers (docs/DECISIONS.md, D-006).
  agg('count', 'functions_aggregate_generic:count', 'never-null', function (args) {
    if (args.length > 1) throw new TypeCheckError('count takes at most one argument');
    return t.uint32;
  }),
  // Substrait expresses this as count with a DISTINCT invocation.
  agg('count_distinct', 'functions_aggregate_generic:count', 'skip', function (args) {
    arity('count_distinct', args, 1);
    return t.uint32;
  }),
  agg('sum', 'functions_arithmetic:sum', 'skip', function (args) {
    arity('sum', args, 1);
    const arg = args[0]!;
    if (!isNumeric(arg)) fail('sum', 'a numeric column', args);
    if (isFloat(arg)) return t.float64;
    return isUnsigned(arg) ? t.uint64 : t.int64;
  }),
  agg('avg', 'functions_arithmetic:avg', 'skip', unary('avg', isNumeric, 'a numeric column', t.float64)),
  agg('min', 'functions_arithmetic:min', 'skip', function (args) {
    arity('min', args, 1);
    if (args[0]!.name === 'bool') fail('min', 'an ordered column', args);
    return args[0]!;
  }),
  agg('max', 'functions_arithmetic:max', 'skip', function (args) {
    arity('max', args, 1);
    if (args[0]!.name === 'bool') fail('max', 'an ordered column', args);
    return args[0]!;
  }),
];

export const REGISTRY: ReadonlyMap<string, FunctionDef> = new Map(
  defs.map(function (d) {
    return [d.name, d] as const;
  }),
);

export function lookup(name: string): FunctionDef {
  // Purpose: fetch a function definition, rejecting names outside the registry
  const def = REGISTRY.get(name);
  if (!def) throw new PlanError(`Unknown function "${name}"`);
  return def;
}

export function canCast(from: DataType, to: DataType): boolean {
  // Purpose: C-CAST: casts are defined between numeric types only
  return isNumeric(from) && isNumeric(to);
}
