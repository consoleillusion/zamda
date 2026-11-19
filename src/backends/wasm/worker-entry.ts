// The code that runs inside the worker (T-409): it holds the engine and answers the page's messages. Start
// it with `new Worker(new URL('./worker-entry.ts', import.meta.url), { type: 'module' })` (or the built
// file); worker-link.ts is the page's side.

import { ExecutionError, ZamdaError } from '../../errors';
import { loadEngine } from './load';
import { hostOf } from './load';
import { EngineLinkFailure, inThreadLink } from './managed';
import type { EngineLink } from './managed';
import { buffersOf, toWire } from './worker-protocol';
import type { EngineSource, Reply, Request } from './worker-protocol';

type Scope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: Request }) => void): void;
};
const scope = globalThis as unknown as Scope;

let source: EngineSource | null = null;
const link: EngineLink = inThreadLink(async () => {
  // Purpose: make a new engine host from the source the page gave
  if (source === null) throw new ExecutionError('The worker was not told where the engine is');
  if ('hostModule' in source) {
    const made = (await import(/* @vite-ignore */ source.hostModule)) as { default: (arg?: string) => Promise<Awaited<ReturnType<typeof loadEngine>> | null> };
    const host = await made.default(source.hostArg);
    if (host === null) throw new ExecutionError('The host module made no engine');
    return host;
  }
  if ('module' in source) return hostOf((await WebAssembly.instantiate(source.module, {})) as unknown as WebAssembly.Instance);
  if ('bytes' in source) return loadEngine(source.bytes);
  const response = await fetch(source.url);
  if (!response.ok) throw new ExecutionError(`The engine could not be fetched from ${source.url} (${response.status})`);
  return loadEngine(await response.arrayBuffer());
});

const running = new Map<number, AbortController>();

const send = (reply: Reply, transfer: Transferable[] = []): void => scope.postMessage(reply, transfer);

async function handle(request: Request): Promise<void> {
  // Purpose: do what one message asks and answer it
  if (request.type === 'abort') {
    running.get(request.target)?.abort();
    return;
  }
  try {
    let value: unknown;
    let transfer: Transferable[] = [];
    switch (request.type) {
      case 'start':
        source = request.engine;
        await link.start(request.memoryLimitBytes);
        break;
      case 'limit':
        await link.setMemoryLimit(request.bytes);
        break;
      case 'createTable':
        value = await link.createTable(request.tableId, request.schema as never, request.data as never, request.options as never, false);
        break;
      case 'append':
        value = await link.append(request.tableId, request.data as never, false);
        break;
      case 'drop':
        await link.dropTable(request.tableId);
        break;
      case 'openSession':
        await link.openSession(request.sessionId);
        break;
      case 'closeSession':
        await link.closeSession(request.sessionId);
        break;
      case 'run': {
        const run = request.request as Parameters<EngineLink['run']>[0];
        const controller = new AbortController();
        running.set(request.id, controller);
        try {
          const result = await link.run(run, {
            signal: controller.signal,
            onProgress: p => send({ id: request.id, progress: p }),
          });
          value = result;
          transfer = buffersOf(result);
        } finally {
          running.delete(request.id);
        }
        break;
      }
      case 'stats':
        value = await link.stats();
        break;
      case 'memoryLive':
        value = await link.memoryLive();
        break;
    }
    send({ id: request.id, ok: true, value }, transfer);
  } catch (e) {
    if (e instanceof EngineLinkFailure) send({ id: request.id, ok: false, error: toWire(e.error), lost: true });
    else if (e instanceof ZamdaError) send({ id: request.id, ok: false, error: toWire(e), lost: false });
    else send({ id: request.id, ok: false, error: toWire(new ExecutionError(e instanceof Error ? e.message : String(e))), lost: false });
  }
}

scope.addEventListener('message', event => void handle(event.data));
