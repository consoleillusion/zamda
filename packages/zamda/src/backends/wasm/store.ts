// Tables in the WASM engine's memory (T-403). The host side of the table store:
// it checks incoming data with the same loader as the JS backend, then copies
// each column once into memory the engine gave it. Strings stay here: a utf8 or
// dictionary column crosses as int32 codes, and the dictionaries are kept per
// segment on this side.

import type { Column } from '../../column';
import { ExecutionError, HandleError, MemoryError, SchemaError } from '../../errors';
import { TYPE_NAMES } from '../../ir-binary';
import type { Fields, Schema } from '../../schema';
import type { TableOptions, TableInput } from '../js';
import { loadSegment } from '../js';
import type { Segment } from '../js/exec';
import { storageMatches } from '../../column';

// What the host needs from the engine: a block allocator, a view of its memory,
// and the table store functions of engine/src/store_abi.rs. Pointers and handles
// are plain numbers. `view` must be called right before use: a WASM memory
// replaces its buffer when it grows.
export interface EngineHost {
  alloc(bytes: number): number;
  free(ptr: number, bytes: number): void;
  view(ptr: number, bytes: number): Uint8Array;
  storeError(): number;
  tableNew(types: number, columns: number, retain: number): number;
  tableFree(table: number): number;
  tableRows(table: number): number;
  tableDropped(table: number): number;
  tableSegments(table: number): number;
  tableSegmentId(table: number, index: number): number;
  segBegin(table: number, rows: number): number;
  segValues(table: number, column: number): number;
  segValid(table: number, column: number): number;
  segDict(table: number, column: number, entries: number): number;
  segCommit(table: number): number;
  segAbort(table: number): number;
  // Keyed tables (src/keyed.ts): commit the staged segment at `index` in place of `replace` segments,
  // drop segments, and set a table back to an earlier snapshot (so an edit is all or nothing).
  segCommitAt(table: number, index: number, replace: number): number;
  tableRemove(table: number, index: number, count: number): number;
  tableRestore(table: number, snapshot: number): number;
  snapshot(table: number): number;
  snapshotFree(snapshot: number): number;
  snapshotRows(snapshot: number): number;
  snapshotSegments(snapshot: number): number;
  snapshotSegmentId(snapshot: number, index: number): number;
  snapshotSegmentRows(snapshot: number, index: number): number;
  snapshotValues(snapshot: number, index: number, column: number): number;
  snapshotValid(snapshot: number, index: number, column: number): number;
  snapshotDictLen(snapshot: number, index: number, column: number): number;
}

// Engine error codes (engine/src/store.rs) and how they reach the caller.
const OUT_OF_MEMORY = 210;
const CODE_OUT_OF_RANGE = 209;

function raise(host: EngineHost, what: string): never {
  // Purpose: turn the engine's last store error into a thrown error
  const code = host.storeError();
  if (code === OUT_OF_MEMORY) throw new MemoryError(`The engine ran out of memory while ${what}`);
  if (code === 203) throw new HandleError(`The engine no longer has this table (${what})`);
  throw new ExecutionError(`The engine refused ${what} (store error ${code}); this is a bug in zamda`);
}

function check(host: EngineHost, status: number, what: string): void {
  // Purpose: raise the engine's error when a call returned a nonzero status
  if (status !== 0) raise(host, what);
}

// One step of a keyed table's edit: replace `remove` segments at `start` with `insert`.
export interface SegmentEdit {
  readonly start: number;
  readonly remove: number;
  readonly insert: readonly Segment[];
}

function checkSegment(schema: Schema, segment: Segment): void {
  // Purpose: a segment built elsewhere (or sent from another thread) must have the schema's storage before its bytes are copied
  const rows = segment.rowCount;
  if (!Number.isInteger(rows) || rows < 0 || !Array.isArray(segment.columns) || segment.columns.length !== schema.list.length) {
    throw new SchemaError(`Expected a segment of ${schema.list.length} columns, found ${String(segment.columns?.length)}`);
  }
  schema.list.forEach((field, c) => {
    const column = segment.columns[c]!;
    if (column.type?.name !== field.type.name || !storageMatches(column, rows)) {
      throw new SchemaError(`Expected column "${field.name}" as ${field.type.name} storage of ${rows} rows in a segment, found something else`);
    }
  });
}

// What this side keeps for one segment: the strings behind its code columns.
export interface SegmentInfo {
  readonly id: number;
  readonly dictionaries: readonly (readonly string[] | null)[];
}

export interface EngineSegment extends SegmentInfo {
  // Rows of the segment as this snapshot sees it (the retain window may have trimmed the front).
  readonly rows: number;
}

