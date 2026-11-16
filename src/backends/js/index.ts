// The JS backend: tables held as typed arrays in the page, executed by the
// reference executor. It needs no WASM and is the default backend.

import type { Backend, BackendOptions, ResultData, Table } from '../../backend';
import type { Column } from '../../column';
import { PlanError, SchemaError } from '../../errors';
import type { IrPlan } from '../../ir';
import type { Fields, RowOf, Schema } from '../../schema';
import { executeJs } from './exec';
import { loadColumns, loadRows } from './load';

// A row as accepted by table(): a missing property means null.
export type RowInput<F extends Fields> = Partial<RowOf<F>>;

// One array per column. A typed array of the column's own storage type is used
// without copying; a plain array is checked value by value and may hold nulls.
export interface ColumnInput<F extends Fields> {
  readonly columns: { readonly [K in keyof F]: ArrayLike<unknown> };
}

export const jsBackend: Backend = {
  name: 'js',
  async execute(plan: IrPlan, table: Table, options: BackendOptions): Promise<ResultData> {
    // Purpose: run a plan on a table owned by the JS backend
    if (!(table instanceof JsTable)) {
      throw new PlanError('The JS backend can only run plans on tables created with table()');
    }
    return executeJs(plan, table.columns, table.rowCount, options);
  },
};

export class JsTable<F extends Fields = Fields> implements Table<F> {
  readonly schema: Schema<F>;
  readonly backend: Backend = jsBackend;
  readonly rowCount: number;
  readonly columns: readonly Column[];

  constructor(schema: Schema<F>, columns: readonly Column[], rowCount: number) {
    // Purpose: hold checked columns for one schema
    this.schema = schema;
    this.columns = columns;
    this.rowCount = rowCount;
  }
}

export function table<F extends Fields>(
  schema: Schema<F>,
  data: readonly RowInput<F>[] | ColumnInput<F>,
): JsTable<F> {
  // Purpose: create a JS-backend table from row objects or from one array per column
  if (Array.isArray(data)) return new JsTable(schema, loadRows(schema, data), data.length);
  const input = data as ColumnInput<F>;
  if (input === null || typeof input !== 'object' || typeof input.columns !== 'object' || input.columns === null) {
    throw new SchemaError('table(): expected an array of rows or { columns: { name: array } }');
  }
  const loaded = loadColumns(schema, input.columns);
  return new JsTable(schema, loaded.columns, loaded.rowCount);
}
