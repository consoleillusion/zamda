# Tasks

Work packages, sized so one agent can finish one in a single session. Read
`AGENTS.md` first. Take a task only when everything in its "Needs" column is done.

**Status values:** `done`, `ready`, `blocked` (needs unfinished), `in progress (name)`.

Every task's acceptance implicitly includes: `bun run check` passes, the
relevant `test.todo` entries are now real passing tests, and the status columns
in this file and `docs/CONTRACT.md` are updated.

## Milestone 1: Core

| ID | Task | Needs | Status |
| --- | --- | --- | --- |
| T-101 | Scaffold and first slice: schema, DSL, IR, validator, `filter`/`select`/`limit` on the JS backend | | done |
| T-102 | Numeric promotion and `cast` | | ready |
| T-103 | Aggregate operator on the JS backend | | ready |
| T-104 | Sort operator and top-k on the JS backend | | ready |
| T-105 | String functions | | ready |
| T-106 | Remaining arithmetic | T-102 | blocked |
| T-107 | Dictionary-encoded storage | T-103 | blocked |
| T-108 | `date32` and `timestamp` | | ready |
| T-109 | Remaining DSL surface | T-102 | blocked |
| T-110 | Typed parameters | | ready |
| T-111 | Column input for `table()` | | ready |
| T-112 | Milestone 1 gate review | all above | blocked |

T-102, T-103, T-104, T-105, T-108, T-110 and T-111 can run in parallel. They
share the hot files listed in `AGENTS.md`; follow the rules there.

### T-102 Numeric promotion and `cast`

- **Goal:** implement C-PROMOTION. Binary numeric operations accept different
  numeric types and widen; `cast(type)` converts explicitly.
- **Files:** `src/registry.ts` (type rules), `src/expr.ts` (operand types,
  `cast` method, a type-level `Promote<A, B>`), `src/backends/js/kernels-cast.ts`
  (new), `tests/golden/`, `tests/types/inference.ts`.
- **Design notes:** promotion is resolved in the DSL by inserting `cast` calls,
  so kernels keep receiving same-typed operands. A cast that loses information
  (float to int out of range, negative to unsigned) raises `ExecutionError`.
- **Acceptance:** the C-PROMOTION todos pass; `c.int8col.add(c.int32col)` infers
  `number` and executes; `int64` with `uint64` is a compile-time and runtime error.

### T-103 Aggregate operator on the JS backend

- **Goal:** execute `aggregate` nodes: hash group-by with `count`, `sum`, `avg`,
  `min`, `max`, and add `countDistinct`.
- **Files:** `src/backends/js/aggregate.ts` (new), `src/backends/js/exec.ts`
  (replace the `PlanError` stub), `src/registry.ts` and `src/expr.ts` for
  `countDistinct`, `tests/golden/`.
- **Design notes:** key rows by an encoded key tuple in a `Map`; output groups
  in first-occurrence order (C-GROUP-ORDER). Null keys form one group. NaN keys
  form one group and `-0.0` joins `0.0` (C-NAN-ORDER). Float sums use Neumaier in
  row order (C-FLOAT-SUM). Integer sums are checked against `int64`/`uint64`
  (C-OVERFLOW). A plan with no keys yields exactly one row (C-EMPTY-AGG).
- **Acceptance:** all C-GROUP-ORDER, C-AGG-TYPES, C-FLOAT-SUM, C-EMPTY-AGG todos
  and the grouping todo in C-NAN-ORDER pass; the "not implemented" slice test is
  updated to expect real results.

### T-104 Sort operator and top-k on the JS backend

- **Goal:** execute `sort` nodes; when a `limit` directly follows a `sort`, use
  a bounded top-k and keep results identical.
- **Files:** `src/backends/js/sort.ts` (new), `src/backends/js/exec.ts`,
  `tests/golden/`.
- **Design notes:** sort an index array with a comparator built from the keys;
  break ties by row index so the sort is stable on every JS engine
  (C-SORT-STABLE). Nulls last unless `nullsFirst` (C-NULL-SORT). NaN after all
  numbers (C-NAN-ORDER). Strings use `compareStrings` from `kernels.ts`
  (C-STR-ORDER).
- **Acceptance:** all C-NULL-SORT and C-SORT-STABLE todos and the sorting todo
  in C-NAN-ORDER pass; a test shows `sort().limit(k)` equals a full sort then limit.

### T-105 String functions

- **Goal:** `lower`, `upper`, `length`, `startsWith`, `endsWith`, `contains`
  (literal match, no regular expressions).
- **Files:** `src/registry.ts`, `src/expr.ts` (`StrExpr`),
  `src/backends/js/kernels-string.ts` (new), `tests/golden/`.
- **Acceptance:** C-STR-LENGTH and C-STR-CASE todos pass; `length('\u{1F600}')` is 1.

### T-106 Remaining arithmetic

- **Goal:** `div`, `intDiv`, `mod`, `neg`, `abs`, `floor`, `ceil`, `round`,
  `isNaN`, and explicit `wrappingAdd`/`wrappingSub`/`wrappingMul`.
