// T-212: a sort keeps a selection over its source and gathers the chosen rows
// only after the order is known. These tests check the observable consequence
// (a pass-through source column is read once, by the final gather, not copied
// before the sort) and that the order still matches a reference comparator over
// chunked, multi-segment, filtered and limited plans.

import { describe, expect, test } from 'bun:test';
import type { BackendOptions, ResultData } from '../src/backend';
import type { Column } from '../src/column';
import { makeColumn, nums } from '../src/column';
import type { Segment } from '../src/backends/js/exec';
import { runPlan } from '../src/backends/js/exec';
import { pipe, schema, t, table } from '../src';
import type { Cols, SortKey } from '../src';

const S = schema({
  id: t.int32,
  k: t.int32,
  f: t.float64,
  s: t.utf8,
  d: t.dictionary,
  big: t.int64,
});

interface Row {
  id: number;
  k: number | null;
  f: number | null;
  s: string | null;
  d: string | null;
  big: bigint | null;
}

interface KeySpec {
  readonly name: 'k' | 'f' | 's' | 'd' | 'big';
  readonly descending: boolean;
  readonly nullsFirst: boolean;
}

function random(seed: number): () => number {
  // Purpose: deterministic pseudo-random number in [0, 1)
  let state = seed;
  return function () {
    // Purpose: next number (mulberry32)
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRows(n: number, rand: () => number): Row[] {
  // Purpose: rows with ties, nulls, NaN and strings above U+FFFF
  const words = ['a', 'ab', 'b', 'z', '～', '\u{1F600}'];
  return Array.from({ length: n }, function (_, id): Row {
    const word = function (): string | null {
      // Purpose: a random string key, sometimes null
      return rand() < 0.12 ? null : words[Math.floor(rand() * words.length)]!;
    };
    return {
      id,
      k: rand() < 0.15 ? null : Math.floor(rand() * 19) - 9,
      f: rand() < 0.1 ? null : rand() < 0.08 ? NaN : Math.floor(rand() * 29) - 14 + 0.5,
      s: word(),
      d: word(),
      big: rand() < 0.1 ? null : BigInt(Math.floor(rand() * 11) - 5) * (2n ** 40n),
    };
  });
}

function codePointOrder(a: string, b: string): number {
  // Purpose: compare by Unicode code point, not by UTF-16 unit (C-STR-ORDER)
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const left = x[i]!.codePointAt(0)!;
    const right = y[i]!.codePointAt(0)!;
    if (left !== right) return left < right ? -1 : 1;
  }
  return x.length - y.length;
}

function valueOrder(a: unknown, b: unknown): number {
  // Purpose: the contract's order for two present values, with NaN greatest (C-NAN-ORDER)
  if (typeof a === 'string' && typeof b === 'string') return codePointOrder(a, b);
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const x = a as number;
  const y = b as number;
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
  if (Number.isNaN(y)) return -1;
  if (x === 0 && y === 0) return 0;
  return x < y ? -1 : x > y ? 1 : 0;
}

function referenceOrder(rows: readonly Row[], specs: readonly KeySpec[]): number[] {
  // Purpose: stable sort of row numbers by a plain comparator, independent of the executor
  const order = Array.from({ length: rows.length }, function (_, i) {
    return i;
  });
  return order.sort(function (i, j) {
    for (const spec of specs) {
      const a = rows[i]![spec.name];
      const b = rows[j]![spec.name];
      const an = a === null || a === undefined;
      const bn = b === null || b === undefined;
      if (an && bn) continue;
      if (an !== bn) {
        const rank = spec.nullsFirst ? -1 : 1;
        return an ? rank : -rank;
      }
      let c = valueOrder(a, b);
      if (spec.descending) c = -c;
      if (c !== 0) return c;
    }
    return i - j;
  });
}

function makeSpecs(rand: () => number): KeySpec[] {
  // Purpose: one to three distinct keys with random direction and null placement
  const names: KeySpec['name'][] = ['k', 'f', 's', 'd', 'big'];
  const count = 1 + Math.floor(rand() * 3);
  const specs: KeySpec[] = [];
  for (let i = 0; i < count; i++) {
    const at = Math.floor(rand() * names.length);
    const name = names.splice(at, 1)[0]!;
    specs.push({ name, descending: rand() < 0.5, nullsFirst: rand() < 0.5 });
  }
  return specs;
}

function runSpecs(specs: readonly KeySpec[]) {
  // Purpose: build the sort keys for one plan from their fixed descriptions
  return function (c: Cols<typeof S.fields>): SortKey[] {
    return specs.map(function (spec) {
      const expr = c[spec.name];
      const key = spec.descending ? expr.desc() : expr.asc();
      return spec.nullsFirst ? key.nullsFirst() : key;
    });
  };
}

describe('sort over a selection', () => {
  test('results match a reference comparator across chunks, segments, filters and top-k', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const rand = random(seed);
      const rows = makeRows(1200, rand);
      // Three segments, so the sort sees separate pieces rather than one dense batch.
      const tb = table(S, rows.slice(0, 400));
      tb.append(rows.slice(400, 850));
      tb.append(rows.slice(850));
      const specs = makeSpecs(rand);
      const filterFrom = seed % 2 === 0 ? 100 : null;
      const limit = [null, 3, 900, 1300][seed % 4]!;

      let pipeline = pipe(S);
      if (filterFrom !== null) pipeline = pipeline.filter(c => c.id.gte(filterFrom));
      pipeline = pipeline.sort(runSpecs(specs));
      if (limit !== null) pipeline = pipeline.limit(limit);
      const plan = pipeline.compile();

      const source = filterFrom === null ? rows : rows.filter(r => r.id >= filterFrom);
      const expected = referenceOrder(source, specs)
        .slice(0, limit ?? undefined)
        .map(i => source[i]!);
      for (const chunkRows of [7, 64, 65536]) {
        const out = (await plan.execute(tb, { chunkRows })).toArray();
        expect(out, `seed ${seed}, chunkRows ${chunkRows}`).toEqual(expected);
      }
    }
  });

  test('a computed key sorts the same rows as a plain key', async () => {
    const rows = makeRows(600, random(71));
    const tb = table(S, rows.slice(0, 300));
    tb.append(rows.slice(300));
    const plan = pipe(S)
      .filter(c => c.k.isNull().not())
      .sort(c => [c.k.abs().desc(), c.id.asc()])
      .limit(25)
      .compile();
    const source = rows.filter(r => r.k !== null);
    const expected = source
      .map((row, i) => ({ row, i }))
      .sort((a, b) => Math.abs(b.row.k!) - Math.abs(a.row.k!) || a.i - b.i)
      .slice(0, 25)
      .map(entry => entry.row);
    for (const chunkRows of [11, 128]) {
      expect((await plan.execute(tb, { chunkRows })).toArray()).toEqual(expected);
    }
  });
});

