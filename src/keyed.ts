// Keyed live tables (C-LIVE-KEY). A KeyedTable owns one immutable backend table
// and swaps it for a newly built one on every mutation. A run that started
// before a mutation keeps reading the table it started on (C-LIVE), and the old
// table is only released once every such run has finished.
//
// Input is checked with the same JS loader ordinary tables use, decoded to typed
// JS rows, and handed to a backend-specific factory as a whole. Every mutation
// validates all of its input before it builds the replacement, so a rejected
// mutation cannot leave a half-applied change behind.

import type { Backend, Table } from './backend';
import { bigs, nums, texts } from './column';
import type { Column } from './column';
import { HandleError, SchemaError } from './errors';
import type { Fields, RowOf, Schema } from './schema';
import type { DataType, JsOf } from './types';
import { MS_PER_DAY } from './types';
import { loadColumns, loadRows } from './backends/js/load';
import type { DictionaryInput } from './backends/js/load';
import type { TableInput, TableOptions } from './backends/js';

// The JS values a key component may be. Their JS type is part of the key:
// 1n, 1, '1', true and new Date(1) are five different components.
export type KeyComponent = string | number | bigint | boolean | Date;
export type Key = readonly KeyComponent[];

// Column names that make up the key, in order.
export type KeyFields<F extends Fields> = readonly (keyof F & string)[];

// A backend builds a whole new table from the keyed table's current rows.
export type KeyedTableFactory<F extends Fields> = (rows: readonly RowOf<F>[]) => Table<F>;

function describe(value: unknown): string {
  // Purpose: say what was found in a structured error message
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return `Date(${String(value.getTime())})`;
  return `${typeof value} ${String(value)}`;
}

function tagged(component: KeyComponent): readonly [string, string | number | boolean] {
  // Purpose: tag a component with its JS type so values of different types never compare equal
  if (component instanceof Date) return ['d', component.getTime()];
  if (typeof component === 'bigint') return ['i', component.toString()];
  if (typeof component === 'boolean') return ['b', component];
  if (typeof component === 'number') return ['n', component];
  return ['s', component];
}

function encodeKey(key: Key): string {
  // Purpose: an unambiguous string for a key, used as the key of the row index
  return JSON.stringify(key.map(tagged));
}

function decodeCell(column: Column, row: number): JsOf<DataType> | null {
  // Purpose: undo the loader's storage conversion for one cell of one typed row
  if (column.valid !== null && column.valid[row] === 0) return null;
  const name = column.type.name;
  if (name === 'bool') return nums(column)[row] !== 0;
  if (name === 'utf8' || name === 'dictionary') return texts(column)[row]!;
  if (name === 'int64' || name === 'uint64') return bigs(column)[row]!;
  if (name === 'date32') return new Date(nums(column)[row]! * MS_PER_DAY);
  if (name === 'timestamp') return new Date(nums(column)[row]!);
  return nums(column)[row]!;
}

function normalise<F extends Fields>(schema: Schema<F>, data: TableInput<F>): readonly RowOf<F>[] {
  // Purpose: check row or column input with the JS loader, then decode it to typed JS rows
  let columns: readonly Column[];
  let rowCount: number;
  if (Array.isArray(data)) {
    columns = loadRows(schema, data);
    rowCount = data.length;
  } else {
    const input = data as { readonly columns?: unknown };
    if (input === null || typeof input !== 'object' || typeof input.columns !== 'object' || input.columns === null) {
      throw new SchemaError(
        `Expected an array of rows or { columns: { name: array } } at input, found ${describe(data)}`,
      );
    }
    const loaded = loadColumns(schema, input.columns as Record<string, ArrayLike<unknown> | DictionaryInput>);
    columns = loaded.columns;
    rowCount = loaded.rowCount;
  }
  const rows: RowOf<F>[] = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < schema.list.length; c++) {
      const field = schema.list[c]!;
      row[field.name] = decodeCell(columns[c]!, r);
    }
    rows[r] = row as RowOf<F>;
  }
  return rows;
}