// A run's view of a table: fixed when taken, valid until released.
export class EngineSnapshot {
  readonly handle: number;
  readonly rows: number;
  readonly segments: readonly EngineSegment[];
  private readonly host: EngineHost;
  private open = true;

  constructor(host: EngineHost, handle: number, rows: number, segments: readonly EngineSegment[]) {
    // Purpose: wrap an engine snapshot handle with the dictionaries of its segments
    this.host = host;
    this.handle = handle;
    this.rows = rows;
    this.segments = segments;
  }

  release(): void {
    // Purpose: give the snapshot back so the engine can free segments nothing else uses; safe to call twice
    if (!this.open) return;
    this.open = false;
    this.host.snapshotFree(this.handle);
  }
}

function typeIds(schema: Schema): Uint8Array {
  // Purpose: the binary IR type id of each column, in column order
  return Uint8Array.from(schema.list, f => TYPE_NAMES.indexOf(f.type.name));
}

function encodeStrings(strings: readonly string[], valid: Uint8Array | null): { codes: Int32Array; dictionary: string[] } {
  // Purpose: turn a utf8 column into codes and a list of its distinct strings; null rows get code 0
  const index = new Map<string, number>();
  const dictionary: string[] = [];
  const codes = new Int32Array(strings.length);
  for (let i = 0; i < strings.length; i++) {
    if (valid !== null && valid[i] === 0) continue;
    const s = strings[i]!;
    let code = index.get(s);
    if (code === undefined) {
      code = dictionary.length;
      index.set(s, code);
      dictionary.push(s);
    }
    codes[i] = code;
  }
  return { codes, dictionary };
}

export class EngineTable<F extends Fields = Fields> {
  readonly schema: Schema<F>;
  private readonly host: EngineHost;
  private handle: number;
  private readonly infos = new Map<number, SegmentInfo>();

