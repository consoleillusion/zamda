// Random typed expressions and random data for checking the engine's evaluator
// against the JS executor (tests/engine-eval.test.ts).

import type { IrExpr, IrParam, LiteralValue } from '../src/ir';
import { lookup } from '../src/registry';
import type { DataType, TypeName } from '../src/types';
import { t } from '../src/types';

export type Rng = () => number;

export function seeded(seed: number): Rng {
  // Purpose: a small deterministic random number generator (mulberry32)
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, list: readonly T[]): T {
  // Purpose: a random element
  return list[Math.floor(rng() * list.length)]!;
}

export const NUMERIC: readonly TypeName[] = [
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64',
];
export const ALL: readonly TypeName[] = [...NUMERIC, 'bool', 'date32', 'timestamp'];
const INTEGERS = NUMERIC.filter(n => !n.startsWith('float'));
const FLOATS = ['float32', 'float64'] as const;

const RANGES: Record<string, [bigint, bigint]> = {
  int8: [-128n, 127n],
  int16: [-32768n, 32767n],
  int32: [-2147483648n, 2147483647n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint8: [0n, 255n],
  uint16: [0n, 65535n],
  uint32: [0n, 4294967295n],
  uint64: [0n, 2n ** 64n - 1n],
};

const FLOAT_POOL = [0, -0, 1, -1, 0.5, -0.5, 2.5, -2.5, 3, 1e10, -1e10, NaN, Infinity, -Infinity, 1e-300, 3.5e38, 0.1];

export function dataValue(rng: Rng, type: TypeName, wild: boolean): LiteralValue {
  // Purpose: a value of a type: small ones mostly, and with `wild` also the extremes that overflow
  if (type === 'bool') return rng() < 0.5;
  if (type === 'date32') return pick(rng, [-1000, -1, 0, 1, 19000, 50000]);
  if (type === 'timestamp') return pick(rng, [-86400000, -1, 0, 1, 1700000000000]);
  if (type === 'float32' || type === 'float64') {
    return wild || rng() < 0.3 ? pick(rng, FLOAT_POOL) : Math.round((rng() - 0.5) * 40) / 4;
  }
  const [lo, hi] = RANGES[type]!;
  const big = type === 'int64' || type === 'uint64';
  let v: bigint;
  if (wild && rng() < 0.4) v = pick(rng, [lo, hi, lo + 1n, hi - 1n, 0n, 1n, lo < 0n ? -1n : 2n]);
  else {
    const small = BigInt(Math.floor(rng() * 40) - (lo < 0n ? 20 : 0));
    v = small < lo ? lo : small > hi ? hi : small;
  }
  return big ? v : Number(v);
}

export interface Case {
  readonly expr: IrExpr;
  readonly params: IrParam[];
  readonly values: Map<string, LiteralValue | LiteralValue[]>;
}

interface Ctx {
  rng: Rng;
  wild: boolean;
  // Field indexes by type (each type has two columns).
  fields: ReadonlyMap<TypeName, readonly number[]>;
  params: IrParam[];
  values: Map<string, LiteralValue | LiteralValue[]>;
}

function dt(name: TypeName): DataType {
  // Purpose: the data type descriptor for a name
  return t[name];
}

function call(fn: string, args: IrExpr[]): IrExpr {
  // Purpose: a call node whose type comes from the registry, so a bad combination fails here
  return { kind: 'call', fn, args, type: lookup(fn).returns(args.map(a => a.type)) };
}

function leaf(ctx: Ctx, type: TypeName): IrExpr {
  // Purpose: a column, a literal or a parameter of a type
  const r = ctx.rng();
  if (r < 0.55) return { kind: 'field', index: pick(ctx.rng, ctx.fields.get(type)!), type: dt(type) };
  const value = dataValue(ctx.rng, type, ctx.wild);
  if (r < 0.85) return { kind: 'literal', value, type: dt(type) };
  const name = `p${ctx.params.length}`;
  ctx.params.push({ name, type: dt(type), list: false });
  ctx.values.set(name, value);
  return { kind: 'param', name, type: dt(type) };
}

function listFor(ctx: Ctx, arg: IrExpr): IrExpr {
  // Purpose: an in() over literals or a list parameter
  const type = arg.type.name;
  const count = 1 + Math.floor(ctx.rng() * 6);
  const list = Array.from({ length: count }, () => dataValue(ctx.rng, type, ctx.wild));
  if (ctx.rng() < 0.5) return { kind: 'in', arg, values: list, param: null, type: t.bool };
  const name = `l${ctx.params.length}`;
  ctx.params.push({ name, type: dt(type), list: true });
  ctx.values.set(name, list);
  return { kind: 'in', arg, values: null, param: name, type: t.bool };
}

export function gen(ctx: Ctx, type: TypeName, depth: number): IrExpr {
  // Purpose: a random well-typed expression of `type`, at most `depth` calls deep
  const rng = ctx.rng;
  if (depth <= 0 || rng() < 0.25) return leaf(ctx, type);
  const sub = (ty: TypeName) => gen(ctx, ty, depth - 1);
  const choices: (() => IrExpr)[] = [];
  const same = (fn: string) => () => call(fn, [sub(type), sub(type)]);
  choices.push(() => call('if_else', [sub('bool'), sub(type), sub(type)]));
  choices.push(() => call('coalesce', [sub(type), sub(type)]));
  if (type === 'bool') {
    const any = pick(rng, ALL);
    const ordered = pick(rng, ALL.filter(x => x !== 'bool'));
    choices.push(
      () => call('eq', [sub(any), sub(any)]),
      () => call('neq', [sub(any), sub(any)]),
      () => call('lt', [sub(ordered), sub(ordered)]),
      () => call('lte', [sub(ordered), sub(ordered)]),
      () => call('gt', [sub(ordered), sub(ordered)]),
      () => call('gte', [sub(ordered), sub(ordered)]),
      () => call('is_null', [sub(any)]),
      () => call('is_nan', [sub(pick(rng, FLOATS))]),
      () => call('and', [sub('bool'), sub('bool')]),
      () => call('or', [sub('bool'), sub('bool')]),
      () => call('not', [sub('bool')]),
      () => listFor(ctx, sub(any)),
    );
  } else if (NUMERIC.includes(type)) {
    const isInt = INTEGERS.includes(type);
    choices.push(same('add'), same('sub'), same('mul'), same('add'));
    choices.push(() => ({ kind: 'cast', arg: sub(pick(rng, NUMERIC)), type: dt(type) }));
    choices.push(() => call('abs', [sub(type)]));
    if (isInt) {
      choices.push(same('wrapping_add'), same('wrapping_sub'), same('wrapping_mul'), same('int_div'), same('mod'));
    } else {
      choices.push(same('div'), same('mod'));
      choices.push(() => call('floor', [sub(type)]), () => call('ceil', [sub(type)]), () => call('round', [sub(type)]));
    }
    if (!type.startsWith('uint')) choices.push(() => call('neg', [sub(type)]));
    if (type === 'float64') {
      const i = pick(rng, INTEGERS);
      choices.push(() => call('div', [sub(i), sub(i)]));
    }
  }
  return pick(rng, choices)();
}

export function makeCase(
  rng: Rng,
  wild: boolean,
  fields: ReadonlyMap<TypeName, readonly number[]>,
  type: TypeName,
): Case {
  // Purpose: one random expression with its declared parameters and their values
  const ctx: Ctx = { rng, wild, fields, params: [], values: new Map() };
  const expr = gen(ctx, type, 1 + Math.floor(rng() * 3));
  return { expr, params: ctx.params, values: ctx.values };
}
