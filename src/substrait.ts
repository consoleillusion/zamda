// Substrait export and import for an IrPlan. The JSON is plain data, so it can
// be handed to JSON.stringify/parse or another tool without a runtime library.
// It is pinned to SUBSTRAIT_VERSION; the registry's function names are checked
// against that release in tests/substrait.test.ts.
//
// The shape follows Substrait's relations and expressions (read/filter/project/
// aggregate/sort/fetch, field/literal/ifThen/cast/singularOrList, ...). The
// `zamda` fields record what protobuf would need extension declarations for:
// type variations, the zamda name behind a shared Substrait function name, and
// the flat node table. See docs/SUBSTRAIT.md.

import { PlanError } from './errors';
import type { IrAggregate, IrExpr, IrNode, IrParam, IrPlan, IrSortKey, LiteralValue } from './ir';
import { IR_VERSION } from './ir';
import { REGISTRY } from './registry';
import type { FunctionDef } from './registry';
import type { Field } from './schema';
import type { DataType, TypeName } from './types';
import { t } from './types';

// Verified against https://github.com/substrait-io/substrait/tree/v0.108.0
// (extensions/*.yaml and proto/substrait/algebra.proto).
export const SUBSTRAIT_VERSION = '0.108.0';
const VERSION_PARTS = SUBSTRAIT_VERSION.split('.').map(function (part) {
  // Purpose: turn the pinned version string into its numeric components
  return Number(part);
});
const MAJOR = VERSION_PARTS[0]!;
const MINOR = VERSION_PARTS[1]!;
const PATCH = VERSION_PARTS[2]!;
const PRODUCER = 'zamda';
const MAX_EXPR_DEPTH = 256;

// Substrait's u8/u16/u32/u64 are unsigned variations of i8/i16/i32/i64 and
// `dictionary` is a string variation. The `zamda` name keeps that distinction.
const TYPE_TO_SUBSTRAIT: Readonly<Partial<Record<TypeName, string>>> = {
  bool: 'bool',
  int8: 'i8',
  int16: 'i16',
  int32: 'i32',
  int64: 'i64',
  uint8: 'u8',
  uint16: 'u16',
  uint32: 'u32',
  uint64: 'u64',
  float32: 'fp32',
  float64: 'fp64',
  utf8: 'string',
  dictionary: 'string',
  date32: 'date',
  timestamp: 'timestamp',
};

export interface SubstraitVersionJson {
  readonly major_number: number;
  readonly minor_number: number;
  readonly patch_number: number;
  readonly producer: string;
}

export interface SubstraitTypeJson {
  readonly substrait: string;
  readonly zamda: TypeName;
  readonly nullable: true;
}

export interface SubstraitFieldJson {
  readonly name: string;
  readonly type: SubstraitTypeJson;
}

// Numbers are decimal strings so that -0, NaN and infinities survive JSON.
export type SubstraitLiteralJson =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'bigint'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string };

export interface SubstraitIfClauseJson {
  readonly if: SubstraitExprJson;
  readonly then: SubstraitExprJson;
}

export type SubstraitExprJson =
  | { readonly expr: 'field'; readonly index: number; readonly type: SubstraitTypeJson }
  | { readonly expr: 'literal'; readonly value: SubstraitLiteralJson; readonly type: SubstraitTypeJson }
  | { readonly expr: 'param'; readonly name: string; readonly type: SubstraitTypeJson }
  | {
      readonly expr: 'call';
      readonly fn: string;
      readonly substrait: string;
      readonly args: readonly SubstraitExprJson[];
      readonly type: SubstraitTypeJson;
    }
  | {
      readonly expr: 'ifThen';
      readonly ifs: readonly SubstraitIfClauseJson[];
      readonly else: SubstraitExprJson;
      readonly type: SubstraitTypeJson;
    }
  | { readonly expr: 'cast'; readonly arg: SubstraitExprJson; readonly type: SubstraitTypeJson }
  | {
      readonly expr: 'in';
      readonly arg: SubstraitExprJson;
      readonly values: readonly SubstraitLiteralJson[] | null;
      readonly param: string | null;
      readonly type: SubstraitTypeJson;
    };

