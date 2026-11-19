// T-415: date_trunc and extract in the engine. They must run in the engine (not fall back to JS), agree with
// the JS backend to the last value over the whole range of the types, and agree with JS Date wherever a Date can hold the value.

import { describe, expect, test } from 'bun:test';
import { pipe, schema, t, table } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const host = nativeHost();
if (host === null) console.warn('wasm date tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const S = schema({ d: t.date32, ts: t.timestamp });
const DAY = 86_400_000;

function plain(rows: readonly object[]): unknown[] {
  // Purpose: rows with each Date as its time value, because two Invalid Dates (a truncation that lands outside what a Date holds) are never equal to toEqual
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.getTime() : v])));
}

function random(seed: number): () => number {
  // Purpose: a small deterministic random number generator (mulberry32)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_MS = 8.64e15;
const MAX_DAYS = 100_000_000;

interface Data {
  readonly days: number[];
  readonly ms: number[];
  readonly input: { columns: { d: Date[]; ts: Date[] } };
}

function data(n: number): Data {
  // Purpose: days and whole-millisecond timestamps over the whole range a Date can hold (the loader takes nothing else), the edge values first
  const rng = random(415);
  const edgeDays = [0, -1, 1, 59, 60, 11016, -25508, -25509, -719528, MAX_DAYS - 1, -MAX_DAYS, 365, 366, -365];
  const edgeMs = [0, -1, 1, 86_399_999, -86_400_000, 951_782_400_000, 951_868_799_999, -62_135_596_800_000, MAX_MS, -MAX_MS, 253_402_300_799_999, 3_599_999, -3_600_001];
  const days: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    days.push(i < edgeDays.length ? edgeDays[i]! : i % 2 === 0 ? Math.floor((rng() - 0.5) * 2 * MAX_DAYS) : Math.floor((rng() - 0.5) * 200_000));
    ms.push(i < edgeMs.length ? edgeMs[i]! : i % 2 === 0 ? Math.floor((rng() - 0.5) * 2 * MAX_MS) : Math.floor((rng() - 0.5) * 4e12));
  }
  return { days, ms, input: { columns: { d: days.map(d => new Date(d * DAY)), ts: ms.map(m => new Date(m)) } } };
}

const plan = pipe(S)
  .select(c => ({
    dy: c.d.extract('year'), dm: c.d.extract('month'), dd: c.d.extract('day'),
    dty: c.d.dateTrunc('year'), dtm: c.d.dateTrunc('month'), dtd: c.d.dateTrunc('day'),
    ty: c.ts.extract('year'), tm: c.ts.extract('month'), td: c.ts.extract('day'),
    th: c.ts.extract('hour'), tmi: c.ts.extract('minute'), ts: c.ts.extract('second'),
    tty: c.ts.dateTrunc('year'), ttm: c.ts.dateTrunc('month'), ttd: c.ts.dateTrunc('day'),
    tth: c.ts.dateTrunc('hour'), ttmi: c.ts.dateTrunc('minute'), tts: c.ts.dateTrunc('second'),
  }))
  .compile();

maybe('date_trunc and extract in the engine', () => {
  const { backend, table: wasmTable } = createWasmBackend(host!);

  test('they run in the engine, and the answers equal the JS backend to the last value', async () => {
    const { input } = data(20_000);
    const before = { ...backend.stats };
    const fromEngine = (await plan.execute(wasmTable(S, input))).toArray();
    expect(backend.stats.engine).toBe(before.engine + 1);
    expect(backend.stats.fallback).toBe(before.fallback);
    const fromJs = (await plan.execute(table(S, input))).toArray();
    expect(fromEngine.length).toBe(20_000);
    expect(plain(fromEngine)).toEqual(plain(fromJs));
  });

  test('the answers equal JS Date, the independent oracle, over the whole range', async () => {
    const { days, ms, input } = data(20_000);
    const rows = (await plan.execute(wasmTable(S, input))).toArray() as Record<string, unknown>[];
    const start = (y: number, m: number) => {
      // Purpose: the first millisecond of a UTC year or month, by Date (setUTCFullYear avoids the remapping of years 0 to 99)
      const s = new Date(0);
      s.setUTCFullYear(y, m, 1);
      return s.getTime();
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const date = new Date(ms[i]!);
      expect([r.ty, r.tm, r.td, r.th, r.tmi, r.ts]).toEqual([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]);
      expect([(r.tty as Date).getTime(), (r.ttm as Date).getTime(), (r.ttd as Date).getTime(), (r.tth as Date).getTime(), (r.ttmi as Date).getTime(), (r.tts as Date).getTime()]).toEqual([
        start(date.getUTCFullYear(), 0), start(date.getUTCFullYear(), date.getUTCMonth()), Math.floor(ms[i]! / DAY) * DAY, Math.floor(ms[i]! / 3_600_000) * 3_600_000, Math.floor(ms[i]! / 60_000) * 60_000, Math.floor(ms[i]! / 1000) * 1000,
      ]);
      const day = new Date(days[i]! * DAY);
      expect([r.dy, r.dm, r.dd]).toEqual([day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()]);
      expect([(r.dty as Date).getTime(), (r.dtm as Date).getTime(), (r.dtd as Date).getTime()]).toEqual([start(day.getUTCFullYear(), 0), start(day.getUTCFullYear(), day.getUTCMonth()), days[i]! * DAY]);
    }
  });

  test('nulls stay null and constants fold, also on a table made from rows', async () => {
    const rows = [{ d: new Date('2024-02-29'), ts: new Date('2024-02-29T13:45:10.500Z') }, { d: null, ts: null }, { d: new Date('1969-12-31'), ts: new Date('1969-12-31T23:59:59.999Z') }];
    const small = pipe(S)
      .select(c => ({ y: c.d.extract('year'), m: c.d.dateTrunc('month'), h: c.ts.extract('hour'), s: c.ts.dateTrunc('second') }))
      .compile();
    const before = { ...backend.stats };
    const fromEngine = (await small.execute(wasmTable(S, rows))).toArray();
    expect(backend.stats.fallback).toBe(before.fallback);
    expect(fromEngine).toEqual((await small.execute(table(S, rows))).toArray());
    expect(fromEngine[1]).toEqual({ y: null, m: null, h: null, s: null });
  });

  test('group by a truncated date and filter on an extracted field, in the engine', async () => {
    const { input } = data(5000);
    const q = pipe(S)
      .filter(c => c.ts.extract('hour').gte(6))
      .select(c => ({ month: c.ts.dateTrunc('month'), year: c.d.extract('year') }))
      .groupBy(c => ({ month: c.month }))
      .agg(c => ({ lo: c.year.min(), hi: c.year.max() }))
      .compile();
    const before = { ...backend.stats };
    const fromEngine = (await q.execute(wasmTable(S, input))).toArray();
    expect(backend.stats.fallback).toBe(before.fallback);
    const key = (r: Record<string, unknown>) => (r.month as Date).getTime();
    const sort = (a: Record<string, unknown>[]) => [...a].sort((x, y) => key(x) - key(y));
    expect(fromEngine.length).toBeGreaterThan(100);
    expect(plain(sort(fromEngine as never))).toEqual(plain(sort((await q.execute(table(S, input))).toArray() as never)));
  });
});
