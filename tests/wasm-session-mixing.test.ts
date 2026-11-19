// Sessions must never hand one chart another chart's filter result: different parameter values,
// different tables and a table that grew in the middle of a session all have to give JS-backend answers.

import { describe, expect, test } from 'bun:test';
import { count, list, pipe, schema, t, table } from '../src';
import { createWasmBackend } from '../src/backends/wasm';
import { nativeHost } from './engine-host';

const host = nativeHost();
const maybe = host === null ? describe.skip : describe;

const S = schema({ k: t.int32, v: t.int32, d: t.dictionary, u: t.utf8 });
const N = 200_000;
const rows = Array.from({ length: N }, (_, i) => ({ k: i % 97, v: i, d: i % 5 === 0 ? null : `g${i % 11}`, u: i % 7 === 0 ? null : `w${i % 13}` }));
const P = { lo: t.int32, hi: t.int32, word: t.utf8, on: t.bool, groups: list(t.dictionary) };
const chart = (by: 'k' | 'd') =>
  pipe(S, P)
    .filter((c, p) => c.v.between(p.lo, p.hi).and(p.on.or(c.u.lower().contains(p.word))).and(c.d.isIn(p.groups)))
    .groupBy(c => (by === 'k' ? { g: c.k } : { g: c.d }))
    .agg(() => ({ n: count() }))
    .compile();
const plans = [chart('k'), chart('d'), chart('k'), chart('d')] as const;
const sets = [
  { lo: 0, hi: 150_000, word: 'w1', on: false, groups: ['g1', 'g2', 'g3'] },
  { lo: 0, hi: 150_000, word: 'w1', on: false, groups: ['g1', 'g2'] },
  { lo: 10, hi: 150_000, word: 'w1', on: false, groups: ['g1', 'g2', 'g3'] },
  { lo: 0, hi: 150_000, word: 'w2', on: false, groups: ['g1', 'g2', 'g3'] },
  { lo: 0, hi: 150_000, word: 'w1', on: true, groups: ['g1', 'g2', 'g3'] },
];

maybe('wasm sessions never mix results', () => {
  test('four charts at once in one session, every pair of parameter sets, two chunk sizes', async () => {
    const { backend, table: wasmTable } = createWasmBackend(host!);
    const big = wasmTable(S, rows);
    const jsBig = table(S, rows);
    for (const options of [{ chunkRows: 999, sliceMs: 0 }, { chunkRows: 20_000, sliceMs: 0 }]) {
      for (const a of sets) {
        for (const b of sets) {
          const run = (tbl: typeof big, session?: unknown) =>
            Promise.all([plans[0].execute(tbl, { ...options, params: a, session } as never), plans[1].execute(tbl, { ...options, params: b, session } as never), plans[2].execute(tbl, { ...options, params: b, session } as never), plans[3].execute(tbl, { ...options, params: a, session } as never)]);
          const session = backend.session();
          const got = (await run(big, session)).map(r => r.toArray());
          session.close();
          const want = (await run(jsBig as unknown as typeof big)).map(r => r.toArray());
          expect(got).toEqual(want);
        }
      }
    }
  });

  test('one session used over two different tables', async () => {
    const { backend, table: wasmTable } = createWasmBackend(host!);
    const rowsB = rows.map((r, i) => ({ ...r, v: (i * 7919) % N, d: i % 3 === 0 ? 'g1' : `g${(i + 4) % 11}` }));
    const a = wasmTable(S, rows);
    const b = wasmTable(S, rowsB);
    const jsA = table(S, rows);
    const jsB = table(S, rowsB);
    const session = backend.session();
    const params = sets[0]!;
    const gotA = (await plans[0].execute(a, { params, session } as never)).toArray();
    const gotB = (await plans[0].execute(b, { params, session } as never)).toArray();
    session.close();
    expect(gotA).toEqual((await plans[0].execute(jsA, { params })).toArray());
    expect(gotB).toEqual((await plans[0].execute(jsB, { params })).toArray());
  });

  test('a table that gets new strings in the middle of a session', async () => {
    const { backend, table: wasmTable } = createWasmBackend(host!);
    const big = wasmTable(S, rows);
    const jsBig = table(S, rows);
    const extra = Array.from({ length: 5000 }, (_, i) => ({ k: i % 5, v: i, d: `new${i % 4}`, u: `aw${i % 6}` }));
    const session = backend.session();
    const params = { ...sets[3]!, groups: ['g1', 'g2', 'new1'] };
    await plans[0].execute(big, { params, session } as never);
    big.append(extra);
    (jsBig as unknown as { append(r: unknown): void }).append(extra);
    const got = (await plans[1].execute(big, { params, session } as never)).toArray();
    session.close();
    expect(got).toEqual((await plans[1].execute(jsBig, { params })).toArray());
  });
});
