// The messages between the page and the worker that holds the engine (T-409). Everything crosses as
// structured clone: plans, schemas, parameters and results are plain data, and typed-array buffers can be
// moved instead of copied.

import type { ResultData } from '../../backend';
import { AbortError, EngineCrashError, ExecutionError, ExpressionError, HandleError, MemoryError, PlanError, SchemaError, TypeCheckError, ZamdaError } from '../../errors';
import type { ErrorCode } from '../../errors';
import type { TableState } from './managed';

// Where the worker gets the engine: a compiled module, its bytes, a URL to fetch (inside the worker), or
// (for tests that load a native library) a module whose default export makes the host.
export type EngineSource = { readonly module: WebAssembly.Module } | { readonly bytes: ArrayBuffer } | { readonly url: string } | { readonly hostModule: string; readonly hostArg?: string };

export interface WireError {
  readonly code: ErrorCode;
  readonly name: string;
  readonly message: string;
}

export type Request =
  | { readonly id: number; readonly type: 'start'; readonly engine: EngineSource; readonly memoryLimitBytes: number }
  | { readonly id: number; readonly type: 'limit'; readonly bytes: number }
  | { readonly id: number; readonly type: 'createTable'; readonly tableId: number; readonly schema: unknown; readonly data: unknown; readonly options: unknown }
  | { readonly id: number; readonly type: 'append'; readonly tableId: number; readonly data: unknown }
  | { readonly id: number; readonly type: 'createBlocks'; readonly tableId: number; readonly schema: unknown; readonly segments: unknown }
  | { readonly id: number; readonly type: 'editBlocks'; readonly tableId: number; readonly edits: unknown }
  | { readonly id: number; readonly type: 'drop'; readonly tableId: number }
  | { readonly id: number; readonly type: 'openSession'; readonly sessionId: number }
  | { readonly id: number; readonly type: 'closeSession'; readonly sessionId: number }
  | { readonly id: number; readonly type: 'run'; readonly request: unknown }
  | { readonly id: number; readonly type: 'abort'; readonly target: number }
  | { readonly id: number; readonly type: 'stats' }
  | { readonly id: number; readonly type: 'memoryLive' };

export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  // `lost`: the engine module behind the worker is gone and the error is what the caller sees.
  | { readonly id: number; readonly ok: false; readonly error: WireError; readonly lost: boolean }
  | { readonly id: number; readonly progress: { readonly rowsScanned: number; readonly rowsTotal: number } };

export type { TableState };

export function toWire(error: ZamdaError): WireError {
  // Purpose: the parts of an error that cross a message
  return { code: error.code, name: error.name, message: error.message };
}

export function fromWire(wire: WireError): ZamdaError {
  // Purpose: the typed error a wire error stands for
  switch (wire.code) {
    case 'schema':
      return new SchemaError(wire.message);
    case 'type':
      return new TypeCheckError(wire.message);
    case 'expression':
      return new ExpressionError(wire.message);
    case 'plan':
      return new PlanError(wire.message);
    case 'execution':
      return new ExecutionError(wire.message);
    case 'memory':
      return new MemoryError(wire.message);
    case 'handle':
      return new HandleError(wire.message);
    case 'abort':
      return new AbortError(wire.message);
    case 'crash':
      return new EngineCrashError(wire.message);
  }
}

export function buffersOf(value: unknown, out: ArrayBuffer[] = [], seen = new Set<unknown>()): ArrayBuffer[] {
  // Purpose: the ArrayBuffers of the typed arrays inside plain data (columns, results), each once, for a transfer list
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && !seen.has(value.buffer)) {
      seen.add(value.buffer);
      out.push(value.buffer);
    }
    return out;
  }
  if (value instanceof Map) {
    for (const v of value.values()) buffersOf(v, out, seen);
    return out;
  }
  for (const v of Object.values(value)) buffersOf(v, out, seen);
  return out;
}

export function resultOf(value: unknown): ResultData {
  // Purpose: a run's result as it arrives (already structured-cloned plain data)
  return value as ResultData;
}
