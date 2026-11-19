// String expressions for the engine (T-414, D-066). The engine holds strings as
// canonical ids and has no string functions. A function of one string column
// (lower, contains, a comparison with a literal, `in`, a coalesce...) gives the
// same answer for the same string, so the host evaluates it once per distinct
// string with the JS kernels, and the engine looks the answer up by id: the plan
// the engine runs has a `lookup` expression where the string expression was.
//
// `deriveLookups` rewrites a plan (once per plan); `buildLookupTable` evaluates one
// replaced expression over the strings of a snapshot (once per snapshot and
// parameter values).

import { makeColumn } from '../../column';
import type { Column } from '../../column';
import type { IrExpr, IrNode, IrPlan, LiteralValue } from '../../ir';
import { lookupExpr } from '../../ir-binary';
import { t } from '../../types';
import type { DataType } from '../../types';
import { evaluate, NEVER_FAILS } from '../js/exec';

// An expression the engine looks up instead of evaluating.
export interface LookupSpec {
  readonly table: number;
  // The original expression, over the string column it reads.
  readonly expr: IrExpr;
  // Index of that column in the expression's input.
  readonly field: number;
  readonly fieldType: DataType;
}

const isString = (type: DataType) => type.name === 'utf8' || type.name === 'dictionary';

function stringField(expr: IrExpr, input: readonly { type: DataType }[]): { index: number; type: DataType } | null {
  // Purpose: the one string column an expression reads and nothing else, or null if it is not a function of one string
  let found = -1;
  let ok = true;
  let calls = 0;
  const visit = (e: IrExpr): void => {
    if (!ok) return;
    switch (e.kind) {
      case 'field':
        if (found !== -1 && found !== e.index) ok = false;
        found = e.index;
        if (!isString(input[e.index]!.type)) ok = false;
        return;
      case 'literal':
      case 'param':
        return;
      case 'call':
        // Only functions that cannot fail: a table is computed for strings no row has.
        if (!NEVER_FAILS.has(e.fn)) ok = false;
        calls++;
        e.args.forEach(visit);
        return;
      case 'in':
        visit(e.arg);
        return;
      case 'cast':
        ok = false;
    }
  };
  visit(expr);
  if (!ok || found === -1 || calls === 0 && expr.kind !== 'in') return null;
  return { index: found, type: input[found]!.type };
}

function mapExprs(plan: IrPlan, f: (expr: IrExpr, node: IrNode) => IrExpr): IrPlan {
  // Purpose: the plan with every expression of every node replaced by f(expression, node)
  const nodes: IrNode[] = plan.nodes.map(node => {
    const r = (e: IrExpr) => f(e, node);
    switch (node.op) {
      case 'scan':
      case 'limit':
        return node;
      case 'filter':
        return { ...node, predicate: r(node.predicate) };
      case 'project':
        return { ...node, exprs: node.exprs.map(r) };
      case 'sort':
        return { ...node, keys: node.keys.map(k => ({ ...k, expr: r(k.expr) })) };
      case 'aggregate':
        return { ...node, keys: node.keys.map(r), aggs: node.aggs.map(a => ({ ...a, arg: a.arg === null ? null : r(a.arg) })) };
    }
  });
  return { ...plan, nodes };
}

