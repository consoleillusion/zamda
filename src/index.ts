// Public API of the zamda core. This entry point must stay free of WASM and
// within the size budget checked by `bun run size`.

export { t } from './types';
export type { DataType, JsOf, TypeName } from './types';

export { schema } from './schema';
export type { Field, Fields, RowOf, Schema } from './schema';

export { list, pipe } from './pipe';
export type { Cols, FieldsOf, Grouped, ListDecl, NoParams, ParamDecls, ParamExprs, ParamValues, Pipeline } from './pipe';

export { count, ifElse, lit } from './expr';
export type {
  AggExpr,
  BoolExpr,
  DateUnit,
  Expr,
  ExprFor,
  ListParam,
  NumExpr,
  OrdExpr,
  SortKey,
  StrExpr,
  TimeExpr,
  TimeUnit,
} from './expr';

export { Plan } from './plan';
export type { ExecuteArgs, ExecuteOptions } from './plan';

export { latest } from './latest';
export type { LatestRun } from './latest';

export { Result } from './result';
export type { ColumnValues } from './column';

export { table, keyedTable } from './backends/js';
export type { ColumnInput, DictionaryInput, JsTable, RowInput, TableInput, TableOptions } from './backends/js';

export { KeyedTable } from './keyed';
export type { Key, KeyComponent, KeyedTableFactory, KeyFields } from './keyed';

export type { Backend, BackendOptions, ResultData, RunSession, Table } from './backend';
export type {
  IrAggregate,
  IrExpr,
  IrNode,
  IrParam,
  IrPlan,
  IrSortKey,
  IrWindowFunction,
  JoinKind,
  WindowFnName,
} from './ir';
export { IR_VERSION } from './ir';

export {
  AbortError,
  EngineCrashError,
  ExecutionError,
  ExpressionError,
  HandleError,
  MemoryError,
  PlanError,
  SchemaError,
  TypeCheckError,
  ZamdaError,
} from './errors';
