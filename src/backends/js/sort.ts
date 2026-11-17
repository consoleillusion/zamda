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
import { isBigInt, isString } from '../../types';
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

export function* sortSteps(
  keys: readonly SortColumn[],
  rowCount: number,
  limit: number | null,
): Generator<void, Uint32Array> {
  // Purpose: row indexes in sorted order, computed in steps that yield so the run can pause or abort.
  // With a limit, only the first `limit` indexes are returned.
  const compare = rowCompare(keys);
  if (limit !== null && limit < rowCount) {
    if (limit === 0) return new Uint32Array(0);
    return yield* topK(rowCount, limit, compare);
  }
  return yield* mergeSort(rowCount, compare);
}
