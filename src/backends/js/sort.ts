// The sort operator for the JS reference executor.
//
// It sorts row indexes, not rows, as a generator that yields between bounded
// steps so a long sort can be paused or aborted (docs/TASKS.md, T-201).
//
// It sorts row indexes, not rows. The comparator ends with the row index, which
// makes it a total order: the sort is stable on every JS engine (C-SORT-STABLE),
// and a bounded top-k returns exactly what a full sort then limit would.

import type { Column } from '../../column';
import { bigs, nums, texts } from '../../column';
import { isBigInt, isInt, isString } from '../../types';
import type { DataType } from '../../types';
import { compareStrings, orderNumbers } from './kernel-util';

export interface SortColumn {
  readonly column: Column;
  readonly descending: boolean;
  readonly nullsFirst: boolean;
}

type Compare = (i: number, j: number) => number;

function valueCompare(column: Column): Compare {
  // Purpose: compare two non-null rows of one column in the contract's ordering
  if (isString(column.type)) {
    const a = texts(column);
    return function (i, j) {
      return compareStrings(a[i]!, a[j]!);
    };
  }
  if (isBigInt(column.type)) {
    const a = bigs(column);
    return function (i, j) {
      return a[i]! < a[j]! ? -1 : a[i]! > a[j]! ? 1 : 0;
    };
  }
  // C-NAN-ORDER: NaN is greater than every number.
  const a = nums(column);
  return function (i, j) {
    return orderNumbers(a[i]!, a[j]!);
  };
}

function keyCompare(key: SortColumn): Compare {
  // Purpose: one key's comparator: nulls placed first or last, values ascending or descending
  const values = valueCompare(key.column);
  const valid = key.column.valid;
  const sign = key.descending ? -1 : 1;
  if (!valid) {
    return function (i, j) {
      return sign * values(i, j);
    };
  }
  // C-NULL-SORT: null placement does not depend on the sort direction.
  const nullRank = key.nullsFirst ? -1 : 1;
  return function (i, j) {
    const vi = valid[i]!;
    const vj = valid[j]!;
    if (vi && vj) return sign * values(i, j);
    if (vi === vj) return 0;
    return vi ? -nullRank : nullRank;
  };
}

function rowCompare(keys: readonly SortColumn[]): Compare {
  // Purpose: compare two rows by every key in turn, then by row index
  const compares = keys.map(keyCompare);
  if (compares.length === 1) {
    const only = compares[0]!;
    return function (i, j) {
      return only(i, j) || i - j;
    };
  }
  return function (i, j) {
    for (const compare of compares) {
      const c = compare(i, j);
      if (c !== 0) return c;
    }
    return i - j;
  };
}

// How much work a sort does between two yields, in comparisons' worth of rows.
const STEP_ROWS = 65536;

function* topK(rowCount: number, k: number, compare: Compare): Generator<void, Uint32Array> {
  // Purpose: the first k rows of the sorted order, using a heap of the k best rows seen so far
  const heap = new Uint32Array(k);
  let size = 0;
  // Max-heap: heap[0] is the worst row kept, so it is the one to replace.
  const siftDown = function (start: number): void {
    // Purpose: restore the heap below `start`
    let at = start;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let worst = at;
      if (left < size && compare(heap[left]!, heap[worst]!) > 0) worst = left;
      if (right < size && compare(heap[right]!, heap[worst]!) > 0) worst = right;
      if (worst === at) return;
      const swap = heap[at]!;
      heap[at] = heap[worst]!;
      heap[worst] = swap;
      at = worst;
    }
  };
  for (let row = 0; row < rowCount; row++) {
    if (size < k) {
      // Sift the new row up.
      let at = size++;
      heap[at] = row;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (compare(heap[at]!, heap[parent]!) <= 0) break;
        const swap = heap[at]!;
        heap[at] = heap[parent]!;
        heap[parent] = swap;
        at = parent;
      }
    } else if (compare(row, heap[0]!) < 0) {
      heap[0] = row;
      siftDown(0);
    }
    if ((row + 1) % STEP_ROWS === 0) yield;
  }
  return heap.subarray(0, size).sort(compare);
}

