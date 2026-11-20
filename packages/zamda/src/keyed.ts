// Keyed live tables (C-LIVE-KEY): at most one row per key; upsert replaces rows in place, delete removes
// them. The usual case is a live view of something that changes by key, such as a routing table fed by
// announcements (upsert) and withdrawals (delete).
//
// Storage. The rows live in BLOCKS of at most `blockRows` rows (default 16,384), each an immutable
// checked segment. A mutation copies only the blocks it touches (copy-on-write) plus, for new keys, the
// last block; every other block is shared with the previous version. A backend sees the blocks through a
// KeyedStore: the JS backend makes a new table over the shared blocks (no copy), the WASM engine edits one
// engine table in place, segment by segment, all or nothing. Either way a run that started before a
// mutation keeps reading what it started on (C-LIVE).
//
// Index. One map from each key's code to the block holding it; the row inside a block is found by
// scanning that block's key list (at most blockRows entries), or through a temporary map when many keys of
// one block change at once. A key's code is the key value itself for one numeric or string field, and an
// unambiguous string for several fields, so no row objects are kept.
//
// Cost of one mutation: O(changed rows + touched blocks x blockRows), independent of the table size.

import type { Backend, Table } from './backend';
import { allocate, bigs, emptyColumn, makeColumn, nums, slice, texts } from './column';
import type { Column, ColumnValues } from './column';
import { HandleError, SchemaError } from './errors';
import type { Fields, RowOf, Schema } from './schema';
import type { DataType, JsOf } from './types';
import { MS_PER_DAY } from './types';
import { loadSegment } from './backends/js/load';
import type { Segment } from './backends/js/exec';
import type { TableInput, TableOptions } from './backends/js';

// The JS values a key component may be. A component of the wrong JS type for its column (a string for a
// number column) is a different key, so it is simply not found.
export type KeyComponent = string | number | bigint | boolean | Date;
export type Key = readonly KeyComponent[];

// Column names that make up the key, in order.
export type KeyFields<F extends Fields> = readonly (keyof F & string)[];

export interface KeyedTableOptions extends TableOptions {
  // Rows per storage block (default 16,384). Smaller blocks make each mutation copy less and each run
  // step over more segments.
  readonly blockRows?: number;
}

// One step of an edit, as a backend applies it: replace `remove` blocks at `start` with `insert`.
// Steps apply in order, and `start` counts in the list as the earlier steps left it.
export interface BlockEdit {
  readonly start: number;
  readonly remove: number;
  readonly insert: readonly Segment[];
}

// How a backend holds a keyed table's blocks.
export interface KeyedStore<F extends Fields> {
  // A table holding exactly these blocks, in order.
  create(blocks: readonly Segment[]): Table<F>;
  // Apply the edits (or rebuild from `blocks`, the whole new list) and return the table to read from now.
  // It must be all or nothing: on error the current table is unchanged. It may finish asynchronously
  // (a worker); calls are made in order, and runs started after it is called must see it.
  edit(current: Table<F>, edits: readonly BlockEdit[], blocks: readonly Segment[]): Table<F> | Promise<Table<F>>;
}

type KeyCode = number | string;

// A block's place in the table. The index maps each key to its slot, not to the block, so rewriting a
// block (a new Block object in the same slot) updates one pointer instead of every key of the block.
interface Slot {
  block: Block;
}

interface Block {
  readonly segment: Segment;
  readonly keys: readonly KeyCode[];
  readonly slot: Slot;
}

// Rows picked for a new block, in output order: from which source, and which row of it.
interface Picks {
  readonly source: Uint8Array;
  readonly row: Uint32Array;
  readonly length: number;
}

function picksOf(length: number): { source: Uint8Array; row: Uint32Array; length: number } {
  // Purpose: room for `length` picks
  return { source: new Uint8Array(length), row: new Uint32Array(length), length };
}

function newBlock(segment: Segment, keys: readonly KeyCode[], slot?: Slot): Block {
  // Purpose: a block in a given slot, or in a new one
  const block = { segment, keys, slot: slot ?? ({} as Slot) } as Block;
  if (slot === undefined) block.slot.block = block;
  return block;
}