export function foldConstants(plan: IrPlan, params: ReadonlyMap<string, LiteralValue | readonly LiteralValue[]>): IrPlan {
  // Purpose: replace every and/or that a boolean literal or parameter decides by its answer, as the executors do at run time (D-045), so the dropped side is never tabulated or scanned
  const constant = (e: IrExpr): boolean | undefined => {
    // Purpose: the value of a boolean literal or parameter, undefined for anything that depends on rows
    if (e.kind === 'literal') return typeof e.value === 'boolean' ? e.value : undefined;
    if (e.kind === 'param') {
      const v = params.get(e.name);
      return typeof v === 'boolean' ? v : undefined;
    }
    return undefined;
  };
  const fold = (e: IrExpr): IrExpr => {
    // Purpose: fold constants out of one expression, innermost first
    switch (e.kind) {
      case 'call': {
        if ((e.fn === 'and' || e.fn === 'or') && e.args.length === 2) {
          // Only an operand that is itself a literal or parameter decides, as in the executors: a nested and/or
          // that folds to a constant does not, so every backend raises the same errors.
          const decisive = e.fn === 'or';
          for (const [c, other] of [[e.args[0]!, e.args[1]!], [e.args[1]!, e.args[0]!]] as const) {
            const v = constant(c);
            if (v !== undefined) return v === decisive ? { kind: 'literal', value: decisive, type: e.type } : fold(other);
          }
        }
        const args = e.args.map(fold);
        if ((e.fn === 'and' || e.fn === 'or') && args.length === 2) {
          // An operand that only folded to a deciding constant (it was not one already) must not decide here:
          // the executors' shortcut would then skip an operand they evaluate otherwise, and a plan could raise on one backend only.
          const decisive = e.fn === 'or';
          for (let i = 0; i < 2; i++) {
            const a = args[i]!;
            if (a.kind === 'literal' && a.value === decisive) args[i] = e.args[i]!;
          }
        }
        return { ...e, args };
      }
      case 'cast':
      case 'in':
        return { ...e, arg: fold(e.arg) };
      default:
        return e;
    }
  };
  return mapExprs(plan, fold);
}

export function deriveLookups(plan: IrPlan): { plan: IrPlan; lookups: LookupSpec[] } {
  // Purpose: replace every expression that is a function of one string column by a lookup; the specs say what each table holds
  const lookups: LookupSpec[] = [];
  const rewrite = (expr: IrExpr, input: readonly { type: DataType }[]): IrExpr => {
    if (!isString(expr.type)) {
      const field = stringField(expr, input);
      // is_null of a column the engine answers itself, from validity.
      const bare = expr.kind === 'call' && expr.fn === 'is_null' && expr.args[0]!.kind === 'field';
      if (field && !bare) {
        const table = lookups.length;
        lookups.push({ table, expr, field: field.index, fieldType: field.type });
        return lookupExpr({ kind: 'field', index: field.index, type: field.type }, table, expr.type);
      }
    }
    switch (expr.kind) {
      case 'call':
        return { ...expr, args: expr.args.map(a => rewrite(a, input)) };
      case 'cast':
        return { ...expr, arg: rewrite(expr.arg, input) };
      case 'in':
        return { ...expr, arg: rewrite(expr.arg, input) };
      default:
        return expr;
    }
  };
  const rewritten = mapExprs(plan, (e, node) => rewrite(e, plan.nodes[(node as { input: number }).input]!.schema));
  return { plan: rewritten, lookups };
}

export interface LookupTable {
  // One value per string id, then one for a null row, as little-endian bytes of the expression's type.
  readonly values: Uint8Array;
  // One byte per entry when some entry is null.
  readonly valid: Uint8Array | null;
  readonly entries: number;
}

export function buildLookupTable(
  spec: LookupSpec,
  strings: readonly string[],
  params: ReadonlyMap<string, LiteralValue | readonly LiteralValue[]>,
): LookupTable {
  // Purpose: evaluate the expression once for every string (and once for null) and keep the answers as bytes
  const n = strings.length + 1;
  const valid = new Uint8Array(n).fill(1);
  valid[n - 1] = 0;
  let column: Column;
  if (spec.fieldType.name === 'dictionary') {
    const codes = new Int32Array(n);
    for (let i = 0; i < strings.length; i++) codes[i] = i;
    column = makeColumn(t.dictionary, codes, valid, strings);
  } else {
    column = makeColumn(t.utf8, [...strings, ''], valid);
  }
  const columns: (Column | undefined)[] = [];
  columns[spec.field] = column;
  const result = evaluate(spec.expr, { columns, rowCount: n }, { params });
  const view = result.values as unknown as ArrayBufferView;
  const values = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  return { values, valid: result.valid ? new Uint8Array(result.valid) : null, entries: n };
}