function* mergeSort(rowCount: number, compare: Compare): Generator<void, Uint32Array> {
  // Purpose: full sort in bounded steps: sort runs of STEP_ROWS natively, then merge runs pairwise
  let from = new Uint32Array(rowCount);
  for (let i = 0; i < rowCount; i++) from[i] = i;
  for (let start = 0; start < rowCount; start += STEP_ROWS) {
    from.subarray(start, Math.min(start + STEP_ROWS, rowCount)).sort(compare);
    yield;
  }
  let to = new Uint32Array(rowCount);
  let sinceYield = 0;
  for (let width = STEP_ROWS; width < rowCount; width *= 2) {
    for (let left = 0; left < rowCount; left += 2 * width) {
      const middle = Math.min(left + width, rowCount);
      const end = Math.min(left + 2 * width, rowCount);
      let a = left;
      let b = middle;
      let out = left;
      while (a < middle && b < end) {
        // On a tie take the left run first; the comparator is a total order, so ties cannot occur anyway.
        to[out++] = compare(from[b]!, from[a]!) < 0 ? from[b++]! : from[a++]!;
        if (++sinceYield === STEP_ROWS) {
          sinceYield = 0;
          yield;
        }
      }
      while (a < middle) to[out++] = from[a++]!;
      while (b < end) to[out++] = from[b++]!;
    }
    const swap = from;
    from = to;
    to = swap;
  }
  return from;
}

// ---------------------------------------------------------------------------
// Radix sort for integer keys
// ---------------------------------------------------------------------------
//
// When every key is an integer or boolean column, rows are ordered by an LSD
// radix sort over the keys' bits instead of by comparisons. Each key becomes an
// unsigned 32-bit word whose natural order is the key's order: signed values
// have their sign bit flipped, descending keys are inverted, and null rows get
// word 0 plus a separate null rank, so every null ties with every other null.
// Passes run from the last key to the first and from the low digit to the high
// digit; each pass is stable, so rows that tie on every key stay in input order,
// the same total order the comparison sort gets from its row-index tie-break
// (C-SORT-STABLE, C-NULL-SORT).

interface RadixKey {
  readonly words: Uint32Array;
  readonly bits: number;
  // 0 or 1 per row when the column can be null: where the row sits relative to non-null rows.
  readonly nullRank: Uint32Array | null;
}

// Limits up to this many rows use the heap even when the radix sort could run.
const HEAP_LIMIT_ROWS = 8192;

// Rows processed between two yields inside a pass: the same bound as the merge sort's steps.
const BLOCK_ROWS = STEP_ROWS;
// The widest digit: 2^11 buckets keeps the counts in cache.
const MAX_DIGIT_BITS = 11;

function integerWidth(type: DataType): { bits: number; signed: boolean } | null {
  // Purpose: the bit width and signedness of a type the radix sort can handle, or null
  if (type.name === 'bool') return { bits: 8, signed: false };
  if (!isInt(type)) return null;
  switch (type.name) {
    case 'int8':
      return { bits: 8, signed: true };
    case 'int16':
      return { bits: 16, signed: true };
    case 'int32':
      return { bits: 32, signed: true };
    case 'uint8':
      return { bits: 8, signed: false };
    case 'uint16':
      return { bits: 16, signed: false };
    case 'uint32':
      return { bits: 32, signed: false };
    default:
      return null;
  }
}

function radixKeys(keys: readonly SortColumn[], rowCount: number): RadixKey[] | null {
  // Purpose: turn every sort key into radix words, or null if any key needs the comparison sort
  const out: RadixKey[] = [];
  for (const key of keys) {
    const width = integerWidth(key.column.type);
    if (!width) return null;
    const values = nums(key.column);
    const valid = key.column.valid;
    const words = new Uint32Array(rowCount);
    const flip = width.signed ? 2 ** (width.bits - 1) : 0;
    const top = width.bits === 32 ? 4294967295 : 2 ** width.bits - 1;
    for (let i = 0; i < rowCount; i++) {
      let word = (values[i]! + flip) >>> 0;
      if (key.descending) word = (top - word) >>> 0;
      words[i] = word;
    }
    let nullRank: Uint32Array | null = null;
    if (valid) {
      nullRank = new Uint32Array(rowCount);
      for (let i = 0; i < rowCount; i++) {
        if (valid[i]) {
          nullRank[i] = key.nullsFirst ? 1 : 0;
        } else {
          nullRank[i] = key.nullsFirst ? 0 : 1;
          words[i] = 0;
        }
      }
    }
    out.push({ words, bits: width.bits, nullRank });
  }
  return out;
}

