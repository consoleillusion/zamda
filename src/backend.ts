// The backend interface: the only seam between the core (DSL, IR, contract)
// and an execution engine. A backend receives a validated IrPlan and a table it
// owns, and returns columns. It must produce exactly the results the contract
// defines; it may never fall back to different semantics.

import type { Column } from './column';
import type { IrPlan, LiteralValue } from './ir';
import type { Field, Fields, Schema } from './schema';

export interface Table<F extends Fields = Fields> {
  readonly schema: Schema<F>;
  readonly backend: Backend;
  readonly rowCount: number;
}

export interface BackendOptions {
  // Parameter values, already type-checked against the plan.
  // A list parameter's value is an array.
  readonly params: ReadonlyMap<string, LiteralValue | readonly LiteralValue[]>;
  readonly signal?: AbortSignal;
}

export interface ResultData {
  readonly schema: readonly Field[];
  readonly columns: readonly Column[];
  readonly rowCount: number;
}

export interface Backend {
  readonly name: string;
  // Rejects with PlanError if the table is not this backend's, or the plan
  // uses something the backend does not implement yet.
  execute(plan: IrPlan, table: Table, options: BackendOptions): Promise<ResultData>;
}
