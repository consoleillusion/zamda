// Browser check of the worker host (T-409) and the memory and failure model (T-410): the engine in a Web
// Worker, a page thread that stays free, abort, transfer, a byte limit. Open /worker.html (bench:browser serves it).
// Every check records a measured value and the limit it is held to, and the result is in window.__workerResult.

import { decodeRoutes, Routes } from '@zamda/bgp-data/file';
import { AbortError, MemoryError, ZamdaError } from 'zamda';
import { createWasmBackend } from 'zamda/internal/backends/wasm/index';
import { loadEngine } from 'zamda/internal/backends/wasm/load';
import { createWorkerBackend } from 'zamda/internal/backends/wasm/worker-link';
import type { WorkerLike } from 'zamda/internal/backends/wasm/worker-link';
import { columnInput, sample, zamdaFromColumns } from '../data';
import { QUERIES } from '../queries';

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly measured: string;
  readonly limit: string;
}

declare global {
  interface Window {
    __workerResult?: { ok: boolean; checks: Check[]; info: string[]; userAgent: string };
    __workerError?: string;
  }
}

const byId = (id: string): HTMLElement => document.getElementById(id)!;
const checks: Check[] = [];
let engineMissing = false;
const info: string[] = [];

function log(line: string): void {
  // Purpose: show progress while the checks run
  byId('log').textContent += `${line}\n`;
}

function record(name: string, pass: boolean, measured: string, limit: string): void {
  // Purpose: keep one check's outcome and show it
  checks.push({ name, pass, measured, limit });
  log(`${pass ? 'PASS' : 'FAIL'}  ${name}: measured ${measured}; limit ${limit}`);
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function maxGapWhile(work: () => Promise<unknown>): Promise<number> {
  // Purpose: the longest time this page thread went between two 4 ms timer ticks while `work` ran
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 4);
  try {
    await work();
    // A page thread that was blocked to the very end never saw the timer fire: count the wait since the last tick
    max = Math.max(max, performance.now() - last);
  } finally {
    clearInterval(timer);
  }
  return max;
}

