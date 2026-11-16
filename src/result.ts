import type { ResultData } from './backend';
import type { Column, ColumnValues } from './column';
import { cells, texts } from './column';
import { SchemaError } from './errors';
import type { Fields, RowOf } from './schema';
import { MS_PER_DAY } from './types';

function outputValues(column: Column): ColumnValues {
  // Purpose: storage as handed to users: dictionary columns are decoded to strings
  return column.dictionary ? (texts(column) as string[]) : column.values;
}

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
      const values = column.dictionary ? texts(column) : cells(column);
      const kind = field.type.name;
      for (let r = 0; r < this.data.rowCount; r++) {
        const row = rows[r]!;
        if (column.valid && !column.valid[r]) row[field.name] = null;
        else if (kind === 'bool') row[field.name] = values[r] === 1;
        else if (kind === 'date32') row[field.name] = new Date((values[r] as number) * MS_PER_DAY);
        else if (kind === 'timestamp') row[field.name] = new Date(values[r] as number);
        else row[field.name] = values[r];
      }
    });
    return rows as RowOf<Out>[];
  }

  columns(): { [K in keyof Out]: ColumnValues } {
    // Purpose: column storage by name, for charting libraries; see column() for nulls.
    // Dates come back as numbers: days (date32) or milliseconds (timestamp) since the epoch.
    const out: Record<string, ColumnValues> = {};
    this.data.schema.forEach((field, c) => {
      out[field.name] = outputValues(this.data.columns[c]!);
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
    return { values: outputValues(column), valid: column.valid ?? undefined };
  }
}