export interface SubstraitSortJson {
  readonly expr: SubstraitExprJson;
  readonly direction: 'asc' | 'desc';
  readonly nulls: 'first' | 'last';
}

export interface SubstraitAggregateJson {
  readonly fn: string;
  readonly substrait: string;
  readonly arg: SubstraitExprJson | null;
  readonly type: SubstraitTypeJson;
  readonly distinct: boolean;
}

export type SubstraitRelationJson =
  | { readonly rel: 'read'; readonly schema: readonly SubstraitFieldJson[] }
  | {
      readonly rel: 'filter';
      readonly input: number;
      readonly schema: readonly SubstraitFieldJson[];
      readonly condition: SubstraitExprJson;
    }
  | {
      readonly rel: 'project';
      readonly input: number;
      readonly schema: readonly SubstraitFieldJson[];
      readonly expressions: readonly SubstraitExprJson[];
    }
  | {
      readonly rel: 'aggregate';
      readonly input: number;
      readonly schema: readonly SubstraitFieldJson[];
      readonly groupings: readonly (readonly SubstraitExprJson[])[];
      readonly measures: readonly SubstraitAggregateJson[];
    }
  | {
      readonly rel: 'sort';
      readonly input: number;
      readonly schema: readonly SubstraitFieldJson[];
      readonly sorts: readonly SubstraitSortJson[];
    }
  | {
      readonly rel: 'fetch';
      readonly input: number;
      readonly schema: readonly SubstraitFieldJson[];
      readonly count: number;
    };

export interface SubstraitParamJson {
  readonly name: string;
  readonly type: SubstraitTypeJson;
  readonly list: boolean;
}

export interface SubstraitPlanJson {
  readonly version: SubstraitVersionJson;
  readonly ir_version: number;
  readonly input: readonly SubstraitFieldJson[];
  readonly relations: readonly SubstraitRelationJson[];
  readonly root: number;
  readonly output: readonly SubstraitFieldJson[];
  readonly params: readonly SubstraitParamJson[];
}

// ---- structured errors and field checks ----

function shown(value: unknown): string {
  // Purpose: describe a found value for an error message
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return `an object with keys [${Object.keys(value).join(', ')}]`;
  return `${typeof value} ${String(value)}`;
}

function bad(where: string, expected: string, found: unknown): never {
  // Purpose: raise the one error type this module uses, naming what, found and where
  throw new PlanError(`${where}: expected ${expected}, found ${shown(found)}`);
}

function objectOf(value: unknown, where: string): Record<string, unknown> {
  // Purpose: require a plain JSON object
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(where, 'an object', value);
  return value as Record<string, unknown>;
}

function arrayOf<T>(value: readonly T[], where: string): T[];
function arrayOf(value: unknown, where: string): unknown[];
function arrayOf(value: unknown, where: string): unknown[] {
  // Purpose: require a JSON array, keeping its element type at compile time
  if (!Array.isArray(value)) bad(where, 'an array', value);
  return value as unknown[];
}

function stringOf(value: unknown, where: string): string {
  // Purpose: require a non-empty string
  if (typeof value !== 'string' || value.length === 0) bad(where, 'a non-empty string', value);
  return value as string;
}

function booleanOf(value: unknown, where: string): boolean {
  // Purpose: require a JSON boolean
  if (typeof value !== 'boolean') bad(where, 'a boolean', value);
  return value as boolean;
}

function countOf(value: unknown, where: string): number {
  // Purpose: require a non-negative, exactly representable integer
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    bad(where, 'a non-negative integer', value);
  }
  return value as number;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  // Purpose: reject missing or extra JSON fields, so a renamed field is never ignored
  const found = Object.keys(value).sort();
  const want = [...expected].sort();
  if (found.length !== want.length || found.some(function (key, i) {
    // Purpose: compare one sorted key
    return key !== want[i];
  })) {
    bad(where, `exactly the fields [${want.join(', ')}]`, `fields [${found.join(', ')}]`);
  }
}

