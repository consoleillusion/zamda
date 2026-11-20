// T-401: the binary IR round-trips exactly and the decoder survives bad input.

import { describe, expect, test } from 'bun:test';
import { count, list, pipe, schema, t } from '../src';
import type { IrExpr, IrPlan, LiteralValue } from '../src/ir';
import { IR_VERSION } from '../src/ir';
import { decodePlan, encodePlan } from '../src/ir-binary';
import { PlanError } from '../src/errors';
import { compilePlans } from './fixtures/sample-plans';
import { validate } from '../src/validate';

const People = schema({ name: t.utf8, age: t.int32, big: t.int64, score: t.float64, city: t.dictionary, born: t.date32, seen: t.timestamp, ok: t.bool });

function roundTrip(plan: IrPlan): IrPlan {
  // Purpose: encode, decode, and require the same plan back
  const back = decodePlan(encodePlan(plan));
  expect(back).toEqual(plan);
  return back;
}

function literalPlan(values: LiteralValue[]): IrPlan {
  // Purpose: a plan whose project node holds one literal per value, to test literal edge cases
  const field = { name: 'x', type: t.float64 };
  const exprs: IrExpr[] = values.map(value => ({ kind: 'literal', value, type: t.float64 }));
  return {
    version: IR_VERSION,
    input: [field],
    nodes: [
      { op: 'scan', schema: [field] },
      { op: 'project', input: 0, exprs, schema: values.map((_, i) => ({ name: `c${i}`, type: t.float64 })) },
    ],
    root: 1,
    output: values.map((_, i) => ({ name: `c${i}`, type: t.float64 })),
    params: [],
  };
}