function validateKeyFields<F extends Fields>(schema: Schema<F>, keyFields: KeyFields<F>): readonly string[] {
  // Purpose: reject an empty, repeated or unknown key field list before any table is built
  if (keyFields.length === 0) {
    throw new SchemaError('Expected at least one key field at keyFields, found none');
  }
  const names = new Set<string>();
  for (let i = 0; i < keyFields.length; i++) {
    const name = keyFields[i]!;
    if (!schema.list.some(field => field.name === name)) {
      throw new SchemaError(`Expected a column of the schema at keyFields[${i}], found "${name}"`);
    }
    if (names.has(name)) {
      throw new SchemaError(`Expected distinct key fields at keyFields[${i}], found duplicate "${name}"`);
    }
    names.add(name);
  }
  return keyFields;
}

function disposeTable(table: Table): void {
  // Purpose: release a replaced backend table when that backend owns memory
  const disposable = table as Table & { dispose?: () => void };
  disposable.dispose?.();
}

export class KeyedTable<F extends Fields = Fields> implements Table<F> {
  readonly schema: Schema<F>;
  readonly backend: Backend;
  private readonly keyFields: readonly string[];
  private readonly factory: KeyedTableFactory<F>;
  private readonly retain: number | null;
  private rows: readonly RowOf<F>[];
  private keyIndex: Map<string, number>;
  private currentTable: Table<F>;
  private activeRuns = 0;
  private readonly retired = new Set<Table<F>>();
  private dropped = 0;
  private disposed = false;

  constructor(
    schema: Schema<F>,
    keyFields: KeyFields<F>,
    data: TableInput<F>,
    options: TableOptions,
    factory: KeyedTableFactory<F>,
  ) {
    // Purpose: own one immutable backend table and the key index over its typed rows
    this.schema = schema;
    this.factory = factory;
    const retain = options.retain?.rows;
    if (retain !== undefined && (!Number.isInteger(retain) || retain < 1)) {
      throw new SchemaError(`Expected retain.rows to be a positive integer at options.retain, found ${describe(retain)}`);
    }
    this.retain = retain ?? null;
    this.keyFields = validateKeyFields(schema, keyFields);

    const initial = normalise(schema, data);
    const index = new Map<string, number>();
    const rows: RowOf<F>[] = [];
    for (let i = 0; i < initial.length; i++) {
      const row = initial[i]!;
      const encoded = encodeKey(this.keyOfRow(row, `initial row ${i}`));
      const at = index.get(encoded);
      if (at === undefined) {
        index.set(encoded, rows.length);
        rows.push(row);
      } else {
        rows[at] = row; // Repeated initial keys keep the first position, like upsert.
      }
    }
    const sized = this.trim(rows, index, 0);
    this.rows = sized.rows;
    this.keyIndex = sized.index;
    this.dropped = sized.dropped;
    this.currentTable = factory(this.rows);
    this.backend = this.currentTable.backend;
  }

  get rowCount(): number {
    // Purpose: the number of rows in the current snapshot
    return this.rows.length;
  }

  get rowsDropped(): number {
    // Purpose: rows removed by delete, replacement and the retain window over this table's life
    return this.dropped;
  }

  current(): Table<F> {
    // Purpose: the immutable backend table holding the current rows
    return this.currentTable;
  }

  get(key: Key): RowOf<F> | undefined {
    // Purpose: a copy of the current row for a key, or undefined when it has none
    const at = this.keyIndex.get(encodeKey(this.validateKey(key, 'key')));
    return at === undefined ? undefined : { ...this.rows[at]! };
  }

  has(key: Key): boolean {
    // Purpose: whether the current table holds this key
    return this.keyIndex.has(encodeKey(this.validateKey(key, 'key')));
  }

  upsert(rows: TableInput<F>): void {
    // Purpose: C-LIVE-KEY: insert new keys and replace whole rows for existing keys, keeping their position
    this.ensureLive();
    const incoming = normalise(this.schema, rows);
    // Every key is validated before anything is changed, so a bad row applies nothing.
    const keys = incoming.map((row, i) => this.keyOfRow(row, `upsert row ${i}`));
    const nextRows = [...this.rows];
    const nextIndex = new Map(this.keyIndex);
    let replaced = 0;
    for (let i = 0; i < incoming.length; i++) {
      const encoded = encodeKey(keys[i]!);
      const at = nextIndex.get(encoded);
      if (at === undefined) {
        nextIndex.set(encoded, nextRows.length);
        nextRows.push(incoming[i]!);
      } else {
        nextRows[at] = incoming[i]!;
        replaced++;
      }
    }
    this.commit(nextRows, nextIndex, replaced);
  }