// Bits each packable key type takes when several key components are packed into one number.
const PACK_BITS: Readonly<Record<string, number>> = { bool: 1, int8: 8, uint8: 8, int16: 16, uint16: 16, int32: 32, uint32: 32, date32: 32 };
const PACK_BIAS: Readonly<Record<string, number>> = { bool: 0, int8: 128, uint8: 0, int16: 32768, uint16: 0, int32: 2 ** 31, uint32: 0, date32: 2 ** 31 };

const DEFAULT_BLOCK_ROWS = 16_384;
function describe(value: unknown): string {
  // Purpose: say what was found in a structured error message
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return `Date(${String(value.getTime())})`;
  return `${typeof value} ${String(value)}`;
}

// What JS type each storage type's key components have.
function componentKind(type: DataType): 'number' | 'bigint' | 'string' | 'boolean' | 'date' {
  // Purpose: the JS type a key component of this column type must have
  switch (type.name) {
    case 'bool':
      return 'boolean';
    case 'int64':
    case 'uint64':
      return 'bigint';
    case 'utf8':
    case 'dictionary':
      return 'string';
    case 'date32':
    case 'timestamp':
      return 'date';
    default:
      return 'number';
  }
}

function joinParts(parts: readonly (number | string)[]): string {
  // Purpose: one unambiguous string for a key of several components (strings are length-prefixed)
  let out = '';
  for (const part of parts) out += typeof part === 'number' ? `n${part === 0 ? 0 : part};` : `s${part.length}:${part}`;
  return out;
}

function decodeCell(column: Column, row: number): JsOf<DataType> | null {
  // Purpose: undo the loader's storage conversion for one cell
  if (column.valid !== null && column.valid[row] === 0) return null;
  const name = column.type.name;
  if (name === 'bool') return nums(column)[row] !== 0;
  if (name === 'utf8') return (column.values as string[])[row]!;
  if (name === 'dictionary') return column.dictionary![nums(column)[row]!]!;
  if (name === 'int64' || name === 'uint64') return bigs(column)[row]!;
  if (name === 'date32') return new Date(nums(column)[row]! * MS_PER_DAY);
  if (name === 'timestamp') return new Date(nums(column)[row]!);
  return nums(column)[row]!;
}

// A string-to-code map per dictionary, built once, so rewriting a block keeps its dictionary (and with
// it the engine's string numbering) whenever the new strings are already in it.
const codeMaps = new WeakMap<readonly string[], Map<string, number>>();

function codeMap(dictionary: readonly string[]): Map<string, number> {
  // Purpose: the code of each string of a dictionary
  let map = codeMaps.get(dictionary);
  if (map === undefined) {
    map = new Map();
    for (let i = 0; i < dictionary.length; i++) map.set(dictionary[i]!, i);
    codeMaps.set(dictionary, map);
  }
  return map;
}

function gatherColumn(type: DataType, sources: readonly Column[], picks: Picks): Column {
  // Purpose: one column of rows picked from several sources; a dictionary column keeps the first source's dictionary when it can
  const n = picks.length;
  let valid: Uint8Array | null = null;
  if (sources.some(s => s.valid !== null)) {
    valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = sources[picks.source[i]!]!.valid;
      valid[i] = v === null ? 1 : v[picks.row[i]!]!;
    }
  }
  if (type.name === 'utf8') {
    const out: string[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = (sources[picks.source[i]!]!.values as string[])[picks.row[i]!]!;
    return makeColumn(type, out, valid);
  }
  const out = allocate(type, n) as unknown as { [i: number]: number | bigint };
  if (type.name !== 'dictionary') {
    const values = sources.map(source => source.values as unknown as { [i: number]: number | bigint });
    if (values.length === 1) {
      const only = values[0]!;
      for (let i = 0; i < n; i++) out[i] = only[picks.row[i]!]!;
    } else {
      for (let i = 0; i < n; i++) out[i] = values[picks.source[i]!]![picks.row[i]!]!;
    }
    return makeColumn(type, out as unknown as ColumnValues, valid);
  }
  let dictionary = sources[0]!.dictionary!;
  let map = codeMap(dictionary);
  let extended = false;
  for (let i = 0; i < n; i++) {
    const s = picks.source[i]!;
    const r = picks.row[i]!;
    const source = sources[s]!;
    const code = nums(source)[r]!;
    // The first source's codes stay valid: an extended dictionary only appends to it.
    if (s === 0 || source.dictionary === sources[0]!.dictionary) {
      out[i] = code;
      continue;
    }
    if (valid !== null && valid[i] === 0) continue;
    const text = source.dictionary![code]!;
    let mapped = map.get(text);
    if (mapped === undefined) {
      if (!extended) {
        // A new string: this block gets its own copy of the dictionary, extended.
        dictionary = [...dictionary];
        map = new Map(map);
        extended = true;
      }
      mapped = dictionary.length;
      (dictionary as string[]).push(text);
      map.set(text, mapped);
    }
    out[i] = mapped;
  }
  if (extended) codeMaps.set(dictionary, map);
  return makeColumn(type, out as unknown as ColumnValues, valid, dictionary);
}