function registered(name: string, kind: FunctionDef['kind'], where: string): FunctionDef {
  // Purpose: look up a function name, requiring the right kind from the registry
  const def = REGISTRY.get(name);
  if (!def) bad(where, `a registered ${kind} function name`, name);
  if (def.kind !== kind) bad(where, `a ${kind} function`, `${name} is ${def.kind}`);
  return def;
}

// ---- writing ----

function writeType(type: DataType, where: string): SubstraitTypeJson {
  // Purpose: write a zamda data type and its Substrait counterpart
  const name = type.name;
  const substrait = TYPE_TO_SUBSTRAIT[name];
  if (substrait === undefined) bad(where, 'a supported zamda type', name);
  return { substrait, zamda: name, nullable: true };
}

function writeFields(fields: readonly Field[], where: string): SubstraitFieldJson[] {
  // Purpose: write an ordered field list
  return arrayOf(fields, where).map(function (field, i) {
    // Purpose: write one field
    const at = `${where}[${i}]`;
    const o = objectOf(field, at);
    return { name: stringOf(o.name, `${at}.name`), type: writeType(o.type as DataType, `${at}.type`) };
  });
}

function writeLiteral(value: LiteralValue, where: string): SubstraitLiteralJson {
  // Purpose: write a literal without losing its JavaScript kind or value
  switch (typeof value) {
    case 'boolean':
      return { kind: 'boolean', value };
    case 'number':
      return { kind: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    case 'bigint':
      return { kind: 'bigint', value: value.toString(10) };
    case 'string':
      return { kind: 'string', value };
    default:
      return bad(where, 'a boolean, number, bigint or string literal', value);
  }
}

function writeExpr(expr: IrExpr, where: string, depth: number): SubstraitExprJson {
  // Purpose: write one expression, using the registry's Substrait function names
  if (depth > MAX_EXPR_DEPTH) bad(where, `expression nesting of at most ${MAX_EXPR_DEPTH}`, 'a deeper expression');
  const type = writeType(expr.type, `${where}.type`);
  switch (expr.kind) {
    case 'field':
      return { expr: 'field', index: countOf(expr.index, `${where}.index`), type };
    case 'literal':
      return { expr: 'literal', value: writeLiteral(expr.value, `${where}.value`), type };
    case 'param':
      return { expr: 'param', name: stringOf(expr.name, `${where}.name`), type };
    case 'call': {
      const def = registered(expr.fn, 'scalar', `${where}.fn`);
      if (expr.fn === 'if_else') {
        if (def.substrait !== 'expression:if_then') bad(`${where}.fn`, 'expression:if_then for if_else', def.substrait);
        if (expr.args.length !== 3) bad(`${where}.args`, 'three arguments for if_else', `${expr.args.length} arguments`);
        return {
          expr: 'ifThen',
          ifs: [{
            if: writeExpr(expr.args[0]!, `${where}.args[0]`, depth + 1),
            then: writeExpr(expr.args[1]!, `${where}.args[1]`, depth + 1),
          }],
          else: writeExpr(expr.args[2]!, `${where}.args[2]`, depth + 1),
          type,
        };
      }
      return {
        expr: 'call',
        fn: def.name,
        substrait: def.substrait,
        args: arrayOf(expr.args, `${where}.args`).map(function (arg, i) {
          // Purpose: write one function argument
          return writeExpr(arg, `${where}.args[${i}]`, depth + 1);
        }),
        type,
      };
    }
    case 'cast':
      return { expr: 'cast', arg: writeExpr(expr.arg, `${where}.arg`, depth + 1), type };
    case 'in': {
      if ((expr.values === null) === (expr.param === null)) {
        bad(where, 'exactly one of values and param', `${expr.values === null ? 'null' : 'values'} and ${expr.param === null ? 'null' : 'param'}`);
      }
      return {
        expr: 'in',
        arg: writeExpr(expr.arg, `${where}.arg`, depth + 1),
        values: expr.values === null ? null : arrayOf(expr.values, `${where}.values`).map(function (value, i) {
          // Purpose: write one in-list value
          return writeLiteral(value, `${where}.values[${i}]`);
        }),
        param: expr.param,
        type,
      };
    }
    default:
      return bad(where, 'a supported expression kind', expr);
  }
}

function writeSortKey(key: IrSortKey, where: string): SubstraitSortJson {
  // Purpose: write a sort key as a Substrait direction and null ordering
  if (key.descending !== true && key.descending !== false) bad(`${where}.descending`, 'a boolean', key.descending);
  if (key.nullsFirst !== true && key.nullsFirst !== false) bad(`${where}.nullsFirst`, 'a boolean', key.nullsFirst);
  return {
    expr: writeExpr(key.expr, `${where}.expr`, 0),
    direction: key.descending ? 'desc' : 'asc',
    nulls: key.nullsFirst ? 'first' : 'last',
  };
}

function writeAgg(agg: IrAggregate, where: string): SubstraitAggregateJson {
  // Purpose: write an aggregate call, keeping its registry name beside the Substrait name
  const def = registered(agg.fn, 'aggregate', `${where}.fn`);
  return {
    fn: def.name,
    substrait: def.substrait,
    arg: agg.arg === null ? null : writeExpr(agg.arg, `${where}.arg`, 0),
    type: writeType(agg.type, `${where}.type`),
    distinct: def.name === 'count_distinct',
  };
}

function writeNode(node: IrNode, where: string): SubstraitRelationJson {
  // Purpose: write one IR node as its Substrait relation
  const schema = writeFields(node.schema, `${where}.schema`);
  switch (node.op) {
    case 'scan':
      return { rel: 'read', schema };
    case 'filter':
      return {
        rel: 'filter',
        input: countOf(node.input, `${where}.input`),
        schema,
        condition: writeExpr(node.predicate, `${where}.condition`, 0),
      };
    case 'project':
      return {
        rel: 'project',
        input: countOf(node.input, `${where}.input`),
        schema,
        expressions: arrayOf(node.exprs, `${where}.expressions`).map(function (expr, i) {
          // Purpose: write one projected expression
          return writeExpr(expr, `${where}.expressions[${i}]`, 0);
        }),
      };
    case 'aggregate':
      return {
        rel: 'aggregate',
        input: countOf(node.input, `${where}.input`),
        schema,
        groupings: node.keys.length === 0 ? [] : [arrayOf(node.keys, `${where}.keys`).map(function (key, i) {
          // Purpose: write one grouping key
          return writeExpr(key, `${where}.keys[${i}]`, 0);
        })],
        measures: arrayOf(node.aggs, `${where}.aggs`).map(function (agg, i) {
          // Purpose: write one aggregate call
          return writeAgg(agg, `${where}.measures[${i}]`);
        }),
      };
    case 'sort':
      return {
        rel: 'sort',
        input: countOf(node.input, `${where}.input`),
        schema,
        sorts: arrayOf(node.keys, `${where}.sorts`).map(function (key, i) {
          // Purpose: write one sort key
          return writeSortKey(key, `${where}.sorts[${i}]`);
        }),
      };
    case 'limit':
      return { rel: 'fetch', input: countOf(node.input, `${where}.input`), schema, count: countOf(node.count, `${where}.count`) };
    default:
      return bad(where, 'a supported node op', node);
  }
}

function writeParam(param: IrParam, where: string): SubstraitParamJson {
  // Purpose: write one declared parameter
  return {
    name: stringOf(param.name, `${where}.name`),
    type: writeType(param.type, `${where}.type`),
    list: booleanOf(param.list, `${where}.list`),
  };
}

export function exportPlan(plan: IrPlan): SubstraitPlanJson {
  // Purpose: an IrPlan as a plain Substrait-shaped JSON plan
  if (plan.version !== IR_VERSION) bad('plan.version', `IR version ${IR_VERSION}`, plan.version);
  const nodes = arrayOf(plan.nodes, 'plan.nodes');
  if (nodes.length === 0) bad('plan.nodes', 'at least one node', nodes);
  if ((nodes[0] as IrNode | undefined)?.op !== 'scan') bad('plan.nodes[0]', 'a scan', nodes[0]);
  const root = countOf(plan.root, 'plan.root');
  if (root >= nodes.length) bad('plan.root', `a node index below ${nodes.length}`, plan.root);
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i] as IrNode;
    const input = 'input' in node ? node.input : undefined;
    if (input === undefined || !Number.isSafeInteger(input) || input < 0 || input >= i) {
      bad(`plan.nodes[${i}].input`, `an earlier node index below ${i}`, input);
    }
  }
  return {
    version: { major_number: MAJOR, minor_number: MINOR, patch_number: PATCH, producer: PRODUCER },
    ir_version: plan.version,
    input: writeFields(plan.input, 'plan.input'),
    relations: nodes.map(function (node, i) {
      // Purpose: write one relation
      return writeNode(node as IrNode, `plan.relations[${i}]`);
    }),
    root,
    output: writeFields(plan.output, 'plan.output'),
    params: arrayOf(plan.params, 'plan.params').map(function (param, i) {
      // Purpose: write one parameter declaration
      return writeParam(param as IrParam, `plan.params[${i}]`);
    }),
  };
}

