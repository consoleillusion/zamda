// T-405: the engine's chain runner (scan -> filter | project | limit) against the
// JS executor. Random plans run over random multi-segment tables with small
// chunks on both sides; they must return the same rows (values, nulls, order)
// or raise the same error. Row selection and early stop on a limit are the
// parts being checked.

import { describe, expect, test } from 'bun:test';
import { EngineTable } from '../src/backends/wasm/store';
import { executeJs } from '../src/backends/js/exec';
import { table as jsTable } from '../src/backends/js';
import { ExecutionError } from '../src/errors';
import type { IrExpr, IrParam, IrPlan, LiteralValue } from '../src/ir';
import { IR_VERSION } from '../src/ir';
import { encodeParams, encodePlan, TYPE_NAMES } from '../src/ir-binary';
import { schema } from '../src/schema';
import type { Field } from '../src/schema';
import { t } from '../src/types';
import type { TypeName } from '../src/types';
import { validate } from '../src/validate';
import { nativeHost } from './engine-host';
import { compareValues, readResult } from './engine-compare';
import { ALL, dataValue, makeCase, seeded } from './engine-eval-gen';
import type { Rng } from './engine-eval-gen';

const host = nativeHost();
if (host === null) console.warn('engine-run tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const WHATS = ['add', 'sub', 'mul', 'div', 'intDiv', 'mod', 'neg', 'abs', 'cast'];
const FIELDS = ALL.flatMap(type => [`${type}_a`, `${type}_b`]);
const SCHEMA = schema(Object.fromEntries(FIELDS.map(name => [name, t[name.replace(/_[ab]$/, '') as TypeName]])));

function storedValue(type: TypeName, v: LiteralValue): unknown {
  // Purpose: the JS value a loader expects for a data value of a type (dates as Date objects)
  if (type === 'date32') return new Date((v as number) * 86400000);
  if (type === 'timestamp') return new Date(v as number);
  return v;
}

function makeRows(rng: Rng, count: number, wild: boolean): Record<string, unknown>[] {
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

function rename(expr: IrExpr, prefix: string): IrExpr {
  // Purpose: the same expression with every parameter name prefixed, so several expressions can share one plan
  switch (expr.kind) {
    case 'field':
    case 'literal':
      return expr;
    case 'param':
      return { ...expr, name: prefix + expr.name };
    case 'call':
      return { ...expr, args: expr.args.map(a => rename(a, prefix)) };
    case 'cast':
      return { ...expr, arg: rename(expr.arg, prefix) };
    case 'in':
      return { ...expr, arg: rename(expr.arg, prefix), param: expr.param === null ? null : prefix + expr.param };
  }
}

interface Built {
  plan: IrPlan;
  values: Map<string, LiteralValue | LiteralValue[]>;
  shape: string;
}

function build(rng: Rng, wild: boolean, rowCount: number): Built {
  // Purpose: a random chain of filter, project and limit nodes with its parameters
  let fields: readonly Field[] = SCHEMA.list;
  const nodes: IrPlan['nodes'][number][] = [{ op: 'scan', schema: fields }];
  const params: IrParam[] = [];
  const values = new Map<string, LiteralValue | LiteralValue[]>();
  const shape: string[] = [];
  const indexes = () => {
    const map = new Map<TypeName, number[]>();
    fields.forEach((f, i) => map.set(f.type.name, [...(map.get(f.type.name) ?? []), i]));
    return map;
  };
  const expression = (type: TypeName): IrExpr => {
    const c = makeCase(rng, wild, indexes(), type);
    const prefix = `e${params.length}_`;
    for (const p of c.params) params.push({ ...p, name: prefix + p.name });
    for (const [k, v] of c.values) values.set(prefix + k, v);
    return rename(c.expr, prefix);
  };
  const steps = 1 + Math.floor(rng() * 4);
  for (let s = 0; s < steps; s++) {
    const r = rng();
    const input = nodes.length - 1;
    if (r < 0.4) {
      nodes.push({ op: 'filter', input, predicate: expression('bool'), schema: fields });
      shape.push('filter');
    } else if (r < 0.8) {
      const count = 1 + Math.floor(rng() * 3);
      const exprs = Array.from({ length: count }, () => expression(ALL[Math.floor(rng() * ALL.length)]!));
      fields = exprs.map((e, i) => ({ name: `c${i}`, type: e.type }));
      nodes.push({ op: 'project', input, exprs, schema: fields });
      shape.push('project');
    } else {
      const count = rng() < 0.15 ? 0 : Math.floor(rng() * rowCount * 1.2);
      nodes.push({ op: 'limit', input, count, schema: fields });
      shape.push(`limit ${count}`);
    }
  }
  const plan: IrPlan = { version: IR_VERSION, input: SCHEMA.list, nodes, root: nodes.length - 1, output: fields, params };
  return { plan: validate(plan), values, shape: shape.join(' > ') };
}

// How many plans exercised each path, so the test cannot pass on empty results alone.
const stats = { nonEmpty: 0, filtered: 0, limited: 0 };

async function runOne(rng: Rng, wild: boolean, label: string): Promise<'ok' | 'error' | 'unsupported'> {
  // Purpose: one random plan on both executors over the same segments and chunk size; the outcomes must match
  const h = host!;
  const rowCount = 20 + Math.floor(rng() * 80);
  const rows = makeRows(rng, rowCount, wild);
  const cut = rng() < 0.5 ? rowCount : 1 + Math.floor(rng() * (rowCount - 1));
  const chunkRows = 1 + Math.floor(rng() * 40);
  const built = build(rng, wild, rowCount);
  label = `${label} [${built.shape}] chunk ${chunkRows} cut ${cut}`;
  const js = jsTable(SCHEMA, rows.slice(0, cut) as never);
  const engineTable = new EngineTable(h, SCHEMA, rows.slice(0, cut) as never);
  if (cut < rowCount) {
    js.append(rows.slice(cut) as never);
    engineTable.append(rows.slice(cut) as never);
  }
  const snapshot = engineTable.snapshot();
  const planHandle = h.planLoad(encodePlan(built.plan));
  if (planHandle === 0) throw new Error(`${label}: the engine refused a valid plan (${h.evalError()})`);
  const paramsHandle = h.paramsLoad(planHandle, encodeParams(built.plan.params, built.values));
  if (paramsHandle === 0) throw new Error(`${label}: the engine refused the parameters (${h.evalError()})`);
  try {
    let jsScanned = 0;
    let jsError: unknown = null;
    let jsResult: Awaited<ReturnType<typeof executeJs>> | null = null;
    try {
      jsResult = await executeJs(built.plan, js.snapshot(), {
        params: built.values,
        chunkRows,
        onProgress: p => (jsScanned = p.rowsScanned),
      });
    } catch (e) {
      jsError = e;
    }
    const run = h.runNew(planHandle, paramsHandle, snapshot.handle, chunkRows);
    if (run === 0) throw new Error(`${label}: the engine could not start (${h.evalError()})`);
    let status = 0;
    while (status === 0) status = h.runStep(run);
    if (status > 1) {
      const code = h.evalError();
      const what = WHATS[h.evalErrorWhat()] ?? '';
      const type = TYPE_NAMES[h.evalErrorType()] ?? '';
      h.runFree(run);
      if (jsError === null) throw new Error(`${label}: the engine raised ${code} (${what} ${type}) but JS returned a result`);
      expect(jsError, label).toBeInstanceOf(ExecutionError);
      const message = (jsError as Error).message;
      if (code === 301) expect(message.startsWith(`Integer overflow in ${what} (${type})`), `${label}: ${message}`).toBe(true);
      else if (code === 302) expect(message, label).toBe(`Integer divide by zero in ${what}`);
      else throw new Error(`${label}: engine error ${code}, JS said "${message}"`);
      return 'error';
    }
    if (jsError !== null) {
      h.runFree(run);
      throw new Error(`${label}: JS raised "${(jsError as Error).message}" but the engine returned a result`);
    }
    // Rows read: the same count as the JS backend reports (it reads the same chunks).
    if (jsScanned > 0) expect(h.runScanned(run), `${label}: rows scanned`).toBe(jsScanned);
    const n = h.runFinish(run);
    expect(n, label).toBe(built.plan.output.length);
    const out = jsResult!;
    let expectedRows = out.rowCount;
    for (let c = 0; c < n; c++) {
      const e = readResult(h, h.runColumn(c));
      expect(e.rows, `${label}: rows`).toBe(expectedRows);
      expect(TYPE_NAMES[e.type], label).toBe(built.plan.output[c]!.type.name);
      compareValues(built.plan.output[c]!.type.name, out.columns[c]!, e, `${label} column ${c}`);
    }
    if (expectedRows > 0) stats.nonEmpty++;
    if (expectedRows > 0 && expectedRows < rowCount && built.shape.includes('filter')) stats.filtered++;
    if (built.shape.includes('limit') && expectedRows > 0 && expectedRows < rowCount) stats.limited++;
    return 'ok';
  } finally {
    h.paramsFree(paramsHandle);
    h.planFree(planHandle);
    snapshot.release();
    engineTable.dispose();
  }
}

maybe('engine chain runner against the JS executor', () => {
  for (const wild of [false, true]) {
    test(`random filter, project and limit chains (${wild ? 'extreme values' : 'small values'})`, async () => {
      // Purpose: thousands of random chains agree on rows, nulls, order and which error is raised
      let errors = 0;
      let total = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const rng = seeded(seed * 104729 + (wild ? 1 : 0));
        for (let k = 0; k < 20; k++) {
          total++;
          if ((await runOne(rng, wild, `seed ${seed} case ${k}`)) === 'error') errors++;
        }
      }
      console.log(`  ${total} plans, ${errors} raised on both sides (${wild ? 'extreme' : 'small'} values)`);
      if (wild) expect(errors).toBeGreaterThan(10);
      else expect(errors).toBeLessThan(total / 2);
      console.log(`  non-empty ${stats.nonEmpty}, partly filtered ${stats.filtered}, cut by a limit ${stats.limited}`);
      expect(stats.nonEmpty).toBeGreaterThan(total / 4);
      expect(stats.filtered).toBeGreaterThan(total / 20);
      expect(stats.limited).toBeGreaterThan(total / 20);
    }, 240000);
  }
});
