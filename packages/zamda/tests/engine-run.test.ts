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
import type { IrAggregate, IrExpr, IrParam, IrPlan, LiteralValue } from '../src/ir';
import { IR_VERSION } from '../src/ir';
import { encodeParams, encodePlan, TYPE_NAMES } from '../src/ir-binary';
import type { Column } from '../src/column';
import { schema } from '../src/schema';
import type { Field } from '../src/schema';
import { t } from '../src/types';
import type { TypeName } from '../src/types';
import { validate } from '../src/validate';
import { nativeHost } from './engine-host';
import { buildCanon } from '../src/backends/wasm/canon';
import { buildLookupTable, deriveLookups } from '../src/backends/wasm/derive';
import { lookup as registryLookup } from '../src/registry';
import { texts } from '../src/column';
import { compareValues, readResult } from './engine-compare';
import type { Engine } from './engine-compare';
import { ALL, dataValue, makeCase, seeded } from './engine-eval-gen';
import type { Rng } from './engine-eval-gen';

const host = nativeHost();
if (host === null) console.warn('engine-run tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const WHATS = ['add', 'sub', 'mul', 'div', 'intDiv', 'mod', 'neg', 'abs', 'cast', 'sum'];
const NUMERIC_FIELDS = ALL.flatMap(type => [`${type}_a`, `${type}_b`]);
const STRING_FIELDS = ['utf8_a', 'utf8_b', 'dictionary_a', 'dictionary_b'];
const FIELDS = [...NUMERIC_FIELDS, ...STRING_FIELDS];
const SCHEMA = schema(Object.fromEntries(FIELDS.map(name => [name, t[name.replace(/_[ab]$/, '') as TypeName]])));
// Strings that differ in case, length, and where UTF-16 and code-point order disagree.
const WORDS = ['', 'a', 'b', 'B', 'ab', 'zz', 'é', 'e', 'Z', '\u{FFFF}', '\u{1F600}', '\u{10000}', 'a b', 'aa'];

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
      if (STRING_FIELDS.includes(name)) {
        row[name] = nullable.has(name) && rng() < 0.25 ? null : WORDS[Math.floor(rng() * WORDS.length)];
        continue;
      }
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
    if (r < 0.2) {
      // Group by some columns or small expressions and compute some aggregates.
      const keyCount = Math.floor(rng() * 4);
      const keys = Array.from({ length: keyCount }, () => {
        if (rng() < 0.6) {
          const i = Math.floor(rng() * fields.length);
          return { kind: 'field', index: i, type: fields[i]!.type } as IrExpr;
        }
        return expression(ALL[Math.floor(rng() * ALL.length)]!);
      });
      const aggCount = 1 + Math.floor(rng() * 4);
      const aggs: IrAggregate[] = [];
      for (let a = 0; a < aggCount; a++) {
        const argument = () =>
          rng() < 0.6
            ? ({ kind: 'field', index: Math.floor(rng() * fields.length), type: undefined } as unknown as IrExpr)
            : expression(ALL[Math.floor(rng() * ALL.length)]!);
        const fix = (e: IrExpr): IrExpr => (e.kind === 'field' && e.type === undefined ? { ...e, type: fields[e.index]!.type } : e);
        const fn = ['count', 'count', 'count_distinct', 'sum', 'avg', 'min', 'max'][Math.floor(rng() * 7)]!;
        if (fn === 'count' && rng() < 0.5) {
          aggs.push({ fn, arg: null, type: t.uint32 });
          continue;
        }
        let arg = fix(argument());
        const name = arg.type.name;
        if ((fn === 'sum' || fn === 'avg') && (name === 'bool' || name === 'utf8' || name === 'dictionary')) arg = expression('int32');
        if ((fn === 'sum' || fn === 'avg') && (name === 'date32' || name === 'timestamp')) arg = expression('int64');
        if ((fn === 'min' || fn === 'max') && name === 'bool') arg = expression('uint8');
        const argName = arg.type.name;
        const type =
          fn === 'count' || fn === 'count_distinct' ? t.uint32
          : fn === 'avg' ? t.float64
          : fn === 'sum' ? (argName.startsWith('float') ? t.float64 : argName.startsWith('uint') ? t.uint64 : t.int64)
          : arg.type;
        aggs.push({ fn, arg, type });
      }
      fields = [...keys.map((k, i) => ({ name: `k${i}`, type: k.type })), ...aggs.map((a, i) => ({ name: `a${i}`, type: a.type }))];
      nodes.push({ op: 'aggregate', input, keys, aggs, schema: fields });
      shape.push(`aggregate ${keyCount} keys ${aggs.map(a => a.fn).join(',')}`);
    } else if (r < 0.4) {
      // Sort by one to three keys, columns or small expressions, in either direction and with nulls either way.
      const keyCount = 1 + Math.floor(rng() * 3);
      const keys = Array.from({ length: keyCount }, () => {
        const expr =
          rng() < 0.7
            ? ({ kind: 'field', index: Math.floor(rng() * fields.length), type: fields[0]!.type } as IrExpr)
            : expression(ALL[Math.floor(rng() * ALL.length)]!);
        const typed = expr.kind === 'field' ? { ...expr, type: fields[expr.index]!.type } : expr;
        // bool is not sortable.
        const fixed = typed.type.name === 'bool' ? expression('int16') : typed;
        return { expr: fixed, descending: rng() < 0.5, nullsFirst: rng() < 0.5 };
      });
      nodes.push({ op: 'sort', input, keys, schema: fields });
      shape.push(`sort ${keyCount}`);
    } else if (r < 0.6) {
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

function compareStringColumns(js: Column, e: Engine, strings: readonly string[], label: string): void {
  // Purpose: a string result from the engine (canonical ids) equals the JS column's strings, and null rows agree
  const ids = new Int32Array(e.values.buffer.slice(e.values.byteOffset, e.values.byteOffset + e.values.byteLength));
  const expected = texts(js);
  expect(ids.length, label).toBe(expected.length);
  for (let i = 0; i < ids.length; i++) {
    const jsNull = js.valid !== null && js.valid !== undefined && js.valid[i] === 0;
    const engineNull = e.valid !== null && e.valid[i] === 0;
    if (jsNull !== engineNull) throw new Error(`${label}: row ${i} validity differs (js ${!jsNull}, engine ${!engineNull})`);
    if (!jsNull && strings[ids[i]!] !== expected[i]) throw new Error(`${label}: row ${i} differs (js ${JSON.stringify(expected[i])}, engine ${JSON.stringify(strings[ids[i]!])})`);
  }
}

// How many plans exercised each path, so the test cannot pass on empty results alone.
const stats = { nonEmpty: 0, filtered: 0, limited: 0, groups: 0, strings: 0, sorted: 0, topK: 0, fns: new Map<string, number>() };

async function runOne(rng: Rng, wild: boolean, label: string, skip = false): Promise<'ok' | 'error' | 'unsupported'> {
  // Purpose: one random plan on both executors over the same segments and chunk size; the outcomes must match
  const rowCount = 20 + Math.floor(rng() * 80);
  const rows = makeRows(rng, rowCount, wild);
  const cut = rng() < 0.5 ? rowCount : 1 + Math.floor(rng() * (rowCount - 1));
  const chunkRows = 1 + Math.floor(rng() * 40);
  const built = build(rng, wild, rowCount);
  if (skip) return 'ok';
  return compareRun(built, rows, cut, chunkRows, `${label} [${built.shape}] chunk ${chunkRows} cut ${cut}`);
}

let lookupCount = 0;

async function compareRun(built: Built, rows: Record<string, unknown>[], cut: number, chunkRows: number, label: string): Promise<'ok' | 'error'> {
  // Purpose: run a plan on both executors over a table of one or two segments and require the same outcome
  const h = host!;
  const rowCount = rows.length;
  const debug = process.env.ZAMDA_CASE !== undefined;
  const js = jsTable(SCHEMA, rows.slice(0, cut) as never);
  const engineTable = new EngineTable(h, SCHEMA, rows.slice(0, cut) as never);
  if (cut < rowCount) {
    js.append(rows.slice(cut) as never);
    engineTable.append(rows.slice(cut) as never);
  }
  const snapshot = engineTable.snapshot();
  // The engine has no string functions: expressions of one string column become lookups (T-414).
  const derived = deriveLookups(built.plan);
  const planHandle = h.planLoad(encodePlan(derived.plan));
  if (planHandle === 0) throw new Error(`${label}: the engine refused a valid plan (${h.evalError()})`);
  const paramsHandle = h.paramsLoad(planHandle, encodeParams(built.plan.params, built.values));
  if (paramsHandle === 0) throw new Error(`${label}: the engine refused the parameters (${h.evalError()})`);
  const universe = buildCanon(snapshot, STRING_FIELDS.map(name => FIELDS.indexOf(name))).strings;
  for (const spec of derived.lookups) {
    const table = buildLookupTable(spec, universe, built.values);
    expect(h.paramsTable(paramsHandle, spec.table, table.values, table.valid, table.entries), `${label}: table ${spec.table} (${h.evalError()})`).toBe(0);
  }
  lookupCount += derived.lookups.length;
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
    const stringColumns = STRING_FIELDS.map(name => FIELDS.indexOf(name));
    const canon = buildCanon(snapshot, stringColumns);
    for (const [segment, byColumn] of canon.maps) {
      for (const [column, map] of byColumn) expect(h.runCanon(run, column, segment, map), `${label}: map`).toBe(0);
    }
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
      throw new Error(`${label}: JS raised "${(jsError as Error).message}" but the engine returned a result\n${JSON.stringify(built.plan.nodes.slice(1), (_k, v) => (typeof v === 'bigint' ? `${v}n` : _k === 'schema' ? undefined : v))}\n${JSON.stringify([...built.values], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
    }
    // Rows read: the same count as the JS backend reports (it reads the same chunks).
    if (jsScanned > 0) expect(h.runScanned(run), `${label}: rows scanned`).toBe(jsScanned);
    const n = h.runFinish(run);
    expect(n, label).toBe(built.plan.output.length);
    const out = jsResult!;
    let expectedRows = out.rowCount;
    if (debug) {
      console.log(label, JSON.stringify(built.plan.nodes.slice(1), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
      console.log('js rows', out.rowCount, out.columns.map(c => `${c.type.name}: ${Array.from(c.values as ArrayLike<unknown>).slice(0, 12).map(String)} valid ${c.valid ? Array.from(c.valid).slice(0, 12) : '-'}`));
    }
    for (let c = 0; c < n; c++) {
      const e = readResult(h, h.runColumn(c));
      if (debug) console.log('engine rows', e.rows, 'type', TYPE_NAMES[e.type], 'values', Array.from(e.values.slice(0, 40)).join(','), 'valid', e.valid ? Array.from(e.valid).slice(0, 14).join(',') : '-');
      expect(e.rows, `${label}: rows`).toBe(expectedRows);
      expect(TYPE_NAMES[e.type], label).toBe(built.plan.output[c]!.type.name);
      const outType = built.plan.output[c]!.type.name;
      if (outType === 'utf8' || outType === 'dictionary') compareStringColumns(out.columns[c]!, e, canon.strings, `${label} column ${c}`);
      else compareValues(outType, out.columns[c]!, e, `${label} column ${c}`);
    }
    if (expectedRows > 0) stats.nonEmpty++;
    if (expectedRows > 0 && expectedRows < rowCount && built.shape.includes('filter')) stats.filtered++;
    if (built.shape.includes('aggregate') && expectedRows > 1) {
      stats.groups++;
      if (built.plan.output.some(f => f.type.name === 'utf8' || f.type.name === 'dictionary')) stats.strings++;
      for (const fn of ['count', 'count_distinct', 'sum', 'avg', 'min', 'max']) {
        if (built.shape.split('aggregate')[1]!.split(/[ >]/).some(w => w.split(',').includes(fn))) stats.fns.set(fn, (stats.fns.get(fn) ?? 0) + 1);
      }
    }
    if (built.shape.includes('sort') && expectedRows > 1) stats.sorted++;
    if (/sort \d > limit/.test(built.shape) && expectedRows > 1) stats.topK++;
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
      // ZAMDA_CASE=seed:case:wild runs one case alone and prints what both sides produced.
      const only = process.env.ZAMDA_CASE?.split(':');
      for (let seed = 1; seed <= 150; seed++) {
        const rng = seeded(seed * 104729 + (wild ? 1 : 0));
        for (let k = 0; k < 20; k++) {
          if (only && (Number(only[0]) !== seed || Number(only[1]) !== k || Number(only[2]) !== Number(wild))) {
            await runOne(rng, wild, '', true);
            continue;
          }
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
      console.log(`  aggregates with several rows ${stats.groups}; by function ${[...stats.fns].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      console.log(`  of those, with a string result column ${stats.strings}`);
      console.log(`  sorts with several rows ${stats.sorted}, of them cut by a limit right after ${stats.topK}`);
      expect(stats.sorted).toBeGreaterThan(200);
      expect(stats.topK).toBeGreaterThan(20);
      expect(stats.groups).toBeGreaterThan(100);
      expect(stats.strings).toBeGreaterThan(30);
      for (const fn of ['count', 'count_distinct', 'sum', 'avg', 'min', 'max']) expect(stats.fns.get(fn) ?? 0, fn).toBeGreaterThan(30);
    }, 240000);
  }
});

