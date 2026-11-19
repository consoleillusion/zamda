// What the wasm backend needs from an engine: the table store (store.ts) plus
// plan, parameter and run entry points of engine/src/eval_abi.rs and run_abi.rs.
// A host is the engine loaded as WASM, or as a native library in tests.

import type { EngineHost } from './store';

export interface EngineRunHost extends EngineHost {
  planLoad(bytes: Uint8Array): number;
  planFree(plan: number): number;
  paramsLoad(plan: number, bytes: Uint8Array): number;
  paramsFree(params: number): number;
  paramsTable(params: number, index: number, values: Uint8Array, valid: Uint8Array | null, entries: number): number;
  exprCount(plan: number, node: number): number;
  exprSupported(plan: number, node: number, expr: number): number;
  eval(plan: number, params: number, node: number, expr: number, snapshot: number, segment: number, start: number, rows: number): number;
  resultType(result: number): number;
  resultRows(result: number): number;
  resultValues(result: number): number;
  resultValid(result: number): number;
  resultFree(result: number): number;
  runNew(plan: number, params: number, snapshot: number, chunkRows: number): number;
  runStep(run: number): number;
  runScanned(run: number): number;
  runFinish(run: number): number;
  runColumn(index: number): number;
  runFree(run: number): number;
  runCanon(run: number, column: number, segment: number, map: Uint32Array): number;
  sessionBegin(): number;
  sessionEnd(session: number): number;
  sessionArm(run: number, session: number): number;
  sessionHits(session: number): number;
  sessionMisses(session: number): number;
  evalError(): number;
  evalErrorWhat(): number;
  evalErrorType(): number;
}