describe('round trip', () => {
  test('the dashboard plans, with parameters, list parameters, strings and aggregates', () => {
    for (const plan of Object.values(compilePlans())) roundTrip(plan.ir);
  });

  test('every node kind and expression kind', () => {
    const plans = [
      pipe(People).filter(c => c.age.gt(30).and(c.city.isIn(['Auckland', 'Sydney'])).or(c.ok.not())).compile(),
      pipe(People).select(c => ({ a: c.age.cast(t.float64), n: c.name.upper(), d: c.big.add(1n) })).compile(),
      pipe(People).groupBy(c => ({ city: c.city })).agg(c => ({ n: count(), top: c.score.max(), who: c.name.min(), u: c.age.countDistinct() })).compile(),
      pipe(People).sort(c => [c.age.desc(), c.score.asc().nullsFirst(), c.name.asc()]).limit(25).compile(),
    ];
    for (const plan of plans) roundTrip(plan.ir);
  });

  test('a join binds its second scan and round-trips', () => {
    const id = { name: 'id', type: t.int32 };
    const leftValue = { name: 'left', type: t.utf8 };
    const rightValue = { name: 'right', type: t.dictionary };
    const plan: IrPlan = {
      version: IR_VERSION,
      input: [id, leftValue],
      nodes: [
        { op: 'scan', schema: [id, leftValue] },
        { op: 'scan', schema: [{ name: 'rid', type: t.int32 }, rightValue] },
        { op: 'join', input: 0, right: 1, leftKeys: [0], rightKeys: [0], how: 'left', schema: [id, leftValue, rightValue] },
      ],
      root: 2,
      output: [id, leftValue, rightValue],
      params: [],
    };
    roundTrip(plan);
  });

  test('a window round-trips its partitions, sorts and functions', () => {
    const group = { name: 'g', type: t.int32 };
    const score = { name: 'score', type: t.float64 };
    const name = { name: 'name', type: t.utf8 };
    const rank = { name: 'rank', type: t.int64 };
    const row = { name: 'row', type: t.int64 };
    const plan: IrPlan = {
      version: IR_VERSION,
      input: [group, score, name],
      nodes: [
        { op: 'scan', schema: [group, score, name] },
        {
          op: 'window',
          input: 0,
          partitions: [{ kind: 'field', index: 0, type: t.int32 }],
          sorts: [{ expr: { kind: 'field', index: 1, type: t.float64 }, descending: true, nullsFirst: false }],
          functions: [{ fn: 'rank', type: t.int64 }, { fn: 'row_number', type: t.int64 }],
          schema: [group, score, name, rank, row],
        },
      ],
      root: 1,
      output: [group, score, name, rank, row],
      params: [],
    };
    roundTrip(plan);
  });

  test('a decoded plan still validates', () => {
    for (const plan of Object.values(compilePlans())) validate(decodePlan(encodePlan(plan.ir)));
  });

  test('literal edge cases come back exactly', () => {
    const values: LiteralValue[] = [
      0, -0, 1, -1, 2 ** 52 - 1, -(2 ** 52 - 1), 2 ** 52, -(2 ** 52), 2 ** 52 + 1, -(2 ** 52) - 1, 2 ** 53 - 1, Number.MAX_VALUE, Number.MIN_VALUE, 0.1, -1.5,
      NaN, Infinity, -Infinity, 0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 64n - 1n, -(2n ** 64n) + 1n,
      '', 'x', '\ufeffbom first', 'naïve ☃ 😀', 'line\nbreak', 'a'.repeat(300), true, false,
    ];
    const back = roundTrip(literalPlan(values));
    const got = (back.nodes[1] as unknown as { exprs: { value: LiteralValue }[] }).exprs.map(e => e.value);
    values.forEach((v, i) => expect(Object.is(got[i], v)).toBe(true));
  });

  test('a long list in an "in" expression and a deeply nested expression', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `city${i}`);
    roundTrip(pipe(People).filter(c => c.city.isIn(many)).compile().ir);
    let e = (pipe(People).compile() as unknown as { ir: IrPlan }).ir;
    expect(e.nodes.length).toBe(1);
    const nest = (depth: number): IrExpr => (depth === 0 ? { kind: 'field', index: 0, type: t.bool } : { kind: 'call', fn: 'not', args: [nest(depth - 1)], type: t.bool });
    const field = { name: 'ok', type: t.bool };
    e = {
      version: IR_VERSION,
      input: [field],
      nodes: [{ op: 'scan', schema: [field] }, { op: 'filter', input: 0, predicate: nest(150), schema: [field] }],
      root: 1,
      output: [field],
      params: [],
    };
    roundTrip(e);
  });

  test('equal plans give equal bytes, and the encoding is compact', () => {
    const plan = compilePlans().networks.ir;
    const a = encodePlan(plan);
    const b = encodePlan(decodePlan(a));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a.length).toBeLessThan(JSON.stringify(plan).length / 3);
  });
});