// ---- reading ----

function readType(value: unknown, where: string): DataType {
  // Purpose: read a type, checking that its zamda name and Substrait name agree
  const o = objectOf(value, where);
  exactKeys(o, ['substrait', 'zamda', 'nullable'], where);
  const zamda = stringOf(o.zamda, `${where}.zamda`) as TypeName;
  const expected = TYPE_TO_SUBSTRAIT[zamda];
  if (expected === undefined) bad(`${where}.zamda`, 'a supported zamda type', zamda);
  const substrait = stringOf(o.substrait, `${where}.substrait`);
  if (substrait !== expected) bad(`${where}.substrait`, expected, substrait);
  if (o.nullable !== true) bad(`${where}.nullable`, 'true (every zamda column is nullable)', o.nullable);
  return t[zamda];
}

function readFields(value: unknown, where: string): Field[] {
  // Purpose: read an ordered list of fields
  return arrayOf(value, where).map(function (field, i) {
    // Purpose: read one field
    const at = `${where}[${i}]`;
    const o = objectOf(field, at);
    exactKeys(o, ['name', 'type'], at);
    return { name: stringOf(o.name, `${at}.name`), type: readType(o.type, `${at}.type`) };
  });
}

function readLiteral(value: unknown, where: string): LiteralValue {
  // Purpose: read a literal, refusing null, alternate encodings and unknown kinds
  const o = objectOf(value, where);
  const kind = stringOf(o.kind, `${where}.kind`);
  if (kind === 'boolean') {
    exactKeys(o, ['kind', 'value'], where);
    return booleanOf(o.value, `${where}.value`);
  }
  if (kind === 'number') {
    exactKeys(o, ['kind', 'value'], where);
    const raw = stringOf(o.value, `${where}.value`);
    const parsed = raw === '-0' ? -0 : Number(raw);
    const canonical = Object.is(parsed, -0) ? '-0' : String(parsed);
    if (canonical !== raw) bad(`${where}.value`, `the canonical number ${canonical}`, raw);
    return parsed;
  }
  if (kind === 'bigint') {
    exactKeys(o, ['kind', 'value'], where);
    const raw = stringOf(o.value, `${where}.value`);
    if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) bad(`${where}.value`, 'a canonical decimal integer string', raw);
    const parsed = BigInt(raw);
    if (parsed.toString(10) !== raw) bad(`${where}.value`, `the canonical integer ${parsed.toString(10)}`, raw);
    return parsed;
  }
  if (kind === 'string') {
    exactKeys(o, ['kind', 'value'], where);
    return stringOfAllowEmpty(o.value, `${where}.value`);
  }
  return bad(`${where}.kind`, 'boolean, number, bigint or string', kind);
}

