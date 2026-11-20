// T-404: the engine's expression evaluator against the JS executor. Random
// well-typed expressions run over random data (with nulls and the extreme
// values that overflow) on both; they must agree on every non-null value, on
// which rows are null, and on which error is raised. The evaluator is also
// checked on its own: splitting the rows into batches must not change a result.

import { describe, expect, test } from 'bun:test';
import { EngineTable } from '../src/backends/wasm/store';
import { executeJs } from '../src/backends/js/exec';
import { table as jsTable } from '../src/backends/js';
import type { Column } from '../src/column';
import { ExecutionError } from '../src/errors';
import type { IrExpr, IrPlan, LiteralValue } from '../src/ir';
import { IR_VERSION, walkExpr } from '../src/ir';
import { encodeParams, encodePlan, TYPE_NAMES } from '../src/ir-binary';
import { schema } from '../src/schema';
import { t } from '../src/types';
import type { TypeName } from '../src/types';
import { validate } from '../src/validate';
import { nativeHost } from './engine-host';
import { compareValues } from './engine-compare';
import type { Engine } from './engine-compare';
import { ALL, dataValue, makeCase, seeded } from './engine-eval-gen';
import type { Case } from './engine-eval-gen';

const host = nativeHost();
if (host === null) console.warn('engine-eval tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const WHATS = ['add', 'sub', 'mul', 'div', 'intDiv', 'mod', 'neg', 'abs', 'cast'];
const OVERFLOW = 301;
const DIVIDE_BY_ZERO = 302;

// Two columns of every type, in this order.
const FIELDS = ALL.flatMap(type => [`${type}_a`, `${type}_b`]);
const SCHEMA = schema(Object.fromEntries(FIELDS.map(name => [name, t[name.replace(/_[ab]$/, '') as TypeName]])));
const INDEXES = new Map<TypeName, number[]>(ALL.map(type => [type, [FIELDS.indexOf(`${type}_a`), FIELDS.indexOf(`${type}_b`)]]));

function storedValue(type: TypeName, v: LiteralValue): unknown {
  // Purpose: the JS value a loader expects for a data value of a type (dates as Date objects)
  if (type === 'date32') return new Date((v as number) * 86400000);
  if (type === 'timestamp') return new Date(v as number);
  return v;
}

function makeRows(rng: () => number, count: number, wild: boolean): Record<string, unknown>[] {
  // Purpose: random rows for the schema, some columns with nulls
  const nullable = new Set(FIELDS.filter(() => rng() < 0.5));
  return Array.from({ length: count }, () => {
    const row: Record<string, unknown> = {};
    for (const name of FIELDS) {
      const type = name.replace(/_[ab]$/, '') as TypeName;
      row[name] = nullable.has(name) && rng() < 0.25 ? null : storedValue(type, dataValue(rng, type, wild));
    }
    return row;
  });
}

function planFor(c: Case): IrPlan {
  // Purpose: scan then project one expression: the smallest plan that evaluates it
  const out = [{ name: 'out', type: c.expr.type }];
  return {
    version: IR_VERSION,
    input: SCHEMA.list,
    nodes: [
      { op: 'scan', schema: SCHEMA.list },
      { op: 'project', input: 0, exprs: [c.expr], schema: out },
    ],
    root: 1,
    output: out,
    params: c.params,
  };
}

type Outcome = { ok: true; engine: Engine } | { ok: false; code: number; what: string; type: string };

function evaluate(plan: number, params: number, snapshot: number, start: number, rows: number): Outcome {
  // Purpose: evaluate expression 0 of node 1 over a range of rows and copy the result out of the engine
  const h = host!;
  const r = h.eval(plan, params, 1, 0, snapshot, 0, start, rows);
  if (r === 0) {
    const code = h.evalError();
    return { ok: false, code, what: WHATS[h.evalErrorWhat()] ?? '', type: TYPE_NAMES[h.evalErrorType()] ?? '' };
  }
  const type = h.resultType(r);
  const n = h.resultRows(r);
  const width = (({ bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, date32: 4, utf8: 4, dictionary: 4 }) as Record<string, number>)[TYPE_NAMES[type]!] ?? 8;
  const values = h.view(h.resultValues(r), n * width).slice();
  const v = h.resultValid(r);
  const valid = v === 0 ? null : h.view(v, n).slice();
  h.resultFree(r);
  return { ok: true, engine: { rows: n, type, values, valid } };
}

async function runCase(c: Case, rows: Record<string, unknown>[], label: string): Promise<'ok' | 'error'> {
  // Purpose: run one expression on both executors and require the same outcome
  const h = host!;
  const plan = validate(planFor(c));
  const js = jsTable(SCHEMA, rows as never);
  const engineTable = new EngineTable(h, SCHEMA, rows as never);
  const snapshot = engineTable.snapshot();
  const planHandle = h.planLoad(encodePlan(plan));
  if (planHandle === 0) throw new Error(`${label}: the engine refused a plan the JS validator accepts (error ${h.evalError()})`);
  const paramsHandle = h.paramsLoad(planHandle, encodeParams(plan.params, c.values));
  if (paramsHandle === 0) throw new Error(`${label}: the engine refused the parameters (error ${h.evalError()})`);
  try {
    let jsError: unknown = null;
    let jsResult: Column | null = null;
    try {
      jsResult = (await executeJs(plan, js.snapshot(), { params: c.values })).columns[0]!;
    } catch (e) {
      jsError = e;
    }
    const n = rows.length;
    const outcome = evaluate(planHandle, paramsHandle, snapshot.handle, 0, n);
    if (jsError !== null) {
      expect(jsError, label).toBeInstanceOf(ExecutionError);
      const message = (jsError as Error).message;
      if (outcome.ok) throw new Error(`${label}: JS raised "${message}" but the engine returned a result`);
      if (outcome.code === OVERFLOW) expect(message.startsWith(`Integer overflow in ${outcome.what} (${outcome.type})`), `${label}: ${message}`).toBe(true);
      else if (outcome.code === DIVIDE_BY_ZERO) expect(message, label).toBe(`Integer divide by zero in ${outcome.what}`);
      else throw new Error(`${label}: engine error ${outcome.code}, JS said "${message}"`);
      return 'error';
    }
    if (!outcome.ok) throw new Error(`${label}: the engine raised ${outcome.code} (${outcome.what} ${outcome.type}) but JS returned a result`);
    expect(TYPE_NAMES[outcome.engine.type], label).toBe(c.expr.type.name);
    compareValues(c.expr.type.name, jsResult!, outcome.engine, label);
    // C-CHUNK for the engine alone: two halves give the same values as the whole.
    if (n >= 4) {
      const cut = Math.floor(n / 3);
      const a = evaluate(planHandle, paramsHandle, snapshot.handle, 0, cut);
      const b = evaluate(planHandle, paramsHandle, snapshot.handle, cut, n - cut);
      if (!a.ok || !b.ok) throw new Error(`${label}: a half raised where the whole did not`);
      const joined = new Uint8Array(a.engine.values.length + b.engine.values.length);
      joined.set(a.engine.values);
      joined.set(b.engine.values, a.engine.values.length);
      let valid: Uint8Array | null = null;
      if (a.engine.valid || b.engine.valid) {
        valid = new Uint8Array(n);
        valid.set(a.engine.valid ?? new Uint8Array(a.engine.rows).fill(1));
        valid.set(b.engine.valid ?? new Uint8Array(b.engine.rows).fill(1), a.engine.rows);
      }
      compareValues(c.expr.type.name, jsResult!, { rows: n, type: outcome.engine.type, values: joined, valid }, `${label} (in two batches)`);
    }
    return 'ok';
  } finally {
    h.paramsFree(paramsHandle);
    h.planFree(planHandle);
    snapshot.release();
    engineTable.dispose();
  }
}

maybe('engine evaluator against the JS executor', () => {
  for (const wild of [false, true]) {
    test(`random expressions over random data (${wild ? 'extreme values' : 'small values'})`, async () => {
      // Purpose: thousands of random expressions agree, including which ones raise
      let errors = 0;
      let total = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const rng = seeded(seed * 7919 + (wild ? 1 : 0));
        const rows = makeRows(rng, 40 + Math.floor(rng() * 60), wild);
        for (let k = 0; k < 40; k++) {
          const type = ALL[Math.floor(rng() * ALL.length)]!;
          const c = makeCase(rng, wild, INDEXES, type);
          total++;
          if ((await runCase(c, rows, `seed ${seed} case ${k} (${type})`)) === 'error') errors++;
        }
      }
      console.log(`  ${total} expressions, ${errors} raised on both sides (${wild ? 'extreme' : 'small'} values)`);
      // Small values must mostly run; extreme values must raise sometimes, or the error paths are untested.
      if (wild) expect(errors).toBeGreaterThan(20);
      else expect(errors).toBeLessThan(total / 3);
    }, 120000);
  }
});