  constructor(host: EngineHost, schema: Schema<F>, data: TableInput<F>, options: TableOptions = {}) {
    // Purpose: create an engine table for a schema and load its first rows
    this.host = host;
    this.schema = schema;
    const retain = options.retain?.rows;
    if (retain !== undefined && (!Number.isInteger(retain) || retain < 1)) {
      throw new SchemaError(`retain.rows must be a positive integer, got ${retain}`);
    }
    const ids = typeIds(schema);
    const ptr = host.alloc(ids.length);
    if (ptr === 0) throw new MemoryError('The engine ran out of memory while creating a table');
    try {
      host.view(ptr, ids.length).set(ids);
      // The engine counts rows in 32 bits, so a larger window can never be reached: it means "keep everything".
      this.handle = host.tableNew(ptr, ids.length, retain === undefined || retain >= 0xffffffff ? 0 : retain);
    } finally {
      host.free(ptr, ids.length);
    }
    if (this.handle === 0) raise(host, 'creating a table');
    try {
      this.append(data);
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  get rowCount(): number {
    // Purpose: rows in the table now
    return this.host.tableRows(this.live());
  }

  get rowsDropped(): number {
    // Purpose: rows removed so far by the retain window
    return this.host.tableDropped(this.live());
  }

  private live(): number {
    // Purpose: the engine handle, or an error if the table was disposed
    if (this.handle === 0) throw new HandleError('This table was disposed');
    return this.handle;
  }

  append(data: TableInput<F>): void {
    // Purpose: C-LIVE: check the rows, copy each column once into the engine, and add them as one segment; a bad append changes nothing
    this.appendSegment(loadSegment(this.schema, data));
  }

  appendSegment(segment: Segment): void {
    // Purpose: add columns already checked by the JS loader as one segment at the end
    if (segment.rowCount === 0) return;
    const table = this.live();
    const dictionaries = this.stage(table, segment);
    const status = this.host.segCommit(table);
    this.finish(table, status, dictionaries, this.host.tableSegments(table) - 1);
  }

  // Keyed tables: replace segments in place (C-LIVE-KEY). `edits` apply in order; each replaces `remove`
  // segments at `start` (an index into the list as the earlier edits left it) with `insert`. All or
  // nothing: if any step fails the table is set back to how it was, so runs and the keyed table's own
  // bookkeeping never see half an edit. Runs already started keep their snapshots either way.
  edit(edits: readonly SegmentEdit[]): void {
    // Purpose: apply a keyed table's segment edits atomically
    const table = this.live();
    const host = this.host;
    for (const e of edits) for (const segment of e.insert) checkSegment(this.schema, segment);
    const before = host.snapshot(table);
    if (before === 0) raise(host, 'taking a snapshot before an edit');
    try {
      for (const e of edits) {
        const inserts = e.insert.filter(segment => segment.rowCount > 0);
        if (inserts.length === 0) {
          if (e.remove > 0) check(host, host.tableRemove(table, e.start, e.remove), 'removing segments');
          continue;
        }
        for (let i = 0; i < inserts.length; i++) {
          const at = e.start + i;
          const dictionaries = this.stage(table, inserts[i]!);
          this.finish(table, host.segCommitAt(table, at, i === 0 ? e.remove : 0), dictionaries, at);
        }
      }
    } catch (error) {
      if (host.tableRestore(table, before) !== 0) {
        host.snapshotFree(before);
        this.dispose();
        throw new ExecutionError(`A keyed edit failed and the table could not be set back (${String(error)}); this is a bug in zamda`);
      }
      host.snapshotFree(before);
      this.forget();
      throw error;
    }
    host.snapshotFree(before);
    this.forget();
  }

  private stage(table: number, segment: Segment): (readonly string[] | null)[] {
    // Purpose: copy one segment's columns into the engine's staging area; its dictionaries, kept on this side
    const host = this.host;
    const rows = segment.rowCount;
    check(host, host.segBegin(table, rows), 'starting a segment');
    try {
      const dictionaries: (readonly string[] | null)[] = [];
      for (let c = 0; c < segment.columns.length; c++) {
        const column: Column = segment.columns[c]!;
        let values = column.values;
        let dictionary: readonly string[] | null = column.dictionary ?? null;
        if (column.type.name === 'utf8') {
          const encoded = encodeStrings(values as string[], column.valid);
          values = encoded.codes;
          dictionary = encoded.dictionary;
        }
        dictionaries.push(dictionary);
        const source = values as Exclude<typeof values, string[]>;
        const bytes = source.byteLength;
        const to = host.segValues(table, c);
        if (to === 0) raise(host, 'storing a column');
        host.view(to, bytes).set(new Uint8Array(source.buffer, source.byteOffset, bytes));
        if (column.valid !== null) {
          const at = host.segValid(table, c);
          if (at === 0) raise(host, 'storing a validity column');
          host.view(at, rows).set(column.valid);
        }
        if (dictionary !== null) check(host, host.segDict(table, c, dictionary.length), 'storing a dictionary size');
      }
      return dictionaries;
    } catch (e) {
      host.segAbort(table);
      throw e;
    }
  }

  private finish(table: number, status: number, dictionaries: (readonly string[] | null)[], index: number): void {
    // Purpose: after a commit: raise its error, or remember the new segment's dictionaries
    if (status === CODE_OUT_OF_RANGE) {
      this.host.segAbort(table);
      throw new SchemaError('A dictionary column holds a code outside its dictionary');
    }
    if (status !== 0) {
      this.host.segAbort(table);
      raise(this.host, 'adding a segment');
    }
    const id = this.host.tableSegmentId(table, index);
    this.infos.set(id, { id, dictionaries });
    this.forget();
  }

  private forget(): void {
    // Purpose: drop the dictionaries of segments the table no longer holds (retain window, keyed edits)
    const table = this.live();
    const count = this.host.tableSegments(table);
    const alive = new Set<number>();
    for (let i = 0; i < count; i++) alive.add(this.host.tableSegmentId(table, i));
    for (const id of [...this.infos.keys()]) if (!alive.has(id)) this.infos.delete(id);
  }

  snapshot(): EngineSnapshot {
    // Purpose: freeze the table for one run: appends and dropped rows after this do not change what the run reads
    const table = this.live();
    const handle = this.host.snapshot(table);
    if (handle === 0) raise(this.host, 'taking a snapshot');
    const count = this.host.snapshotSegments(handle);
    const segments: EngineSegment[] = [];
    for (let i = 0; i < count; i++) {
      const id = this.host.snapshotSegmentId(handle, i);
      const info = this.infos.get(id);
      if (info === undefined) {
        this.host.snapshotFree(handle);
        throw new ExecutionError(`No dictionaries kept for segment ${id}; this is a bug in zamda`);
      }
      segments.push({ ...info, rows: this.host.snapshotSegmentRows(handle, i) });
    }
    return new EngineSnapshot(this.host, handle, this.host.snapshotRows(handle), segments);
  }

  dispose(): void {
    // Purpose: free the table's segments (snapshots still open keep theirs); safe to call twice
    if (this.handle === 0) return;
    const handle = this.handle;
    this.handle = 0;
    this.host.tableFree(handle);
    this.infos.clear();
  }
}