// ---------------------------------------------------------------------------
// Directed cases: the boundaries random data rarely reaches
// ---------------------------------------------------------------------------

const col = (name: string) => FIELDS.indexOf(name);

function aggregatePlan(keys: string[], aggs: [string, string | null][]): Built {
  // Purpose: a scan then one aggregate over named columns: group by `keys`, compute (function, column) pairs
  const field = (name: string): IrExpr => ({ kind: 'field', index: col(name), type: SCHEMA.list[col(name)]!.type });
  const irAggs: IrAggregate[] = aggs.map(([fn, name]) => {
    const arg = name === null ? null : field(name);
    const argName = arg?.type.name ?? '';
    const type =
      fn === 'count' || fn === 'count_distinct' ? t.uint32
      : fn === 'avg' ? t.float64
      : fn === 'sum' ? (argName.startsWith('float') ? t.float64 : argName.startsWith('uint') ? t.uint64 : t.int64)
      : arg!.type;
    return { fn, arg, type };
  });
  const fields: Field[] = [...keys.map((k, i) => ({ name: `k${i}`, type: field(k).type })), ...irAggs.map((a, i) => ({ name: `a${i}`, type: a.type }))];
  const plan: IrPlan = {
    version: IR_VERSION,
    input: SCHEMA.list,
    nodes: [
      { op: 'scan', schema: SCHEMA.list },
      { op: 'aggregate', input: 0, keys: keys.map(field), aggs: irAggs, schema: fields },
    ],
    root: 1,
    output: fields,
    params: [],
  };
  return { plan: validate(plan), values: new Map(), shape: `directed ${keys.join(',')} ${aggs.map(a => a.join(':')).join(',')}` };
}

