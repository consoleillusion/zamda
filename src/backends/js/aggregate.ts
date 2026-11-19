// The aggregate operator for the JS reference executor: hash group-by.
//
// An Aggregator is fed the input one chunk at a time (docs/TASKS.md, T-201) and
// keeps its state between chunks:
//   - a group table that gives every row a group id, numbered in order of first
//     occurrence across the whole input (C-GROUP-ORDER);
//   - one accumulator per aggregate, holding arrays indexed by group id;
//   - the key values of each group, captured when the group first appears.
// finish() turns that state into the output columns.

import type { AnyCells, BigCells, Column, ColumnValues } from '../../column';
import { allocate, bigs, cells, grow, makeColumn, nums, stringColumn, texts } from '../../column';
import { PlanError } from '../../errors';
import type { IrAggregate } from '../../ir';
import type { DataType } from '../../types';
import { BIGINT_RANGES, isBigInt, isFloat, isInt, isString, t } from '../../types';
import { compareStrings, orderNumbers, overflow } from './kernel-util';

// The rows of one chunk: `count` rows, read directly, or through `sel` when the
// chunk was filtered or sorted (row i of the chunk is row sel[i] of the columns).
// Reading through the selection avoids copying the surviving rows first.
export interface Rows {
  readonly count: number;
  readonly sel: Uint32Array | null;
}

const HASH_MULTIPLIER = 0x9e3779b1;
const PAIR_MULTIPLIER = 0x85ebca6b;

// ---------------------------------------------------------------------------
// Dictionary columns across chunks
// ---------------------------------------------------------------------------

// Chunks computed separately can carry different dictionaries, so their codes
// are not comparable. A Canon maps every dictionary it sees onto one canonical
// dictionary; state that outlives a chunk stores canonical codes only.
class Canon {
  readonly strings: string[] = [];
  private readonly index = new Map<string, number>();
  private last: readonly string[] | null = null;
  private remap: Int32Array | null = null;

  resolve(column: Column): Column {
    // Purpose: the same column with canonical codes; unchanged when its codes already are canonical
    const dictionary = column.dictionary ?? [];
    if (dictionary !== this.last) {
      const remap = new Int32Array(dictionary.length);
      let identity = true;
      for (let d = 0; d < dictionary.length; d++) {
        const s = dictionary[d]!;
        let code = this.index.get(s);
        if (code === undefined) {
          code = this.strings.length;
          this.index.set(s, code);
          this.strings.push(s);
        }
        remap[d] = code;
        if (code !== d) identity = false;
      }
      this.last = dictionary;
      this.remap = identity ? null : remap;
    }
    const remap = this.remap;
    if (!remap) return column;
    const codes = nums(column);
    const out = new Int32Array(codes.length);
    for (let i = 0; i < out.length; i++) out[i] = remap[codes[i]!] ?? 0;
    return makeColumn(column.type, out, column.valid, this.strings);
  }
}

// ---------------------------------------------------------------------------
// Group tables: assign a group id to every row of a chunk
// ---------------------------------------------------------------------------

interface GroupTable {
  // Number of groups seen so far.
  groups: number;
  // Fills ids[i] for each row of the chunk and appends to `fresh` the column row
  // of every group that first appears in this chunk, in order.
  assign(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void;
}

class NoKeys implements GroupTable {
  // No keys: exactly one group, even over zero rows (C-EMPTY-AGG).
  groups = 1;

  assign(): void {
    // Purpose: nothing to do; ids are already all zero
  }
}

class SmallIntKeys implements GroupTable {
  groups = 0;
  private readonly slots = new Int32Array(65536).fill(-1);
  private nullGroup = -1;

  assign(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void {
    // Purpose: group by a key with at most 65,536 possible values, using a lookup table
    const key = keys[0]!;
    const values = nums(key);
    const valid = key.valid;
    const sel = rows.sel;
    const slots = this.slots;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) {
        if (this.nullGroup === -1) {
          this.nullGroup = this.groups++;
          fresh.push(r);
        }
        ids[i] = this.nullGroup;
        continue;
      }
      // int16 values -32768..32767 and uint16 values 0..65535 both map one-to-one onto 0..65535.
      const slot = (values[r]! + 32768) & 0xffff;
      let g = slots[slot]!;
      if (g === -1) {
        g = this.groups++;
        slots[slot] = g;
        fresh.push(r);
      }
      ids[i] = g;
    }
  }
}