function gather(schema: Schema, sources: readonly Segment[], picks: Picks): Segment {
  // Purpose: a new block made of rows picked from several segments: picks are [source, row] in output order
  if (picks.length === 0) return { columns: schema.list.map(f => emptyColumn(f.type)), rowCount: 0 };
  const columns = schema.list.map((field, c) => gatherColumn(field.type, sources.map(source => source.columns[c]!), picks));
  return { columns, rowCount: picks.length };
}

function sliceBlock(segment: Segment, start: number, end: number): Segment {
  // Purpose: rows [start, end) of a block; typed arrays are views, not copies
  return { columns: segment.columns.map(column => slice(column, start, end)), rowCount: end - start };
}

function diffBlocks(before: readonly Block[], after: readonly Block[]): BlockEdit[] {
  // Purpose: the edits that turn the old block list into the new one; unchanged blocks keep their order, so one merge pass finds them
  const kept = new Set(after);
  const edits: BlockEdit[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    const start = j;
    let remove = 0;
    const insert: Segment[] = [];
    while (i < before.length && !kept.has(before[i]!)) {
      remove++;
      i++;
    }
    while (j < after.length && (i >= before.length || after[j] !== before[i])) {
      insert.push(after[j]!.segment);
      j++;
    }
    edits.push({ start, remove, insert });
  }
  return edits;
}

export class KeyedTable<F extends Fields = Fields> implements Table<F> {
  readonly schema: Schema<F>;
  readonly backend: Backend;
  private readonly keyFields: readonly string[];
  private readonly keyColumns: readonly number[];
  private readonly kinds: readonly ReturnType<typeof componentKind>[];
  // For several integer key components that fit in 52 bits together: each one's shift and bias.
  private readonly packing: readonly { readonly scale: number; readonly bias: number; readonly bits: number }[] | null;
  private readonly store: KeyedStore<F>;
  private readonly retain: number | null;
  private readonly blockRows: number;
  private blocks: readonly Block[];
  private readonly where = new Map<KeyCode, Slot>();
  private count = 0;
  private dropped = 0;
  private currentTable: Table<F>;
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private disposed = false;

