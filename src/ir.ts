// The intermediate representation (IR): the one format every backend consumes.
// It is a flat node table; nodes refer to their input by index, and expressions
// refer to columns by index into that input's schema. See docs/IR.md.
//
// Rule: every node and every function must map 1:1 to Substrait. A feature that
// cannot be mapped does not enter the IR.

import type { Field } from './schema';
import type { DataType } from './types';

export const IR_VERSION = 2;

// Dates are stored as numbers: days (date32) or milliseconds (timestamp).
export type LiteralValue = boolean | number | bigint | string;

export type IrExpr =
  | { readonly kind: 'field'; readonly index: number; readonly type: DataType }
  | { readonly kind: 'literal'; readonly value: LiteralValue; readonly type: DataType }
  | { readonly kind: 'param'; readonly name: string; readonly type: DataType }
  | {
      readonly kind: 'call';
      readonly fn: string;
      readonly args: readonly IrExpr[];
      readonly type: DataType;
    }
  // Substrait: Cast expression.
  | { readonly kind: 'cast'; readonly arg: IrExpr; readonly type: DataType }
  // Substrait: SingularOrList. Exactly one of `values` and `param` is set.
  | {
      readonly kind: 'in';
      readonly arg: IrExpr;
      readonly values: readonly LiteralValue[] | null;
      readonly param: string | null;
      readonly type: DataType;
    };

export interface IrAggregate {
  readonly fn: string;
  // null for a row count.
  readonly arg: IrExpr | null;
  readonly type: DataType;
}

export interface IrSortKey {
  readonly expr: IrExpr;
  readonly descending: boolean;
  readonly nullsFirst: boolean;
}

// Substrait JoinRel.JoinType, restricted to the four kinds with a contract rule.
export type JoinKind = 'inner' | 'left' | 'right' | 'full';

// Substrait ConsistentPartitionWindowRel functions, restricted to those whose
// value depends only on the partition and its peer groups.
export type WindowFnName = 'row_number' | 'rank' | 'dense_rank';

export interface IrWindowFunction {
  readonly fn: WindowFnName;
  readonly type: DataType;
}

export interface IrParam {
  readonly name: string;
  readonly type: DataType;
  // True for a list parameter, used by isIn().
  readonly list: boolean;
}

interface NodeBase {
  // Output schema of this node.
  readonly schema: readonly Field[];
}

// Substrait relation for each op: scan=Read, filter=Filter, project=Project,
// aggregate=Aggregate, sort=Sort, limit=Fetch.
export type IrNode =
  | (NodeBase & { readonly op: 'scan' })
  | (NodeBase & { readonly op: 'filter'; readonly input: number; readonly predicate: IrExpr })
  | (NodeBase & { readonly op: 'project'; readonly input: number; readonly exprs: readonly IrExpr[] })
  | (NodeBase & {
      readonly op: 'aggregate';
      readonly input: number;
      readonly keys: readonly IrExpr[];
      readonly aggs: readonly IrAggregate[];
    })
  | (NodeBase & { readonly op: 'sort'; readonly input: number; readonly keys: readonly IrSortKey[] })
  | (NodeBase & { readonly op: 'limit'; readonly input: number; readonly count: number })
  // Substrait: JoinRel. `right` is the index of the second table's scan node;
  // both key lists are column indexes into the left and right inputs.
  | (NodeBase & {
      readonly op: 'join';
      readonly input: number;
      readonly right: number;
      readonly leftKeys: readonly number[];
      readonly rightKeys: readonly number[];
      readonly how: JoinKind;
    })
  // Substrait: ConsistentPartitionWindowRel. Output is the input columns plus
  // one int64 column per function, named by the trailing entries of schema.
  | (NodeBase & {
      readonly op: 'window';
      readonly input: number;
      readonly partitions: readonly IrExpr[];
      readonly sorts: readonly IrSortKey[];
      readonly functions: readonly IrWindowFunction[];
    });

export interface IrPlan {
  readonly version: number;
  readonly input: readonly Field[];
  readonly nodes: readonly IrNode[];
  // Index of the node whose output is the plan's result.
  readonly root: number;
  readonly output: readonly Field[];
  readonly params: readonly IrParam[];
}

export function walkExpr(expr: IrExpr, visit: (e: IrExpr) => void): void {
  // Purpose: visit an expression and all of its sub-expressions, parents first
  visit(expr);
  if (expr.kind === 'call') {
    for (const arg of expr.args) walkExpr(arg, visit);
  } else if (expr.kind === 'cast' || expr.kind === 'in') {
    walkExpr(expr.arg, visit);
  }
}

export function nodeExprs(node: IrNode): IrExpr[] {
  // Purpose: list every expression a node holds, for validators and optimizers
  switch (node.op) {
    case 'scan':
    case 'limit':
      return [];
    case 'filter':
      return [node.predicate];
    case 'project':
      return [...node.exprs];
    case 'aggregate': {
      const out = [...node.keys];
      for (const agg of node.aggs) if (agg.arg) out.push(agg.arg);
      return out;
    }
    case 'sort':
      return node.keys.map(function (k) {
        return k.expr;
      });
    case 'join':
      return [];
    case 'window':
      return [...node.partitions, ...node.sorts.map(function (k) {
        return k.expr;
      })];
  }
}