class Int32Keys implements GroupTable {
  groups = 0;
  private bits = 10;
  private slotKeys = new Uint32Array(1 << 10);
  private slotIds = new Int32Array(1 << 10).fill(-1);
  private used = 0;
  private nullGroup = -1;

  private double(): void {
    // Purpose: keep the table at most half full: double it and reinsert every key
    const oldKeys = this.slotKeys;
    const oldIds = this.slotIds;
    this.bits++;
    const capacity = 1 << this.bits;
    const keys = new Uint32Array(capacity);
    const ids = new Int32Array(capacity).fill(-1);
    for (let s = 0; s < oldIds.length; s++) {
      if (oldIds[s] === -1) continue;
      let to = Math.imul(oldKeys[s]!, HASH_MULTIPLIER) >>> (32 - this.bits);
      while (ids[to] !== -1) to = (to + 1) & (capacity - 1);
      keys[to] = oldKeys[s]!;
      ids[to] = oldIds[s]!;
    }
    this.slotKeys = keys;
    this.slotIds = ids;
  }

  assign(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void {
    // Purpose: group by a key stored as a 32-bit integer, with an open-addressing hash table
    const key = keys[0]!;
    const values = nums(key);
    const valid = key.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) {
        if (this.nullGroup === -1) {
          this.nullGroup = this.groups++;
          fresh.push(r);
        }
        ids[i] = this.nullGroup;
        continue;
      }
      // >>> 0 maps signed and unsigned 32-bit values one-to-one onto unsigned keys.
      const k = values[r]! >>> 0;
      const mask = this.slotIds.length - 1;
      let slot = Math.imul(k, HASH_MULTIPLIER) >>> (32 - this.bits);
      let g = this.slotIds[slot]!;
      while (g !== -1 && this.slotKeys[slot] !== k) {
        slot = (slot + 1) & mask;
        g = this.slotIds[slot]!;
      }
      if (g === -1) {
        g = this.groups++;
        this.slotKeys[slot] = k;
        this.slotIds[slot] = g;
        fresh.push(r);
        if (++this.used * 2 > this.slotIds.length) this.double();
      }
      ids[i] = g;
    }
  }
}

class MapKeys implements GroupTable {
  groups = 0;
  // Map equality gives C-NAN-ORDER: NaN equals NaN, and -0 equals 0.
  private readonly seen = new Map<number | bigint | string, number>();
  private nullGroup = -1;

  assign(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void {
    // Purpose: group by one key of any type
    const key = keys[0]!;
    const values = cells(key);
    const valid = key.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) {
        if (this.nullGroup === -1) {
          this.nullGroup = this.groups++;
          fresh.push(r);
        }
        ids[i] = this.nullGroup;
        continue;
      }
      const value = values[r]!;
      let g = this.seen.get(value);
      if (g === undefined) {
        g = this.groups++;
        this.seen.set(value, g);
        fresh.push(r);
      }
      ids[i] = g;
    }
  }
}

function encodeKey(key: Column, values: AnyCells, row: number): string {
  // Purpose: encode one key value so that distinct values never collide in a tuple
  if (key.valid && !key.valid[row]) return 'n';
  const value = values[row]!;
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (typeof value === 'bigint') return `b${value}`;
  // String(-0) is "0" and String(NaN) is "NaN", which is the equality C-NAN-ORDER wants.
  // Dictionary keys arrive as canonical codes, which are numbers too.
  return `d${value}`;
}

class TupleKeys implements GroupTable {
  groups = 0;
  private readonly seen = new Map<string, number>();

  assign(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void {
    // Purpose: group by several keys, using an encoded string per row
    const views = keys.map(cells);
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      let encoded = '';
      for (let k = 0; k < keys.length; k++) encoded += encodeKey(keys[k]!, views[k]!, r) + '|';
      let g = this.seen.get(encoded);
      if (g === undefined) {
        g = this.groups++;
        this.seen.set(encoded, g);
        fresh.push(r);
      }
      ids[i] = g;
    }
  }
}