// The scalar functions the engine evaluates (T-404), and the casts between every pair of numeric types.
const ENGINE_FUNCTIONS = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_null', 'is_nan', 'coalesce', 'if_else', 'and', 'or', 'not',
  'add', 'sub', 'mul', 'wrapping_add', 'wrapping_sub', 'wrapping_mul', 'div', 'int_div', 'mod', 'neg', 'abs',
  'floor', 'ceil', 'round', 'date_trunc', 'extract',
];

test('the random expressions reach every function, cast pair, and expression kind', () => {
  // Purpose: the cross-check is only as good as what it generates: nothing the engine evaluates may be left out
  const seen = new Map<string, number>();
  const bump = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1);
  for (let seed = 1; seed <= 100; seed++) {
    const rng = seeded(seed * 7919);
    for (let k = 0; k < 60; k++) {
      const c = makeCase(rng, seed % 2 === 0, INDEXES, ALL[Math.floor(rng() * ALL.length)]!);
      walkExpr(c.expr, e => {
        if (e.kind === 'call') bump(e.fn);
        else if (e.kind === 'cast') bump(`cast ${e.arg.type.name} to ${e.type.name}`);
        else bump(e.kind + (e.kind === 'in' ? (e.param ? ' param' : ' values') : ''));
      });
    }
  }
  for (const fn of ENGINE_FUNCTIONS) expect(seen.get(fn) ?? 0, fn).toBeGreaterThan(20);
  for (const kind of ['field', 'literal', 'param', 'in values', 'in param']) expect(seen.get(kind) ?? 0, kind).toBeGreaterThan(20);
  const numeric = ['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64'];
  for (const from of numeric) for (const to of numeric) expect(seen.get(`cast ${from} to ${to}`) ?? 0, `cast ${from} to ${to}`).toBeGreaterThan(0);
});