function fill(partial: Record<string, unknown>): Record<string, unknown> {
  // Purpose: a full row from a few columns (the rest null)
  const row: Record<string, unknown> = {};
  for (const name of FIELDS) row[name] = partial[name] ?? null;
  return row;
}

maybe('engine aggregates: boundaries', () => {
  test('integer sums raise exactly when the total leaves the result type', async () => {
    const big = 2n ** 63n - 1n;
    const cases: [string, bigint[], boolean][] = [
      ['int64_a', [big, 1n], true],
      ['int64_a', [big, 0n], false],
      ['int64_a', [big, -1n, 1n], false],
      ['int64_a', [-(2n ** 63n), -1n], true],
      ['int64_a', [-(2n ** 63n), 1n], false],
      ['uint64_a', [2n ** 64n - 1n, 1n], true],
      ['uint64_a', [2n ** 64n - 2n, 1n], false],
      ['int32_a', [2147483647n, 2147483647n, 1n], false],
    ];
    for (const [name, values, raises] of cases) {
      const rows = values.map(v => fill({ [name]: name.includes('64') ? v : Number(v) }));
      const outcome = await compareRun(aggregatePlan([], [['sum', name]]), rows, rows.length, 7, `sum ${name} ${values}`);
      expect(outcome, `sum ${name} ${values}`).toBe(raises ? 'error' : 'ok');
    }
  });

  test('NaN, -0 and 0 group, count and order as the contract says', async () => {
    const values = [0, -0, NaN, 1, -0, NaN, 0, -1, NaN, 2.5, 0];
    const rows = values.map((v, i) => fill({ float64_a: v, float32_a: v, int32_a: i % 3 }));
    for (const keys of [['float64_a'], ['float32_a'], ['float64_a', 'int32_a']]) {
      for (const order of [rows, [...rows].reverse()]) {
        const plan = aggregatePlan(keys, [['count', null], ['count_distinct', 'float64_a'], ['min', 'float64_a'], ['max', 'float64_a'], ['min', 'float32_a'], ['max', 'float32_a'], ['sum', 'float64_a'], ['avg', 'float32_a']]);
        expect(await compareRun(plan, order, 5, 4, `floats ${keys}`)).toBe('ok');
      }
    }
    // Ties between 0 and -0 keep the first one seen, as in JS.
    for (const pair of [[0, -0], [-0, 0]]) {
      const rows2 = pair.map(v => fill({ float64_a: v }));
      const plan = aggregatePlan([], [['min', 'float64_a'], ['max', 'float64_a']]);
      expect(await compareRun(plan, rows2, rows2.length, 5, `zeros ${pair}`)).toBe('ok');
    }
  });

  test('many groups: the group table and distinct sets grow', async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => fill({ int32_a: i % 3001, int64_a: BigInt(i % 17), uint16_a: (i * 7919) % 65536, utf8_a: `s${i % 1500}`, dictionary_a: `d${i % 40}` }));
    const cases: [string[], [string, string | null][]][] = [
      [['int32_a'], [['count', null], ['count_distinct', 'uint16_a'], ['sum', 'int64_a'], ['min', 'utf8_a'], ['max', 'dictionary_a']]],
      [['int32_a', 'int64_a'], [['count', null], ['count_distinct', 'utf8_a']]],
      [['utf8_a', 'dictionary_a'], [['count', null], ['count_distinct', 'int32_a']]],
      [['uint16_a'], [['count', null], ['avg', 'int32_a']]],
      [[], [['count_distinct', 'uint16_a'], ['count_distinct', 'utf8_a']]],
    ];
    for (const [keys, aggs] of cases) {
      expect(await compareRun(aggregatePlan(keys, aggs), rows, 4000, 1000, `many groups ${keys}`)).toBe('ok');
    }
  });

  test('over no rows: no groups with keys, one row without', async () => {
    expect(await compareRun(aggregatePlan(['int32_a'], [['count', null], ['sum', 'int32_a']]), [], 0, 10, 'empty with keys')).toBe('ok');
    expect(await compareRun(aggregatePlan([], [['count', null], ['sum', 'int32_a'], ['min', 'utf8_a']]), [], 0, 10, 'empty without keys')).toBe('ok');
  });

  test('a string column without a usable map is refused, not read as raw codes', () => {
    const h = host!;
    const rows = ['a', 'b', 'a'].map(v => fill({ utf8_a: v }));
    const built = aggregatePlan(['utf8_a'], [['count', null]]);
    const engineTable = new EngineTable(h, SCHEMA, rows as never);
    const snapshot = engineTable.snapshot();
    const plan = h.planLoad(encodePlan(built.plan));
    const params = h.paramsLoad(plan, encodeParams(built.plan.params, built.values));
    const column = col('utf8_a');
    try {
      for (const map of [null, new Uint32Array(1)]) {
        const run = h.runNew(plan, params, snapshot.handle, 10);
        expect(run).not.toBe(0);
        if (map) expect(h.runCanon(run, column, 0, map)).toBe(0);
        expect(h.runStep(run), map ? 'a map shorter than the dictionary' : 'no map').toBe(310);
        h.runFree(run);
      }
      // A map for a column or segment that does not exist is refused when given.
      const run = h.runNew(plan, params, snapshot.handle, 10);
      expect(h.runCanon(run, 999, 0, new Uint32Array(2))).toBe(309);
      expect(h.runCanon(run, column, 5, new Uint32Array(2))).toBe(309);
      h.runFree(run);
    } finally {
      h.paramsFree(params);
      h.planFree(plan);
      snapshot.release();
      engineTable.dispose();
    }
  });
});

