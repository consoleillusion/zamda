// The engine as a native shared library, for tests that cannot run WASM here:
// the same C functions, called through bun:ffi. Builds the library if it is
// missing and `cargo` is available; otherwise `nativeHost()` returns null.

import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import { existsSync } from 'node:fs';
import type { EngineHost } from '../src/backends/wasm/store';

const ROOT = new URL('../engine/', import.meta.url).pathname;
const SUFFIX = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
const LIBRARY = `${ROOT}target/release/${process.platform === 'win32' ? '' : 'lib'}zamda_engine.${SUFFIX}`;

export function nativeHost(): EngineHost | null {
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
  });
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
  };
}
