// Bun only: the same kernels as a native shared library, called through bun:ffi.
// This is the upper bound for what WASM can reach: WASM runs the same code a
// little slower (bounds checks on memory, no wide SIMD unless enabled).

import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';
import type { RawKernels } from './engine';

export function loadNative(path: string): RawKernels {
  // Purpose: open the shared library and wrap its functions in the RawKernels shape
  const { symbols: s } = dlopen(path, {
    zs_alloc: { args: [FFIType.u64], returns: FFIType.ptr },
    zs_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
    zs_overflowed: { args: [], returns: FFIType.u32 },
    zs_q1: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    zs_q3: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    zs_q4: { args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    zs_mask: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    zs_c_networks: { args: [FFIType.u64, FFIType.ptr, FFIType.u8, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    zs_c_hist: { args: [FFIType.u64, FFIType.ptr, FFIType.u8, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    zs_c_regions: { args: [FFIType.u64, FFIType.ptr, FFIType.u8, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    zs_q7: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.void },
  });
  // Pointers travel as numbers. The ones the library hands out stay below 2^53 on 64-bit desktop systems.
  const asPtr = (n: number) => n as unknown as import('bun:ffi').Pointer;
  return {
    alloc: bytes => Number(s.zs_alloc!(bytes)),
    free: (ptr, bytes) => void s.zs_free!(asPtr(ptr), bytes),
    u8: (ptr, length) => new Uint8Array(toArrayBuffer(asPtr(ptr), 0, length), 0, length),
    u32: (ptr, length) => new Uint32Array(toArrayBuffer(asPtr(ptr), 0, length * 4), 0, length),
    q1: (n, a, b, c, d, f) => Number(s.zs_q1!(n, asPtr(a), asPtr(b), asPtr(c), asPtr(d), asPtr(f))),
    q3: (n, a, b, c, d) => void s.zs_q3!(n, asPtr(a), asPtr(b), asPtr(c), asPtr(d)),
    q4: (n, a, l, c, d) => Number(s.zs_q4!(n, asPtr(a), l, asPtr(c), asPtr(d))),
    q7: (n, a, b, c, d, r) => void s.zs_q7!(n, asPtr(a), asPtr(b), asPtr(c), asPtr(d), r),
    mask: (n, a, b, c, d, f, g, h, i, j, k) => void s.zs_mask!(n, asPtr(a), asPtr(b), asPtr(c), asPtr(d), asPtr(f), asPtr(g), asPtr(h), asPtr(i), j, asPtr(k)),
    cNetworks: (n, m, k, o, nm, a, b, c) => Number(s.zs_c_networks!(n, asPtr(m), k, asPtr(o), asPtr(nm), asPtr(a), asPtr(b), asPtr(c))),
    cHist: (n, m, k, col, out) => void s.zs_c_hist!(n, asPtr(m), k, asPtr(col), asPtr(out)),
    cRegions: (n, m, k, r, o, a, b) => void s.zs_c_regions!(n, asPtr(m), k, asPtr(r), asPtr(o), asPtr(a), asPtr(b)),
    overflowed: () => Number(s.zs_overflowed!()),
  };
}