class IntTupleKeys implements GroupTable {
  // Several keys, each stored as an integer of 32 bits or fewer (including
  // dictionary codes and dates). Each group's key tuple is kept in a flat
  // Uint32Array: one word per key, then a word whose bits mark the null keys.
  groups = 0;
  private bits = 10;
  private slots = new Int32Array(1 << 10).fill(-1);
  private tuples: Uint32Array;
  private hashes = new Uint32Array(16);
  private readonly width: number;
  private readonly scratch: Uint32Array;

  constructor(private readonly keyCount: number) {
    // Purpose: an empty open-addressing table for tuples of `keyCount` integer keys
    this.width = keyCount + 1;
    this.tuples = new Uint32Array(16 * this.width);
    this.scratch = new Uint32Array(this.width);
  }

  private double(): void {
    // Purpose: keep the table at most half full: double it and reinsert every group by its stored hash
    this.bits++;
    const capacity = 1 << this.bits;
    const slots = new Int32Array(capacity).fill(-1);
    for (let g = 0; g < this.groups; g++) {
      let slot = this.hashes[g]! >>> (32 - this.bits);
      while (slots[slot] !== -1) slot = (slot + 1) & (capacity - 1);
      slots[slot] = g;
    }
    this.slots = slots;
  }

  private matches(g: number): boolean {
    // Purpose: true if group g's stored tuple equals the scratch tuple
    const base = g * this.width;
    for (let j = 0; j < this.width; j++) if (this.tuples[base + j] !== this.scratch[j]) return false;
    return true;
  }

  private insert(h: number, slot: number, row: number, fresh: number[]): number {
    // Purpose: add the scratch tuple as a new group at `slot`, returning its id
    const g = this.groups++;
    this.tuples = grow(this.tuples, this.groups * this.width);
    this.tuples.set(this.scratch, g * this.width);
    this.hashes = grow(this.hashes, this.groups);
    this.hashes[g] = h;
    this.slots[slot] = g;
    fresh.push(row);
    if (this.groups * 2 > this.slots.length) this.double();
    return g;
  }

  private assignPairs(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void {
    // Purpose: the two-key case with the per-key arrays held in locals; the common dashboard shape
    const a = nums(keys[0]!);
    const b = nums(keys[1]!);
    const va = keys[0]!.valid;
    const vb = keys[1]!.valid;
    const scratch = this.scratch;
    const sel = rows.sel;
    // Held in locals for speed; reloaded after an insert, which can grow them.
    let slots = this.slots;
    let tuples = this.tuples;
    let mask = slots.length - 1;
    let shift = 32 - this.bits;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      const nulls = (va && !va[r] ? 1 : 0) | (vb && !vb[r] ? 2 : 0);
      const x = nulls & 1 ? 0 : a[r]! >>> 0;
      const y = nulls & 2 ? 0 : b[r]! >>> 0;
      // Murmur3-style finaliser over both words, so slots spread evenly.
      let h = Math.imul(x, 0xcc9e2d51) ^ Math.imul(y ^ nulls, 0x1b873593);
      h ^= h >>> 16;
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      h = (h ^ (h >>> 16)) >>> 0;
      let slot = h >>> shift;
      let g = slots[slot]!;
      while (g !== -1) {
        const base = g * 3;
        if (tuples[base] === x && tuples[base + 1] === y && tuples[base + 2] === nulls) break;
        slot = (slot + 1) & mask;
        g = slots[slot]!;
      }
      if (g === -1) {
        scratch[0] = x;
        scratch[1] = y;
        scratch[2] = nulls;
        g = this.insert(h, slot, r, fresh);
        slots = this.slots;
        tuples = this.tuples;
        mask = slots.length - 1;
        shift = 32 - this.bits;
      }
      ids[i] = g;
    }
  }