- **Files:** `src/registry.ts`, `src/expr.ts` (`NumExpr`),
  `src/backends/js/kernels-arith.ts` (new), `tests/golden/`.
- **Acceptance:** C-DIV todos pass; `neg` and `abs` of the minimum signed value
  raise `ExecutionError`.

### T-107 Dictionary-encoded storage

- **Goal:** store `dictionary` columns as `Int32Array` codes plus a string
  dictionary; run equality and group-by on codes.
- **Files:** `src/column.ts`, `src/backends/js/load.ts`, kernels and
  `aggregate.ts` where they read strings.
- **Acceptance:** results are identical to `utf8` for every golden test, run
  with both types; a benchmark note shows group-by on a dictionary key is faster.

### T-108 `date32` and `timestamp`

- **Goal:** load, store, compare and output dates and timestamps; add
  `dateTrunc(unit)` and `extract(unit)`.
- **Files:** `src/types.ts` (timestamp unit), `src/column.ts`,
  `src/backends/js/load.ts`, `src/expr.ts`, `src/result.ts`,
  `src/backends/js/kernels-time.ts` (new), `docs/CONTRACT.md` (propose the rules
  first: storage unit, time zone handling, JS `Date` conversion).
- **Acceptance:** the proposed rules are agreed and pinned by golden tests.

### T-109 Remaining DSL surface

- **Goal:** `isIn` (literal list and list parameter), `coalesce`, `ifElse`,
  `bin(width, origin)` as sugar, `distinct()`, `withColumns()`, `rename()`.
- **Files:** `src/expr.ts`, `src/pipe.ts`, `src/registry.ts`, kernels,
  `tests/`.
- **Acceptance:** each has golden and type tests; `distinct()` lowers to an
  `aggregate` node with every column as a key.

### T-110 Typed parameters

- **Goal:** `Plan` carries the parameter object type, so
  `execute(table, { params })` is checked by TypeScript.
- **Files:** `src/expr.ts`, `src/pipe.ts`, `src/plan.ts`, `tests/types/inference.ts`.
- **Design notes:** thread a third type parameter through `Pipeline` that
  accumulates `{ name: JsType }` from `param()` calls. If inference proves too
  costly, propose an explicit `params` declaration on `pipe()` instead.
- **Acceptance:** a missing or wrongly typed parameter is a compile-time error.

### T-111 Column input for `table()`

- **Goal:** `table(schema, { columns })` accepts typed arrays without copying
  where the array type already matches.
- **Files:** `src/backends/js/index.ts`, `src/backends/js/load.ts`, `tests/`.
- **Acceptance:** wrong array type or length raises `SchemaError`.

### T-112 Milestone 1 gate review

- **Goal:** confirm the gate in `docs/ROADMAP.md`. No `test.todo` remains for
  Milestone 1 rules; every contract rule is `pinned`; size is within budget.
- **Acceptance:** a short written report; the roadmap's "Current position" updated.

## Milestone 2: JS release

All blocked until T-112.

| ID | Task | Needs |
| --- | --- | --- |
| T-201 | Chunked, resumable execution: `step()` per 64k-row chunk, yield about every 8 ms, abort within one time slice, progress callback | T-112 |
| T-202 | `latest(plan)` helper: a new run aborts the one in flight | T-201 |
| T-203 | Optimizer passes: constant folding, filter and project fusion, projection pushdown, limit pushdown; golden suite runs with passes on and off | T-112 |
| T-204 | Append-only live tables: `table.append(rows)`, rolling `retain` window, a run sees the table as of its start | T-201 |
| T-205 | `scripts/prep-bgp.ts`: download one RouteViews snapshot and write rows matching the reference schema | T-112 |
| T-206 | Reference dashboard under `demo/`: four linked charts, controls as parameters, live panel on RIPE RIS Live | T-202, T-204, T-205 |
| T-207 | Benchmark harness under `bench/`: JS executor vs Arquero on the reference queries; publish results | T-205 |
| T-208 | ESLint rule flagging `&&`, `\|\|`, `!` and `===` in accessor callbacks; API reference docs | T-112 |
| T-209 | Build and publish: ESM output with `.d.ts`, npm alpha | T-206, T-208 |

## Spike

| ID | Task | Needs |
| --- | --- | --- |
| S-301 | Under `spike/`: Rust/WASM prototypes of group-by and sort using arrow-rs kernels and, separately, DataFusion. Measure against the spike gate in `docs/ROADMAP.md`, with JS row loading included. Deliver a decision memo. Throwaway code. | T-207 |

## Milestone 3: WASM engine

Broken into tasks after the spike passes. Expected areas: binary IR encoding,
Rust validator, kernels, worker host, row loader, memory budget, failure model,
cross-backend property tests.

## Later

| ID | Task |
| --- | --- |
| T-501 | Substrait export and import; verify the registry's Substrait names against a pinned spec version |
| T-502 | Keyed live tables |
| T-503 | Joins, then window functions |
