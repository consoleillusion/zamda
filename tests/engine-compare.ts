// Shared by the engine cross-checks: read an engine result out of engine memory
// and compare it with a JS column.

import { expect } from 'bun:test';
import type { Column } from '../src/column';
import { TYPE_NAMES } from '../src/ir-binary';
import type { TypeName } from '../src/types';
import type { EvalHost } from './engine-host';

export interface Engine {
  rows: number;
  type: number;
  values: Uint8Array;
  valid: Uint8Array | null;
}

export function widthOf(type: number): number {
  // Purpose: bytes per value of a type id
  return (({ bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, date32: 4, utf8: 4, dictionary: 4 }) as Record<string, number>)[TYPE_NAMES[type]!] ?? 8;
}

export function readResult(h: EvalHost, r: number): Engine {
  // Purpose: copy a result out of the engine and free it
  const type = h.resultType(r);
  const rows = h.resultRows(r);
  const values = h.view(h.resultValues(r), rows * widthOf(type)).slice();
  const v = h.resultValid(r);
  const valid = v === 0 ? null : h.view(v, rows).slice();
  h.resultFree(r);
  return { rows, type, values, valid };
}

function same(a: number, b: number, float: boolean): boolean {
  // Purpose: equal values, with NaN equal to NaN and -0 different from 0
  return float ? (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b) : a === b;
}

export function compareValues(type: TypeName, js: Column, e: Engine, label: string): void {
  // Purpose: the engine's result equals the JS column in null rows and, for rows that are not null, in value
  const n = e.rows;
  expect(js.values.length, label).toBe(n);
  const jsValid = js.valid;
  for (let i = 0; i < n; i++) {
    const jv = jsValid ? jsValid[i]! : 1;
    const ev = e.valid ? e.valid[i]! : 1;
    if (jv !== ev) throw new Error(`${label}: row ${i} validity differs (js ${jv}, engine ${ev})`);
  }
  const copy = e.values.buffer.slice(e.values.byteOffset, e.values.byteOffset + e.values.byteLength);
  const typed =
    type === 'float64' || type === 'timestamp' ? new Float64Array(copy)
    : type === 'float32' ? new Float32Array(copy)
    : type === 'int64' ? new BigInt64Array(copy)
    : type === 'uint64' ? new BigUint64Array(copy)
    : type === 'int32' || type === 'date32' ? new Int32Array(copy)
    : type === 'uint32' ? new Uint32Array(copy)
    : type === 'int16' ? new Int16Array(copy)
    : type === 'uint16' ? new Uint16Array(copy)
    : type === 'int8' ? new Int8Array(copy)
    : new Uint8Array(copy);
  const float = type.startsWith('float') || type === 'timestamp';
  const jsValues = js.values as unknown as ArrayLike<number | bigint>;
  for (let i = 0; i < n; i++) {
    if (jsValid && !jsValid[i]) continue;
    const a = jsValues[i]!;
    const b = typed[i]!;
    const ok = typeof a === 'bigint' ? a === b : same(a as number, b as number, float);
    if (!ok) throw new Error(`${label}: row ${i} differs (js ${String(a)}, engine ${String(b)})`);
  }
}

