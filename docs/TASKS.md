# Tasks

Work packages, sized so one agent can finish one in a single session. Read
`AGENTS.md` first. Take a task only when everything in its "Needs" column is done.

**Status values:** `done`, `ready`, `blocked` (needs unfinished), `in progress (name)`.

Every task's acceptance implicitly includes: `bun run check` passes, the
relevant `test.todo` entries are now real passing tests, and the status columns
in this file and `docs/CONTRACT.md` are updated.

## Milestone 1: Core

Complete. Gate review: `docs/MILESTONE-1.md`.

| ID | Task | Status |
| --- | --- | --- |
| T-101 | Scaffold and first slice: schema, DSL, IR, validator, `filter`/`select`/`limit` | done |
| T-102 | Numeric promotion and `cast` | done |
| T-103 | Aggregate operator, plus the first benchmark | done |
| T-104 | Sort operator and top-k | done |
| T-105 | String functions | done |
| T-106 | Remaining arithmetic | done |
| T-107 | Dictionary-encoded storage | done |
| T-108 | `date32` and `timestamp` | done |
| T-109 | Remaining DSL surface: `isIn`, `coalesce`, `ifElse`, `bin`, `distinct`, `withColumns`, `rename`, keyless `agg` | done |
| T-110 | Typed parameters | done |
| T-111 | Column input for `table()` | done |
| T-113 | Selection vectors: stop copying columns in `filter` | done |
| T-114 | Faster row loading | done; 1.4x to 1.6x Arquero against a 1.5x target |
| T-112 | Milestone 1 gate review | done |

## Milestone 2: JS release

All ready: Milestone 1 is complete. T-201 and T-203 touch `src/backends/js/exec.ts`
and `src/optimize.ts` respectively and can run in parallel; T-205 and T-208 are independent.

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
| T-210 | Measure the reference queries in Chrome and Firefox, not only Bun | T-207 |
| T-211 | Allow `utf8` and `dictionary` expressions to be mixed in one operation | T-112 |

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
