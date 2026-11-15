# Architecture

zamda has one idea: **describe once, run anywhere.** A pipeline is compiled to an
IR; any backend that honours the contract can execute it.

## Layers

```
 user code
    |
    v
+------------------------------------------------------------------+
| DSL            schema.ts  types.ts  expr.ts  pipe.ts             |
|                builds typed expressions; type-checks eagerly      |
+------------------------------------------------------------------+
    | Pipeline.compile()
    v
+------------------------------------------------------------------+
| COMPILER       optimize.ts  ->  validate.ts                      |
|                IR-to-IR passes, then one validator                |
+------------------------------------------------------------------+
    | IrPlan (ir.ts): flat node table, fields by index
    v
+------------------------------------------------------------------+
| PLAN           plan.ts   checks schema + params, picks backend    |
+------------------------------------------------------------------+
    | Backend.execute(plan, table, options)        (backend.ts)
    v
+---------------------+  +----------------------+  +---------------+
| JS backend          |  | WASM backend         |  | Substrait     |
| backends/js/        |  | backends/wasm/       |  | export        |
| typed arrays        |  | Rust engine, worker  |  | (after MVP)   |
| ships first; oracle |  | Milestone 3, if the  |  |               |
|                     |  | spike passes         |  |               |
+---------------------+  +----------------------+  +---------------+
    | ResultData: columns (column.ts)
    v
+------------------------------------------------------------------+
| RESULT         result.ts   toArray(), columns(), column()         |
+------------------------------------------------------------------+

 Across all layers: registry.ts (functions), errors.ts, docs/CONTRACT.md
```

## Life of a query

1. `schema({...})` declares column names and types. TypeScript infers row types from it.
2. `pipe(schema)` starts a `Pipeline`. Each method (`filter`, `select`, ...) calls
   the user's callback **once** with a proxy of typed column expressions. The
   callback builds an expression tree; it never sees data.
3. Each expression method looks its function up in the **registry**, which
   checks operand types and returns the result type. A type mistake throws
   `TypeCheckError` at the line that made it.
4. `compile()` assembles the nodes into an `IrPlan`, runs the optimizer passes,
   then the validator, and returns a reusable `Plan`.
5. `plan.execute(table)` checks the table's schema and the parameters, then
   hands the IR to the backend that owns the table.
6. The backend returns columns. `Result` exposes them as rows or columns.

## Module map

| Module | Responsibility | May import |
| --- | --- | --- |
| `src/types.ts` | Data types, `t`, ranges, type predicates | nothing |
| `src/errors.ts` | Error classes | nothing |
| `src/schema.ts` | `schema()`, `RowOf`, schema compatibility | types, errors |
| `src/ir.ts` | IR type definitions and walkers | schema, types |
| `src/registry.ts` | Function definitions: type rule, nulls, Substrait name | types, errors |
| `src/expr.ts` | Expression classes, `lit`, `param`, `count` | ir, registry, types, errors |
| `src/pipe.ts` | `Pipeline`, `Grouped`, accessor proxy, misuse guards | expr, ir, schema, optimize, validate, plan |
| `src/optimize.ts` | IR-to-IR passes | ir |
| `src/validate.ts` | The IR validator | ir, registry, schema, types, errors |
| `src/column.ts` | JS-side column storage | types, errors |
| `src/backend.ts` | `Backend`, `Table`, `ResultData` interfaces | column, ir, schema |
| `src/plan.ts` | `Plan.execute`, `explain` | backend, expr, ir, result, schema |
| `src/result.ts` | `Result` | backend, column, schema |
| `src/backends/js/` | JS reference executor | core modules only |
| `src/index.ts` | Public API | everything |

### Dependency rules

- Core modules never import from `src/backends/`. Only `src/index.ts` does.
- A backend imports core modules only. Backends never import each other.
- `src/index.ts` must not pull in WASM. The WASM backend gets its own entry
  point, `zamda/wasm`, so a JS-only install stays small.

## The IR

Defined in `src/ir.ts`; details in `docs/IR.md`.

- A plan is a flat array of nodes. Node 0 is always `scan`. Every other node
  names its input by index, and the index is always lower than its own.
- Each node carries its output schema.
- Expressions refer to columns by index into the input node's schema. Names are
  resolved in the DSL; the IR and the backends never look names up.
- Every node and function maps 1:1 to Substrait.

## The backend contract

A backend implements `Backend` from `src/backend.ts`:

```ts
interface Backend {
  readonly name: string;
  execute(plan: IrPlan, table: Table, options: BackendOptions): Promise<ResultData>;
}
```

A backend must:

- produce exactly the results `docs/CONTRACT.md` defines, bit for bit;
- raise `PlanError` for anything it does not implement, never approximate;
- leave the table unchanged, including after an abort;
- pass the entire golden suite in `tests/golden/`.

## Extending zamda

### Add a function

1. Check `docs/CONTRACT.md` defines its behaviour; propose a rule if not.
2. Add a `FunctionDef` to `src/registry.ts`: type rule, null behaviour, Substrait name.
3. Add the DSL method to the right class in `src/expr.ts`.
4. Add a kernel in `src/backends/js/` and register it in `kernels.ts`.
5. Add golden tests, and a type test in `tests/types/inference.ts`.

`tests/registry.test.ts` fails if a registered scalar has no JS kernel or no
Substrait mapping.

### Add an operator

1. Add the node variant to `IrNode` in `src/ir.ts` and to `nodeExprs`.
2. Add checks in `src/validate.ts` and rendering in `formatNode` in `src/plan.ts`.
3. Add the builder method in `src/pipe.ts`.
4. Implement it in `src/backends/js/exec.ts`.
5. Record the Substrait relation it maps to in `docs/IR.md`.

### Add a backend

1. Create `src/backends/<name>/` with a `Table` implementation and a `Backend`.
2. Add its name to `backends` in `tests/golden/helpers.ts` so the golden suite
   runs against it.
3. Give it its own package entry point.

## JS backend internals

- `load.ts` turns rows into checked columns.
- A column is a typed array (or `string[]`) plus an optional validity array with
  one byte per row.
- `kernels.ts` holds one function per registry entry, operating on whole columns.
- `exec.ts` walks the node table. Today each node processes the whole table as
  one batch; Milestone 2 makes it chunked and resumable (task T-201).

## Planned layout for the WASM backend

Not built until the spike passes (see `docs/ROADMAP.md`).

```
crates/zamda-engine/      Rust: IR decoder, validator, kernels, executor
src/backends/wasm/        TS: worker host, loader, Backend implementation
spike/                    Throwaway spike code; never imported by src/
```

## Errors

| Class | Raised when |
| --- | --- |
| `SchemaError` | A table or row does not match its schema |
| `TypeCheckError` | An expression combines types the contract does not allow |
| `ExpressionError` | The DSL is misused, for example with `&&` or `>` |
| `PlanError` | A plan is invalid, or a backend cannot run it |
| `ExecutionError` | A contract-defined runtime failure, such as overflow |
| `AbortError` | A run was cancelled |
| `MemoryError`, `HandleError` | Reserved for the WASM backend |

## Testing strategy

| Kind | Where | Purpose |
| --- | --- | --- |
| Golden | `tests/golden/` | One block per contract rule; runs on every backend |
| Slice | `tests/slice.test.ts` | End-to-end API behaviour and guards |
| Types | `tests/types/inference.ts` | TypeScript inference, checked by `tsc` |
| Registry | `tests/registry.test.ts` | Structural rules on the function registry |
| Cross-backend property tests | later, with the WASM backend | Random plans must match the JS backend |
