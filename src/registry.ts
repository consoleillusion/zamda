// The function registry: the single list of functions a plan may name.
// Each entry fixes the type rule, null behaviour and Substrait mapping.
// A function without a Substrait mapping is not admitted (tests enforce this).
//
// Substrait names below are the intended mapping and must be verified against
// the pinned Substrait version when export is built (docs/TASKS.md, T-501).

import { PlanError, TypeCheckError } from './errors';
import type { DataType } from './types';
import { isFloat, isNumeric, isUnsigned, sameType, t } from './types';

export type NullBehaviour =
  // Result is null when any argument is null.
  | 'propagate'
  // Three-valued (Kleene) logic.
  | 'kleene'
  // Result is never null.
  | 'never-null'
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
  // Purpose: require two arguments of the same type (no implicit promotion yet)
  arity(fn, args, 2);
  if (!sameType(args[0]!, args[1]!)) {
    throw new TypeCheckError(
      `${fn} needs two operands of the same type, got (${names(args)}); use cast()`,
    );
  }
}

function equality(fn: string) {
  // Purpose: type rule for eq and neq
  return function (args: readonly DataType[]): DataType {
    sameTypes(fn, args);
    return t.bool;
  };
}

function ordering(fn: string) {
  // Purpose: type rule for lt, lte, gt and gte
  return function (args: readonly DataType[]): DataType {
    sameTypes(fn, args);
    if (args[0]!.name === 'bool') throw new TypeCheckError(`${fn} is not defined for bool`);
    return t.bool;
  };
}

function logical(fn: string, n: number) {
  // Purpose: type rule for and, or and not
  return function (args: readonly DataType[]): DataType {
    arity(fn, args, n);
    for (const a of args) {
      if (a.name !== 'bool') throw new TypeCheckError(`${fn} needs bool operands, got (${names(args)})`);
    }
    return t.bool;
  };
}

function arithmetic(fn: string) {
  // Purpose: type rule for add, sub and mul
  return function (args: readonly DataType[]): DataType {
    sameTypes(fn, args);
    if (!isNumeric(args[0]!)) throw new TypeCheckError(`${fn} needs numeric operands, got (${names(args)})`);
    return args[0]!;
  };
}

function numericArg(fn: string, args: readonly DataType[]): DataType {
  // Purpose: require exactly one numeric argument and return its type
  arity(fn, args, 1);
  if (!isNumeric(args[0]!)) throw new TypeCheckError(`${fn} needs a numeric column, got ${names(args)}`);
  return args[0]!;
}

const defs: FunctionDef[] = [
  // --- scalar ---
  { name: 'eq', kind: 'scalar', substrait: 'functions_comparison:equal', nulls: 'propagate', deterministic: true, returns: equality('eq') },
  { name: 'neq', kind: 'scalar', substrait: 'functions_comparison:not_equal', nulls: 'propagate', deterministic: true, returns: equality('neq') },
  { name: 'lt', kind: 'scalar', substrait: 'functions_comparison:lt', nulls: 'propagate', deterministic: true, returns: ordering('lt') },
  { name: 'lte', kind: 'scalar', substrait: 'functions_comparison:lte', nulls: 'propagate', deterministic: true, returns: ordering('lte') },
  { name: 'gt', kind: 'scalar', substrait: 'functions_comparison:gt', nulls: 'propagate', deterministic: true, returns: ordering('gt') },
  { name: 'gte', kind: 'scalar', substrait: 'functions_comparison:gte', nulls: 'propagate', deterministic: true, returns: ordering('gte') },
  {
    name: 'is_null', kind: 'scalar', substrait: 'functions_comparison:is_null', nulls: 'never-null', deterministic: true,
    returns: function (args) {
      arity('is_null', args, 1);
      return t.bool;
    },
  },
  { name: 'and', kind: 'scalar', substrait: 'functions_boolean:and', nulls: 'kleene', deterministic: true, returns: logical('and', 2) },
  { name: 'or', kind: 'scalar', substrait: 'functions_boolean:or', nulls: 'kleene', deterministic: true, returns: logical('or', 2) },
  { name: 'not', kind: 'scalar', substrait: 'functions_boolean:not', nulls: 'propagate', deterministic: true, returns: logical('not', 1) },
  { name: 'add', kind: 'scalar', substrait: 'functions_arithmetic:add', nulls: 'propagate', deterministic: true, returns: arithmetic('add') },
  { name: 'sub', kind: 'scalar', substrait: 'functions_arithmetic:subtract', nulls: 'propagate', deterministic: true, returns: arithmetic('sub') },
  { name: 'mul', kind: 'scalar', substrait: 'functions_arithmetic:multiply', nulls: 'propagate', deterministic: true, returns: arithmetic('mul') },

  // --- aggregate ---
  {
    // Row count, or count of non-null values when given a column.
    // uint32 so results are plain JS numbers (docs/DECISIONS.md, D-006).
    name: 'count', kind: 'aggregate', substrait: 'functions_aggregate_generic:count', nulls: 'never-null', deterministic: true,
    returns: function (args) {
      if (args.length > 1) throw new TypeCheckError('count takes at most one argument');
      return t.uint32;
    },
  },
  {
    name: 'sum', kind: 'aggregate', substrait: 'functions_arithmetic:sum', nulls: 'skip', deterministic: true,
    returns: function (args) {
      const arg = numericArg('sum', args);
      if (isFloat(arg)) return t.float64;
      return isUnsigned(arg) ? t.uint64 : t.int64;
    },
  },
  {
    name: 'avg', kind: 'aggregate', substrait: 'functions_arithmetic:avg', nulls: 'skip', deterministic: true,
    returns: function (args) {
      numericArg('avg', args);
      return t.float64;
    },
  },
  {
    name: 'min', kind: 'aggregate', substrait: 'functions_arithmetic:min', nulls: 'skip', deterministic: true,
    returns: function (args) {
      arity('min', args, 1);
      return args[0]!;
    },
  },
  {
    name: 'max', kind: 'aggregate', substrait: 'functions_arithmetic:max', nulls: 'skip', deterministic: true,
    returns: function (args) {
      arity('max', args, 1);
      return args[0]!;
    },
  },
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
