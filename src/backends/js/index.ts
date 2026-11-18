// The JS backend: tables held as typed arrays in the page, executed by the
// reference executor. It needs no WASM and is the default backend.
//
// A table is a list of SEGMENTS: the rows it was created with, then one per
// append(). Segments are never modified. append() and the retain window build a
// new segment list and swap it in, so a run that captured the list at its start
// keeps seeing exactly that table (C-LIVE).

import type { Backend, BackendOptions, ResultData, Table } from '../../backend';
import type { Column } from '../../column';
import { slice } from '../../column';
import { PlanError, SchemaError } from '../../errors';
import type { IrPlan } from '../../ir';
import type { Fields, RowOf, Schema } from '../../schema';
import type { Segment } from './exec';
import { executeJs } from './exec';
import { loadColumns, loadRows } from './load';
import type { DictionaryInput } from './load';
export type { DictionaryInput };

// A row as accepted by table() and append(): a missing property means null.
export type RowInput<F extends Fields> = Partial<RowOf<F>>;

// One array per column. A typed array of the column's own storage type is used
// without copying; a plain array is checked value by value and may hold nulls.
// A dictionary column may also arrive already encoded as { codes, dictionary }:
// the strings are not re-encoded, only the codes are checked.
export interface ColumnInput<F extends Fields> {
  readonly columns: { readonly [K in keyof F]: ArrayLike<unknown> | DictionaryInput };
}

export type TableInput<F extends Fields> = readonly RowInput<F>[] | ColumnInput<F>;

export interface TableOptions {
  // Keep only the most recent `rows` rows; older rows are dropped as new ones are appended.
  readonly retain?: { readonly rows: number };
}

export const jsBackend: Backend = {
  name: 'js',
  async execute(plan: IrPlan, table: Table, options: BackendOptions): Promise<ResultData> {
    // Purpose: run a plan on a table owned by the JS backend, as the table stood when the run started
    if (!(table instanceof JsTable)) {
      throw new PlanError('The JS backend can only run plans on tables created with table()');
    }
    return executeJs(plan, table.snapshot(), options);
  },
};

function load<F extends Fields>(schema: Schema<F>, data: TableInput<F>): Segment {
  // Purpose: check and convert row objects or column arrays into one segment
  if (Array.isArray(data)) return { columns: loadRows(schema, data), rowCount: data.length };
  const input = data as ColumnInput<F>;
  if (input === null || typeof input !== 'object' || typeof input.columns !== 'object' || input.columns === null) {
    throw new SchemaError('Expected an array of rows or { columns: { name: array } }');
  }
  return loadColumns(schema, input.columns);
}

function trimFront(segment: Segment, drop: number): Segment {
  // Purpose: a segment without its first `drop` rows; typed arrays are views, not copies
  const columns = segment.columns.map(function (column: Column) {
    return slice(column, drop, segment.rowCount);
  });
  return { columns, rowCount: segment.rowCount - drop };
}

export class JsTable<F extends Fields = Fields> implements Table<F> {
  readonly schema: Schema<F>;
  readonly backend: Backend = jsBackend;
  private segments: readonly Segment[];
  private count: number;
  private readonly retain: number | null;
  private dropped = 0;

  constructor(schema: Schema<F>, first: Segment, options: TableOptions = {}) {
    // Purpose: hold checked columns for one schema, with an optional retain window
    this.schema = schema;
    const retain = options.retain?.rows;
    if (retain !== undefined && (!Number.isInteger(retain) || retain < 1)) {
      throw new SchemaError(`retain.rows must be a positive integer, got ${retain}`);
    }
    this.retain = retain ?? null;
    this.segments = first.rowCount > 0 ? [first] : [];
    this.count = first.rowCount;
    this.enforceRetain();
  }

  get rowCount(): number {
    // Purpose: rows in the table now
    return this.count;
  }

  get rowsDropped(): number {
    // Purpose: rows removed so far by the retain window
    return this.dropped;
  }

  /** @internal */
  snapshot(): readonly Segment[] {
    // Purpose: the segment list as it stands; later appends replace the list, never change it
    return this.segments;
  }

  append(data: TableInput<F>): void {
    // Purpose: C-LIVE: add rows at the end; runs already started do not see them
    const segment = load(this.schema, data);
    if (segment.rowCount === 0) return;
    this.segments = [...this.segments, segment];
    this.count += segment.rowCount;
    this.enforceRetain();
  }

  private enforceRetain(): void {
    // Purpose: drop the oldest rows until at most `retain` remain
    if (this.retain === null || this.count <= this.retain) return;
    let excess = this.count - this.retain;
    const kept: Segment[] = [];
    for (const segment of this.segments) {
      if (excess >= segment.rowCount) {
        excess -= segment.rowCount;
        continue;
      }
      kept.push(excess > 0 ? trimFront(segment, excess) : segment);
      excess = 0;
    }
    this.dropped += this.count - this.retain;
    this.count = this.retain;
    this.segments = kept;
  }
}

export function table<F extends Fields>(
  schema: Schema<F>,
  data: TableInput<F>,
  options: TableOptions = {},
): JsTable<F> {
  // Purpose: create a JS-backend table from row objects or from one array per column
  return new JsTable(schema, load(schema, data), options);
}
