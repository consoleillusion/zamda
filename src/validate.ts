// The IR validator. Every plan passes through here before any backend sees it.
// The WASM engine will re-validate in Rust, because it treats IR as untrusted;
// shared golden cases keep the two validators in step.

import { PlanError, ZamdaError } from './errors';
import type { IrExpr, IrParam, IrPlan } from './ir';
import { IR_VERSION, nodeExprs, walkExpr } from './ir';
import { canCast, lookup } from './registry';
import type { Field } from './schema';
import { compatibleTypes, sameType } from './types';

const MAX_NODES = 1024;
const MAX_EXPR_DEPTH = 256;
const MAX_LIST_VALUES = 65536;

function depth(expr: IrExpr): number {
  // Purpose: nesting depth of an expression, for the depth limit
  if (expr.kind === 'cast' || expr.kind === 'in') return depth(expr.arg) + 1;
  if (expr.kind !== 'call') return 1;
  let deepest = 0;
  for (const arg of expr.args) deepest = Math.max(deepest, depth(arg));
  return deepest + 1;
}

function checkParam(name: string, expr: IrExpr, list: boolean, params: ReadonlyMap<string, IrParam>, where: string): void {
  // Purpose: a parameter reference must match a declared parameter in type and kind
  const declared = params.get(name);
  if (!declared) throw new PlanError(`${where}: parameter "${name}" is not declared`);
  const type = expr.kind === 'in' ? expr.arg.type : expr.type;
  if (declared.list !== list || !compatibleTypes(declared.type, type)) {
    throw new PlanError(`${where}: parameter "${name}" is used with a different type than declared`);
  }
}

function checkExpr(expr: IrExpr, input: readonly Field[], params: ReadonlyMap<string, IrParam>, where: string): void {
  // Purpose: check field references, function names, casts and result types in one expression
  if (depth(expr) > MAX_EXPR_DEPTH) throw new PlanError(`${where}: expression is nested too deeply`);
  walkExpr(expr, function (e) {
    switch (e.kind) {
      case 'field': {
        const field = input[e.index];
        if (!Number.isInteger(e.index) || !field) {
          throw new PlanError(`${where}: field index ${e.index} is out of range`);
        }
        if (!sameType(field.type, e.type)) {
          throw new PlanError(`${where}: field ${e.index} is ${field.type.name}, not ${e.type.name}`);
        }
        break;
      }
      case 'call': {
        const def = lookup(e.fn);
        if (def.kind !== 'scalar') throw new PlanError(`${where}: ${e.fn} is not a scalar function`);
        let type;
        try {
          type = def.returns(
            e.args.map(function (a) {
              return a.type;
            }),
          );
        } catch (err) {
          if (err instanceof ZamdaError) throw new PlanError(`${where}: ${err.message}`);
          throw err;
        }
        if (!sameType(type, e.type)) {
          throw new PlanError(`${where}: ${e.fn} returns ${type.name}, plan says ${e.type.name}`);
        }
        break;
      }
      case 'cast':
        if (!canCast(e.arg.type, e.type)) {
          throw new PlanError(`${where}: cannot cast ${e.arg.type.name} to ${e.type.name}`);
        }
        break;
      case 'in':
        if (e.type.name !== 'bool') throw new PlanError(`${where}: an in-list test must be bool`);
        if ((e.values === null) === (e.param === null)) {
          throw new PlanError(`${where}: an in-list test needs either values or a parameter`);
        }
        if (e.values && e.values.length > MAX_LIST_VALUES) {
          throw new PlanError(`${where}: an in-list may hold at most ${MAX_LIST_VALUES} values`);
        }
        if (e.param !== null) checkParam(e.param, e, true, params, where);
        break;
      case 'param':
        checkParam(e.name, e, false, params, where);
        break;
      case 'literal':
        break;
    }
  });
}

