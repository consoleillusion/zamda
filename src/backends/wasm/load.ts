// Loading the engine as a WebAssembly module (T-413). The module has no imports
// and exports the C-ABI functions of engine/src (`zs_*`) and its memory; this
// wraps them in the EngineRunHost shape the backend uses. The same code runs in
// a browser, in Bun and in Node.
//
// Pointers are offsets into the module's memory and can pass 2 GB, where a
// WebAssembly i32 result turns negative, so every pointer is read with `>>> 0`.
// The memory's buffer is replaced when it grows, so views are made per call.

import type { EngineRunHost } from './host';

type Fn = (...args: number[]) => number;

export async function loadEngine(bytes: BufferSource): Promise<EngineRunHost> {
  // Purpose: instantiate the engine module and return its host
  const { instance } = (await WebAssembly.instantiate(bytes, {})) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  return hostOf(instance);
}

export function hostOf(instance: WebAssembly.Instance): EngineRunHost {
  // Purpose: wrap an instantiated engine module's exports
  const e = instance.exports as unknown as Record<string, Fn> & { memory: WebAssembly.Memory };
  const fn = (name: string): Fn => {
    // Purpose: an export by name, or a clear error if the module is not the engine
    const f = e[name];
    if (typeof f !== 'function') throw new Error(`The WASM module has no export ${name}; it is not the zamda engine`);
    return f;
  };
  const view = (ptr: number, bytes: number): Uint8Array => new Uint8Array(e.memory.buffer, ptr, bytes);
  const alloc = fn('zs_alloc');
  const free = fn('zs_free');
  const withBytes = <R>(bytes: Uint8Array, f: (at: number) => R): R => {
    // Purpose: copy bytes into engine memory for the duration of a call
    const size = Math.max(bytes.length, 1);
    const at = alloc(size)! >>> 0;
    if (at === 0) throw new Error('The engine ran out of memory');
    try {
      view(at, bytes.length).set(bytes);
      return f(at);
    } finally {
      free(at, size);
    }
  };
  const f = {
    storeError: fn('zs_store_error'),
    tableNew: fn('zs_table_new'),
    tableFree: fn('zs_table_free'),
    tableRows: fn('zs_table_rows'),
    tableDropped: fn('zs_table_dropped'),
    tableSegments: fn('zs_table_segments'),
    tableSegmentId: fn('zs_table_segment_id'),
    segBegin: fn('zs_seg_begin'),
    segValues: fn('zs_seg_values'),
    segValid: fn('zs_seg_valid'),
    segDict: fn('zs_seg_dict'),
    segCommit: fn('zs_seg_commit'),
    segAbort: fn('zs_seg_abort'),
    snapshot: fn('zs_snapshot'),
    snapshotFree: fn('zs_snapshot_free'),
    snapshotRows: fn('zs_snapshot_rows'),
    snapshotSegments: fn('zs_snapshot_segments'),
    snapshotSegmentId: fn('zs_snapshot_segment_id'),
    snapshotSegmentRows: fn('zs_snapshot_segment_rows'),
    snapshotValues: fn('zs_snapshot_values'),
    snapshotValid: fn('zs_snapshot_valid'),
    snapshotDictLen: fn('zs_snapshot_dict_len'),
    planLoad: fn('zs_plan_load'),
    planFree: fn('zs_plan_free'),
    paramsLoad: fn('zs_params_load'),
    paramsFree: fn('zs_params_free'),
    paramsTable: fn('zs_params_table'),
    exprCount: fn('zs_expr_count'),
    exprSupported: fn('zs_expr_supported'),
    eval: fn('zs_eval'),
    resultType: fn('zs_result_type'),
    resultRows: fn('zs_result_rows'),
    resultValues: fn('zs_result_values'),
    resultValid: fn('zs_result_valid'),
    resultFree: fn('zs_result_free'),
    runNew: fn('zs_run_new'),
    runStep: fn('zs_run_step'),
    runScanned: fn('zs_run_scanned'),
    runFinish: fn('zs_run_finish'),
    runColumn: fn('zs_run_column'),
    runFree: fn('zs_run_free'),
    runCanon: fn('zs_run_canon'),
    sessionBegin: fn('zs_session_begin'),
    sessionEnd: fn('zs_session_end'),
    sessionArm: fn('zs_session_arm'),
    sessionHits: fn('zs_session_hits'),
    sessionMisses: fn('zs_session_misses'),
    evalError: fn('zs_eval_error'),
    evalErrorWhat: fn('zs_eval_error_what'),
    evalErrorType: fn('zs_eval_error_type'),
  };
  return {
    alloc: bytes => alloc(bytes)! >>> 0,
    free: (ptr, bytes) => void free(ptr, bytes),
    view,
    storeError: () => f.storeError(),
    tableNew: (types, columns, retain) => f.tableNew(types, columns, retain)! >>> 0,
    tableFree: t => f.tableFree(t)!,
    tableRows: t => f.tableRows(t)!,
    tableDropped: t => f.tableDropped(t)!,
    tableSegments: t => f.tableSegments(t)!,
    tableSegmentId: (t, i) => f.tableSegmentId(t, i)!,
    segBegin: (t, rows) => f.segBegin(t, rows)!,
    segValues: (t, c) => f.segValues(t, c)! >>> 0,
    segValid: (t, c) => f.segValid(t, c)! >>> 0,
    segDict: (t, c, n) => f.segDict(t, c, n)!,
    segCommit: t => f.segCommit(t)!,
    segAbort: t => f.segAbort(t)!,
    snapshot: t => f.snapshot(t)! >>> 0,
    snapshotFree: h => f.snapshotFree(h)!,
    snapshotRows: h => f.snapshotRows(h)!,
    snapshotSegments: h => f.snapshotSegments(h)!,
    snapshotSegmentId: (h, i) => f.snapshotSegmentId(h, i)!,
    snapshotSegmentRows: (h, i) => f.snapshotSegmentRows(h, i)!,
    snapshotValues: (h, i, c) => f.snapshotValues(h, i, c)! >>> 0,
    snapshotValid: (h, i, c) => f.snapshotValid(h, i, c)! >>> 0,
    snapshotDictLen: (h, i, c) => f.snapshotDictLen(h, i, c)!,
    planLoad: bytes => withBytes(bytes, at => f.planLoad(at, bytes.length)! >>> 0),
    planFree: h => f.planFree(h)!,
    paramsLoad: (plan, bytes) => withBytes(bytes, at => f.paramsLoad(plan, at, bytes.length)! >>> 0),
    paramsFree: h => f.paramsFree(h)!,
    paramsTable: (params, index, values, valid, entries) =>
      withBytes(values, at =>
        valid === null
          ? f.paramsTable(params, index, at, values.length, 0, entries)!
          : withBytes(valid, vat => f.paramsTable(params, index, at, values.length, vat, entries)!),
      ),
    exprCount: (plan, node) => f.exprCount(plan, node)!,
    exprSupported: (plan, node, expr) => f.exprSupported(plan, node, expr)!,
    eval: (plan, params, node, expr, snapshot, segment, start, rows) => f.eval(plan, params, node, expr, snapshot, segment, start, rows)! >>> 0,
    resultType: r => f.resultType(r)!,
    resultRows: r => f.resultRows(r)!,
    resultValues: r => f.resultValues(r)! >>> 0,
    resultValid: r => f.resultValid(r)! >>> 0,
    resultFree: r => f.resultFree(r)!,
    runNew: (plan, params, snapshot, chunkRows) => f.runNew(plan, params, snapshot, chunkRows)! >>> 0,
    runStep: r => f.runStep(r)!,
    // zs_run_scanned returns a u64, which WebAssembly hands over as a BigInt.
    runScanned: r => Number(f.runScanned(r) as unknown as bigint),
    runFinish: r => f.runFinish(r)!,
    runColumn: i => f.runColumn(i)! >>> 0,
    runFree: r => f.runFree(r)!,
    runCanon: (run, column, segment, map) =>
      withBytes(new Uint8Array(map.buffer, map.byteOffset, map.byteLength), at => f.runCanon(run, column, segment, at, map.length)!),
    sessionBegin: () => f.sessionBegin()! >>> 0,
    sessionEnd: s => f.sessionEnd(s)!,
    sessionArm: (run, session) => f.sessionArm(run, session)!,
    // zs_session_hits and zs_session_misses return u64, which WebAssembly hands over as a BigInt.
    sessionHits: s => Number(f.sessionHits(s) as unknown as bigint),
    sessionMisses: s => Number(f.sessionMisses(s) as unknown as bigint),
    evalError: () => f.evalError()!,
    evalErrorWhat: () => f.evalErrorWhat()!,
    evalErrorType: () => f.evalErrorType()!,
  };
}
