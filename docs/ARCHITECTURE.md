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
| `src/promotion.ts` | Generated numeric promotion table (C-PROMOTION) | nothing |
| `src/convert.ts` | One JS value to its stored form, with every schema check | types |
| `src/errors.ts` | Error classes | nothing |
| `src/schema.ts` | `schema()`, `RowOf`, schema compatibility | types, errors |
| `src/ir.ts` | IR type definitions and walkers | schema, types |
| `src/registry.ts` | Function definitions: type rule, nulls, Substrait name | types, errors |
| `src/expr.ts` | Expression classes, `lit`, `ifElse`, `count`, promotion | ir, registry, promotion, convert, types, errors |
| `src/pipe.ts` | `Pipeline`, `Grouped`, accessor proxy, misuse guards | expr, ir, schema, optimize, validate, plan |
| `src/optimize.ts` | IR-to-IR passes | ir |
| `src/validate.ts` | The IR validator | ir, registry, schema, types, errors |
| `src/column.ts` | JS-side column storage | types, errors |
| `src/backend.ts` | `Backend`, `Table`, `ResultData` interfaces | column, ir, schema |
| `src/plan.ts` | `Plan.execute`, `explain` | backend, expr, ir, result, schema |
| `src/result.ts` | `Result` | backend, column, schema |
| `src/latest.ts` | `latest()`: a new run aborts the previous one | plan (types only) |
| `src/keyed.ts` | `KeyedTable`: keyed live tables over any backend (C-LIVE-KEY) | backend, schema, types, errors |
| `src/ir-binary.ts` | Binary IR encoder and decoder for the engine (docs/IR-BINARY.md) | ir, types, errors |
| `src/substrait.ts` | Substrait export and import, pinned to 0.108.0 (docs/SUBSTRAIT.md); not exported yet | ir, registry, types |
| `src/backends/js/` | JS reference executor | core modules only |
| `src/backends/wasm/` | WASM backend: engine host, tables in engine memory, worker link, failure model | core modules, and `backends/js` (see below) |
| `src/index.ts` | Public API (`zamda`) | everything except `backends/wasm` |
| `src/wasm.ts` | Public API (`zamda/wasm`): `wasmEngine()` | `backends/wasm` |

### Dependency rules

- Core modules never import from `src/backends/`. Only `src/index.ts` does.
- A backend imports core modules only, with one exception: the WASM backend uses
  the JS executor as its oracle for string lookups (D-066) and for plans the
  engine does not support yet (D-067). The JS backend never imports the WASM one.
- `src/index.ts` must not pull in WASM. The WASM backend has its own entry
  point, `src/wasm.ts` (`zamda/wasm`), so a JS-only install stays small.

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
4. Add a kernel in the matching `src/backends/js/kernels-<group>.ts`.
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

- `index.ts` holds `JsTable`: a list of immutable segments, one per `append`,
  plus the optional retain window. A run captures the segment list at its start.
- `load.ts` turns rows, or one array per column, into checked columns.
- A column is a typed array (or `string[]`) plus an optional validity array with
  one byte per row. A dictionary column is integer codes plus a list of unique strings.
- `kernels.ts` holds comparison and logic and assembles the kernel table;
  `kernels-arith.ts`, `kernels-string.ts`, `kernels-time.ts` and `kernels-misc.ts`
  hold the rest. Each kernel operates on whole columns.
- `sort.ts` sorts row indexes with a total-order comparator, and does top-k with a heap.
- `aggregate.ts` is the hash group-by: assign group ids in first-occurrence
  order, then one loop per aggregate.
- `exec.ts` runs a plan as a generator in resumable steps. It cuts the node
  chain into phases at the blocking operators and reads each phase's source in
  64k-row chunks:

  ```
  table segments --chunks--> [filter | project | limit]* --> aggregate
        --chunks--> [filter | project | limit]* --> sort
        --chunks--> [filter | project | limit]* --> result
  ```

  The driver resumes the generator until about 8 ms have passed, then returns to
  the event loop and checks the abort signal.
- `filter` and `sort` output a selection of row indexes over their input, and
  columns nothing reads are never copied.
- `aggregate.ts` keeps its group table, accumulators and key values across
  chunks. Dictionary codes are mapped onto one canonical dictionary per key,
  because chunks computed separately have separate dictionaries.
- `sort.ts` sorts row indexes: integer and boolean keys by a stable radix sort, anything else by native-sorted runs merged in bounded steps; a small limit uses a heap. Every step yields so a sort can be paused or aborted.