export function validate(plan: IrPlan): IrPlan {
  // Purpose: reject any structurally or type-invalid plan with a PlanError
  if (plan.version !== IR_VERSION) {
    throw new PlanError(`Unsupported IR version ${plan.version}; expected ${IR_VERSION}`);
  }
  if (plan.nodes.length === 0 || plan.nodes.length > MAX_NODES) {
    throw new PlanError(`A plan must have between 1 and ${MAX_NODES} nodes`);
  }
  if (plan.nodes[0]!.op !== 'scan') throw new PlanError('Node 0 must be a scan');

  // A join binds a second table through an extra scan node. Record those scans
  // so the loop below can tell them from a stray scan.
  const boundScans = new Set<number>();
  for (const node of plan.nodes) {
    if (node.op === 'join') boundScans.add(node.right);
  }

  const params = new Map<string, IrParam>();
  for (const param of plan.params) {
    if (params.has(param.name)) throw new PlanError(`Parameter "${param.name}" is declared twice`);
    params.set(param.name, param);
  }

  for (let i = 1; i < plan.nodes.length; i++) {
    const node = plan.nodes[i]!;
    const where = `node ${i} (${node.op})`;
    if (node.op === 'scan') {
      if (!boundScans.has(i)) throw new PlanError(`${where}: only node 0 and a join's right input may be a scan`);
      continue;
    }
    if (!Number.isInteger(node.input) || node.input < 0 || node.input >= i) {
      throw new PlanError(`${where}: input ${node.input} must refer to an earlier node`);
    }
    const input = plan.nodes[node.input]!.schema;
    for (const expr of nodeExprs(node)) checkExpr(expr, input, params, where);

    if (node.op === 'filter' && node.predicate.type.name !== 'bool') {
      throw new PlanError(`${where}: predicate must be bool`);
    }
    if (node.op === 'limit' && (!Number.isInteger(node.count) || node.count < 0)) {
      throw new PlanError(`${where}: count must be a non-negative integer`);
    }
    if (node.op === 'project' && node.exprs.length !== node.schema.length) {
      throw new PlanError(`${where}: schema does not match the projected expressions`);
    }
    if (node.op === 'sort') {
      for (const key of node.keys) {
        if (key.expr.type.name === 'bool') throw new PlanError(`${where}: bool is not a sortable type`);
      }
    }
    if (node.op === 'aggregate') {
      if (node.keys.length + node.aggs.length !== node.schema.length) {
        throw new PlanError(`${where}: schema does not match keys and aggregates`);
      }
      for (const agg of node.aggs) {
        const def = lookup(agg.fn);
        if (def.kind !== 'aggregate') throw new PlanError(`${where}: ${agg.fn} is not an aggregate function`);
      }
    }
    if (node.op === 'join') {
      if (!Number.isInteger(node.right) || node.right < 1 || node.right >= i ||
          plan.nodes[node.right]!.op !== 'scan') {
        throw new PlanError(`${where}: right ${node.right} must refer to an earlier scan node`);
      }
      if (node.leftKeys.length === 0 || node.leftKeys.length !== node.rightKeys.length) {
        throw new PlanError(`${where}: a join needs at least one key, with matching left and right counts`);
      }
      const right = plan.nodes[node.right]!.schema;
      for (let k = 0; k < node.leftKeys.length; k++) {
        const leftField = input[node.leftKeys[k]!];
        const rightField = right[node.rightKeys[k]!];
        if (!leftField || !rightField) throw new PlanError(`${where}: key ${k} points outside an input schema`);
        if (!compatibleTypes(leftField.type, rightField.type)) {
          throw new PlanError(`${where}: key ${k} types ${leftField.type.name} and ${rightField.type.name} are not compatible`);
        }
      }
      if (node.schema.length !== input.length + right.length) {
        throw new PlanError(`${where}: schema does not match the joined inputs`);
      }
      const names = new Set<string>();
      for (let c = 0; c < node.schema.length; c++) {
        const expected = c < input.length ? input[c]! : right[c - input.length]!;
        const field = node.schema[c]!;
        if (field.name !== expected.name || !sameType(field.type, expected.type)) {
          throw new PlanError(`${where}: schema column ${c} does not match the joined inputs`);
        }
        if (names.has(field.name)) throw new PlanError(`${where}: duplicate output column "${field.name}"`);
        names.add(field.name);
      }
    }
    if (node.op === 'window') {
      if (node.sorts.some(function (k) {
        return k.expr.type.name === 'bool';
      })) throw new PlanError(`${where}: bool is not a sortable type`);
      if (node.functions.length === 0) throw new PlanError(`${where}: a window needs at least one function`);
      if (node.schema.length !== input.length + node.functions.length) {
        throw new PlanError(`${where}: schema does not match the input plus window functions`);
      }
      for (let c = 0; c < input.length; c++) {
        const field = node.schema[c]!;
        if (field.name !== input[c]!.name || !sameType(field.type, input[c]!.type)) {
          throw new PlanError(`${where}: schema column ${c} does not match the input`);
        }
      }
      const names = new Set(node.schema.map(function (f) {
        return f.name;
      }));
      if (names.size !== node.schema.length) throw new PlanError(`${where}: duplicate output column name`);
      for (let f = 0; f < node.functions.length; f++) {
        const fn = node.functions[f]!;
        if (fn.fn !== 'row_number' && fn.fn !== 'rank' && fn.fn !== 'dense_rank') {
          throw new PlanError(`${where}: unknown window function "${fn.fn}"`);
        }
        if (fn.type.name !== 'int64') {
          throw new PlanError(`${where}: window function ${fn.fn} must be int64, not ${fn.type.name}`);
        }
        const out = node.schema[input.length + f]!;
        if (!sameType(out.type, fn.type)) {
          throw new PlanError(`${where}: schema column ${input.length + f} does not match window function ${fn.fn}`);
        }
      }
    }
  }

  if (!Number.isInteger(plan.root) || !plan.nodes[plan.root]) {
    throw new PlanError(`Root ${plan.root} is not a node`);
  }
  return plan;
}