  assign(keys: readonly Column[], rows: Rows, ids: Uint32Array, fresh: number[]): void {
    // Purpose: give every row the id of its key tuple, adding a group for each tuple not seen before
    if (this.keyCount === 2) {
      this.assignPairs(keys, rows, ids, fresh);
      return;
    }
    const k = this.keyCount;
    const values = keys.map(nums);
    const valids = keys.map(function (key) {
      return key.valid;
    });
    const scratch = this.scratch;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      let nulls = 0;
      let h = 0x811c9dc5;
      for (let j = 0; j < k; j++) {
        const valid = valids[j];
        let v = 0;
        if (valid && !valid[r]) nulls |= 1 << j;
        // >>> 0 maps each key type's values one-to-one onto unsigned 32-bit words.
        else v = values[j]![r]! >>> 0;
        scratch[j] = v;
        h = Math.imul(h ^ v, 0x01000193);
        h ^= h >>> 15;
      }
      scratch[k] = nulls;
      h = Math.imul(h ^ nulls, HASH_MULTIPLIER);
      h = (h ^ (h >>> 16)) >>> 0;
      const mask = this.slots.length - 1;
      let slot = h >>> (32 - this.bits);
      let g = this.slots[slot]!;
      while (g !== -1 && !(this.hashes[g] === h && this.matches(g))) {
        slot = (slot + 1) & mask;
        g = this.slots[slot]!;
      }
      if (g === -1) g = this.insert(h, slot, r, fresh);
      ids[i] = g;
    }
  }
}

const SMALL_KEY_TYPES = new Set(['bool', 'int8', 'uint8', 'int16', 'uint16']);
// Dictionary codes and date32 days are 32-bit integers too.
const INT32_KEY_TYPES = new Set(['int32', 'uint32', 'dictionary', 'date32']);

function groupTable(keyTypes: readonly DataType[]): GroupTable {
  // Purpose: pick the grouping strategy for the key types
  if (keyTypes.length === 0) return new NoKeys();
  if (keyTypes.length > 1) {
    const integers = keyTypes.every(function (type) {
      return SMALL_KEY_TYPES.has(type.name) || INT32_KEY_TYPES.has(type.name);
    });
    // The null-mask word has one bit per key.
    return integers && keyTypes.length <= 32 ? new IntTupleKeys(keyTypes.length) : new TupleKeys();
  }
  const name = keyTypes[0]!.name;
  if (SMALL_KEY_TYPES.has(name)) return new SmallIntKeys();
  if (INT32_KEY_TYPES.has(name)) return new Int32Keys();
  return new MapKeys();
}

// ---------------------------------------------------------------------------
// Key values: captured when a group first appears
// ---------------------------------------------------------------------------

class KeyBuilder {
  private values: ColumnValues;
  private valid = new Uint8Array(16);
  private size = 0;

  constructor(
    private readonly type: DataType,
    private readonly canon: Canon | null,
  ) {
    // Purpose: collect one key column's value for each group, in group order
    this.values = allocate(type, type.name === 'utf8' ? 0 : 16);
  }

  append(key: Column, rowsOfNewGroups: readonly number[]): void {
    // Purpose: store the key value of every group that first appeared in this chunk
    const need = this.size + rowsOfNewGroups.length;
    this.valid = grow(this.valid, need);
    const source = cells(key);
    if (Array.isArray(this.values)) {
      for (const r of rowsOfNewGroups) this.values.push(source[r] as string);
    } else {
      this.values = grow(this.values, need);
      const out = this.values as unknown as AnyCells;
      let at = this.size;
      for (const r of rowsOfNewGroups) out[at++] = source[r]!;
    }
    let at = this.size;
    for (const r of rowsOfNewGroups) this.valid[at++] = key.valid ? key.valid[r]! : 1;
    this.size = need;
  }

  finish(groups: number): Column {
    // Purpose: the output key column; -0.0 is reported as 0.0 (C-NAN-ORDER)
    const values = Array.isArray(this.values)
      ? this.values
      : (this.values.subarray(0, groups) as ColumnValues);
    if (isFloat(this.type)) {
      const floats = values as unknown as { [i: number]: number };
      for (let g = 0; g < groups; g++) if (floats[g] === 0) floats[g] = 0;
    }
    return makeColumn(this.type, values, this.valid.subarray(0, groups), this.canon?.strings);
  }
}

// ---------------------------------------------------------------------------
// Accumulators: one per aggregate, state indexed by group id
// ---------------------------------------------------------------------------

interface Accumulator {
  // Fold one chunk in. `groups` is the group count after this chunk's assignment.
  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void;
  finish(groups: number): Column;
}

function validFrom(seen: Uint32Array | Uint8Array, groups: number): Uint8Array {
  // Purpose: validity array that is 1 for groups that saw at least one value
  const valid = new Uint8Array(groups);
  for (let g = 0; g < groups; g++) valid[g] = seen[g] ? 1 : 0;
  return valid;
}