function stringOfAllowEmpty(value: unknown, where: string): string {
  // Purpose: require a string, allowing the empty string for literals and names
  if (typeof value !== 'string') bad(where, 'a string', value);
  return value as string;
}

function readExpr(value: unknown, where: string, depth: number): IrExpr {
  // Purpose: read one expression, rebuilding the exact IR variant
  if (depth > MAX_EXPR_DEPTH) bad(where, `expression nesting of at most ${MAX_EXPR_DEPTH}`, 'a deeper expression');
  const o = objectOf(value, where);
  const kind = stringOf(o.expr, `${where}.expr`);
  switch (kind) {
    case 'field': {
      exactKeys(o, ['expr', 'index', 'type'], where);
      return { kind: 'field', index: countOf(o.index, `${where}.index`), type: readType(o.type, `${where}.type`) };
    }
    case 'literal': {
      exactKeys(o, ['expr', 'value', 'type'], where);
      return { kind: 'literal', value: readLiteral(o.value, `${where}.value`), type: readType(o.type, `${where}.type`) };
    }
    case 'param': {
      exactKeys(o, ['expr', 'name', 'type'], where);
      return { kind: 'param', name: stringOf(o.name, `${where}.name`), type: readType(o.type, `${where}.type`) };
    }
    case 'call': {
      exactKeys(o, ['expr', 'fn', 'substrait', 'args', 'type'], where);
      const fn = stringOf(o.fn, `${where}.fn`);
      const substrait = stringOf(o.substrait, `${where}.substrait`);
      if (fn === 'if_else') bad(`${where}.fn`, 'an ifThen expression for if_else', fn);
      const def = registered(fn, 'scalar', `${where}.fn`);
      if (def.substrait !== substrait) bad(`${where}.substrait`, def.substrait, substrait);
      const args = arrayOf(o.args, `${where}.args`).map(function (arg, i) {
        // Purpose: read one function argument
        return readExpr(arg, `${where}.args[${i}]`, depth + 1);
      });
      return { kind: 'call', fn: def.name, args, type: readType(o.type, `${where}.type`) };
    }
    case 'ifThen': {
      exactKeys(o, ['expr', 'ifs', 'else', 'type'], where);
      const def = registered('if_else', 'scalar', where);
      if (def.substrait !== 'expression:if_then') bad(where, 'expression:if_then for ifThen', def.substrait);
      const clauses = arrayOf(o.ifs, `${where}.ifs`);
      if (clauses.length !== 1) bad(`${where}.ifs`, 'one if/then clause', `${clauses.length} clauses`);
      const clause = objectOf(clauses[0], `${where}.ifs[0]`);
      exactKeys(clause, ['if', 'then'], `${where}.ifs[0]`);
      const cond = readExpr(clause.if, `${where}.ifs[0].if`, depth + 1);
      const then = readExpr(clause.then, `${where}.ifs[0].then`, depth + 1);
      const otherwise = readExpr(o.else, `${where}.else`, depth + 1);
      return { kind: 'call', fn: 'if_else', args: [cond, then, otherwise], type: readType(o.type, `${where}.type`) };
    }
    case 'cast': {
      exactKeys(o, ['expr', 'arg', 'type'], where);
      return { kind: 'cast', arg: readExpr(o.arg, `${where}.arg`, depth + 1), type: readType(o.type, `${where}.type`) };
    }
    case 'in': {
      exactKeys(o, ['expr', 'arg', 'values', 'param', 'type'], where);
      const arg = readExpr(o.arg, `${where}.arg`, depth + 1);
      const hasValues = o.values !== null;
      const hasParam = o.param !== null;
      if (hasValues === hasParam) bad(where, 'exactly one of values and param', `${hasValues ? 'values' : 'null'} and ${hasParam ? 'param' : 'null'}`);
      const values = hasValues ? arrayOf(o.values, `${where}.values`).map(function (value, i) {
        // Purpose: read one in-list value
        return readLiteral(value, `${where}.values[${i}]`);
      }) : null;
      const param = hasParam ? stringOf(o.param, `${where}.param`) : null;
      return { kind: 'in', arg, values, param, type: readType(o.type, `${where}.type`) };
    }
    default:
      return bad(`${where}.expr`, 'a supported expression kind', kind);
  }
}

