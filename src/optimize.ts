// IR-to-IR optimization passes. They run before validation, so every backend
// benefits and no pass can smuggle an invalid plan through.
//
// Planned, in order (docs/TASKS.md, T-203):
//   1. constant folding
//   2. filter and project fusion
//   3. projection pushdown
//   4. limit pushdown
// A pass must never change results: not the rows or their order, not which
// error is raised, not the output schema, and not which parameters are read.
// Every golden case runs with the passes on and off and compares both answers.
//
// Two rules keep the passes conservative. A rewrite that drops an evaluation
// is only made when the dropped expression cannot fail (it reads no column, or
// uses only total functions), and a rewrite never introduces a literal or
// parameter where the executors' and/or shortcuts would not have seen one.

import type { IrExpr, IrNode, IrPlan, LiteralValue } from './ir';
import { walkExpr } from './ir';

type Field = IrPlan['input'][number];
type Pass = (plan: IrPlan) => IrPlan;
type CompareOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';

const MAX_NODES = 1024;

// Functions that cannot raise for any valid input (C-DETERMINISM and the
// executor's NEVER_FAILS set). The same list decides when an evaluation may be
// dropped or moved past a filter or limit.
const TOTAL_CALLS = new Set([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_nan', 'coalesce', 'if_else', 'and', 'or', 'not',
  'lower', 'upper', 'length', 'starts_with', 'ends_with', 'contains',
]);

// String comparison is by code point, not by JavaScript's UTF-16 order, so
// literal comparisons of strings are left to the backends.
const COMPARABLE_TYPES = new Set([
  'bool', 'int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32', 'int64', 'uint64',
  'float32', 'float64', 'date32', 'timestamp',
]);

// --- expression helpers ---

function literal(value: LiteralValue, type: IrExpr['type']): IrExpr {
  // Purpose: build a typed literal expression
  return { kind: 'literal', value, type };
}

function isTotal(expr: IrExpr): boolean {
  // Purpose: true when evaluating this expression can never raise an error
  switch (expr.kind) {
    case 'field':
    case 'literal':
    case 'param':
      return true;
    case 'cast':
      return false;
    case 'in':
      return isTotal(expr.arg);
    case 'call':
      return TOTAL_CALLS.has(expr.fn) && expr.args.every(isTotal);
  }
}

function originalLiteral(expr: IrExpr): boolean | undefined {
  // Purpose: a boolean literal's value, or undefined for anything else
  return expr.kind === 'literal' && typeof expr.value === 'boolean' ? expr.value : undefined;
}

function substitute(expr: IrExpr, replacements: readonly (IrExpr | undefined)[]): IrExpr | null {
  // Purpose: replace field references with expressions, or give up on a type mismatch
  switch (expr.kind) {
    case 'field': {
      const found = replacements[expr.index];
      return found && found.type.name === expr.type.name ? found : null;
    }
    case 'call': {
      const args: IrExpr[] = [];
      for (const arg of expr.args) {
        const done = substitute(arg, replacements);
        if (done === null) return null;
        args.push(done);
      }
      return { ...expr, args };
    }
    case 'cast': {
      const arg = substitute(expr.arg, replacements);
      return arg === null ? null : { ...expr, arg };
    }
    case 'in': {
      const arg = substitute(expr.arg, replacements);
      return arg === null ? null : { ...expr, arg };
    }
    case 'literal':
    case 'param':
      return expr;
  }
}

function fieldsOf(expr: IrExpr, into: Set<number>): void {
  // Purpose: collect the input columns an expression reads
  walkExpr(expr, function (e) {
    if (e.kind === 'field') into.add(e.index);
  });
}

// --- constant folding ---

function numberCompare(op: CompareOp, a: number, b: number): boolean {
  // Purpose: compare two number literals with IEEE 754 predicate rules (C-NAN-PREDICATE)
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
  }
}

function bigintCompare(op: CompareOp, a: bigint, b: bigint): boolean {
  // Purpose: compare two bigint literals
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
  }
}

function foldCall(fn: string, args: readonly IrExpr[], type: IrExpr['type']): IrExpr | null {
  // Purpose: evaluate a total call over literals; return null when it is not foldable
  const values = args.map(function (a) {
    return (a as Extract<IrExpr, { kind: 'literal' }>).value;
  });
  if (fn === 'is_null' && args.length === 1) return literal(false, type);
  if (fn === 'is_nan' && args.length === 1) {
    return typeof values[0] === 'number' ? literal(Number.isNaN(values[0]), type) : null;
  }
  if (fn === 'not' && args.length === 1) {
    return typeof values[0] === 'boolean' ? literal(!values[0], type) : null;
  }
  // and/or, coalesce and if_else are deliberately absent. The executors
  // evaluate coalesce and if_else eagerly and shortcut only on and/or with a
  // literal or parameter operand; folding them here could drop an argument
  // that the unoptimized plan still evaluates (and that may raise). and/or
  // with an original literal are handled by foldExpr below.
  const op = fn as CompareOp;
  if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
    if (args.length !== 2 || !COMPARABLE_TYPES.has(args[0]!.type.name)) return null;
    const a = values[0]!;
    const b = values[1]!;
    if (typeof a === 'number' && typeof b === 'number') return literal(numberCompare(op, a, b), type);
    if (typeof a === 'bigint' && typeof b === 'bigint') return literal(bigintCompare(op, a, b), type);
    return null;
  }
  return null;
}

