import type { ResultData } from './backend';
import type { ColumnValues } from './column';
import { cells } from './column';
import { SchemaError } from './errors';
import type { Fields, RowOf } from './schema';

export class Result<Out extends Fields> {
  private readonly data: ResultData;

  constructor(data: ResultData) {
    // Purpose: wrap the columns a backend returned
    this.data = data;
  }

  get rowCount(): number {
    // Purpose: number of rows in the result
    return this.data.rowCount;
  }

  toArray(): RowOf<Out>[] {
    // Purpose: convert to an array of typed row objects, with null for missing values
    const rows: Record<string, unknown>[] = [];
    for (let r = 0; r < this.data.rowCount; r++) rows.push({});
    this.data.schema.forEach((field, c) => {
      const column = this.data.columns[c]!;
      const values = cells(column);
      const isBool = field.type.name === 'bool';
      for (let r = 0; r < this.data.rowCount; r++) {
        if (column.valid && !column.valid[r]) rows[r]![field.name] = null;
        else rows[r]![field.name] = isBool ? values[r] === 1 : values[r];
      }
    });
    return rows as RowOf<Out>[];
  }

  columns(): { [K in keyof Out]: ColumnValues } {
    // Purpose: raw column storage by name, for charting libraries; see column() for nulls
    const out: Record<string, ColumnValues> = {};
    this.data.schema.forEach((field, c) => {
      out[field.name] = this.data.columns[c]!.values;
    });
    return out as { [K in keyof Out]: ColumnValues };
  }

  column(name: keyof Out & string): { values: ColumnValues; valid: Uint8Array | undefined } {
    // Purpose: one column's values plus its validity array, if any value is null
    const c = this.data.schema.findIndex(function (field) {
      return field.name === name;
    });
    if (c === -1) throw new SchemaError(`The result has no column "${name}"`);
    const column = this.data.columns[c]!;
    return { values: column.values, valid: column.valid ?? undefined };
  }
}