## The demos (not part of the package)

`bun run demo` serves `atlas/` (the AS-topology view, T-513); `bun run demo:legacy` serves
`demo/`, the four-chart dashboard of the spec plus the later graph and race panels:

```
demo/server.ts     Bun.serve: bundles index.html and serves data/routes.bin and data/graph.bin
demo/index.html    page layout; demo/style.css
demo/dashboard.ts  the linked charts' plans, parameters and selection logic (tested)
demo/live.ts       RIS Live parsing, the live table and its plans, simulated feed (tested)
demo/charts.ts     SVG drawing: bars, brushable histogram, region toggles, activity
demo/graph-data.ts graph plans and the pure row-to-view conversion (tested)
demo/graph-view.ts graphology + sigma WebGL renderer on frozen positions, synced world map
demo/world-map.ts  committed, simplified Natural Earth land rings for the map layer
demo/graph-panel.ts graph file loading, view controls and the browser probe
demo/main.ts       wiring: load, run charts through latest(), feed the live panel
```

## Benchmarks (bench/, not part of the package)

```
bench/groupby.ts          the original group-by benchmark (plain JS, Arquero, zamda)
bench/reference/data.ts   routes file -> sampled columns and row objects -> zamda and Arquero tables
bench/reference/queries.ts the reference queries once, per engine: exec (timed) and summary (checked)
bench/reference/run.ts    checks, times and writes bench/results/<name>.{json,md}
bench/reference/measure.ts timing helpers with no Node imports, so a browser can use them
bench/reference/compare.ts the runtime comparison: queries and dashboard interactions, with and without slicing
bench/reference/compare-bun.ts and browser/   run compare.ts under Bun, or in a page served by Bun
```

## Scripts (not part of the package)

```
scripts/size.ts           size gate for `bun run size`
scripts/prep-bgp.ts       builds data/routes.bin and data/graph.bin from a RIPE RIS dump and registry data
scripts/inspect-routes.ts runs the dashboard queries on data/routes.bin
scripts/fake-routes.ts    writes a synthetic data/routes.bin for offline use
scripts/check-dump.ts     re-reads a dump with random splits; all passes must agree
scripts/bgp/mrt.ts        streaming MRT (RFC 6396) reader: TABLE_DUMP_V2 IPv4 RIBs and AS_PATH
scripts/bgp/routes.ts     one route per prefix (shortest path, lowest peer)
scripts/bgp/graph.ts      one weighted AS-adjacency graph from the same chosen routes
scripts/bgp/graph-file.ts the graph file format (ZGR4), country-centred positions and its loader
scripts/bgp/registry.ts   asn.txt names/countries, NRO delegation stats and country centroids
scripts/bgp/file.ts       the routes file format and its loader into a zamda table
```

## The WASM backend

```
engine/                   Rust, no dependencies: binary IR decoder and validator, table store,
                          expression kernels, executor (filter, project, limit, aggregate, sort),
                          sessions, counting allocator with a byte limit; C-ABI `zs_*` exports
src/backends/wasm/load.ts    instantiate the module and wrap its exports (EngineRunHost)
src/backends/wasm/index.ts   the in-thread Backend: plans to bytes, string ids and lookups, time slices
src/backends/wasm/managed.ts the failure model: traps replace the module, tables reload or are lost
src/backends/wasm/worker-*   the worker host: messages, transfer, abort, the stall backstop
src/wasm.ts               `wasmEngine()`, the public entry
spike/                    Throwaway spike code; never imported by src/
```

`bun run build` emits `dist/index.js`, `dist/wasm.js`, `dist/zamda-worker.js` and keeps
`dist/zamda-engine.wasm` from `bun run wasm:build` (`bun run build:all` does both).

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
| Golden | `tests/golden/` | One block per contract rule; each plan runs at several chunk sizes and must give identical results; runs on every backend |
| Slice | `tests/slice.test.ts` | End-to-end API behaviour and guards |
| Execution | `tests/execution.test.ts` | Yielding, cancellation, progress, early termination, `latest()` |
| Types | `tests/types/inference.ts` | TypeScript inference, checked by `tsc` |
| Registry | `tests/registry.test.ts` | Structural rules on the function registry |
| Cross-backend property tests | `tests/engine-*.test.ts`, `tests/wasm-*.test.ts` | Random plans and expressions must match the JS backend; the golden suite runs on both |