  constructor(schema: Schema<F>, keyFields: KeyFields<F>, data: TableInput<F>, options: KeyedTableOptions, store: KeyedStore<F>) {
    // Purpose: check the key fields and the initial rows, lay them out in blocks and hand them to the backend
    this.schema = schema;
    this.store = store;
    const retain = options.retain?.rows;
    if (retain !== undefined && (!Number.isInteger(retain) || retain < 1)) {
      throw new SchemaError(`Expected retain.rows to be a positive integer at options.retain, found ${describe(retain)}`);
    }
    this.retain = retain ?? null;
    const blockRows = options.blockRows ?? DEFAULT_BLOCK_ROWS;
    if (!Number.isInteger(blockRows) || blockRows < 1) {
      throw new SchemaError(`Expected blockRows to be a positive integer at options.blockRows, found ${describe(blockRows)}`);
    }
    this.blockRows = blockRows;
    this.keyFields = this.validateKeyFields(keyFields);
    this.keyColumns = this.keyFields.map(name => schema.list.findIndex(f => f.name === name));
    this.kinds = this.keyColumns.map(c => componentKind(schema.list[c]!.type));
    this.packing = this.packingFor();

    const initial = loadSegment(schema, data);
    const codes = this.codesOf(initial, 'initial row');
    // Repeated initial keys keep the first position with the last value, like upserts in order.
    const at = new Map<KeyCode, number>();
    for (let r = 0; r < codes.length; r++) at.set(codes[r]!, r);
    let rows = initial;
    let keys: readonly KeyCode[] = codes;
    if (at.size !== codes.length) {
      const picks = picksOf(at.size);
      const kept: KeyCode[] = [];
      let i = 0;
      for (const [code, r] of at) {
        picks.row[i++] = r;
        kept.push(code);
      }
      rows = gather(schema, [initial], picks);
      keys = kept;
    }
    let blocks = this.split(rows, keys);
    blocks = this.applyRetain(blocks, []);
    this.blocks = blocks;
    for (const block of blocks) for (const code of block.keys) this.where.set(code, block.slot);
    this.count = blocks.reduce((n, b) => n + b.segment.rowCount, 0);
    this.dropped = rows.rowCount - this.count;
    this.currentTable = store.create(blocks.map(b => b.segment));
    this.backend = this.currentTable.backend;
  }

  get rowCount(): number {
    // Purpose: the number of rows in the current snapshot
    return this.count;
  }

  get rowsDropped(): number {
    // Purpose: rows removed by delete, replacement and the retain window over this table's life
    return this.dropped;
  }

  current(): Table<F> {
    // Purpose: the backend table holding the current rows
    this.ensureUsable();
    return this.currentTable;
  }

  // Resolves once the backend has every mutation so far (it is immediate except in a worker); rejects with
  // the error if one failed there, after which the table cannot be used.
  flush(): Promise<void> {
    // Purpose: wait for the backend to hold every mutation so far
    return this.pending.then(() => {
      if (this.failure !== null) throw this.failure;
    });
  }

  get(key: Key): RowOf<F> | undefined {
    // Purpose: a copy of the current row for a key, or undefined when it has none
    const found = this.locate(key, 'key');
    if (found === null) return undefined;
    const row: Record<string, unknown> = {};
    this.schema.list.forEach((field, c) => {
      row[field.name] = decodeCell(found.block.segment.columns[c]!, found.row);
    });
    return row as RowOf<F>;
  }

  has(key: Key): boolean {
    // Purpose: whether the current table holds this key
    return this.locate(key, 'key') !== null;
  }

  upsert(rows: TableInput<F>): void {
    // Purpose: C-LIVE-KEY: insert new keys at the end and replace whole rows for existing keys, keeping their position
    this.ensureLive();
    // Everything is checked before anything changes, so bad input applies nothing.
    const incoming = loadSegment(this.schema, rows);
    const codes = this.codesOf(incoming, 'upsert row');
    if (codes.length === 0) return;
    // Within one call, later rows for a key win; a new key is placed where it first appeared.
    const last = new Map<KeyCode, number>();
    for (let r = 0; r < codes.length; r++) last.set(codes[r]!, r);
    const replacing = new Map<Block, Map<KeyCode, number>>();
    const fresh: KeyCode[] = [];
    for (const [code, r] of last) {
      const slot = this.where.get(code);
      if (slot === undefined) {
        fresh.push(code);
        continue;
      }
      let changes = replacing.get(slot.block);
      if (changes === undefined) replacing.set(slot.block, (changes = new Map()));
      changes.set(code, r);
    }
    const next: Block[] = [];
    let replaced = 0;
    for (const block of this.blocks) {
      const changes = replacing.get(block);
      if (changes === undefined) {
        next.push(block);
        continue;
      }
      replaced += changes.size;
      const picks = picksOf(block.keys.length);
      for (let row = 0; row < block.keys.length; row++) {
        const r = changes.get(block.keys[row]!);
        if (r === undefined) picks.row[row] = row;
        else {
          picks.source[row] = 1;
          picks.row[row] = r;
        }
      }
      next.push(newBlock(gather(this.schema, [block.segment, incoming], picks), block.keys, block.slot));
    }
    // New keys fill the last block, then new blocks.
    const placed: [KeyCode, Slot][] = [];
    if (fresh.length > 0) {
      const tail = next.length > 0 && next[next.length - 1]!.segment.rowCount < this.blockRows ? next.pop()! : null;
      const kept = tail === null ? 0 : tail.keys.length;
      const picks = picksOf(kept + fresh.length);
      const keys: KeyCode[] = tail === null ? [] : [...tail.keys];
      for (let row = 0; row < kept; row++) picks.row[row] = row;
      // With no tail to extend, the incoming rows are the only source.
      const incomingSource = tail === null ? 0 : 1;
      fresh.forEach((code, i) => {
        picks.source[kept + i] = incomingSource;
        picks.row[kept + i] = last.get(code)!;
        keys.push(code);
      });
      const merged = gather(this.schema, tail === null ? [incoming] : [tail.segment, incoming], picks);
      this.split(merged, keys, tail?.slot).forEach((block, i) => {
        next.push(block);
        // The first piece keeps the tail's slot, so only the new keys need an index entry.
        for (let k = i === 0 ? kept : 0; k < block.keys.length; k++) placed.push([block.keys[k]!, block.slot]);
      });
    }
    const removed: KeyCode[] = [];
    const sized = this.applyRetain(next, removed);
    this.commit(sized, placed, removed, replaced + removed.length);
  }