class Count implements Accumulator {
  private counts = new Uint32Array(16);

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: C-AGG-TYPES: count rows, or non-null values when given a column
    const counts = (this.counts = grow(this.counts, groups));
    const valid = arg ? arg.valid : null;
    const sel = rows.sel;
    if (!valid) for (let i = 0; i < rows.count; i++) counts[ids[i]!]!++;
    else for (let i = 0; i < rows.count; i++) if (valid[sel ? sel[i]! : i]) counts[ids[i]!]!++;
  }

  finish(groups: number): Column {
    // Purpose: the counts as uint32; never null
    return makeColumn(t.uint32, grow(this.counts, groups).subarray(0, groups), null);
  }
}

class CountDistinctInt implements Accumulator {
  // One hash set of (group, value) pairs for values stored as integers up to 32 bits.
  private counts = new Uint32Array(16);
  private bits = 12;
  private slotGroups = new Uint32Array(1 << 12);
  private slotValues = new Uint32Array(1 << 12);
  private used = new Uint8Array(1 << 12);
  private size = 0;

  private hash(value: number, group: number): number {
    // Purpose: slot for a (group, value) pair
    return (Math.imul(value, HASH_MULTIPLIER) ^ Math.imul(group, PAIR_MULTIPLIER)) >>> (32 - this.bits);
  }

  private double(): void {
    // Purpose: keep the table at most half full: double it and reinsert every pair
    const oldGroups = this.slotGroups;
    const oldValues = this.slotValues;
    const oldUsed = this.used;
    this.bits++;
    const capacity = 1 << this.bits;
    this.slotGroups = new Uint32Array(capacity);
    this.slotValues = new Uint32Array(capacity);
    this.used = new Uint8Array(capacity);
    for (let s = 0; s < oldUsed.length; s++) {
      if (!oldUsed[s]) continue;
      let to = this.hash(oldValues[s]!, oldGroups[s]!);
      while (this.used[to]) to = (to + 1) & (capacity - 1);
      this.used[to] = 1;
      this.slotGroups[to] = oldGroups[s]!;
      this.slotValues[to] = oldValues[s]!;
    }
  }

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: count each (group, value) pair the first time it is seen
    const column = arg!;
    const counts = (this.counts = grow(this.counts, groups));
    const values = nums(column);
    const valid = column.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      const v = values[r]! >>> 0;
      const mask = this.used.length - 1;
      let slot = this.hash(v, g);
      while (this.used[slot] && (this.slotValues[slot] !== v || this.slotGroups[slot] !== g)) {
        slot = (slot + 1) & mask;
      }
      if (this.used[slot]) continue;
      this.used[slot] = 1;
      this.slotGroups[slot] = g;
      this.slotValues[slot] = v;
      counts[g]!++;
      if (++this.size * 2 > this.used.length) this.double();
    }
  }

  finish(groups: number): Column {
    // Purpose: the distinct counts as uint32; never null
    return makeColumn(t.uint32, grow(this.counts, groups).subarray(0, groups), null);
  }
}

class CountDistinctSet implements Accumulator {
  // Set equality gives C-NAN-ORDER: NaN equals NaN, and -0 equals 0.
  private readonly sets: (Set<number | bigint | string> | undefined)[] = [];

  add(arg: Column | null, rows: Rows, ids: Uint32Array): void {
    // Purpose: exact distinct count for floats, 64-bit integers, timestamps and utf8 strings
    const column = arg!;
    const values = cells(column);
    const valid = column.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      let set = this.sets[g];
      if (!set) {
        set = new Set();
        this.sets[g] = set;
      }
      set.add(values[r]!);
    }
  }

  finish(groups: number): Column {
    // Purpose: the distinct counts as uint32; never null
    const out = new Uint32Array(groups);
    for (let g = 0; g < groups; g++) out[g] = this.sets[g] ? this.sets[g]!.size : 0;
    return makeColumn(t.uint32, out, null);
  }
}

class FloatSum implements Accumulator {
  // C-FLOAT-SUM: Neumaier compensated summation in row order.
  private sum = new Float64Array(16);
  private comp = new Float64Array(16);
  private seen = new Uint32Array(16);

