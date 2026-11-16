// The sort operator for the JS reference executor.
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

function topK(rowCount: number, k: number, compare: Compare): Uint32Array {
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
  }
  return heap.subarray(0, size).sort(compare);
}

export function sortIndices(keys: readonly SortColumn[], rowCount: number, limit: number | null): Uint32Array {
  // Purpose: row indexes in sorted order; with a limit, only the first `limit` of them
  const compare = rowCompare(keys);
  if (limit !== null && limit < rowCount) {
    return limit === 0 ? new Uint32Array(0) : topK(rowCount, limit, compare);
  }
  const indices = new Uint32Array(rowCount);
  for (let i = 0; i < rowCount; i++) indices[i] = i;
  return indices.sort(compare);
}
