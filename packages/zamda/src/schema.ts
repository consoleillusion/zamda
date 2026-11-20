import { SchemaError } from './errors';
import type { DataType, JsOf } from './types';
import { sameType } from './types';

export type Fields = Record<string, DataType>;

export interface Field {
  readonly name: string;
  readonly type: DataType;
}

export interface Schema<F extends Fields = Fields> {
  // Field map, used for TypeScript inference.
  readonly fields: F;
  // The same fields in declaration order, used at runtime.
  readonly list: readonly Field[];
}

// The row object type for a schema. Every column is nullable.
export type RowOf<F extends Fields> = { [K in keyof F]: JsOf<F[K]> | null };

export function schema<F extends Fields>(fields: F): Schema<F> {
  // Purpose: declare a table schema from a map of column name to data type
  const list = Object.entries(fields).map(function ([name, type]) {
    return { name, type };
  });
  if (list.length === 0) throw new SchemaError('A schema needs at least one column');
  return Object.freeze({ fields, list: Object.freeze(list) });
}

export function schemaFromList(list: readonly Field[]): Schema {
  // Purpose: build a runtime schema from an ordered field list (internal)
  const fields: Record<string, DataType> = {};
  for (const field of list) {
    if (field.name in fields) throw new SchemaError(`Duplicate column name "${field.name}"`);
    fields[field.name] = field.type;
  }
  return Object.freeze({ fields, list: Object.freeze([...list]) });
}

export function checkCompatible(expected: readonly Field[], actual: readonly Field[]): void {
  // Purpose: raise SchemaError unless a table's schema matches the plan's input
  if (expected.length !== actual.length) {
    throw new SchemaError(
      `Plan expects ${expected.length} columns but the table has ${actual.length}`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!;
    const got = actual[i]!;
    if (want.name !== got.name || !sameType(want.type, got.type)) {
      throw new SchemaError(
        `Column ${i}: plan expects "${want.name}" (${want.type.name}) ` +
          `but the table has "${got.name}" (${got.type.name})`,
      );
    }
  }
}