  constructor(private readonly mean: boolean) {
    // Purpose: sum, or mean when `mean` is set, of a numeric column as float64
  }

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: add this chunk's values to the running compensated sums
    const column = arg!;
    const sum = (this.sum = grow(this.sum, groups));
    const comp = (this.comp = grow(this.comp, groups));
    const seen = (this.seen = grow(this.seen, groups));
    const big = isBigInt(column.type);
    const values = cells(column);
    const valid = column.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
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
  }

  finish(groups: number): Column {
    // Purpose: apply the compensation; null for a group with no values
    const sum = grow(this.sum, groups);
    const comp = grow(this.comp, groups);
    const seen = grow(this.seen, groups);
    const out = new Float64Array(groups);
    for (let g = 0; g < groups; g++) {
      // A non-finite running sum is already the IEEE answer; the compensation would turn it into NaN.
      const total = Number.isFinite(sum[g]!) ? sum[g]! + comp[g]! : sum[g]!;
      out[g] = this.mean && seen[g] ? total / seen[g]! : total;
    }
    return makeColumn(t.float64, out, validFrom(seen, groups));
  }
}

// Below this magnitude, adding any 32-bit integer to a double stays exact.
const EXACT_LIMIT = 2 ** 52;

class SmallIntSum implements Accumulator {
  // Exact sum of integers that fit a JS number, widened to 64 bits (C-AGG-TYPES).
  private acc = new Float64Array(16);
  private seen = new Uint8Array(16);
  private readonly spill: (bigint | undefined)[] = [];

  constructor(private readonly type: DataType<'int64' | 'uint64'>) {
    // Purpose: sum of an integer column of 32 bits or fewer
  }

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: add this chunk's values, moving a partial sum into a bigint before it can lose precision
    const column = arg!;
    const acc = (this.acc = grow(this.acc, groups));
    const seen = (this.seen = grow(this.seen, groups));
    const values = nums(column);
    const valid = column.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      let a = acc[g]! + values[r]!;
      if (a > EXACT_LIMIT || a < -EXACT_LIMIT) {
        this.spill[g] = (this.spill[g] ?? 0n) + BigInt(a);
        a = 0;
      }
      acc[g] = a;
      seen[g] = 1;
    }
  }

  finish(groups: number): Column {
    // Purpose: the totals as 64-bit integers, checked against the result type
    const acc = grow(this.acc, groups);
    const [lo, hi] = BIGINT_RANGES[this.type.name];
    const out = allocate(this.type, groups);
    const cellsOut = out as unknown as BigCells;
    for (let g = 0; g < groups; g++) {
      const total = (this.spill[g] ?? 0n) + BigInt(acc[g]!);
      if (total < lo || total > hi) overflow('sum', this.type);
      cellsOut[g] = total;
    }
    return makeColumn(this.type, out, validFrom(grow(this.seen, groups), groups));
  }
}

class BigIntSum implements Accumulator {
  private readonly acc: bigint[] = [];
  private seen = new Uint8Array(16);

  constructor(private readonly type: DataType<'int64' | 'uint64'>) {
    // Purpose: sum of a 64-bit integer column
  }

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: C-OVERFLOW: add this chunk's values, checking every partial sum in row order
    const column = arg!;
    const [lo, hi] = BIGINT_RANGES[this.type.name];
    const seen = (this.seen = grow(this.seen, groups));
    const acc = this.acc;
    while (acc.length < groups) acc.push(0n);
    const values = bigs(column);
    const valid = column.valid;
    const sel = rows.sel;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      const total = acc[g]! + values[r]!;
      if (total < lo || total > hi) overflow('sum', this.type);
      acc[g] = total;
      seen[g] = 1;
    }
  }

  finish(groups: number): Column {
    // Purpose: the totals as 64-bit integers
    const out = allocate(this.type, groups);
    const cellsOut = out as unknown as BigCells;
    for (let g = 0; g < groups; g++) cellsOut[g] = this.acc[g] ?? 0n;
    return makeColumn(this.type, out, validFrom(grow(this.seen, groups), groups));
  }
}

class NumberExtreme implements Accumulator {
  private best: Exclude<ColumnValues, string[]>;
  private seen = new Uint8Array(16);

