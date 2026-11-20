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
  // Rows per chunk; a backend may ignore it. Default 65,536.
  readonly chunkRows?: number;
  // How long to work before returning to the event loop, in milliseconds. Default 8.
  readonly sliceMs?: number;
  // Called between time slices and once at the end.
  readonly onProgress?: (progress: { rowsScanned: number; rowsTotal: number }) => void;
  // An opaque handle grouping runs that share work; only the backend that made it understands it, the rest ignore it.
  readonly session?: RunSession;
  // Extra tables bound by the plan, ordered by the extra scan nodes in the IR.
  // D-076: a join binds its right table at compile time; the plan executes on
  // the snapshot each table had when the run started (C-JOIN, C-LIVE).
  readonly sources?: readonly Table[];
}

export interface ResultData {
  readonly schema: readonly Field[];
  readonly columns: readonly Column[];
  readonly rowCount: number;
}

// A group of runs a backend lets share work (the zamda/wasm backend: one dashboard interaction
// shares the filter pass between its charts, T-416). A backend that does not define sessions
// ignores the option. A session is single-use: closing it drops whatever it holds, and using it
// afterwards is an error. Opaque to everyone but the backend that made it.
export interface RunSession {
  readonly kind: string;
}

export interface Backend {
  readonly name: string;
  // Rejects with PlanError if the table is not this backend's, or the plan
  // uses something the backend does not implement yet.
  execute(plan: IrPlan, table: Table, options: BackendOptions): Promise<ResultData>;
  // Optional wrapper support (C-LIVE-KEY). unwrap() gives back the backend's own
  // table from a wrapper such as a KeyedTable. retain() and release() bracket
  // one execute call, so a wrapper can keep the table a run started on alive
  // until that run is over even if a mutation replaces it meanwhile. A backend
  // with no wrappers leaves all three out; ordinary tables are unaffected.
  unwrap?(table: Table): Table;
  retain?(table: Table): void;
  release?(table: Table): void;
}