function* radixPass(
  from: Uint32Array,
  to: Uint32Array,
  words: Uint32Array,
  shift: number,
  mask: number,
  counts: Uint32Array,
  rowCount: number,
): Generator<void, boolean> {
  // Purpose: one stable counting-sort pass of `from` into `to` by one digit of `words`; false (and no reordering) if every row has the same digit
  counts.fill(0, 0, mask + 1);
  for (let start = 0; start < rowCount; start += BLOCK_ROWS) {
    const end = Math.min(start + BLOCK_ROWS, rowCount);
    for (let i = start; i < end; i++) counts[(words[i]! >>> shift) & mask]!++;
    if (end < rowCount) yield;
  }
  if (counts[(words[0]! >>> shift) & mask] === rowCount) return false;
  let sum = 0;
  for (let b = 0; b <= mask; b++) {
    const c = counts[b]!;
    counts[b] = sum;
    sum += c;
  }
  for (let start = 0; start < rowCount; start += BLOCK_ROWS) {
    const end = Math.min(start + BLOCK_ROWS, rowCount);
    for (let i = start; i < end; i++) {
      const row = from[i]!;
      to[counts[(words[row]! >>> shift) & mask]!++] = row;
    }
    if (end < rowCount) yield;
  }
  return true;
}

function* radixSort(keys: readonly RadixKey[], rowCount: number): Generator<void, Uint32Array> {
  // Purpose: all row indexes in sorted order, by LSD radix passes over the keys, last key first
  let from = new Uint32Array(rowCount);
  for (let i = 0; i < rowCount; i++) from[i] = i;
  if (rowCount < 2) return from;
  let to = new Uint32Array(rowCount);
  const counts = new Uint32Array(1 << MAX_DIGIT_BITS);
  for (let k = keys.length - 1; k >= 0; k--) {
    const { words, bits, nullRank } = keys[k]!;
    const passes = Math.ceil(bits / MAX_DIGIT_BITS);
    const digitBits = Math.ceil(bits / passes);
    const mask = (1 << digitBits) - 1;
    for (let p = 0; p < passes; p++) {
      const shift = p * digitBits;
      const moved = yield* radixPass(from, to, words, shift, mask, counts, rowCount);
      if (moved) {
        const swap = from;
        from = to;
        to = swap;
      }
      // Let the driver check the time and the abort signal after every pass.
      yield;
    }
    if (nullRank) {
      const moved = yield* radixPass(from, to, nullRank, 0, 1, counts, rowCount);
      if (moved) {
        const swap = from;
        from = to;
        to = swap;
      }
      yield;
    }
  }
  return from;
}

export function* sortSteps(
  keys: readonly SortColumn[],
  rowCount: number,
  limit: number | null,
): Generator<void, Uint32Array> {
  // Purpose: row indexes in sorted order, computed in steps that yield so the run can pause or abort.
  // With a limit, only the first `limit` indexes are returned.
  // A small limit is cheaper with a heap than with a full sort: few rows ever replace the worst kept row.
  const heapIsCheaper = limit !== null && limit <= HEAP_LIMIT_ROWS;
  if (!heapIsCheaper) {
    const radix = radixKeys(keys, rowCount);
    if (radix) {
      yield;
      const order = yield* radixSort(radix, rowCount);
      return limit !== null && limit < rowCount ? order.subarray(0, limit) : order;
    }
  }
  const compare = rowCompare(keys);
  if (limit !== null && limit < rowCount) {
    if (limit === 0) return new Uint32Array(0);
    return yield* topK(rowCount, limit, compare);
  }
  return yield* mergeSort(rowCount, compare);
}