function foldExpr(expr: IrExpr): IrExpr {
  // Purpose: fold total calls over literals without changing the executor's shortcuts
  switch (expr.kind) {
    case 'call': {
      if ((expr.fn === 'and' || expr.fn === 'or') && expr.args.length === 2) {
        const decisive = expr.fn === 'or';
        for (const [constant, other] of [[expr.args[0]!, expr.args[1]!], [expr.args[1]!, expr.args[0]!]] as const) {
          const value = originalLiteral(constant);
          if (value !== undefined) return value === decisive ? literal(decisive, expr.type) : foldExpr(other);
        }
      }
      const args = expr.args.map(foldExpr);
      if ((expr.fn === 'and' || expr.fn === 'or') && args.length === 2) {
        const decisive = expr.fn === 'or';
        for (let i = 0; i < 2; i++) {
          const arg = args[i]!;
          // A side that only folded to a deciding constant must not decide here:
          // the executors would still evaluate the other side, and it might fail.
          if (arg.kind === 'literal' && arg.value === decisive && expr.args[i]!.kind !== 'literal') {
            args[i] = expr.args[i]!;
          }
        }
      }
      if (expr.fn !== 'and' && expr.fn !== 'or' && args.every(function (a) {
        return a.kind === 'literal';
      })) {
        const folded = foldCall(expr.fn, args, expr.type);
        if (folded !== null) return folded;
      }
      return { ...expr, args };
    }
    case 'in': {
      const arg = foldExpr(expr.arg);
      if (expr.param === null && expr.values !== null && arg.kind === 'literal') {
        const hit = expr.values.some(function (v) {
          return v === arg.value;
        });
        return literal(hit, expr.type);
      }
      return { ...expr, arg };
    }
    case 'cast':
      return { ...expr, arg: foldExpr(expr.arg) };
    case 'field':
    case 'literal':
    case 'param':
      return expr;
  }
}

function foldNode(node: IrNode): IrNode {
  // Purpose: fold every expression of one node
  switch (node.op) {
    case 'scan':
    case 'limit':
      return node;
    case 'filter':
      return { ...node, predicate: foldExpr(node.predicate) };
    case 'project':
      return { ...node, exprs: node.exprs.map(foldExpr) };
    case 'sort':
      return { ...node, keys: node.keys.map(function (k) {
        return { ...k, expr: foldExpr(k.expr) };
      }) };
    case 'aggregate':
      return { ...node, keys: node.keys.map(foldExpr), aggs: node.aggs.map(function (a) {
        return a.arg === null ? a : { ...a, arg: foldExpr(a.arg) };
      }) };
  }
}

function foldConstants(plan: IrPlan): IrPlan {
  // Purpose: pass 1, replace constant subtrees by literals
  return { ...plan, nodes: plan.nodes.map(foldNode) };
}

// --- chain rewriting ---

function chainOf(plan: IrPlan): IrNode[] {
  // Purpose: the plan's nodes from the scan to the root, or empty if it is not a simple chain
  const chain: IrNode[] = [];
  let at = plan.root;
  for (;;) {
    const node = plan.nodes[at];
    if (!node) return [];
    chain.push(node);
    if (node.op === 'scan') break;
    at = node.input;
  }
  return chain.reverse();
}

function link(chain: readonly IrNode[]): IrNode[] {
  // Purpose: renumber each node's input after nodes were added or removed
  return chain.map(function (node, i) {
    return i === 0 ? node : ({ ...node, input: i - 1 } as IrNode);
  });
}

function rewrite(plan: IrPlan, transform: (chain: readonly IrNode[]) => IrNode[]): IrPlan {
  // Purpose: apply a structural pass to a chain, leaving plans with stray nodes alone
  const chain = chainOf(plan);
  if (chain.length !== plan.nodes.length || chain[0]?.op !== 'scan') return plan;
  const nodes = transform(chain);
  if (nodes.length === 0 || nodes.length > MAX_NODES || nodes[0]?.op !== 'scan') return plan;
  const linked = link(nodes);
  return { ...plan, nodes: linked, root: linked.length - 1 };
}

// --- filter and project fusion ---