function readSortKey(value: unknown, where: string): IrSortKey {
  // Purpose: read a sort key from its direction and null ordering
  const o = objectOf(value, where);
  exactKeys(o, ['expr', 'direction', 'nulls'], where);
  const direction = stringOf(o.direction, `${where}.direction`);
  if (direction !== 'asc' && direction !== 'desc') bad(`${where}.direction`, 'asc or desc', direction);
  const nulls = stringOf(o.nulls, `${where}.nulls`);
  if (nulls !== 'first' && nulls !== 'last') bad(`${where}.nulls`, 'first or last', nulls);
  return {
    expr: readExpr(o.expr, `${where}.expr`, 0),
    descending: direction === 'desc',
    nullsFirst: nulls === 'first',
  };
}

function readAgg(value: unknown, where: string): IrAggregate {
  // Purpose: read an aggregate call, checking its registry and Substrait names
  const o = objectOf(value, where);
  exactKeys(o, ['fn', 'substrait', 'arg', 'type', 'distinct'], where);
  const fn = stringOf(o.fn, `${where}.fn`);
  const substrait = stringOf(o.substrait, `${where}.substrait`);
  const def = registered(fn, 'aggregate', `${where}.fn`);
  if (def.substrait !== substrait) bad(`${where}.substrait`, def.substrait, substrait);
  const distinct = booleanOf(o.distinct, `${where}.distinct`);
  if (distinct !== (def.name === 'count_distinct')) {
    bad(`${where}.distinct`, def.name === 'count_distinct' ? 'true for count_distinct' : 'false for this aggregate', distinct);
  }
  return {
    fn: def.name,
    arg: o.arg === null ? null : readExpr(o.arg, `${where}.arg`, 0),
    type: readType(o.type, `${where}.type`),
  };
}

