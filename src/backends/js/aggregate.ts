// The aggregate operator for the JS reference executor: hash group-by.
//
// Two phases. First every row gets a group id, numbered in order of first
// occurrence (C-GROUP-ORDER). Then each aggregate runs one loop over the rows,
// writing into arrays indexed by group id.

import type { AnyCells, BigCells, Column } from '../../column';
import { allocate, bigs, cells, makeColumn, nums, take, texts } from '../../column';
import { PlanError } from '../../errors';
import type { IrAggregate } from '../../ir';
import type { DataType } from '../../types';
import { BIGINT_RANGES, isBigInt, isFloat, isInt, isString, t } from '../../types';
import { compareStrings, orderNumbers, overflow } from './kernel-util';

// The rows to aggregate: `count` rows, read directly, or through `sel` when the
// input was filtered or sorted (row i of the input is base row sel[i]). Reading
// through the selection avoids copying the surviving rows first.
export interface Rows {
  readonly count: number;
  readonly sel: Uint32Array | null;
}

interface Groups {
  // Group id of every row.
  readonly ids: Uint32Array;
  // Row index at which each group first appeared; its length is the group count.
  readonly first: number[];
}

const HASH_MULTIPLIER = 0x9e3779b1;

const SMALL_KEY_TYPES = new Set(['bool', 'int8', 'uint8', 'int16', 'uint16']);
const INT32_KEY_TYPES = new Set(['int32', 'uint32', 'dictionary', 'date32']);

function groupBySmallInt(key: Column, rows: Rows): Groups {
  // Purpose: group by a key with at most 65,536 possible values, using a lookup table
  const n = rows.count;
  const sel = rows.sel;
  const ids = new Uint32Array(n);
  const first: number[] = [];
  const slots = new Int32Array(65536).fill(-1);
  const values = nums(key);
  const valid = key.valid;
  let nullGroup = -1;
  for (let i = 0; i < n; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) {
      if (nullGroup === -1) {
        nullGroup = first.length;
        first.push(r);
      }
      ids[i] = nullGroup;
      continue;
    }
    const slot = values[r]! + 32768;
    let g = slots[slot]!;
    if (g === -1) {
      g = first.length;
      slots[slot] = g;
      first.push(r);
    }
    ids[i] = g;
  }
  return { ids, first };
}

function groupByMap(key: Column, rows: Rows): Groups {
  // Purpose: group by one key of any type; Map equality gives C-NAN-ORDER (NaN = NaN, -0 = 0)
  const n = rows.count;
  const sel = rows.sel;
  const ids = new Uint32Array(n);
  const first: number[] = [];
  const seen = new Map<number | bigint | string, number>();
  const values = cells(key);
  const valid = key.valid;
  let nullGroup = -1;
  for (let i = 0; i < n; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) {
      if (nullGroup === -1) {
        nullGroup = first.length;
        first.push(r);
      }
      ids[i] = nullGroup;
      continue;
    }
    const value = values[r]!;
    let g = seen.get(value);
    if (g === undefined) {
      g = first.length;
      seen.set(value, g);
      first.push(r);
    }
    ids[i] = g;
  }
  return { ids, first };
}

function groupByInt32(key: Column, rows: Rows): Groups {
  // Purpose: group by an int32 or uint32 key with an open-addressing hash table over typed arrays
  const n = rows.count;
  const sel = rows.sel;
  const ids = new Uint32Array(n);
  const first: number[] = [];
  const values = nums(key);
  const valid = key.valid;
  let bits = 10;
  let capacity = 1 << bits;
  let slotKeys = new Uint32Array(capacity);
  let slotIds = new Int32Array(capacity).fill(-1);
  let nullGroup = -1;
  for (let i = 0; i < n; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) {
      if (nullGroup === -1) {
        nullGroup = first.length;
        first.push(r);
      }
      ids[i] = nullGroup;
      continue;
    }
    // >>> 0 maps int32 and uint32 values one-to-one onto unsigned 32-bit keys.
    const k = values[r]! >>> 0;
    let slot = Math.imul(k, HASH_MULTIPLIER) >>> (32 - bits);
    let g = slotIds[slot]!;
    while (g !== -1 && slotKeys[slot] !== k) {
      slot = (slot + 1) & (capacity - 1);
      g = slotIds[slot]!;
    }
    if (g === -1) {
      g = first.length;
      slotKeys[slot] = k;
      slotIds[slot] = g;
      first.push(r);
      if (first.length * 2 > capacity) {
        // Keep the table at most half full: double it and reinsert every key.
        const oldKeys = slotKeys;
        const oldIds = slotIds;
        bits++;
        capacity = 1 << bits;
        slotKeys = new Uint32Array(capacity);
        slotIds = new Int32Array(capacity).fill(-1);
        for (let s = 0; s < oldIds.length; s++) {
          if (oldIds[s] === -1) continue;
          let to = Math.imul(oldKeys[s]!, HASH_MULTIPLIER) >>> (32 - bits);
          while (slotIds[to] !== -1) to = (to + 1) & (capacity - 1);
          slotKeys[to] = oldKeys[s]!;
          slotIds[to] = oldIds[s]!;
        }
      }
    }
    ids[i] = g;
  }
  return { ids, first };
}

