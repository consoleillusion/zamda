// The JS backend: tables held as typed arrays in the page, executed by the
// reference executor. It needs no WASM and is the default backend.

import type { Backend, BackendOptions, ResultData, Table } from '../../backend';
import type { Column } from '../../column';
import { PlanError } from '../../errors';
import type { IrPlan } from '../../ir';
import type { Fields, RowOf, Schema } from '../../schema';
import { executeJs } from './exec';
import { loadRows } from './load';

// A row as accepted by table(): a missing property means null.
export type RowInput<F extends Fields> = Partial<RowOf<F>>;

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

export function table<F extends Fields>(schema: Schema<F>, rows: readonly RowInput<F>[]): JsTable<F> {
  // Purpose: create a JS-backend table from row objects, validating every value
  return new JsTable(schema, loadRows(schema, rows), rows.length);
}
