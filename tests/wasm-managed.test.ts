// T-410: the failure model around an engine module. A trap is simulated by a host that throws a
// WebAssembly.RuntimeError at a chosen call (a native library cannot trap without ending the process).

import { afterEach, describe, expect, test } from 'bun:test';
import { AbortError, EngineCrashError, ExecutionError, HandleError, MemoryError, PlanError, count, lit, pipe, schema, t, table } from '../src';
import { createManagedBackend, inThreadLink } from '../src/backends/wasm/managed';
import type { EngineRunHost } from '../src/backends/wasm/host';
import { nativeHost } from './engine-host';

const base = nativeHost();
if (base === null) console.warn('managed engine tests skipped: the engine library is not built (needs cargo)');
const maybe = base === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: i % 7, v: i }));
const total = pipe(S).agg(c => ({ n: count(), s: c.v.sum() })).compile();
const groups = pipe(S).groupBy(c => ({ k: c.k })).agg(c => ({ n: count(), s: c.v.sum() })).compile();

function faulty(trap: { on: keyof EngineRunHost; after: number; refused?: boolean }): EngineRunHost {
  // Purpose: the native host, except that the `after`-th call of one function traps
  let calls = 0;
  return new Proxy(base!, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'memoryRefused' && trap.refused !== undefined) return () => trap.refused!;
      if (prop !== trap.on || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (++calls > trap.after) throw new WebAssembly.RuntimeError('unreachable');
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

const make = async (hosts: (() => EngineRunHost)[], options: { memoryLimitBytes?: number } = {}) => {
  // Purpose: a managed backend whose n-th engine module is hosts[n] (the last one repeats)
  let n = 0;
  const loads = { count: 0 };
  const backend = await createManagedBackend(
    inThreadLink(async () => {
      loads.count++;
      return hosts[Math.min(n++, hosts.length - 1)]!();
    }),
    options,
  );
  return { backend, loads };
};
const healthy = () => base!;

maybe('managed engine', () => {
  afterEach(() => base!.memoryLimit(0));

  test('without failures it answers like the JS backend, with asynchronous tables', async () => {
    const { backend } = await make([healthy]);
    const wasm = await backend.table(S, rows(5000));
    const js = table(S, rows(5000));
    expect((await groups.execute(wasm as never)).toArray()).toEqual((await groups.execute(js)).toArray());
    await wasm.append(rows(10));
    expect(wasm.rowCount).toBe(5010);
    expect((await total.execute(wasm as never)).toArray()).toEqual([{ n: 5010, s: BigInt(5000 * 4999 / 2 + 45) }]);
    expect(backend.replacements).toBe(0);
  });

  test('a trap in the middle of a run: a typed error, no result, a new module, a rebuilt table', async () => {
    const { backend, loads } = await make([() => faulty({ on: 'runStep', after: 1 }), healthy]);
    const wasm = await backend.table(S, rows(100_000), { reload: () => rows(100_000) });
    const failed = groups.execute(wasm as never, { chunkRows: 1000 });
    await expect(failed).rejects.toBeInstanceOf(EngineCrashError);
    await backend.settled();
    expect(backend.replacements).toBe(1);
    expect(loads.count).toBe(2);
    expect((await groups.execute(wasm as never)).toArray()).toEqual((await groups.execute(table(S, rows(100_000)))).toArray());
    expect(wasm.rowCount).toBe(100_000);
  });

  test('a trap after the engine refused an allocation is a MemoryError', async () => {
    const { backend } = await make([() => faulty({ on: 'runStep', after: 0, refused: true }), healthy], { memoryLimitBytes: base!.memoryLive() * 4 + (64 << 20) });
    const wasm = await backend.table(S, rows(1000), { reload: () => rows(1000) });
    await expect(groups.execute(wasm as never)).rejects.toBeInstanceOf(MemoryError);
    await backend.settled();
    expect((await total.execute(wasm as never)).toArray()).toEqual([{ n: 1000, s: BigInt(499_500) }]);
  });

  test('a table with no reload function is lost, and says so', async () => {
    const { backend } = await make([() => faulty({ on: 'runStep', after: 0 }), healthy]);
    const keep = await backend.table(S, rows(100), { reload: () => rows(100) });
    const gone = await backend.table(S, rows(100));
    await expect(total.execute(keep as never)).rejects.toBeInstanceOf(EngineCrashError);
    await backend.settled();
    await expect(total.execute(gone as never)).rejects.toBeInstanceOf(HandleError);
    await expect(gone.append(rows(1))).rejects.toBeInstanceOf(HandleError);
    expect((await total.execute(keep as never)).toArray()[0]).toEqual({ n: 100, s: BigInt(4950) });
  });

  test('runs in flight fail together; a run started after the trap waits for the new module and succeeds', async () => {
    const { backend } = await make([() => faulty({ on: 'runStep', after: 2 }), healthy]);
    const wasm = await backend.table(S, rows(50_000), { reload: () => rows(50_000) });
    const inFlight = [groups.execute(wasm as never, { chunkRows: 1000 }), total.execute(wasm as never, { chunkRows: 1000 })];
    const settled = await Promise.allSettled(inFlight);
    expect(settled.map(r => r.status)).toEqual(['rejected', 'rejected']);
    for (const r of settled) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EngineCrashError);
    const after = await total.execute(wasm as never);
    expect(after.toArray()).toEqual([{ n: 50_000, s: BigInt((50_000 * 49_999) / 2) }]);
    expect(backend.replacements).toBe(1);
  });

  test('an error the contract defines does not replace the engine', async () => {
    const { backend } = await make([healthy]);
    const wasm = await backend.table(S, rows(100));
    const boom = pipe(S).filter(c => c.k.mod(lit(0, t.int32)).eq(lit(0, t.int32))).agg(() => ({ n: count() })).compile();
    await expect(boom.execute(wasm as never)).rejects.toBeInstanceOf(ExecutionError);
    expect(backend.replacements).toBe(0);
    expect((await total.execute(wasm as never)).toArray()).toEqual([{ n: 100, s: BigInt(4950) }]);
  });

  test('a session does not survive its module, and using it afterwards is a PlanError', async () => {
    const { backend } = await make([() => faulty({ on: 'runStep', after: 0 }), healthy]);
    const wasm = await backend.table(S, rows(100), { reload: () => rows(100) });
    const session = backend.session();
    await expect(total.execute(wasm as never, { session } as never)).rejects.toBeInstanceOf(EngineCrashError);
    await backend.settled();
    await expect(total.execute(wasm as never, { session } as never)).rejects.toBeInstanceOf(PlanError);
    const fresh = backend.session();
    expect((await total.execute(wasm as never, { session: fresh } as never)).toArray()[0]).toEqual({ n: 100, s: BigInt(4950) });
    fresh.close();
  });

  test('a trap during an append fails the append and the table is rebuilt from reload', async () => {
    const { backend } = await make([() => faulty({ on: 'segCommit', after: 1 }), healthy]);
    const wasm = await backend.table(S, rows(100), { reload: () => rows(100) });
    await expect(wasm.append(rows(10))).rejects.toBeInstanceOf(EngineCrashError);
    await backend.settled();
    expect(wasm.rowCount).toBe(100);
    expect((await total.execute(wasm as never)).toArray()[0]).toEqual({ n: 100, s: BigInt(4950) });
  });

  test('aborting still raises AbortError and does not replace the engine', async () => {
    const { backend } = await make([healthy]);
    const wasm = await backend.table(S, rows(200_000));
    const controller = new AbortController();
    const run = groups.execute(wasm as never, { chunkRows: 1000, sliceMs: 0, signal: controller.signal, onProgress: p => void (p.rowsScanned >= 5000 && controller.abort()) });
    await expect(run).rejects.toBeInstanceOf(AbortError);
    expect(backend.replacements).toBe(0);
  });

  test('a rebuild that cannot happen leaves the table lost, not half built', async () => {
    const { backend } = await make([() => faulty({ on: 'runStep', after: 0 }), healthy]);
    const wasm = await backend.table(S, rows(100), {
      reload: () => {
        throw new Error('the data is gone');
      },
    });
    await expect(total.execute(wasm as never)).rejects.toBeInstanceOf(EngineCrashError);
    await backend.settled();
    await expect(total.execute(wasm as never)).rejects.toBeInstanceOf(HandleError);
  });
});
