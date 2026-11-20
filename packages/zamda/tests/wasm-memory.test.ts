// T-410: the engine's byte limit. A table that does not fit is refused with a typed error and leaves the
// table as it was; a run that outgrows the limit stops with a typed error and gives no result; the
// limit is the only thing that changes (the same plan answers the same once it is lifted).

import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryError, count, pipe, schema, t, table } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const host = nativeHost();
if (host === null) console.warn('wasm memory tests skipped: the engine library is not built (needs cargo)');
const maybe = host === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32 });
const make = (n: number, offset = 0) => ({ columns: { k: Int32Array.from({ length: n }, (_, i) => (i + offset) % 1000), v: Int32Array.from({ length: n }, (_, i) => i + offset) } });
const total = pipe(S).agg(c => ({ n: count(), s: c.v.sum() })).compile();
const byValue = pipe(S).groupBy(c => ({ v: c.v })).agg(() => ({ n: count() })).compile();

maybe('engine memory limit', () => {
  afterEach(() => host!.memoryLimit(0));

  test('memory is counted, and freed when a table is disposed', () => {
    const { table: wasmTable } = createWasmBackend(host!);
    const before = host!.memoryLive();
    const big = wasmTable(S, make(200_000));
    // The counter is process-wide, so threads of other tests can free memory meanwhile: ask for at least one
    // column's worth of growth (not both), and for the memory to come back to near where it started.
    expect(host!.memoryLive() - before).toBeGreaterThanOrEqual(200_000 * 4);
    big.dispose();
    expect(host!.memoryLive()).toBeLessThanOrEqual(before + (1 << 20));
  });

  test('an append past the limit raises MemoryError and changes nothing', async () => {
    const { table: wasmTable } = createWasmBackend(host!);
    const small = wasmTable(S, make(10_000));
    const want = (await total.execute(small)).toArray();
    const live = host!.memoryLive();
    host!.memoryLimit(live + 100_000);
    expect(() => small.append(make(500_000, 10_000))).toThrow(MemoryError);
    expect(host!.memoryRefused()).toBe(true);
    expect(small.rowCount).toBe(10_000);
    expect(host!.memoryLive()).toBeLessThanOrEqual(live + 4096);
    host!.memoryLimit(0);
    expect((await total.execute(small)).toArray()).toEqual(want);
    small.append(make(1000, 10_000));
    expect(small.rowCount).toBe(11_000);
  });

  test('a table that does not fit at creation raises MemoryError and leaves nothing behind', () => {
    const { table: wasmTable } = createWasmBackend(host!);
    const live = host!.memoryLive();
    host!.memoryLimit(live + 50_000);
    expect(() => wasmTable(S, make(300_000))).toThrow(MemoryError);
    expect(host!.memoryLive()).toBeLessThanOrEqual(live + 4096);
  });

  test('a run that outgrows the limit stops with MemoryError and no result, and works once the limit is lifted', async () => {
    const { table: wasmTable } = createWasmBackend(host!);
    const jsTable = table(S, make(300_000));
    const big = wasmTable(S, make(300_000));
    const want = (await byValue.execute(jsTable)).toArray();
    const live = host!.memoryLive();
    // The table is held; leave only a little room, so grouping 300,000 distinct values cannot fit.
    host!.memoryLimit(live + 600_000);
    await expect(byValue.execute(big, { chunkRows: 10_000 })).rejects.toBeInstanceOf(MemoryError);
    host!.memoryLimit(0);
    expect(host!.memoryLive()).toBeLessThanOrEqual(live + 1_000_000);
    expect((await byValue.execute(big)).toArray()).toEqual(want);
  });

  test('a plan that fits is unaffected by a limit that is not reached', async () => {
    const { table: wasmTable } = createWasmBackend(host!);
    const big = wasmTable(S, make(100_000));
    host!.memoryLimit(host!.memoryLive() + 64 * 1024 * 1024);
    expect((await total.execute(big)).toArray()).toEqual([{ n: 100_000, s: BigInt((100_000 * 99_999) / 2) }]);
    expect(host!.memoryRefused()).toBe(false);
  });
});