function encodeKey(key: Column, values: AnyCells, i: number): string {
  // Purpose: encode one key value so that distinct values never collide in a tuple
  if (key.valid && !key.valid[i]) return 'n';
  const value = values[i]!;
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (typeof value === 'bigint') return `b${value}`;
  // String(-0) is "0" and String(NaN) is "NaN", which is the equality C-NAN-ORDER wants.
  return `d${value}`;
}

function groupByTuple(keys: readonly Column[], rows: Rows): Groups {
  // Purpose: group by several keys, using an encoded string per row
  const n = rows.count;
  const sel = rows.sel;
  const ids = new Uint32Array(n);
  const first: number[] = [];
  const seen = new Map<string, number>();
  const views = keys.map(cells);
  for (let i = 0; i < n; i++) {
    const r = sel ? sel[i]! : i;
    let encoded = '';
    for (let k = 0; k < keys.length; k++) encoded += encodeKey(keys[k]!, views[k]!, r) + '|';
    let g = seen.get(encoded);
    if (g === undefined) {
      g = first.length;
      seen.set(encoded, g);
      first.push(r);
    }
    ids[i] = g;
  }
  return { ids, first };
}

function assignGroups(keys: readonly Column[], rows: Rows): Groups {
  // Purpose: pick the grouping strategy for the key columns
  if (keys.length === 0) {
    // No keys: exactly one group, even over zero rows (C-EMPTY-AGG).
    return { ids: new Uint32Array(rows.count), first: [0] };
  }
  if (keys.length === 1) {
    const key = keys[0]!;
    if (SMALL_KEY_TYPES.has(key.type.name)) return groupBySmallInt(key, rows);
    // Dictionary codes and date32 days are 32-bit integers too.
    if (INT32_KEY_TYPES.has(key.type.name)) return groupByInt32(key, rows);
    return groupByMap(key, rows);
  }
  return groupByTuple(keys, rows);
}

function keyColumn(key: Column, first: Uint32Array): Column {
  // Purpose: the output key column: each group's key from its first row; -0.0 reported as 0.0
  const out = take(key, first);
  if (isFloat(key.type)) {
    const values = nums(out);
    for (let g = 0; g < first.length; g++) if (values[g] === 0) values[g] = 0;
  }
  return out;
}

function count(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: C-AGG-TYPES: count rows, or non-null values when given a column
  const out = new Uint32Array(groups);
  const valid = arg ? arg.valid : null;
  const sel = rows.sel;
  if (!valid) for (let i = 0; i < ids.length; i++) out[ids[i]!]!++;
  else for (let i = 0; i < ids.length; i++) if (valid[sel ? sel[i]! : i]) out[ids[i]!]!++;
  return makeColumn(t.uint32, out, null);
}

const PAIR_MULTIPLIER = 0x85ebca6b;

function countDistinctInt(arg: Column, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: distinct count for values stored as integers up to 32 bits: one hash set of (group, value) pairs
  const out = new Uint32Array(groups);
  const values = nums(arg);
  const valid = arg.valid;
  const sel = rows.sel;
  let bits = 12;
  let capacity = 1 << bits;
  let slotGroups = new Uint32Array(capacity);
  let slotValues = new Uint32Array(capacity);
  let used = new Uint8Array(capacity);
  let size = 0;
  for (let i = 0; i < ids.length; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) continue;
    const g = ids[i]!;
    const v = values[r]! >>> 0;
    let slot = (Math.imul(v, HASH_MULTIPLIER) ^ Math.imul(g, PAIR_MULTIPLIER)) >>> (32 - bits);
    while (used[slot] && (slotValues[slot] !== v || slotGroups[slot] !== g)) {
      slot = (slot + 1) & (capacity - 1);
    }
    if (used[slot]) continue;
    used[slot] = 1;
    slotGroups[slot] = g;
    slotValues[slot] = v;
    out[g]!++;
    size++;
    if (size * 2 > capacity) {
      // Keep the table at most half full: double it and reinsert every pair.
      const oldGroups = slotGroups;
      const oldValues = slotValues;
      const oldUsed = used;
      bits++;
      capacity = 1 << bits;
      slotGroups = new Uint32Array(capacity);
      slotValues = new Uint32Array(capacity);
      used = new Uint8Array(capacity);
      for (let s = 0; s < oldUsed.length; s++) {
        if (!oldUsed[s]) continue;
        let to = (Math.imul(oldValues[s]!, HASH_MULTIPLIER) ^ Math.imul(oldGroups[s]!, PAIR_MULTIPLIER)) >>> (32 - bits);
        while (used[to]) to = (to + 1) & (capacity - 1);
        used[to] = 1;
        slotGroups[to] = oldGroups[s]!;
        slotValues[to] = oldValues[s]!;
      }
    }
  }
  return makeColumn(t.uint32, out, null);
}