function sortPlan(keys: [string, boolean, boolean][], limit: number | null): Built {
  // Purpose: a scan, a sort by (column, descending, nulls first) keys, and optionally a limit right after it
  const field = (name: string): IrExpr => ({ kind: 'field', index: col(name), type: SCHEMA.list[col(name)]!.type });
  const nodes: IrPlan['nodes'][number][] = [
    { op: 'scan', schema: SCHEMA.list },
    { op: 'sort', input: 0, keys: keys.map(([name, descending, nullsFirst]) => ({ expr: field(name), descending, nullsFirst })), schema: SCHEMA.list },
  ];
  if (limit !== null) nodes.push({ op: 'limit', input: 1, count: limit, schema: SCHEMA.list });
  const plan: IrPlan = { version: IR_VERSION, input: SCHEMA.list, nodes, root: nodes.length - 1, output: SCHEMA.list, params: [] };
  return { plan: validate(plan), values: new Map(), shape: `directed sort ${keys.map(k => k.join(':')).join(',')} limit ${limit}` };
}

maybe('engine sort: directed cases', () => {
  test('nulls, NaN, ties and direction', async () => {
    const floats = [3, NaN, -0, 0, null, -1, NaN, null, 3, 2.5, -0, Infinity, -Infinity, 0];
    const rows = floats.map((v, i) => fill({ float64_a: v, float32_a: v === null ? null : Math.fround(v), int32_a: i % 3, utf8_a: i % 4 === 0 ? null : WORDS[i % WORDS.length], dictionary_a: WORDS[(i * 5) % WORDS.length], int64_a: BigInt(i % 2) - 1n, uint8_a: i % 5 }));
    const names = ['float64_a', 'float32_a', 'int32_a', 'utf8_a', 'dictionary_a', 'int64_a', 'uint8_a'];
    for (const name of names) {
      for (const descending of [false, true]) {
        for (const nullsFirst of [false, true]) {
          for (const limit of [null, 0, 1, 5, floats.length, floats.length + 3]) {
            const plan = sortPlan([[name, descending, nullsFirst]], limit);
            expect(await compareRun(plan, rows, 6, 4, `sort ${name} desc ${descending} nullsFirst ${nullsFirst} limit ${limit}`)).toBe('ok');
          }
        }
      }
    }
    // Several keys, mixed directions.
    for (const limit of [null, 4, 100]) {
      const plan = sortPlan([['int32_a', true, true], ['utf8_a', false, false], ['float64_a', true, false]], limit);
      expect(await compareRun(plan, rows, 9, 5, `three keys limit ${limit}`)).toBe('ok');
    }
  });

  test('thousands of rows, with ties, in several segments and chunks', async () => {
    const rows = Array.from({ length: 7000 }, (_, i) => fill({ int32_a: (i * 7919) % 211, utf8_a: i % 13 === 0 ? null : `w${(i * 31) % 97}`, float64_a: i % 50 === 0 ? NaN : ((i * 13) % 101) / 4 }));
    for (const [keys, limit] of [
      [[['int32_a', false, false]], null],
      [[['utf8_a', true, true], ['int32_a', false, false]], 100],
      [[['float64_a', true, false]], 8000],
      [[['float64_a', false, true], ['utf8_a', false, false]], 3],
    ] as [[string, boolean, boolean][], number | null][]) {
      expect(await compareRun(sortPlan(keys, limit), rows, 4500, 2048, `large sort ${keys} limit ${limit}`)).toBe('ok');
    }
  });
});