async function main(): Promise<void> {
  // Purpose: run every check against an engine in a Web Worker and publish the outcome
  const params = new URLSearchParams(location.search);
  const rows = Number(params.get('rows') ?? 1_000_000);
  const runs = Number(params.get('runs') ?? 5);
  const spawn = (): WorkerLike => new Worker('/worker-entry.js', { type: 'module' }) as unknown as WorkerLike;
  const engineUrl = new URL('/engine.wasm', location.href).href;
  const hasEngine = (await fetch(engineUrl)).ok;

  // 1. The worker starts, and the page can talk to it.
  const began = performance.now();
  let backend;
  try {
    backend = await createWorkerBackend({ spawn, engine: { url: engineUrl } });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    engineMissing = !hasEngine;
    record('worker starts and answers', !hasEngine && error instanceof ZamdaError, `no engine ready (${message})`, hasEngine ? 'must start' : 'no /engine.wasm on the server, so a typed zamda error (not a browser error) is the expected outcome (run `bun run wasm:build`)');
    return;
  }
  record('worker starts and answers', true, `${(performance.now() - began).toFixed(0)} ms`, 'starts');

  const response = await fetch('/data/routes.bin');
  if (!response.ok) throw new Error(await response.text());
  const { arrays } = decodeRoutes(new Uint8Array(await response.arrayBuffer()));
  const sampled = sample(arrays, rows);
  info.push(`${sampled.rowCount.toLocaleString()} rows`);

  // 2. A table made with transfer: the page's arrays are moved to the worker, not copied.
  const input = columnInput(sampled);
  const copy = Object.fromEntries(Object.entries(input.columns).map(([k, v]) => [k, (v as { slice(): unknown }).slice()]));
  const typedCopies = Object.values(copy).filter((v): v is ArrayBufferView => ArrayBuffer.isView(v));
  const mover = await backend.table(Routes, { columns: copy } as never, { transfer: true });
  const detached = typedCopies.filter(v => v.byteLength === 0).length;
  record('transfer moves the typed arrays to the worker', detached === typedCopies.length && typedCopies.length > 0, `${detached} of ${typedCopies.length} arrays detached on the page`, 'all detached');
  await mover.dispose();

  // 3. The worker answers the reference queries as the JS backend does.
  const wasm = await backend.table(Routes, input as never);
  const js = zamdaFromColumns(sampled);
  let equal = 0;
  for (const q of QUERIES) {
    const fromWorker = q.zamdaSummary(await q.zamdaExec(wasm as never));
    const fromJs = q.zamdaSummary(await q.zamdaExec(js as never));
    if (fromWorker === fromJs) equal++;
    else log(`  ${q.id} differs between the worker and the JS backend`);
  }
  record('worker answers equal the JS backend', equal === QUERIES.length, `${equal} of ${QUERIES.length} queries equal`, 'all equal');

  // 4. The page thread stays free while the worker runs plans (and the same plans in this thread, as a control).
  const runAll = async (table: unknown): Promise<void> => {
    // Purpose: every reference query, `runs` times, one after another
    for (let i = 0; i < runs; i++) for (const q of QUERIES) await q.zamdaExec(table as never);
  };
  const gapWorker = await maxGapWhile(() => runAll(wasm));
  record('page thread gap while the worker runs plans', gapWorker < 50, `${gapWorker.toFixed(1)} ms longest gap between 4 ms timer ticks`, 'under 50 ms (a 4 ms tick that is 50 ms late is visible jank)');
  const bytes = await (await fetch(engineUrl)).arrayBuffer();
  const inThread = createWasmBackend(await loadEngine(bytes));
  const local = inThread.table(Routes, input as never);
  const gapLocal = await maxGapWhile(() => runAll(local));
  info.push(`control: the same plans on this thread leave a gap of ${gapLocal.toFixed(1)} ms (no limit; it shows what the worker saves)`);
  log(`  control: the same plans on this thread leave a gap of ${gapLocal.toFixed(1)} ms`);

  // 5. What the worker costs per query: messages and the result's copy (information, no limit).
  const perQuery: string[] = [];
  for (const q of QUERIES) {
    const viaWorker: number[] = [];
    const viaThread: number[] = [];
    for (let i = 0; i < runs; i++) {
      let t0 = performance.now();
      await q.zamdaExec(wasm as never);
      viaWorker.push(performance.now() - t0);
      t0 = performance.now();
      await q.zamdaExec(local as never);
      viaThread.push(performance.now() - t0);
    }
    perQuery.push(`${q.id} worker ${median(viaWorker).toFixed(1)} ms, this thread ${median(viaThread).toFixed(1)} ms`);
  }
  info.push(`median per query: ${perQuery.join('; ')}`);
  log(`  median per query: ${perQuery.join('; ')}`);
  local.dispose();

  // 6. Abort: the run is rejected on the page at once, and the worker takes the next run.
  const controller = new AbortController();
  let abortedAt = 0;
  let rejectedAfter = -1;
  let typed = false;
  const q1 = QUERIES[0]!;
  try {
    await q1.zamdaExec(wasm as never, { chunkRows: 1000, sliceMs: 0, signal: controller.signal, onProgress: () => { if (abortedAt === 0) { abortedAt = performance.now(); controller.abort(); } } });
  } catch (error) {
    rejectedAfter = performance.now() - abortedAt;
    // instanceof, not the name: the bundler renames classes (an ExecutionError showed up as ExecutionError4)
    typed = error instanceof AbortError;
  }
  const after = q1.zamdaSummary(await q1.zamdaExec(wasm as never)) === q1.zamdaSummary(await q1.zamdaExec(js as never));
  record('abort rejects at once, the worker stays usable', typed && rejectedAfter >= 0 && rejectedAfter < 50 && after, `${typed ? 'AbortError' : 'other outcome'} ${rejectedAfter.toFixed(1)} ms after abort(); next run ${after ? 'correct' : 'wrong'}`, 'AbortError within 50 ms of abort(); next run correct');

  // 7. The byte limit: a table that does not fit is a typed MemoryError, and the engine is not replaced.
  const live = await backend.memoryLive();
  await backend.setMemoryLimit(live + (4 << 20));
  let memoryError = false;
  try {
    await backend.table(Routes, { columns: Object.fromEntries(Object.entries(input.columns).map(([k, v]) => [k, (v as { slice(): unknown }).slice()])) } as never);
  } catch (error) {
    memoryError = error instanceof MemoryError;
  }
  await backend.setMemoryLimit(0);
  const stillRight = q1.zamdaSummary(await q1.zamdaExec(wasm as never)) === q1.zamdaSummary(await q1.zamdaExec(js as never));
  record('byte limit raises MemoryError and keeps the engine', memoryError && backend.replacements === 0 && stillRight, `${memoryError ? 'MemoryError' : 'no MemoryError'}; engine replaced ${backend.replacements} times; first table ${stillRight ? 'still correct' : 'wrong'}`, 'MemoryError; 0 replacements; first table still correct');

  backend.terminate();
}

main()
  .then(() => {
    // Purpose: show and publish the outcome
    const ok = checks.every(c => c.pass);
    byId('status').textContent = engineMissing ? 'No engine on the server: only the worker plumbing was checked (build it with `bun run wasm:build`).' : ok ? 'All checks passed.' : 'Some checks FAILED.';
    byId('report').textContent = [...checks.map(c => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      measured: ${c.measured}\n      limit:    ${c.limit}`), '', ...info].join('\n');
    window.__workerResult = { ok, checks, info, userAgent: navigator.userAgent };
  })
  .catch((error: unknown) => {
    // Purpose: show a failure on the page and for scripted runs
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    byId('status').textContent = `Failed: ${message}`;
    window.__workerError = message;
  });