function countDistinct(arg: Column, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: exact count of distinct non-null values per group; NaN = NaN and -0 = 0
  const name = arg.type.name;
  if (isInt(arg.type) || name === 'bool' || name === 'dictionary' || name === 'date32') {
    return countDistinctInt(arg, rows, ids, groups);
  }
  const sets: (Set<number | bigint | string> | undefined)[] = new Array(groups);
  const values = cells(arg);
  const valid = arg.valid;
  const sel = rows.sel;
  for (let i = 0; i < ids.length; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) continue;
    const g = ids[i]!;
    let set = sets[g];
    if (!set) {
      set = new Set();
      sets[g] = set;
    }
    set.add(values[r]!);
  }
  const out = new Uint32Array(groups);
  for (let g = 0; g < groups; g++) out[g] = sets[g] ? sets[g]!.size : 0;
  return makeColumn(t.uint32, out, null);
}

interface FloatSums {
  readonly sum: Float64Array;
  readonly seen: Uint32Array;
}

function neumaier(arg: Column, rows: Rows, ids: Uint32Array, groups: number): FloatSums {
  // Purpose: C-FLOAT-SUM: compensated summation in row order, with a non-null count per group
  const sum = new Float64Array(groups);
  const comp = new Float64Array(groups);
  const seen = new Uint32Array(groups);
  const big = isBigInt(arg.type);
  const values = cells(arg);
  const valid = arg.valid;
  const sel = rows.sel;
  for (let i = 0; i < ids.length; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) continue;
    const g = ids[i]!;
    const x = big ? Number(values[r]) : (values[r] as number);
    const s = sum[g]!;
    const total = s + x;
    if (Math.abs(s) >= Math.abs(x)) comp[g] = comp[g]! + (s - total + x);
    else comp[g] = comp[g]! + (x - total + s);
    sum[g] = total;
    seen[g]!++;
  }
  // A non-finite running sum is already the IEEE answer; the compensation would turn it into NaN.
  for (let g = 0; g < groups; g++) if (Number.isFinite(sum[g]!)) sum[g] = sum[g]! + comp[g]!;
  return { sum, seen };
}

function validFrom(seen: Uint32Array | Uint8Array): Uint8Array {
  // Purpose: validity array that is 1 for groups that saw at least one value
  const valid = new Uint8Array(seen.length);
  for (let g = 0; g < seen.length; g++) valid[g] = seen[g] ? 1 : 0;
  return valid;
}

function sumFloat(arg: Column, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: sum of a float column as float64; null for a group with no values
  const { sum, seen } = neumaier(arg, rows, ids, groups);
  return makeColumn(t.float64, sum, validFrom(seen));
}

function avg(arg: Column, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: mean as float64: the Neumaier sum of the values as float64, over the non-null count
  const { sum, seen } = neumaier(arg, rows, ids, groups);
  for (let g = 0; g < groups; g++) if (seen[g]) sum[g] = sum[g]! / seen[g]!;
  return makeColumn(t.float64, sum, validFrom(seen));
}

// Below this magnitude, adding any 32-bit integer to a double stays exact.
const EXACT_LIMIT = 2 ** 52;

function sumSmallInt(
  arg: Column,
  type: DataType<'int64' | 'uint64'>,
  rows: Rows,
  ids: Uint32Array,
  groups: number,
): Column {
  // Purpose: exact sum of integers that fit a JS number, widened to 64 bits (C-AGG-TYPES)
  const acc = new Float64Array(groups);
  const spill: (bigint | undefined)[] = new Array(groups);
  const seen = new Uint8Array(groups);
  const values = nums(arg);
  const valid = arg.valid;
  const sel = rows.sel;
  for (let i = 0; i < ids.length; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) continue;
    const g = ids[i]!;
    let a = acc[g]! + values[r]!;
    if (a > EXACT_LIMIT || a < -EXACT_LIMIT) {
      // Move the exact partial sum into a bigint before it can lose precision.
      spill[g] = (spill[g] ?? 0n) + BigInt(a);
      a = 0;
    }
    acc[g] = a;
    seen[g] = 1;
  }
  const [lo, hi] = BIGINT_RANGES[type.name];
  const out = allocate(type, groups);
  const cellsOut = out as unknown as BigCells;
  for (let g = 0; g < groups; g++) {
    const total = (spill[g] ?? 0n) + BigInt(acc[g]!);
    if (total < lo || total > hi) overflow('sum', type, `in group ${g}`);
    cellsOut[g] = total;
  }
  return makeColumn(type, out, validFrom(seen));
}

