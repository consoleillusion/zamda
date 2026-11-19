// The binary form of an IR plan: what the WASM engine reads. The layout is
// written down in docs/IR-BINARY.md; this file is its encoder and decoder.
//
// The format is exact: decodePlan(encodePlan(plan)) equals the plan, including
// -0, NaN, infinities, 64-bit literals and every string. The decoder trusts
// nothing: every read is bounds-checked, counts are limited by the bytes left,
// nesting is limited, and anything unexpected is a PlanError, never a crash.
// It checks that the bytes are well formed; whether the plan makes sense (types,
// column and parameter references) is the validator's job.

import { PlanError } from './errors';
import type { IrAggregate, IrExpr, IrNode, IrParam, IrPlan, IrSortKey, LiteralValue } from './ir';
import { IR_VERSION } from './ir';
import type { Field } from './schema';
import type { DataType, TypeName } from './types';
import { t } from './types';

const MAGIC = [0x5a, 0x49, 0x52, 0x01]; // "ZIR" and the format version
const MAX_DEPTH = 200;

// The order is part of the format: never reorder, only append.
export const TYPE_NAMES: readonly TypeName[] = [
  'bool', 'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'utf8', 'dictionary', 'date32', 'timestamp',
];
const OPS = ['scan', 'filter', 'project', 'aggregate', 'sort', 'limit'] as const;
const EXPR_KINDS = ['field', 'literal', 'param', 'call', 'cast', 'in', 'lookup'] as const;

// Engine only, never in a plan the JS side runs or validates: the result of a function of one string,
// read by the string's canonical id from table `table` (docs/IR-BINARY.md). It sits in an IrExpr
// position through a cast, so the core types do not know it.
export interface LookupExpr {
  readonly kind: 'lookup';
  readonly arg: IrExpr;
  readonly table: number;
  readonly type: DataType;
}

export function lookupExpr(arg: IrExpr, table: number, type: DataType): IrExpr {
  // Purpose: build a lookup expression for the engine
  return { kind: 'lookup', arg, table, type } as LookupExpr as unknown as IrExpr;
}

// Literal kinds.
const L_FALSE = 0;
const L_TRUE = 1;
const L_INT = 2; // zigzag varint, |n| <= 2^52 - 1
const L_FLOAT = 3; // float64 bits, little-endian
const L_BIG = 4; // magnitude as uint64 little-endian, value >= 0
const L_NEG_BIG = 5; // magnitude as uint64 little-endian, value = -magnitude
const L_STRING = 6;

const MAX_ZIGZAG_INT = 2 ** 52 - 1;
const U64_MASK = (1n << 64n) - 1n;

function bad(message: string): never {
  // Purpose: raise the one error type this module uses
  throw new PlanError(`Binary IR: ${message}`);
}

// ---- writing ----

class Writer {
  private bytes = new Uint8Array(256);
  private length = 0;
  private readonly view = (): DataView => new DataView(this.bytes.buffer);