  delete(keys: readonly Key[]): number {
    // Purpose: C-LIVE-KEY: remove the rows for these keys and report how many were removed
    this.ensureLive();
    const byBlock = new Map<Block, Set<KeyCode>>();
    const codes = keys.map((key, i) => this.codeOfKey(this.validateKey(key, `keys[${i}]`)));
    for (const code of codes) {
      if (code === null) continue;
      const slot = this.where.get(code);
      if (slot === undefined) continue;
      let set = byBlock.get(slot.block);
      if (set === undefined) byBlock.set(slot.block, (set = new Set()));
      set.add(code);
    }
    if (byBlock.size === 0) return 0;
    let count = 0;
    const removed: KeyCode[] = [];
    const next: Block[] = [];
    for (const block of this.blocks) {
      const gone = byBlock.get(block);
      if (gone === undefined) {
        next.push(block);
        continue;
      }
      count += gone.size;
      const picks = picksOf(block.keys.length - gone.size);
      const kept: KeyCode[] = [];
      block.keys.forEach((code, row) => {
        if (gone.has(code)) removed.push(code);
        else {
          picks.row[kept.length] = row;
          kept.push(code);
        }
      });
      if (kept.length > 0) next.push(newBlock(gather(this.schema, [block.segment], picks), kept, block.slot));
    }
    this.commit(next, [], removed, count);
    return count;
  }

  dispose(): void {
    // Purpose: free the backend table; safe to repeat
    if (this.disposed) return;
    this.disposed = true;
    const disposable = this.currentTable as Table & { dispose?: () => unknown };
    void disposable.dispose?.();
    this.where.clear();
    this.blocks = [];
  }

  private commit(next: readonly Block[], placed: readonly [KeyCode, Slot][], removed: readonly KeyCode[], dropped: number): void {
    // Purpose: give the backend the edit first; only when it accepts it does the index change (C-LIVE-KEY atomicity)
    const edits = diffBlocks(this.blocks, next);
    if (edits.length === 0 && dropped === 0) return;
    const result = this.store.edit(this.currentTable, edits, next.map(b => b.segment));
    if (result instanceof Promise) {
      // A worker: the edit is posted in order before any later run, so the bookkeeping moves on now; a
      // failure there leaves the engine as it was, out of step with this side, so the table stops working.
      this.pending = this.pending.then(
        () =>
          result.then(
            () => undefined,
            (error: unknown) => {
              this.failure = error instanceof Error ? error : new Error(String(error));
            },
          ),
      );
    } else {
      this.currentTable = result;
    }
    this.blocks = next;
    for (const block of next) block.slot.block = block;
    // New placements first: a key placed and then dropped by the retain window must end up gone.
    for (const [code, slot] of placed) this.where.set(code, slot);
    for (const code of removed) this.where.delete(code);
    this.count = next.reduce((n, b) => n + b.segment.rowCount, 0);
    this.dropped += dropped;
  }