describe('bad input', () => {
  const good = encodePlan(compilePlans().regions.ir);

  test('every truncation is a PlanError', () => {
    for (let n = 0; n < good.length; n++) {
      expect(() => decodePlan(good.subarray(0, n))).toThrow(PlanError);
    }
  });

  test('trailing bytes, wrong magic and wrong versions are PlanErrors', () => {
    expect(() => decodePlan(new Uint8Array([...good, 0]))).toThrow(PlanError);
    const magic = good.slice();
    magic[0] = 0;
    expect(() => decodePlan(magic)).toThrow(PlanError);
    const format = good.slice();
    format[3] = 2;
    expect(() => decodePlan(format)).toThrow(PlanError);
    const version = good.slice();
    version[4] = IR_VERSION + 1;
    expect(() => decodePlan(version)).toThrow(PlanError);
    expect(() => decodePlan(new Uint8Array(0))).toThrow(PlanError);
  });

  test('flipping any byte either decodes or raises a PlanError, never another error', () => {
    for (let i = 0; i < good.length; i++) {
      for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
        const copy = good.slice();
        copy[i] = copy[i]! ^ bit;
        try {
          decodePlan(copy);
        } catch (error) {
          expect(error).toBeInstanceOf(PlanError);
        }
      }
    }
  });

  test('random bytes never crash the decoder', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 24;
    };
    for (let round = 0; round < 2000; round++) {
      const bytes = new Uint8Array(1 + (next() % 80));
      for (let i = 0; i < bytes.length; i++) bytes[i] = next();
      // Half the rounds start with a valid header so the parser gets past the magic check.
      if (round % 2 === 0) bytes.set([0x5a, 0x49, 0x52, 0x01, IR_VERSION].slice(0, bytes.length));
      try {
        decodePlan(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(PlanError);
      }
    }
  });

  test('huge counts, over-long and non-minimal numbers, and over-deep nesting are refused', () => {
    const head = [0x5a, 0x49, 0x52, 0x01, IR_VERSION];
    expect(() => decodePlan(new Uint8Array([...head, 0xff, 0xff, 0xff, 0xff, 0x0f]))).toThrow(PlanError); // 4 billion input fields
    expect(() => decodePlan(new Uint8Array([...head, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))).toThrow(PlanError); // 9-byte varint
    // An empty plan is five zero counts: no input fields, no nodes, root 0, no output fields, no parameters.
    expect(decodePlan(new Uint8Array([...head, 0, 0, 0, 0, 0])).nodes).toEqual([]);
    // The same plan with the root written as zero in two bytes is refused: every number has one encoding.
    expect(() => decodePlan(new Uint8Array([...head, 0, 0, 0x80, 0x00, 0, 0]))).toThrow(PlanError);
    const field = { name: 'ok', type: t.bool };
    let deep: IrExpr = { kind: 'field', index: 0, type: t.bool };
    for (let i = 0; i < 400; i++) deep = { kind: 'call', fn: 'not', args: [deep], type: t.bool };
    const plan: IrPlan = { version: IR_VERSION, input: [field], nodes: [{ op: 'scan', schema: [field] }, { op: 'filter', input: 0, predicate: deep, schema: [field] }], root: 1, output: [field], params: [] };
    expect(() => encodePlan(plan)).toThrow(PlanError);
  });

  test('a value with a second encoding is refused: big integers as ints, whole floats, odd NaNs', () => {
    const plan = literalPlan([7]);
    const bytes = encodePlan(plan);
    // The literal is the last three bytes of the project node's expression list: kind 2 (int), then zigzag 14.
    const at = bytes.findIndex((b, i) => b === 2 && bytes[i + 1] === 14);
    expect(at).toBeGreaterThan(0);
    const asFloat = (value: number): Uint8Array => {
      // Purpose: the same plan with the literal rewritten as a float64
      const f = new Uint8Array(9);
      f[0] = 3;
      new DataView(f.buffer).setFloat64(1, value, true);
      return new Uint8Array([...bytes.subarray(0, at), ...f, ...bytes.subarray(at + 2)]);
    };
    expect(() => decodePlan(asFloat(7))).toThrow(PlanError); // 7 must be an int
    expect(decodePlan(asFloat(7.5))).toBeTruthy(); // a real fraction is a float
    const nan = asFloat(NaN);
    expect(decodePlan(nan)).toBeTruthy(); // the standard NaN is fine
    nan[at + 8] = 0x7f; // flip a high byte into another NaN pattern
    nan[at + 7] = 0xf9;
    expect(() => decodePlan(nan)).toThrow(PlanError);
    // An int literal of -2^52 (zigzag 2^53 - 1) is refused: integers that large are written as floats.
    const big = new Uint8Array([...bytes.subarray(0, at), 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f, ...bytes.subarray(at + 2)]);
    expect(() => decodePlan(big)).toThrow(PlanError);
  });

  test('a string that is not UTF-8, or has a lone surrogate, is refused', () => {
    const plan = literalPlan(['abc']);
    const bytes = encodePlan(plan);
    const at = bytes.lastIndexOf(0x61); // the "a" of "abc"
    const broken = bytes.slice();
    broken[at] = 0xff;
    expect(() => decodePlan(broken)).toThrow(PlanError);
    expect(() => encodePlan(literalPlan(['\ud800']))).toThrow(PlanError);
  });
});

// list() is used only to keep the import list honest with the API under test.
void list;