function readNode(value: unknown, where: string, index: number): IrNode {
  // Purpose: read one relation and check its position in the flat node table
  const o = objectOf(value, where);
  const rel = stringOf(o.rel, `${where}.rel`);
  if (index === 0 && rel !== 'read') bad(where, 'a read relation at node 0', rel);
  const input = function (): number {
    // Purpose: read and check a relation's input index
    const n = countOf(o.input, `${where}.input`);
    if (index === 0 || n >= index) bad(`${where}.input`, `an earlier node index below ${index}`, n);
    return n;
  };
  switch (rel) {
    case 'read': {
      exactKeys(o, ['rel', 'schema'], where);
      if (index !== 0) bad(where, 'a read relation only at node 0', `node ${index}`);
      return { op: 'scan', schema: readFields(o.schema, `${where}.schema`) };
    }
    case 'filter': {
      exactKeys(o, ['rel', 'input', 'schema', 'condition'], where);
      return {
        op: 'filter', input: input(), schema: readFields(o.schema, `${where}.schema`),
        predicate: readExpr(o.condition, `${where}.condition`, 0),
      };
    }
    case 'project': {
      exactKeys(o, ['rel', 'input', 'schema', 'expressions'], where);
      return {
        op: 'project', input: input(), schema: readFields(o.schema, `${where}.schema`),
        exprs: arrayOf(o.expressions, `${where}.expressions`).map(function (expr, i) {
          // Purpose: read one projected expression
          return readExpr(expr, `${where}.expressions[${i}]`, 0);
        }),
      };
    }
    case 'aggregate': {
      exactKeys(o, ['rel', 'input', 'schema', 'groupings', 'measures'], where);
      const groupings = arrayOf(o.groupings, `${where}.groupings`);
      if (groupings.length > 1) bad(`${where}.groupings`, 'at most one grouping set', `${groupings.length} grouping sets`);
      const keys = groupings.length === 0 ? [] : arrayOf(groupings[0], `${where}.groupings[0]`).map(function (key, i) {
        // Purpose: read one grouping key
        return readExpr(key, `${where}.groupings[0][${i}]`, 0);
      });
      return {
        op: 'aggregate', input: input(), schema: readFields(o.schema, `${where}.schema`),
        keys,
        aggs: arrayOf(o.measures, `${where}.measures`).map(function (agg, i) {
          // Purpose: read one aggregate call
          return readAgg(agg, `${where}.measures[${i}]`);
        }),
      };
    }
    case 'sort': {
      exactKeys(o, ['rel', 'input', 'schema', 'sorts'], where);
      return {
        op: 'sort', input: input(), schema: readFields(o.schema, `${where}.schema`),
        keys: arrayOf(o.sorts, `${where}.sorts`).map(function (key, i) {
          // Purpose: read one sort key
          return readSortKey(key, `${where}.sorts[${i}]`);
        }),
      };
    }
    case 'fetch': {
      exactKeys(o, ['rel', 'input', 'schema', 'count'], where);
      return { op: 'limit', input: input(), schema: readFields(o.schema, `${where}.schema`), count: countOf(o.count, `${where}.count`) };
    }
    default:
      return bad(`${where}.rel`, 'a supported relation', rel);
  }
}