  constructor(
    private readonly type: DataType,
    private readonly wantMax: boolean,
  ) {
    // Purpose: min or max of a column stored as numbers or bigints, in the contract's ordering
    this.best = allocate(type, 16) as Exclude<ColumnValues, string[]>;
  }

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: fold this chunk in; NaN is greater than every number (C-NAN-ORDER)
    const column = arg!;
    this.best = grow(this.best, groups);
    const best = this.best as unknown as AnyCells;
    const seen = (this.seen = grow(this.seen, groups));
    const values = cells(column);
    const valid = column.valid;
    const sel = rows.sel;
    const wantMax = this.wantMax;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      const value = values[r]!;
      if (!seen[g]) {
        best[g] = value;
        seen[g] = 1;
        continue;
      }
      const c = orderNumbers(value as number | bigint, best[g] as number | bigint);
      if (wantMax ? c > 0 : c < 0) best[g] = value;
    }
  }

  finish(groups: number): Column {
    // Purpose: the extreme per group; null for a group with no values
    const values = grow(this.best, groups).subarray(0, groups) as ColumnValues;
    return makeColumn(this.type, values, validFrom(grow(this.seen, groups), groups));
  }
}

// Code-point order of a dictionary's entries: rank[code] orders codes like their
// strings (C-STR-ORDER). Computed once per dictionary and reused, since a
// table's dictionaries live as long as the table.
const dictionaryRanks = new WeakMap<readonly string[], Int32Array>();

function ranksOf(dictionary: readonly string[]): Int32Array {
  // Purpose: the rank of each dictionary code in code-point order of its string
  let ranks = dictionaryRanks.get(dictionary);
  if (!ranks) {
    const order = Array.from({ length: dictionary.length }, function (_, i) {
      return i;
    });
    order.sort(function (x, y) {
      return compareStrings(dictionary[x]!, dictionary[y]!);
    });
    ranks = new Int32Array(dictionary.length);
    for (let i = 0; i < order.length; i++) ranks[order[i]!] = i;
    dictionaryRanks.set(dictionary, ranks);
  }
  return ranks;
}

class StringExtreme implements Accumulator {
  private readonly best: string[] = [];
  private seen = new Uint8Array(16);

  constructor(
    private readonly type: DataType,
    private readonly wantMax: boolean,
  ) {
    // Purpose: min or max of a string column by code point order (C-STR-ORDER)
  }

  // For each group, the dictionary and code of its current best value, when it
  // came from a dictionary column: lets same-dictionary comparisons use ranks.
  private readonly bestDictionary: (readonly string[] | undefined)[] = [];
  private bestCode = new Int32Array(16);

  private addDictionary(column: Column, rows: Rows, ids: Uint32Array, seen: Uint8Array): void {
    // Purpose: fold in a dictionary column by comparing ranks; strings only when dictionaries differ
    const dictionary = column.dictionary!;
    const ranks = ranksOf(dictionary);
    const codes = nums(column);
    const valid = column.valid;
    const sel = rows.sel;
    const wantMax = this.wantMax;
    const best = this.best;
    const bestDictionary = this.bestDictionary;
    const bestCode = this.bestCode;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      const code = codes[r]!;
      let better: boolean;
      if (!seen[g]) better = true;
      else if (bestDictionary[g] === dictionary) {
        const c = ranks[code]! - ranks[bestCode[g]!]!;
        better = wantMax ? c > 0 : c < 0;
      } else {
        const c = compareStrings(dictionary[code]!, best[g]!);
        better = wantMax ? c > 0 : c < 0;
      }
      if (better) {
        seen[g] = 1;
        best[g] = dictionary[code]!;
        bestDictionary[g] = dictionary;
        bestCode[g] = code;
      }
    }
  }

  add(arg: Column | null, rows: Rows, ids: Uint32Array, groups: number): void {
    // Purpose: fold this chunk in, comparing strings rather than dictionary codes
    const column = arg!;
    const seen = (this.seen = grow(this.seen, groups));
    this.bestCode = grow(this.bestCode, groups);
    if (column.dictionary) {
      this.addDictionary(column, rows, ids, seen);
      return;
    }
    const best = this.best;
    const bestDictionary = this.bestDictionary;
    const dictionary = column.dictionary;
    const codes = dictionary ? nums(column) : null;
    const strings = dictionary ? null : texts(column);
    const valid = column.valid;
    const sel = rows.sel;
    const wantMax = this.wantMax;
    for (let i = 0; i < rows.count; i++) {
      const r = sel ? sel[i]! : i;
      if (valid && !valid[r]) continue;
      const g = ids[i]!;
      const value = codes ? dictionary![codes[r]!]! : strings![r]!;
      if (!seen[g]) {
        best[g] = value;
        bestDictionary[g] = undefined;
        seen[g] = 1;
        continue;
      }
      const c = compareStrings(value, best[g]!);
      if (wantMax ? c > 0 : c < 0) {
        best[g] = value;
        bestDictionary[g] = undefined;
      }
    }
  }

  finish(groups: number): Column {
    // Purpose: the extreme per group as a utf8 or dictionary column
    const out: string[] = new Array(groups);
    for (let g = 0; g < groups; g++) out[g] = this.best[g] ?? '';
    return stringColumn(this.type, out, validFrom(grow(this.seen, groups), groups));
  }
}