  delete(keys: readonly Key[]): number {
    // Purpose: C-LIVE-KEY: remove the rows for these keys and report how many were removed
    this.ensureLive();
    const wanted = keys.map((key, i) => encodeKey(this.validateKey(key, `keys[${i}]`)));
    const removing = new Set(wanted.filter(encoded => this.keyIndex.has(encoded)));
    if (removing.size === 0) return 0;
    const nextRows: RowOf<F>[] = [];
    const nextIndex = new Map<string, number>();
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      const encoded = encodeKey(this.keyOfRow(row, `existing row ${i}`));
      if (removing.has(encoded)) continue;
      nextIndex.set(encoded, nextRows.length);
      nextRows.push(row);
    }
    this.commit(nextRows, nextIndex, removing.size);
    return removing.size;
  }

  dispose(): void {
    // Purpose: free the current and any retired backend tables; backends make this safe to repeat
    if (this.disposed) return;
    this.disposed = true;
    disposeTable(this.currentTable);
    for (const table of this.retired) disposeTable(table);
    this.retired.clear();
    this.activeRuns = 0;
  }

  /** @internal */
  acquire(): void {
    // Purpose: count a run that has started on the current table, so a mutation cannot free it mid-run
    this.activeRuns++;
  }

  /** @internal */
  releaseRun(): void {
    // Purpose: count a finished run, freeing replaced tables once no run is left in flight
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns !== 0) return;
    for (const table of this.retired) disposeTable(table);
    this.retired.clear();
  }

  private keyOfRow(row: RowOf<F>, where: string): Key {
    // Purpose: the typed components of a row's key, rejecting a null or missing one
    return this.keyFields.map(function (name, i) {
      const value = row[name as keyof F];
      if (value === null || value === undefined) {
        throw new SchemaError(
          `Expected a non-null value for key "${name}" at ${where}, component ${i}, found ${describe(value)}`,
        );
      }
      return value as KeyComponent;
    });
  }

  private validateKey(key: Key, where: string): Key {
    // Purpose: check a caller-supplied key's arity and component types before it is used
    if (!Array.isArray(key)) {
      throw new SchemaError(`Expected an array of ${this.keyFields.length} components at ${where}, found ${describe(key)}`);
    }
    if (key.length !== this.keyFields.length) {
      throw new SchemaError(
        `Expected ${this.keyFields.length} key components (${this.keyFields.join(', ')}) at ${where}, found ${key.length}`,
      );
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

  private trim(
    rows: readonly RowOf<F>[],
    index: Map<string, number>,
    dropped: number,
  ): { rows: readonly RowOf<F>[]; index: Map<string, number>; dropped: number } {
    // Purpose: apply the retain window to the canonical rows and rebuild their key index
    if (this.retain === null || rows.length <= this.retain) return { rows, index, dropped };
    const excess = rows.length - this.retain;
    const kept = rows.slice(excess);
    const next = new Map<string, number>();
    for (let i = 0; i < kept.length; i++) next.set(encodeKey(this.keyOfRow(kept[i]!, 'retained row')), i);
    return { rows: kept, index: next, dropped: dropped + excess };
  }

  private commit(rows: readonly RowOf<F>[], index: Map<string, number>, dropped: number): void {
    // Purpose: build the replacement table first, then swap it in atomically (C-LIVE-KEY)
    const sized = this.trim(rows, index, dropped);
    const nextTable = this.factory(sized.rows);
    const old = this.currentTable;
    if (this.activeRuns === 0) disposeTable(old);
    else this.retired.add(old);
    this.currentTable = nextTable;
    this.rows = sized.rows;
    this.keyIndex = sized.index;
    this.dropped += sized.dropped;
  }

  private ensureLive(): void {
    // Purpose: reject mutations of a disposed keyed table with a typed error
    if (this.disposed) throw new HandleError('This keyed table was disposed');
  }
}