function fuseFilterProject(plan: IrPlan): IrPlan {
  // Purpose: pass 2, combine adjacent filters and projects, and move a filter below a safe project
  return rewrite(plan, function (chain) {
    const out: IrNode[] = [];
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i]!;
      const next = chain[i + 1];
      if (node.op === 'filter' && next?.op === 'filter' && isTotal(next.predicate)) {
        out.push({
          op: 'filter',
          input: 0,
          schema: node.schema,
          predicate: { kind: 'call', fn: 'and', args: [node.predicate, next.predicate], type: node.predicate.type },
        });
        i++;
        continue;
      }
      if (
        node.op === 'project' && next?.op === 'project' && node.exprs.every(isTotal) &&
        // A literal or parameter placed directly in an outer and/or would
        // newly trigger the executors' shortcut and could hide an error.
        node.exprs.every(function (e) {
          return e.kind !== 'literal' && e.kind !== 'param';
        })
      ) {
        const exprs = next.exprs.map(function (e) {
          return substitute(e, node.exprs);
        });
        if (exprs.every(function (e) {
          return e !== null;
        })) {
          out.push({ op: 'project', input: 0, schema: next.schema, exprs: exprs as IrExpr[] });
          i++;
          continue;
        }
      }
      if (
        node.op === 'project' && next?.op === 'filter' && node.exprs.every(isTotal) &&
        node.exprs.every(function (e) {
          return e.kind !== 'literal' && e.kind !== 'param';
        })
      ) {
        const predicate = substitute(next.predicate, node.exprs);
        const source = chain[i - 1]?.schema;
        if (predicate !== null && source !== undefined) {
          out.push({ op: 'filter', input: 0, schema: source, predicate });
          out.push({ op: 'project', input: 0, schema: node.schema, exprs: node.exprs });
          i++;
          continue;
        }
      }
      out.push(node);
    }
    return out;
  });
}

// --- projection pushdown ---

function pushDownProjects(plan: IrPlan): IrPlan {
  // Purpose: pass 3, keep only the columns a filter and the following project read
  return rewrite(plan, function (chain) {
    const out: IrNode[] = [];
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i]!;
      const next = chain[i + 1];
      if (node.op === 'filter' && next?.op === 'project' && chain.length < MAX_NODES) {
        const used = new Set<number>();
        fieldsOf(node.predicate, used);
        for (const expr of next.exprs) fieldsOf(expr, used);
        if (used.size < node.schema.length) {
          const indexes = [...used].sort(function (a, b) {
            return a - b;
          });
          const narrowed: Field[] = indexes.map(function (k) {
            const field = node.schema[k]!;
            return { name: field.name, type: field.type };
          });
          const replacements: (IrExpr | undefined)[] = [];
          indexes.forEach(function (oldIndex, newIndex) {
            replacements[oldIndex] = { kind: 'field', index: newIndex, type: node.schema[oldIndex]!.type };
          });
          const predicate = substitute(node.predicate, replacements);
          const exprs = next.exprs.map(function (e) {
            return substitute(e, replacements);
          });
          if (predicate !== null && exprs.every(function (e) {
            return e !== null;
          })) {
            out.push({
              op: 'project',
              input: 0,
              schema: narrowed,
              exprs: indexes.map(function (k) {
                return { kind: 'field', index: k, type: node.schema[k]!.type };
              }),
            });
            out.push({ op: 'filter', input: 0, schema: narrowed, predicate });
            out.push({ op: 'project', input: 0, schema: next.schema, exprs: exprs as IrExpr[] });
            i++;
            continue;
          }
        }
      }
      out.push(node);
    }
    return out;
  });
}

// --- limit pushdown ---

function pushDownLimits(plan: IrPlan): IrPlan {
  // Purpose: pass 4, combine adjacent limits and move a limit below a safe project
  return rewrite(plan, function (chain) {
    const out: IrNode[] = [];
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i]!;
      const next = chain[i + 1];
      if (node.op === 'limit' && next?.op === 'limit') {
        out.push({ op: 'limit', input: 0, schema: node.schema, count: Math.min(node.count, next.count) });
        i++;
        continue;
      }
      if (node.op === 'project' && next?.op === 'limit' && node.exprs.every(isTotal)) {
        const source = chain[i - 1]?.schema;
        if (source !== undefined) {
          out.push({ op: 'limit', input: 0, schema: source, count: next.count });
          out.push({ op: 'project', input: 0, schema: node.schema, exprs: node.exprs });
          i++;
          continue;
        }
      }
      out.push(node);
    }
    return out;
  });
}

export const PASSES: readonly Pass[] = [foldConstants, fuseFilterProject, pushDownProjects, pushDownLimits];

export function optimize(plan: IrPlan): IrPlan {
  // Purpose: run every optimization pass in order
  let current = plan;
  for (const pass of PASSES) current = pass(current);
  return current;
}