// Reads of a source cell are counted through an array-like view, not a typed
// array: TypedArray.set has a fast path for typed-array sources that would skip
// a proxy's get trap. subarray() returns another view, so chunking keeps the
// counter. A pre-sort copy reads the view's length; the sorted gather only
// indexes cells. No executor code knows this view is there.
interface Reads {
  cells: number;
  lengths: number;
}

function wrapped(values: Int32Array, reads: Reads, start = 0, end = values.length): unknown {
  // Purpose: a counted array-like view of [start, end) over a source column
  return new Proxy({}, {
    get(_target, prop) {
      // Purpose: count a cell or length read, or hand out a subarray view
      if (prop === 'length') {
        reads.lengths++;
        return end - start;
      }
      if (prop === 'subarray') {
        return (from = 0, to = end - start): unknown => wrapped(values, reads, start + from, start + to);
      }
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        const at = Number(prop);
        if (at >= 0 && at < end - start) {
          reads.cells++;
          return values[start + at]!;
        }
      }
      return undefined;
    },
    has(_target, prop) {
      // Purpose: report the array-like properties the executor may look for
      return prop === 'length' || prop === 'subarray' || (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop));
    },
    ownKeys() {
      // Purpose: list the view's length and indexed cells
      return ['length', ...Array.from({ length: end - start }, function (_, i) {
        return String(i);
      })];
    },
    getOwnPropertyDescriptor(_target, prop) {
      // Purpose: describe a property without counting it as a read
      if (prop === 'length') return { value: end - start, enumerable: false, configurable: true };
      return { value: undefined, enumerable: true, configurable: true };
    },
  });
}

function countingColumn(values: Int32Array, reads: Reads): Column {
  // Purpose: a column that records how the executor reads it
  return {
    type: t.int32,
    valid: null,
    get values() {
      return wrapped(values, reads) as Column['values'];
    },
  };
}

function drain(gen: Generator<void, ResultData>): ResultData {
  // Purpose: run a plan generator to completion
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

describe('no pre-sort copy', () => {
  test('a pass-through column is gathered after the sort, never copied before it', () => {
    const n = 24;
    const keys = Int32Array.from({ length: n }, function (_, i) {
      return (i * 7) % 11;
    });
    const payload = Int32Array.from({ length: n }, function (_, i) {
      return 100 + i;
    });
    const reads: Reads = { cells: 0, lengths: 0 };
    const segments: Segment[] = [
      {
        columns: [makeColumn(t.int32, keys, null), countingColumn(payload, reads)],
        rowCount: n,
      },
    ];
    const P = schema({ k: t.int32, v: t.int32 });
    const plan = pipe(P)
      .sort(c => c.k.asc())
      .compile();
    const options: BackendOptions = { params: new Map(), chunkRows: 4 };
    const out = drain(runPlan(plan.ir, segments, options, { rowsScanned: 0, rowsTotal: n }));

    // One cell read per output row, from the final gather. The old pre-sort
    // concat() read each chunk's length to copy it into a dense batch.
    expect(reads.cells).toBe(n);
    expect(reads.lengths).toBe(0);
    const expected = Array.from({ length: n }, function (_, i) {
      return i;
    }).sort(function (a, b) {
      return keys[a]! - keys[b]! || a - b;
    });
    const v = nums(out.columns[1]!);
    expect(Array.from({ length: n }, function (_, i) {
      return v[i];
    })).toEqual(expected.map(i => payload[i]));
  });
});