  private split(rows: Segment, keys: readonly KeyCode[], slot?: Slot): Block[] {
    // Purpose: cut rows into blocks of at most blockRows (views, no copy); the first may reuse a slot
    const out: Block[] = [];
    for (let start = 0; start < rows.rowCount; start += this.blockRows) {
      const end = Math.min(rows.rowCount, start + this.blockRows);
      const segment = start === 0 && end === rows.rowCount ? rows : sliceBlock(rows, start, end);
      out.push(newBlock(segment, keys.slice(start, end), start === 0 ? slot : undefined));
    }
    return out;
  }

  private applyRetain(blocks: Block[], removed: KeyCode[]): Block[] {
    // Purpose: drop the oldest rows beyond the retain window: whole blocks, then the front of the first kept one
    if (this.retain === null) return blocks;
    let excess = blocks.reduce((n, b) => n + b.segment.rowCount, 0) - this.retain;
    if (excess <= 0) return blocks;
    const out: Block[] = [];
    for (const block of blocks) {
      const rows = block.segment.rowCount;
      if (excess >= rows) {
        excess -= rows;
        for (const code of block.keys) removed.push(code);
        continue;
      }
      if (excess > 0) {
        for (let i = 0; i < excess; i++) removed.push(block.keys[i]!);
        out.push(newBlock(sliceBlock(block.segment, excess, rows), block.keys.slice(excess), block.slot));
        excess = 0;
        continue;
      }
      out.push(block);
    }
    return out;
  }

  private locate(key: Key, where: string): { block: Block; row: number } | null {
    // Purpose: the block and row holding a key, or null
    this.ensureUsable();
    const code = this.codeOfKey(this.validateKey(key, where));
    if (code === null) return null;
    const slot = this.where.get(code);
    if (slot === undefined) return null;
    return { block: slot.block, row: slot.block.keys.indexOf(code) };
  }

  private packingFor(): { scale: number; bias: number; bits: number }[] | null {
    // Purpose: shifts and biases when there are several key components and all are small integers together
    if (this.keyColumns.length < 2) return null;
    const types = this.keyColumns.map(c => this.schema.list[c]!.type.name);
    if (!types.every(name => name in PACK_BITS)) return null;
    const total = types.reduce((n, name) => n + PACK_BITS[name]!, 0);
    if (total > 52) return null;
    let scale = 1;
    const out: { scale: number; bias: number; bits: number }[] = [];
    for (let i = types.length - 1; i >= 0; i--) {
      out[i] = { scale, bias: PACK_BIAS[types[i]!]!, bits: PACK_BITS[types[i]!]! };
      scale *= 2 ** PACK_BITS[types[i]!]!;
    }
    return out;
  }

  private codesOf(segment: Segment, where: string): KeyCode[] {
    // Purpose: the key code of every row of checked input, rejecting a null key component (C-LIVE-KEY)
    const n = segment.rowCount;
    const parts = this.keyColumns.map((c, i) => {
      const column = segment.columns[c]!;
      if (column.valid !== null) {
        for (let r = 0; r < n; r++) {
          if (column.valid[r] === 0) {
            throw new SchemaError(`Expected a non-null value for key "${this.keyFields[i]}" at ${where} ${r}, component ${i}, found null`);
          }
        }
      }
      return this.cellCodes(column, n);
    });
    if (parts.length === 1) return Array.from(parts[0]!);
    const out: KeyCode[] = new Array(n);
    const packing = this.packing;
    if (packing !== null) {
      for (let r = 0; r < n; r++) {
        let code = 0;
        for (let i = 0; i < parts.length; i++) code += ((parts[i]![r] as number) + packing[i]!.bias) * packing[i]!.scale;
        out[r] = code;
      }
      return out;
    }
    for (let r = 0; r < n; r++) out[r] = joinParts(parts.map(p => p[r]!));
    return out;
  }