function readVersion(value: unknown, where: string): SubstraitVersionJson {
  // Purpose: require exactly the pinned Substrait version
  const o = objectOf(value, where);
  exactKeys(o, ['major_number', 'minor_number', 'patch_number', 'producer'], where);
  const expected = { major_number: MAJOR, minor_number: MINOR, patch_number: PATCH, producer: PRODUCER } as const;
  for (const key of ['major_number', 'minor_number', 'patch_number'] as const) {
    if (o[key] !== expected[key]) bad(`${where}.${key}`, String(expected[key]), o[key]);
  }
  if (o.producer !== expected.producer) bad(`${where}.producer`, expected.producer, o.producer);
  return expected;
}

function readParam(value: unknown, where: string): IrParam {
  // Purpose: read one declared parameter
  const o = objectOf(value, where);
  exactKeys(o, ['name', 'type', 'list'], where);
  return {
    name: stringOf(o.name, `${where}.name`),
    type: readType(o.type, `${where}.type`),
    list: booleanOf(o.list, `${where}.list`),
  };
}

export function importPlan(value: unknown): IrPlan {
  // Purpose: read a Substrait JSON plan, raising PlanError for anything unsupported or malformed
  const o = objectOf(value, 'plan');
  exactKeys(o, ['version', 'ir_version', 'input', 'relations', 'root', 'output', 'params'], 'plan');
  readVersion(o.version, 'plan.version');
  if (o.ir_version !== IR_VERSION) bad('plan.ir_version', `IR version ${IR_VERSION}`, o.ir_version);
  const input = readFields(o.input, 'plan.input');
  const relations = arrayOf(o.relations, 'plan.relations');
  if (relations.length === 0) bad('plan.relations', 'at least one relation', relations);
  const nodes = relations.map(function (relation, i) {
    // Purpose: read one relation
    return readNode(relation, `plan.relations[${i}]`, i);
  });
  const root = countOf(o.root, 'plan.root');
  if (root >= nodes.length) bad('plan.root', `a node index below ${nodes.length}`, o.root);
  return {
    version: IR_VERSION,
    input,
    nodes,
    root,
    output: readFields(o.output, 'plan.output'),
    params: arrayOf(o.params, 'plan.params').map(function (param, i) {
      // Purpose: read one parameter declaration
      return readParam(param, `plan.params[${i}]`);
    }),
  };
}