function accumulator(agg: IrAggregate): Accumulator {
  // Purpose: build the accumulator for one aggregate
  if (agg.fn === 'count') return new Count();
  const arg = agg.arg;
  if (!arg) throw new PlanError(`${agg.fn} needs an argument`);
  const type = arg.type;
  switch (agg.fn) {
    case 'count_distinct': {
      const name = type.name;
      const integers = isInt(type) || name === 'bool' || name === 'dictionary' || name === 'date32';
      return integers ? new CountDistinctInt() : new CountDistinctSet();
    }
    case 'sum': {
      if (isFloat(type)) return new FloatSum(false);
      const result = agg.type as DataType<'int64' | 'uint64'>;
      return isBigInt(type) ? new BigIntSum(result) : new SmallIntSum(result);
    }
    case 'avg':
      return new FloatSum(true);
    case 'min':
    case 'max':
      return isString(type)
        ? new StringExtreme(type, agg.fn === 'max')
        : new NumberExtreme(type, agg.fn === 'max');
    default:
      throw new PlanError(`JS backend: aggregate "${agg.fn}" is not implemented yet`);
  }
}

// ---------------------------------------------------------------------------
// The operator
// ---------------------------------------------------------------------------

export class Aggregator {
  private readonly table: GroupTable;
  private readonly keys: KeyBuilder[];
  private readonly keyCanons: (Canon | null)[];
  private readonly accumulators: Accumulator[];
  // Distinct counts on a dictionary column need canonical codes too.
  private readonly argCanons: (Canon | null)[];
  private ids = new Uint32Array(0);

  constructor(
    keyTypes: readonly DataType[],
    private readonly aggs: readonly IrAggregate[],
  ) {
    // Purpose: set up the group table, key builders and accumulators for one aggregate node
    this.table = groupTable(keyTypes);
    this.keyCanons = keyTypes.map(function (type) {
      return type.name === 'dictionary' ? new Canon() : null;
    });
    this.keys = keyTypes.map((type, k) => new KeyBuilder(type, this.keyCanons[k] ?? null));
    this.accumulators = aggs.map(accumulator);
    this.argCanons = aggs.map(function (agg) {
      return agg.fn === 'count_distinct' && agg.arg?.type.name === 'dictionary' ? new Canon() : null;
    });
  }

  consume(keys: readonly Column[], args: readonly (Column | null)[], rows: Rows): void {
    // Purpose: fold one chunk into the running state
    const resolved = keys.map((key, k) => {
      const canon = this.keyCanons[k];
      return canon ? canon.resolve(key) : key;
    });
    if (this.ids.length < rows.count) this.ids = new Uint32Array(rows.count);
    const ids = this.ids;
    if (this.table instanceof NoKeys) ids.fill(0, 0, rows.count);
    const fresh: number[] = [];
    this.table.assign(resolved, rows, ids, fresh);
    if (fresh.length > 0) {
      for (let k = 0; k < resolved.length; k++) this.keys[k]!.append(resolved[k]!, fresh);
    }
    const groups = this.table.groups;
    for (let a = 0; a < this.accumulators.length; a++) {
      const canon = this.argCanons[a];
      const arg = args[a] ?? null;
      this.accumulators[a]!.add(canon && arg ? canon.resolve(arg) : arg, rows, ids, groups);
    }
  }

  finish(): { columns: Column[]; rowCount: number } {
    // Purpose: the output columns: each group's keys, then each aggregate
    const groups = this.table.groups;
    const columns = this.keys.map(function (builder) {
      return builder.finish(groups);
    });
    for (const acc of this.accumulators) columns.push(acc.finish(groups));
    return { columns, rowCount: groups };
  }
}