function stringPlan(rng: Rng): Built {
  // Purpose: a random plan whose expressions are functions of one string column, alone or mixed with numeric columns
  const call = (fn: string, args: IrExpr[]): IrExpr => ({ kind: 'call', fn, args, type: registryLookup(fn).returns(args.map(a => a.type)) });
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const text = (value: string): IrExpr => ({ kind: 'literal', value, type: t.utf8 });
  const int = (value: number): IrExpr => ({ kind: 'literal', value, type: t.int32 });
  const word = () => pick([...WORDS, 'x', 'A']);
  const field = (name: string): IrExpr => ({ kind: 'field', index: FIELDS.indexOf(name), type: SCHEMA.list[FIELDS.indexOf(name)]!.type });
  const str = (name: string, depth: number): IrExpr => {
    const base = field(name);
    if (depth === 0 || rng() < 0.4) return base;
    const inner = str(name, depth - 1);
    const r = rng();
    if (r < 0.4) return call('lower', [inner]);
    if (r < 0.8) return call('upper', [inner]);
    return inner.type.name === 'utf8' ? call('coalesce', [inner, text(word())]) : call('lower', [inner]);
  };
  const flag = (name: string, depth: number): IrExpr => {
    const s = str(name, 2);
    const r = rng();
    if (depth > 0 && r < 0.3) return call(pick(['and', 'or']), [flag(name, depth - 1), flag(name, depth - 1)]);
    if (depth > 0 && r < 0.4) return call('not', [flag(name, depth - 1)]);
    // Comparisons need operands of one type: a dictionary column is compared as text.
    const cmp = s.type.name === 'dictionary' ? call('lower', [s]) : s;
    if (r < 0.65) return call(pick(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']), rng() < 0.5 ? [cmp, text(word())] : [text(word()), cmp]);
    if (r < 0.8) return call(pick(['starts_with', 'ends_with', 'contains']), [cmp, text(word())]);
    if (r < 0.9) return { kind: 'in', arg: s, values: Array.from({ length: 1 + Math.floor(rng() * 4) }, word), param: null, type: t.bool };
    return call('is_null', [s]);
  };
  const number = (name: string): IrExpr => (rng() < 0.5 ? call('length', [str(name, 2)]) : call('if_else', [flag(name, 1), int(Math.floor(rng() * 9)), call('length', [str(name, 1)])]));
  const mixed = (name: string): IrExpr => call(pick(['and', 'or']), [flag(name, 1), call(pick(['gt', 'lt']), [field('int32_a'), int(Math.floor(rng() * 9) - 4)])]);
  const anyFlag = (name: string) => (rng() < 0.3 ? mixed(name) : flag(name, 2));
  const name = pick(STRING_FIELDS);
  const nodes: IrPlan['nodes'][number][] = [{ op: 'scan', schema: SCHEMA.list }];
  let fields: readonly Field[] = SCHEMA.list;
  const shape: string[] = [];
  if (rng() < 0.6) {
    nodes.push({ op: 'filter', input: 0, predicate: anyFlag(name), schema: fields });
    shape.push('filter');
  }
  const last = nodes.length - 1;
  const r = rng();
  if (r < 0.4) {
    const exprs = [number(name), anyFlag(pick(STRING_FIELDS)), field('int32_a')];
    fields = exprs.map((e, i) => ({ name: `c${i}`, type: e.type }));
    nodes.push({ op: 'project', input: last, exprs, schema: fields });
    shape.push('project');
  } else if (r < 0.8) {
    const keys = [anyFlag(name), ...(rng() < 0.5 ? [number(pick(STRING_FIELDS))] : [])];
    const aggs: IrAggregate[] = [
      { fn: 'count', arg: null, type: t.uint32 },
      { fn: 'sum', arg: number(name), type: t.int64 },
      { fn: 'max', arg: field(pick(STRING_FIELDS)), type: SCHEMA.list[0]!.type },
    ];
    aggs[2] = { ...aggs[2]!, type: aggs[2]!.arg!.type };
    fields = [...keys.map((k, i) => ({ name: `k${i}`, type: k.type })), ...aggs.map((a, i) => ({ name: `a${i}`, type: a.type }))];
    nodes.push({ op: 'aggregate', input: last, keys, aggs, schema: fields });
    shape.push('aggregate');
  } else {
    nodes.push({ op: 'sort', input: last, keys: [{ expr: number(name), descending: rng() < 0.5, nullsFirst: rng() < 0.5 }, { expr: field('int32_b'), descending: false, nullsFirst: false }], schema: fields });
    shape.push('sort');
  }
  const plan: IrPlan = { version: IR_VERSION, input: SCHEMA.list, nodes, root: nodes.length - 1, output: fields, params: [] };
  return { plan: validate(plan), values: new Map(), shape: shape.join(' > ') };
}

maybe('string expressions through lookup tables (T-414)', () => {
  const planOver = (exprs: IrExpr[]): IrPlan => {
    const fields = exprs.map((e, i) => ({ name: `c${i}`, type: e.type }));
    const nodes: IrPlan['nodes'][number][] = [{ op: 'scan', schema: SCHEMA.list }, { op: 'project', input: 0, exprs, schema: fields }];
    return validate({ version: IR_VERSION, input: SCHEMA.list, nodes, root: 1, output: fields, params: [] });
  };
  const utf8 = (): IrExpr => ({ kind: 'field', index: FIELDS.indexOf('utf8_a'), type: t.utf8 });
  const len = (): IrExpr => ({ kind: 'call', fn: 'length', args: [utf8()], type: t.int32 });

  test('a function that can fail is not tabulated over strings no row holds', () => {
    // Purpose: division and casts stay out of the table; only their never-failing inner part is looked up
    const divide: IrExpr = { kind: 'call', fn: 'int_div', args: [len(), { kind: 'literal', value: 0, type: t.int32 }], type: t.int32 };
    const narrow: IrExpr = { kind: 'cast', arg: len(), type: t.int8 };
    const { lookups, plan } = deriveLookups(planOver([divide, narrow]));
    expect(lookups.map(l => (l.expr as { fn?: string }).fn)).toEqual(['length', 'length']);
    expect(plan.nodes.length).toBe(2);
  });

  test('an expression reading two string columns is not one lookup', () => {
    // Purpose: a column hidden under a cast still counts as read, so the pair is not tabulated by one column
    const other: IrExpr = { kind: 'call', fn: 'length', args: [{ kind: 'field', index: FIELDS.indexOf('utf8_b'), type: t.utf8 }], type: t.int32 };
    const hidden: IrExpr = { kind: 'cast', arg: { kind: 'cast', arg: other, type: t.int64 }, type: t.int32 };
    const both: IrExpr = { kind: 'call', fn: 'gt', args: [len(), hidden], type: t.bool };
    const { lookups } = deriveLookups(planOver([both]));
    expect(lookups.map(l => l.field).sort()).toEqual([FIELDS.indexOf('utf8_a'), FIELDS.indexOf('utf8_b')].sort());
  });

  test('a string id beyond the table is an error, not another string\'s answer', async () => {
    // Purpose: a table built from too few strings is refused at run time
    const h = host!;
    const rows = [{ utf8_a: 'a' }, { utf8_a: 'b' }, { utf8_a: 'c' }].map(r => ({ ...Object.fromEntries(FIELDS.map(f => [f, null])), ...r }));
    const engineTable = new EngineTable(h, SCHEMA, rows as never);
    const snapshot = engineTable.snapshot();
    const built = planOver([len()]);
    const derived = deriveLookups(built);
    const planHandle = h.planLoad(encodePlan(derived.plan));
    const paramsHandle = h.paramsLoad(planHandle, encodeParams([], new Map()));
    const canon = buildCanon(snapshot, STRING_FIELDS.map(name => FIELDS.indexOf(name)));
    const table = buildLookupTable(derived.lookups[0]!, canon.strings.slice(0, 2), new Map());
    expect(h.paramsTable(paramsHandle, 0, table.values, table.valid, table.entries)).toBe(0);
    const run = h.runNew(planHandle, paramsHandle, snapshot.handle, 10);
    for (const [segment, byColumn] of canon.maps) for (const [column, map] of byColumn) expect(h.runCanon(run, column, segment, map)).toBe(0);
    expect(h.runStep(run)).toBeGreaterThan(1);
    expect(h.evalError()).toBe(310);
    h.runFree(run);
    h.paramsFree(paramsHandle);
    h.planFree(planHandle);
    snapshot.release();
    engineTable.dispose();
  });

  test('random functions of one string column match the JS executor', async () => {
    // Purpose: lower, upper, comparisons, in, coalesce, length and friends agree with the JS kernels, nulls and all
    lookupCount = 0;
    let total = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const rng = seeded(seed * 7919 + 5);
      for (let k = 0; k < 10; k++) {
        const rowCount = 20 + Math.floor(rng() * 80);
        const rows = makeRows(rng, rowCount, false);
        const cut = rng() < 0.5 ? rowCount : 1 + Math.floor(rng() * (rowCount - 1));
        const chunkRows = 1 + Math.floor(rng() * 40);
        const built = stringPlan(rng);
        total++;
        await compareRun(built, rows, cut, chunkRows, `seed ${seed} case ${k} [${built.shape}] chunk ${chunkRows} cut ${cut}`);
      }
    }
    console.log(`  ${total} plans, ${lookupCount} lookup tables built`);
    expect(lookupCount).toBeGreaterThan(total);
  });
});