  private cellCodes(column: Column, n: number): ArrayLike<number | string> {
    // Purpose: one key code per row of one key column: numbers as numbers, everything else as strings
    const kind = componentKind(column.type);
    if (kind === 'string') return texts(column);
    if (kind === 'bigint') return Array.from(bigs(column) as unknown as ArrayLike<bigint>, v => `${v}`);
    const values = nums(column);
    return values.length === n ? (values as unknown as ArrayLike<number>) : Array.from({ length: n }, (_, i) => values[i]!);
  }

  private codeOfKey(key: Key): KeyCode | null {
    // Purpose: the code of a caller's key, or null when a component cannot be a stored value of its column (no such key)
    const parts: (number | string)[] = [];
    for (let i = 0; i < key.length; i++) {
      const value = key[i]!;
      const kind = this.kinds[i]!;
      const column = this.schema.list[this.keyColumns[i]!]!;
      if (kind === 'date') {
        if (!(value instanceof Date)) return null;
        const ms = value.getTime();
        const stored = column.type.name === 'date32' ? ms / MS_PER_DAY : ms;
        if (!Number.isInteger(stored)) return null;
        parts.push(stored);
      } else if (kind === 'boolean') {
        if (typeof value !== 'boolean') return null;
        parts.push(value ? 1 : 0);
      } else if (kind === 'bigint') {
        if (typeof value !== 'bigint') return null;
        parts.push(`${value}`);
      } else if (kind === 'string') {
        if (typeof value !== 'string') return null;
        parts.push(value);
      } else {
        if (typeof value !== 'number') return null;
        // float32 columns store rounded values; look up the rounded value too.
        parts.push(column.type.name === 'float32' ? Math.fround(value) : value);
      }
    }
    if (parts.length === 1) return parts[0]!;
    const packing = this.packing;
    if (packing === null) return joinParts(parts);
    let code = 0;
    for (let i = 0; i < parts.length; i++) {
      // A component that is not a value of its column could alias another key once packed.
      const shifted = (parts[i] as number) + packing[i]!.bias;
      if (!Number.isInteger(shifted) || shifted < 0 || shifted >= 2 ** packing[i]!.bits) return null;
      code += shifted * packing[i]!.scale;
    }
    return code;
  }

  private validateKeyFields(keyFields: KeyFields<F>): readonly string[] {
    // Purpose: reject an empty, repeated or unknown key field list before any table is built
    if (keyFields.length === 0) throw new SchemaError('Expected at least one key field at keyFields, found none');
    const names = new Set<string>();
    for (let i = 0; i < keyFields.length; i++) {
      const name = keyFields[i]!;
      if (!this.schema.list.some(field => field.name === name)) {
        throw new SchemaError(`Expected a column of the schema at keyFields[${i}], found "${name}"`);
      }
      if (names.has(name)) throw new SchemaError(`Expected distinct key fields at keyFields[${i}], found duplicate "${name}"`);
      names.add(name);
    }
    return keyFields;
  }

  private validateKey(key: Key, where: string): Key {
    // Purpose: check a caller-supplied key's arity and component types before it is used
    if (!Array.isArray(key)) {
      throw new SchemaError(`Expected an array of ${this.keyFields.length} components at ${where}, found ${describe(key)}`);
    }
    if (key.length !== this.keyFields.length) {
      throw new SchemaError(`Expected ${this.keyFields.length} key components (${this.keyFields.join(', ')}) at ${where}, found ${key.length}`);
    }
    for (let i = 0; i < key.length; i++) {
      const value = key[i]!;
      const kind = typeof value;
      if (!(value instanceof Date) && kind !== 'string' && kind !== 'number' && kind !== 'bigint' && kind !== 'boolean') {
        throw new SchemaError(
          `Expected a string, number, bigint, boolean or Date for key "${this.keyFields[i]}" at ${where}[${i}], found ${describe(value)}`,
        );
      }
    }
    return key;
  }

  private ensureUsable(): void {
    // Purpose: a table whose backend refused an edit is out of step and must not be read
    if (this.failure !== null) throw new HandleError(`This keyed table is out of step with its engine after a failed edit (${this.failure.message}); recreate it`);
  }

  private ensureLive(): void {
    // Purpose: reject mutations of a disposed or failed keyed table with a typed error
    if (this.disposed) throw new HandleError('This keyed table was disposed');
    this.ensureUsable();
  }
}
