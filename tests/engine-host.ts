// The engine as a native shared library, for tests that cannot run WASM here:
// the same C functions, called through bun:ffi. Builds the library if it is
// missing and `cargo` is available; otherwise `nativeHost()` returns null.

import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import { existsSync } from 'node:fs';
import type { EngineRunHost } from '../src/backends/wasm/host';

// The engine's evaluation and run entry points (engine/src/eval_abi.rs, run_abi.rs), as the backend uses them.
export type EvalHost = EngineRunHost;

const ROOT = new URL('../engine/', import.meta.url).pathname;
const SUFFIX = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
const LIBRARY = `${ROOT}target/release/${process.platform === 'win32' ? '' : 'lib'}zamda_engine.${SUFFIX}`;

export function nativeHost(): EvalHost | null {
  // Purpose: open the engine library (building it first if needed), wrapped in the EngineHost shape
  if (!existsSync(LIBRARY)) {
    const built = Bun.spawnSync(['cargo', 'build', '--release'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' });
    if (built.exitCode !== 0 || !existsSync(LIBRARY)) return null;
  }
  const u = FFIType.u32;
  const p = FFIType.ptr;
  const f = FFIType.f64;
  const { symbols: s } = dlopen(LIBRARY, {
    zs_alloc: { args: [FFIType.u64], returns: p },
    zs_free: { args: [p, FFIType.u64], returns: FFIType.void },
    zs_store_error: { args: [], returns: u },
    zs_table_new: { args: [p, u, u], returns: u },
    zs_table_free: { args: [u], returns: u },
    zs_table_rows: { args: [u], returns: f },
    zs_table_dropped: { args: [u], returns: f },
    zs_table_segments: { args: [u], returns: u },
    zs_table_segment_id: { args: [u, u], returns: f },
    zs_seg_begin: { args: [u, u], returns: u },
    zs_seg_values: { args: [u, u], returns: p },
    zs_seg_valid: { args: [u, u], returns: p },
    zs_seg_dict: { args: [u, u, u], returns: u },
    zs_seg_commit: { args: [u], returns: u },
    zs_seg_abort: { args: [u], returns: u },
    zs_snapshot: { args: [u], returns: u },
    zs_snapshot_free: { args: [u], returns: u },
    zs_snapshot_rows: { args: [u], returns: f },
    zs_snapshot_segments: { args: [u], returns: u },
    zs_snapshot_segment_id: { args: [u, u], returns: f },
    zs_snapshot_segment_rows: { args: [u, u], returns: u },
    zs_snapshot_values: { args: [u, u, u], returns: p },
    zs_snapshot_valid: { args: [u, u, u], returns: p },
    zs_snapshot_dict_len: { args: [u, u, u], returns: u },
    zs_plan_load: { args: [p, FFIType.u64], returns: u },
    zs_plan_free: { args: [u], returns: u },
    zs_params_load: { args: [u, p, FFIType.u64], returns: u },
    zs_params_free: { args: [u], returns: u },
    zs_params_table: { args: [u, u, p, FFIType.u64, p, FFIType.u64], returns: u },
    zs_expr_count: { args: [u, u], returns: FFIType.i32 },
    zs_expr_supported: { args: [u, u, u], returns: u },
    zs_eval: { args: [u, u, u, u, u, u, u, u], returns: u },
    zs_result_type: { args: [u], returns: u },
    zs_result_rows: { args: [u], returns: u },
    zs_result_values: { args: [u], returns: p },
    zs_result_valid: { args: [u], returns: p },
    zs_result_free: { args: [u], returns: u },
    zs_run_new: { args: [u, u, u, u], returns: u },
    zs_run_step: { args: [u], returns: u },
    zs_run_scanned: { args: [u], returns: FFIType.u64 },
    zs_run_finish: { args: [u], returns: u },
    zs_run_column: { args: [u], returns: u },
    zs_run_free: { args: [u], returns: u },
    zs_run_canon: { args: [u, u, u, p, FFIType.u64], returns: u },
    zs_session_begin: { args: [], returns: u },
    zs_session_end: { args: [u], returns: u },
    zs_session_arm: { args: [u, u], returns: u },
    zs_session_hits: { args: [u], returns: FFIType.u64 },
    zs_session_misses: { args: [u], returns: FFIType.u64 },
    zs_eval_error: { args: [], returns: u },
    zs_eval_error_what: { args: [], returns: u },
    zs_eval_error_type: { args: [], returns: u },
  });
  const withBytes = <R>(bytes: Uint8Array, f: (at: number) => R): R => {
    // Purpose: copy bytes into engine memory for the duration of a call
    const at = Number(s.zs_alloc!(Math.max(bytes.length, 1)) ?? 0);
    try {
      new Uint8Array(toArrayBuffer(at as unknown as Pointer, 0, Math.max(bytes.length, 1))).set(bytes);
      return f(at);
    } finally {
      s.zs_free!(at as unknown as Pointer, Math.max(bytes.length, 1));
    }
  };
  const ptr = (n: number) => n as unknown as Pointer;
  const num = (r: unknown) => Number(r ?? 0);
  return {
    alloc: bytes => num(s.zs_alloc!(bytes)),
    free: (at, bytes) => void s.zs_free!(ptr(at), bytes),
    view: (at, bytes) => (bytes === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(ptr(at), 0, bytes), 0, bytes)),
    storeError: () => s.zs_store_error!(),
    tableNew: (types, columns, retain) => s.zs_table_new!(ptr(types), columns, retain),
    tableFree: t => s.zs_table_free!(t),
    tableRows: t => s.zs_table_rows!(t),
    tableDropped: t => s.zs_table_dropped!(t),
    tableSegments: t => s.zs_table_segments!(t),
    tableSegmentId: (t, i) => s.zs_table_segment_id!(t, i),
    segBegin: (t, rows) => s.zs_seg_begin!(t, rows),
    segValues: (t, c) => num(s.zs_seg_values!(t, c)),
    segValid: (t, c) => num(s.zs_seg_valid!(t, c)),
    segDict: (t, c, n) => s.zs_seg_dict!(t, c, n),
    segCommit: t => s.zs_seg_commit!(t),
    segAbort: t => s.zs_seg_abort!(t),
    snapshot: t => s.zs_snapshot!(t),
    snapshotFree: h => s.zs_snapshot_free!(h),
    snapshotRows: h => s.zs_snapshot_rows!(h),
    snapshotSegments: h => s.zs_snapshot_segments!(h),
    snapshotSegmentId: (h, i) => s.zs_snapshot_segment_id!(h, i),
    snapshotSegmentRows: (h, i) => s.zs_snapshot_segment_rows!(h, i),
    snapshotValues: (h, i, c) => num(s.zs_snapshot_values!(h, i, c)),
    snapshotValid: (h, i, c) => num(s.zs_snapshot_valid!(h, i, c)),
    snapshotDictLen: (h, i, c) => s.zs_snapshot_dict_len!(h, i, c),
    planLoad: bytes => withBytes(bytes, at => s.zs_plan_load!(ptr(at), bytes.length)),
    planFree: h => s.zs_plan_free!(h),
    paramsLoad: (plan, bytes) => withBytes(bytes, at => s.zs_params_load!(plan, ptr(at), bytes.length)),
    paramsFree: h => s.zs_params_free!(h),
    paramsTable: (params, index, values, valid, entries) =>
      withBytes(values, at =>
        valid === null
          ? s.zs_params_table!(params, index, ptr(at), values.length, null, entries)
          : withBytes(valid, vat => s.zs_params_table!(params, index, ptr(at), values.length, ptr(vat), entries)),
      ),
    exprCount: (plan, node) => s.zs_expr_count!(plan, node),
    exprSupported: (plan, node, expr) => s.zs_expr_supported!(plan, node, expr),
    eval: (plan, params, node, expr, snapshot, segment, start, rows) =>
      s.zs_eval!(plan, params, node, expr, snapshot, segment, start, rows),
    resultType: r => s.zs_result_type!(r),
    resultRows: r => s.zs_result_rows!(r),
    resultValues: r => num(s.zs_result_values!(r)),
    resultValid: r => num(s.zs_result_valid!(r)),
    resultFree: r => s.zs_result_free!(r),
    runNew: (plan, params, snapshot, chunkRows) => s.zs_run_new!(plan, params, snapshot, chunkRows),
    runStep: r => s.zs_run_step!(r),
    runScanned: r => Number(s.zs_run_scanned!(r)),
    runFinish: r => s.zs_run_finish!(r),
    runColumn: i => s.zs_run_column!(i),
    runFree: r => s.zs_run_free!(r),
    runCanon: (run, column, segment, map) =>
      withBytes(new Uint8Array(map.buffer, map.byteOffset, map.byteLength), at => s.zs_run_canon!(run, column, segment, ptr(at), map.length)),
    sessionBegin: () => s.zs_session_begin!(),
    sessionEnd: h => s.zs_session_end!(h),
    sessionArm: (run, session) => s.zs_session_arm!(run, session),
    sessionHits: h => Number(s.zs_session_hits!(h)),
    sessionMisses: h => Number(s.zs_session_misses!(h)),
    evalError: () => s.zs_eval_error!(),
    evalErrorWhat: () => s.zs_eval_error_what!(),
    evalErrorType: () => s.zs_eval_error_type!(),
  };
}
