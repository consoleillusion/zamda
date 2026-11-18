// The benchmark harness's guard: every query must give the same answer in
// zamda and in Arquero, on data with nulls, empty groups and ties. If this
// fails, a published speed-up could be a fast wrong answer.

import { describe, expect, test } from 'bun:test';
import { arqueroFromColumns, sample, zamdaFromColumns } from '../bench/reference/data';
import type { RouteArrays } from '../bench/reference/data';
import { QUERIES } from '../bench/reference/queries';

function fakeArrays(n: number): RouteArrays {
  // Purpose: a small routes table with null names and regions, repeated origins and many equal sort keys
  let state = 12345;
  const rand = function (): number {
    // Purpose: deterministic pseudo-random number in [0, 1)
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const prefix_addr = new Uint32Array(n);
  const prefix_len = new Uint8Array(n);
  const origin_as = new Uint32Array(n);
  const path_len = new Uint8Array(n);
  const as_name: (string | null)[] = [];
  const rir: (string | null)[] = [];
  const regions = ['ARIN', 'RIPE NCC', 'APNIC'];
  for (let i = 0; i < n; i++) {
    prefix_len[i] = 16 + Math.floor(rand() * 9);
    prefix_addr[i] = Math.floor(rand() * 200) * 16_777_216;
    const network = Math.floor(rand() ** 2 * 60);
    origin_as[i] = network % 3 === 0 ? 4_200_000_000 + network : network + 1;
    path_len[i] = 1 + Math.floor(rand() * 8);
    as_name.push(network % 7 === 0 ? null : `${network % 5 === 0 ? 'Cloud' : 'NET'}-${network}`);
    rir.push(network % 11 === 0 ? null : regions[network % 3]!);
  }
  return { rowCount: n, prefix_addr, prefix_len, origin_as, as_name, path_len, rir };
}

describe('reference benchmark queries', () => {
  for (const rows of [3000, 777]) {
    const arrays = rows === 3000 ? fakeArrays(rows) : sample(fakeArrays(3000), rows);
    const zamda = zamdaFromColumns(arrays);
    const arquero = arqueroFromColumns(arrays);
    for (const q of QUERIES) {
      test(`${q.id} ${q.label} agrees between engines at ${rows} rows`, async () => {
        const z = q.zamdaSummary(await q.zamdaExec(zamda));
        const a = q.arqueroSummary(q.arqueroExec(arquero));
        expect(z).toBe(a);
        expect(z.length).toBeGreaterThan(0);
      });
    }
  }

  test('sampling keeps every k-th row and the requested size', () => {
    const arrays = fakeArrays(1000);
    const small = sample(arrays, 100);
    expect(small.rowCount).toBe(100);
    expect(small.origin_as[1]).toBe(arrays.origin_as[10]);
    expect(small.as_name[99]).toBe(arrays.as_name[990]);
    expect(sample(arrays, 5000)).toBe(arrays);
  });
});