  private room(extra: number): void {
    // Purpose: make space for `extra` more bytes
    if (this.length + extra <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  byte(value: number): void {
    // Purpose: append one byte
    this.room(1);
    this.bytes[this.length++] = value;
  }

  varint(value: number): void {
    // Purpose: append a non-negative integer below 2^53 as a little-endian base-128 varint
    if (!Number.isSafeInteger(value) || value < 0) bad(`cannot write ${value} as a count or index`);
    let v = value;
    while (v >= 128) {
      this.byte((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.byte(v);
  }

  zigzag(value: number): void {
    // Purpose: append a signed integer of at most 2^52 - 1 in magnitude
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  u64(value: bigint): void {
    // Purpose: append 8 bytes, little-endian
    this.room(8);
    this.view().setBigUint64(this.length, value, true);
    this.length += 8;
  }

  f64(value: number): void {
    // Purpose: append the 8 bytes of a float64, little-endian, bit-exact
    this.room(8);
    this.view().setFloat64(this.length, value, true);
    this.length += 8;
  }

  string(value: string): void {
    // Purpose: append a length and the UTF-8 bytes; a string with a lone surrogate cannot be stored exactly
    if (!(value as unknown as { isWellFormed(): boolean }).isWellFormed()) bad('a string holds a lone surrogate');
    const encoded = new TextEncoder().encode(value);
    this.varint(encoded.length);
    this.room(encoded.length);
    this.bytes.set(encoded, this.length);
    this.length += encoded.length;
  }

  done(): Uint8Array {
    // Purpose: the bytes written
    return this.bytes.slice(0, this.length);
  }
}

function writeType(w: Writer, type: DataType): void {
  // Purpose: append a data type as one byte
  const id = TYPE_NAMES.indexOf(type.name);
  if (id === -1) bad(`unknown type "${String(type.name)}"`);
  w.byte(id);
}

function writeField(w: Writer, field: Field): void {
  // Purpose: append a field: name, then type
  w.string(field.name);
  writeType(w, field.type);
}

function writeFields(w: Writer, fields: readonly Field[]): void {
  // Purpose: append a count, then each field
  w.varint(fields.length);
  for (const field of fields) writeField(w, field);
}

function writeLiteral(w: Writer, value: LiteralValue): void {
  // Purpose: append a literal, tagged by its JavaScript kind so it comes back exactly
  switch (typeof value) {
    case 'boolean':
      w.byte(value ? L_TRUE : L_FALSE);
      return;
    case 'number':
      if (Number.isInteger(value) && Math.abs(value) <= MAX_ZIGZAG_INT && !Object.is(value, -0)) {
        w.byte(L_INT);
        w.zigzag(value);
      } else {
        w.byte(L_FLOAT);
        w.f64(value);
      }
      return;
    case 'bigint': {
      const magnitude = value < 0n ? -value : value;
      if (magnitude > U64_MASK) bad('a 64-bit literal is out of range');
      w.byte(value < 0n ? L_NEG_BIG : L_BIG);
      w.u64(magnitude);
      return;
    }
    case 'string':
      w.byte(L_STRING);
      w.string(value);
      return;
    default:
      bad(`cannot write a literal of kind ${typeof value}`);
  }
}

function writeExpr(w: Writer, expr: IrExpr, depth: number): void {
  // Purpose: append an expression: kind, result type, then what the kind needs
  if (depth > MAX_DEPTH) bad('expression nested too deeply');
  w.byte(EXPR_KINDS.indexOf(expr.kind));
  writeType(w, expr.type);
  if ((expr.kind as string) === 'lookup') {
    const lookup = expr as unknown as LookupExpr;
    writeExpr(w, lookup.arg, depth + 1);
    w.varint(lookup.table);
    return;
  }
  switch (expr.kind) {
    case 'field':
      w.varint(expr.index);
      return;
    case 'literal':
      writeLiteral(w, expr.value);
      return;
    case 'param':
      w.string(expr.name);
      return;
    case 'call':
      w.string(expr.fn);
      w.varint(expr.args.length);
      for (const arg of expr.args) writeExpr(w, arg, depth + 1);
      return;
    case 'cast':
      writeExpr(w, expr.arg, depth + 1);
      return;
    case 'in':
      writeExpr(w, expr.arg, depth + 1);
      if (expr.values !== null && expr.param === null) {
        w.byte(0);
        w.varint(expr.values.length);
        for (const value of expr.values) writeLiteral(w, value);
      } else if (expr.param !== null && expr.values === null) {
        w.byte(1);
        w.string(expr.param);
      } else bad('an "in" expression needs exactly one of values and param');
  }
}

function writeNode(w: Writer, node: IrNode): void {
  // Purpose: append a node: op, output schema, then what the op needs
  w.byte(OPS.indexOf(node.op));
  writeFields(w, node.schema);
  switch (node.op) {
    case 'scan':
      return;
    case 'filter':
      w.varint(node.input);
      writeExpr(w, node.predicate, 0);
      return;
    case 'project':
      w.varint(node.input);
      w.varint(node.exprs.length);
      for (const e of node.exprs) writeExpr(w, e, 0);
      return;
    case 'aggregate':
      w.varint(node.input);
      w.varint(node.keys.length);
      for (const key of node.keys) writeExpr(w, key, 0);
      w.varint(node.aggs.length);
      for (const agg of node.aggs) {
        w.string(agg.fn);
        writeType(w, agg.type);
        if (agg.arg === null) w.byte(0);
        else {
          w.byte(1);
          writeExpr(w, agg.arg, 0);
        }
      }
      return;
    case 'sort':
      w.varint(node.input);
      w.varint(node.keys.length);
      for (const key of node.keys) {
        w.byte((key.descending ? 1 : 0) | (key.nullsFirst ? 2 : 0));
        writeExpr(w, key.expr, 0);
      }
      return;
    case 'limit':
      w.varint(node.input);
      w.varint(node.count);
  }
}

export function encodeParams(
  declared: readonly IrParam[],
  values: ReadonlyMap<string, LiteralValue | readonly LiteralValue[]>,
): Uint8Array {
  // Purpose: parameter values as bytes for the engine: for each declared parameter in order, one literal, or a count and that many literals for a list
  const w = new Writer();
  for (const param of declared) {
    const value = values.get(param.name);
    if (value === undefined) bad(`no value for parameter "${param.name}"`);
    if (param.list) {
      if (!Array.isArray(value)) bad(`parameter "${param.name}" is a list`);
      w.varint(value.length);
      for (const v of value as readonly LiteralValue[]) writeLiteral(w, v);
    } else {
      if (Array.isArray(value)) bad(`parameter "${param.name}" is not a list`);
      writeLiteral(w, value as LiteralValue);
    }
  }
  return w.done();
}

export function encodePlan(plan: IrPlan): Uint8Array {
  // Purpose: the plan as bytes in the format of docs/IR-BINARY.md
  if (plan.version !== IR_VERSION) bad(`plan version ${plan.version} is not ${IR_VERSION}`);
  const w = new Writer();
  for (const b of MAGIC) w.byte(b);
  w.varint(plan.version);
  writeFields(w, plan.input);
  w.varint(plan.nodes.length);
  for (const node of plan.nodes) writeNode(w, node);
  w.varint(plan.root);
  writeFields(w, plan.output);
  w.varint(plan.params.length);
  for (const param of plan.params) {
    w.string(param.name);
    writeType(w, param.type);
    w.byte(param.list ? 1 : 0);
  }
  return w.done();
}

// ---- reading ----

class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    // Purpose: read from the start of `bytes`
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    // Purpose: bytes not read yet
    return this.bytes.length - this.at;
  }

  byte(): number {
    // Purpose: the next byte
    if (this.at >= this.bytes.length) bad('the data ends early');
    return this.bytes[this.at++]!;
  }

  varint(): number {
    // Purpose: the next varint; at most 8 bytes and below 2^53
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      value += (b & 127) * scale;
      if (b < 128) {
        if (i > 0 && b === 0) bad('a number is not in its shortest form');
        if (!Number.isSafeInteger(value)) bad('a number is too large');
        return value;
      }
      scale *= 128;
    }
    return bad('a number is too long');
  }

  count(): number {
    // Purpose: a list length; every element takes at least one byte, so it cannot exceed the bytes left
    const n = this.varint();
    if (n > this.left) bad('a count is larger than the data');
    return n;
  }

  zigzag(): number {
    // Purpose: the next signed varint
    const z = this.varint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  u64(): bigint {
    // Purpose: the next 8 bytes as an unsigned integer
    if (this.left < 8) bad('the data ends early');
    const value = this.view.getBigUint64(this.at, true);
    this.at += 8;
    return value;
  }

  f64(): number {
    // Purpose: the next 8 bytes as a float64; a NaN must be the standard one, so a value has one encoding
    if (this.left < 8) bad('the data ends early');
    const value = this.view.getFloat64(this.at, true);
    if (Number.isNaN(value) && this.view.getBigUint64(this.at, true) !== 0x7ff8000000000000n) bad('a NaN is not the standard NaN');
    this.at += 8;
    return value;
  }

  string(): string {
    // Purpose: the next length-prefixed UTF-8 string; invalid UTF-8 is an error
    const length = this.varint();
    if (length > this.left) bad('a string is longer than the data');
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    try {
      // ignoreBOM keeps a leading U+FEFF as part of the string instead of dropping it.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice);
    } catch {
      return bad('a string is not valid UTF-8');
    }
  }
}

function readType(r: Reader): DataType {
  // Purpose: the next data type
  const id = r.byte();
  const name = TYPE_NAMES[id];
  if (name === undefined) bad(`unknown type id ${id}`);
  return t[name];
}

function readFields(r: Reader): Field[] {
  // Purpose: the next list of fields
  const n = r.count();
  const out: Field[] = [];
  for (let i = 0; i < n; i++) {
    const name = r.string();
    out.push({ name, type: readType(r) });
  }
  return out;
}

function readLiteral(r: Reader): LiteralValue {
  // Purpose: the next literal
  const kind = r.byte();
  switch (kind) {
    case L_FALSE:
      return false;
    case L_TRUE:
      return true;
    case L_INT: {
      const n = r.zigzag();
      // Larger integers are written as floats; accepting one here would give a plan two encodings.
      if (Math.abs(n) > MAX_ZIGZAG_INT) bad('an integer literal is larger than the integer form allows');
      return n;
    }
    case L_FLOAT: {
      const v = r.f64();
      // The same value must have one encoding: integers in range are written as integers, NaN has one bit pattern.
      if (Number.isInteger(v) && Math.abs(v) <= MAX_ZIGZAG_INT && !Object.is(v, -0)) bad('an integer literal is written as a float');
      return v;
    }
    case L_BIG:
      return r.u64();
    case L_NEG_BIG: {
      const magnitude = r.u64();
      if (magnitude === 0n) bad('a negative literal of zero');
      return -magnitude;
    }
    case L_STRING:
      return r.string();
    default:
      return bad(`unknown literal kind ${kind}`);
  }
}

function readExpr(r: Reader, depth: number): IrExpr {
  // Purpose: the next expression
  if (depth > MAX_DEPTH) bad('expression nested too deeply');
  const kind = EXPR_KINDS[r.byte()];
  if (kind === undefined) bad('unknown expression kind');
  const type = readType(r);
  switch (kind) {
    case 'field':
      return { kind, index: r.varint(), type };
    case 'literal':
      return { kind, value: readLiteral(r), type };
    case 'param':
      return { kind, name: r.string(), type };
    case 'call': {
      const fn = r.string();
      const n = r.count();
      const args: IrExpr[] = [];
      for (let i = 0; i < n; i++) args.push(readExpr(r, depth + 1));
      return { kind, fn, args, type };
    }
    case 'cast':
      return { kind, arg: readExpr(r, depth + 1), type };
    case 'lookup': {
      const arg = readExpr(r, depth + 1);
      return { kind, arg, table: r.varint(), type } as LookupExpr as unknown as IrExpr;
    }
    case 'in': {
      const arg = readExpr(r, depth + 1);
      const form = r.byte();
      if (form === 0) {
        const n = r.count();
        const values: LiteralValue[] = [];
        for (let i = 0; i < n; i++) values.push(readLiteral(r));
        return { kind, arg, values, param: null, type };
      }
      if (form === 1) return { kind, arg, values: null, param: r.string(), type };
      return bad(`unknown "in" form ${form}`);
    }
  }
}

function readExprs(r: Reader): IrExpr[] {
  // Purpose: the next list of expressions
  const n = r.count();
  const out: IrExpr[] = [];
  for (let i = 0; i < n; i++) out.push(readExpr(r, 0));
  return out;
}

function readNode(r: Reader): IrNode {
  // Purpose: the next node
  const op = OPS[r.byte()];
  if (op === undefined) bad('unknown node op');
  const schema = readFields(r);
  switch (op) {
    case 'scan':
      return { op, schema };
    case 'filter': {
      const input = r.varint();
      return { op, schema, input, predicate: readExpr(r, 0) };
    }
    case 'project': {
      const input = r.varint();
      return { op, schema, input, exprs: readExprs(r) };
    }
    case 'aggregate': {
      const input = r.varint();
      const keys = readExprs(r);
      const n = r.count();
      const aggs: IrAggregate[] = [];
      for (let i = 0; i < n; i++) {
        const fn = r.string();
        const type = readType(r);
        const has = r.byte();
        if (has > 1) bad('bad aggregate argument flag');
        aggs.push({ fn, type, arg: has === 1 ? readExpr(r, 0) : null });
      }
      return { op, schema, input, keys, aggs };
    }
    case 'sort': {
      const input = r.varint();
      const n = r.count();
      const keys: IrSortKey[] = [];
      for (let i = 0; i < n; i++) {
        const flags = r.byte();
        if (flags > 3) bad('bad sort flags');
        keys.push({ descending: (flags & 1) !== 0, nullsFirst: (flags & 2) !== 0, expr: readExpr(r, 0) });
      }
      return { op, schema, input, keys };
    }
    case 'limit': {
      const input = r.varint();
      return { op, schema, input, count: r.varint() };
    }
  }
}

export function decodePlan(bytes: Uint8Array): IrPlan {
  // Purpose: the plan in `bytes`; throws PlanError on anything malformed
  const r = new Reader(bytes);
  for (const b of MAGIC) if (r.byte() !== b) bad('not a zamda plan (bad magic number or format version)');
  const version = r.varint();
  if (version !== IR_VERSION) bad(`plan version ${version} is not supported (this build reads ${IR_VERSION})`);
  const input = readFields(r);
  const n = r.count();
  const nodes: IrNode[] = [];
  for (let i = 0; i < n; i++) nodes.push(readNode(r));
  const root = r.varint();
  const output = readFields(r);
  const p = r.count();
  const params: IrParam[] = [];
  for (let i = 0; i < p; i++) {
    const name = r.string();
    const type = readType(r);
    const list = r.byte();
    if (list > 1) bad('bad parameter list flag');
    params.push({ name, type, list: list === 1 });
  }
  if (r.left !== 0) bad('unexpected bytes after the plan');
  return { version, input, nodes, root, output, params };
}