function sumBigInt(
  arg: Column,
  type: DataType<'int64' | 'uint64'>,
  rows: Rows,
  ids: Uint32Array,
  groups: number,
): Column {
  // Purpose: sum of 64-bit integers, checked on every partial sum in row order (C-OVERFLOW)
  const [lo, hi] = BIGINT_RANGES[type.name];
  const acc: bigint[] = new Array(groups).fill(0n);
  const seen = new Uint8Array(groups);
  const values = bigs(arg);
  const valid = arg.valid;
  const sel = rows.sel;
  for (let i = 0; i < ids.length; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) continue;
    const g = ids[i]!;
    const total = acc[g]! + values[r]!;
    if (total < lo || total > hi) overflow('sum', type, `in group ${g}`);
    acc[g] = total;
    seen[g] = 1;
  }
  const out = allocate(type, groups);
  const cellsOut = out as unknown as BigCells;
  for (let g = 0; g < groups; g++) cellsOut[g] = acc[g]!;
  return makeColumn(type, out, validFrom(seen));
}

function extreme(arg: Column, wantMax: boolean, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: min or max per group in the contract's ordering, skipping nulls
  const out = allocate(arg.type, groups);
  const best = out as unknown as AnyCells;
  const seen = new Uint8Array(groups);
  // For a dictionary column the stored values are codes; strings decide the order.
  const values = cells(arg);
  const strings = isString(arg.type) ? texts(arg) : null;
  const dictionary = arg.dictionary;
  const valid = arg.valid;
  const sel = rows.sel;
  for (let i = 0; i < ids.length; i++) {
    const r = sel ? sel[i]! : i;
    if (valid && !valid[r]) continue;
    const g = ids[i]!;
    const value = values[r]!;
    if (!seen[g]) {
      best[g] = value;
      seen[g] = 1;
      continue;
    }
    let c: number;
    if (strings) {
      const current = dictionary ? dictionary[best[g] as number]! : (best[g] as string);
      c = compareStrings(strings[r]!, current);
    } else {
      c = orderNumbers(value as number | bigint, best[g] as number | bigint);
    }
    if (wantMax ? c > 0 : c < 0) best[g] = value;
  }
  return makeColumn(arg.type, out, validFrom(seen), dictionary);
}

function runAggregate(agg: IrAggregate, arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): Column {
  // Purpose: dispatch one aggregate to its implementation
  if (agg.fn === 'count') return count(arg, rows, ids, groups);
  if (!arg) throw new PlanError(`${agg.fn} needs an argument`);
  switch (agg.fn) {
    case 'count_distinct':
      return countDistinct(arg, rows, ids, groups);
    case 'sum': {
      if (isFloat(arg.type)) return sumFloat(arg, rows, ids, groups);
      const type = agg.type as DataType<'int64' | 'uint64'>;
      return isBigInt(arg.type)
        ? sumBigInt(arg, type, rows, ids, groups)
        : sumSmallInt(arg, type, rows, ids, groups);
    }
    case 'avg':
      return avg(arg, rows, ids, groups);
    case 'min':
      return extreme(arg, false, rows, ids, groups);
    case 'max':
      return extreme(arg, true, rows, ids, groups);
    default:
      throw new PlanError(`JS backend: aggregate "${agg.fn}" is not implemented yet`);
  }
}

export function aggregate(
  keys: readonly Column[],
  aggs: readonly IrAggregate[],
  args: readonly (Column | null)[],
  rows: Rows,
): { columns: Column[]; rowCount: number } {
  // Purpose: group rows by the key columns and compute every aggregate per group
  const { ids, first } = assignGroups(keys, rows);
  const groups = first.length;
  const firstRows = Uint32Array.from(first);
  const columns = keys.map(function (key) {
    return keyColumn(key, firstRows);
  });
  aggs.forEach(function (agg, a) {
    columns.push(runAggregate(agg, args[a]!, rows, ids, groups));
  });
  return { columns, rowCount: groups };
}
