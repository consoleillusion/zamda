# Tasks

Work packages, sized so one agent can finish one in a single session. Read
`AGENTS.md` first. Take a task only when everything in its "Needs" column is done.

**IDs.** The prefix says where a task sits: `T-1xx` Milestone 1, `T-2xx`
Milestone 2, `S-3xx` the spike, `T-4xx` Milestone 3, `T-5xx` later work. Numbers are given out in the
order tasks are written down, not by priority, and are never reused, so there are
gaps. The owner can reorder tasks freely; the "Needs" column is what is binding.

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

T-201, T-202, T-204 to T-207, T-215 to T-218 and T-221 to T-224 are done. Ready now: T-208 and T-203. The spike (S-301) is done and the gate is met.
T-215 needs someone with network access to RIPE. T-203 changes `src/optimize.ts`; the rest are independent.

| ID | Task | Needs |
| --- | --- | --- |
| T-201 | Chunked, resumable execution: 64k-row chunks, yield about every 8 ms, abort within one time slice, progress callback. **Done.** | T-112 |
| T-202 | `latest(plan)` helper: a new run aborts the one in flight. **Done.** | T-201 |
| T-203 (done) | Optimizer passes: constant folding, filter and project fusion, projection pushdown, limit pushdown; golden suite runs with passes on and off | T-112 |
| T-204 | Append-only live tables: `table.append(rows)`, rolling `retain` window, a run sees the table as of its start. **Done.** | T-201 |
| T-205 | `scripts/prep-bgp.ts`: download one RIPE RIS snapshot and write the routes file matching the reference schema. **Done; not yet run against a real dump.** | T-112 |
| T-206 | Reference dashboard under `demo/`: four linked charts, controls as parameters, live panel on RIPE RIS Live. **Done** (`bun run demo`); checked in headless Chrome on synthetic data with the simulated feed, not yet on real data or the real feed. | T-202, T-204, T-205 |
| T-207 | Benchmark harness under `bench/reference/`: seven reference queries, zamda vs Arquero at 10k, 100k and 1M rows, every answer checked against the other engine before timing, results written to `bench/results/` as JSON and markdown. **Done** (`bun run bench:ref`); sandbox results in `bench/results/sandbox.md`. | T-205 |
| T-208 (done: type-aware ESLint rule and API reference, D-073; `bun run lint` clean, `bun run check` green) | ESLint rule flagging `&&`, `\|\|`, `!` and `===` in accessor callbacks; API reference docs | T-112 |
| T-209 (build done: ESM + `.d.ts`, `bun run build`; npm alpha blocked: no npm auth here) | Build and publish: ESM output with `.d.ts`, npm alpha | T-206, T-208 |
| T-210 (done; measured in headless Chrome 156 and Firefox 158 on real RIPE data sampled to 1M rows, `bench/results/t210-browsers.md`) | Measure the reference queries in Chrome and Firefox, not only Bun (the dashboard part is T-217) | T-207 |
| T-211 (done, C-STR-MIX, D-074) | Allow `utf8` and `dictionary` expressions to be mixed in one operation | T-112 |
| T-215 | Run `bun run prep-bgp` against a real RIS dump; record row count, skipped prefixes and timings in `docs/BENCHMARKS.md`. **Done** (`docs/BENCHMARKS.md`). | T-205 |
| T-216 | The first real run stopped at ~930k prefixes with "Path attribute runs past the entry"; a second run of the same dump found no bad entries. **Closed:** `scripts/check-dump.ts` gave identical results under four different splits of the same dump, with no bad entries; the first failure was most likely damage in that one download. | T-205 |
| T-217 (done; owner's Chromium run 109 to 123 ms per chart, headless Firefox 158 measured on real data and real RIS Live, `bench/results/t217-firefox.md`) | Run `bun run demo` on a real `data/routes.bin` with the real RIS Live feed | T-206 |
| T-218 | Cut the work in one dashboard interaction. **Done:** the top-20 chart and the totals line share one per-network query (they apply identical filters), the top 20 is picked in JS, and the live panel's name table is read from the first unfiltered result instead of its own pass over every route. About 20% less work per interaction in the sandbox (161 to 124 ms, 180 to 143 ms, 117 to 94 ms). | T-206 |
| T-220 (closed: not needed; the spike gate was met and D-056 already records the shared failed-controls pass) | What is left per interaction: the per-network group-by (about 40 ms of a million rows), the distinct-network count in the regions chart (about 20 ms) and five filter passes (about 11 ms each). Ideas: share one filter pass across charts with a per-row bitmask of failing controls; cache chart results by parameter values; a cheaper distinct count for 32-bit keys. Only worth doing if the spike gate needs it | T-218 |
| T-221 | Full sort was zamda's weakest query: 87 ms for 1M rows on the owner's machine against Arquero's 31 ms, and two thirds of the spike gate's JS time. **Done as far as it goes:** the sort itself was slow (3 closure calls per comparison); integer and boolean keys now use a stable LSD radix sort (D-051), 4x faster than the comparison sort on random order and 2.5x on address-ordered data in the sandbox. On the owner's real data the full sort only went from 87 to 72 ms (`my-laptop-2.md`) and Arquero still wins it (31 ms): the real table is already in address order, which native comparison sorts exploit, and about half of what remains is gathering the sorted columns. Not worth more work now. | T-207 |
| T-223 | Why is the same dashboard work slower in Chromium than in Bun? **Done:** `bun run bench:compare` and `bun run bench:browser` run the same measurements under Bun (JavaScriptCore) and Chrome (V8). Same machine, 1M rows: not time slicing (identical with it off), but V8 is about 2x slower on the filter path (the dashboard's four charts started together: Chrome 241 to 301 ms, Bun 108 to 137 ms; the filtered query Q5: 88 against 41 ms) while plain group-bys are about equal (Q1 68 against 63 ms) and the full sort is faster in V8 (78 against 160 ms). Results in `docs/BENCHMARKS.md`. Firefox not measured. | T-207 |
| T-224 | The dashboard's four charts cost about twice what the same queries cost alone, because every chart carries all five filter controls and each was evaluated over a million rows even when switched off (the owner's real numbers, `bench/results/browser-my-laptop.md`: interaction 96 to 103 ms in Chrome, 67 to 92 ms in Firefox, against about 41 ms of single queries). **Done** (D-052): a comparison that every row answers the same way (a range covering the column's whole integer type) is now a constant, `and`/`or` skip the other side, and a constant filter keeps all rows or none without reading anything. In the sandbox the interaction fell from 241 to 125 ms (nothing selected) and 301 to 180 ms (with selections) in Chrome, and from 137 to 104 and 108 to 87 ms in Bun. Not yet measured on the owner's machine. | T-223 |
| T-222 | `table()` from columns took 172 ms at 1M rows (sandbox) when a column is a `string[]`, because every string is re-encoded into a dictionary. **Done** (D-055): `{ codes, dictionary, nullCode? }` is accepted for dictionary columns and the routes file loads through it: 172 ms down to 32 ms in the sandbox, 5 new tests (a mutation of each check is caught). Not yet measured on the owner's machine (was 42 to 45 ms). | T-207 |
| T-219 (done, C-STR-CASE) | `lower`/`upper` on a dictionary column return `utf8`, so the strings are materialised per row. Keep dictionary encoding through them (entries must be re-deduplicated: "A" and "a" both lower to "a"). The shortcut in D-045 covers the dashboard's search, so this only matters when the result is stored or grouped | T-211 |
| T-212 (done) | Sort directly over a large table copies every needed column once before sorting; sort a selection over the source instead | T-201 |

## Spike

| ID | Task | Needs |
| --- | --- | --- |
| S-301 | Under `spike/`: Rust/WASM prototypes of group-by and sort, measured against the spike gate with JS row loading included. **Done, gate met** (D-053, D-054): 4.2x Bun, 3.4x Chrome, 3.5x Firefox at 1M rows, 42.9 KB module, ahead at 100k (`bench/results/spike-my-laptop.md`). Not done and not needed for the gate: arrow-rs and DataFusion comparisons (the hand-written kernels fit the size limit by a wide margin). Throwaway code. | T-207 |
| S-302 | The dashboard on WASM, first slice (D-056): a per-row failed-controls mask and the four chart kernels, each checked against zamda's answers for two selections. **Done, target met** (D-057): on the owner's machine at 1M rows one interaction takes 16.6 ms in Chrome and 17 ms in Firefox with nothing selected (zamda JS: 61 and 58 ms), and 4.8 and 5 ms with selections (JS: 85 and 61 ms), against the 50 ms target; Bun 30 ms (`bench/results/spike-my-laptop-2.md`). The kernels are hard-coded to the dashboard's charts, so this shows the ceiling, not what a general engine will reach (T-413 measures that). | S-301 |

## Milestone 3: WASM engine

The spike met its gate (D-054) and the dashboard target (D-057). What is left is to turn
hard-coded kernels into an engine that runs any plan the JS backend runs, with the same answers
and the same errors. Code goes in a new `engine/` crate; `spike/` stays throwaway. Order of work:
the first vertical slice is T-401 (done) to T-406, T-414, T-408 and T-413 (the dashboard runs on WASM), then T-407,
T-409, T-410 and T-411. Known risk: a general expression engine will be slower than the spike's
hard-coded mask pass, so T-413 is the real test of the 50 ms target.

| ID | Task | Needs |
| --- | --- | --- |
| T-401 | Binary IR: a compact byte format for `IrPlan` (nodes, expressions, parameters, types, a version byte), with a JS encoder and decoder and `docs/IR-BINARY.md`. **Done** (D-058): `src/ir-binary.ts`; 12 tests (the dashboard's plans, every node and expression kind, literal edge cases, 1,000-value lists, all truncations, every single-bit corruption, 2,000 random inputs, bad counts and numbers, over-deep nesting); every golden test also round-trips its plan. A mutation of each decoder check is caught except the count limit, which is redundant (every element read consumes bytes) and only rejects earlier. | none |
| T-402 (done) | The `engine/` Rust crate: decoder and validator for the binary IR (types, column and parameter references, limits) with error codes the JS side maps to `PlanError`; a fuzz test that random bytes never panic | T-401 |
| T-403 (done) | Tables in WASM memory: segments of typed columns, validity bytes, dictionary columns taking ready-made codes (D-055), appends and the retain window with the same "a run sees the table as of its start" rule (C-LIVE). A JS loader that copies each column once | T-402 |
| T-404 (done) | Expression evaluation over a batch of 65,536 rows: field, literal, parameter, comparisons, arithmetic with checked overflow raising the same error as JS, Kleene `and`/`or`/`not`, `between`, `in`, `cast`, null handling, the constant shortcuts of D-045 and D-052. Functions in the order the dashboard and the reference queries use them; the rest follow as separate tasks | T-402, T-403 |
| T-405 (done) | Run scan, filter, project and limit chains in the engine with selection vectors, one chunk per step (D-062), checked against the JS executor on random plans. The shared failed-controls evaluation across charts (D-056) is not built: each chart's plan filters on its own, and T-413's measurement decides whether it is needed (T-416) | T-404 |
| T-406 (done) | Aggregate operator: hash group-by with the key-type specialisations of D-043, `count`, `sum` (checked), `min`, `max`, `count_distinct`, dictionary canonicalisation, group order as `docs/CONTRACT.md` fixes it | T-405 |
| T-407 (done) | Sort and limit: radix on integer and boolean keys, comparison sort otherwise, heap for small limits (D-051), stable, null placement as the contract says | T-405 |
| T-408 (done) | `wasmBackend`: a `Backend` whose `execute` loads nothing it does not need, binds parameters, runs the plan in time slices so `AbortSignal`, progress and `latest()` behave as on the JS backend, and returns the same `ResultData` | T-405, T-406 |
| T-409 (done, D-071; `/worker.html` passed all six checks in headless Chromium 156 and Firefox 158 on 1,000,000 rows, `bench/results/t409-worker.md`) | Worker host: the engine in a Web Worker (and a Bun worker), columns moved with `transfer`, abort and progress by message; a plan never blocks the page's thread | T-408 |
| T-410 (done, D-060, D-071) | Memory budget and failure model: a byte limit option, allocation failure raised as a typed error, a trap (`panic = abort`) recovered by re-creating the module and reloading, never a half-written result | T-408 |
| T-411 (done) | Cross-backend tests: the golden suite runs on both backends; a generator of random schemas, data and plans runs each plan on JS and WASM and requires equal results, equal errors and equal group and sort order. This is Milestone 3's "done when" | T-408 |
| T-412 (done: 135 KB gzipped, D-069) | Build and size: one command builds the module with `wasm-opt`, the script fails above 400 KB gzipped, and the built `.wasm` ships in the package so users need no Rust toolchain | T-402 |
| T-413 (done: measured, D-069; Firefox with a selection was 48 to 50 ms before T-416, 38 to 39 ms after; Chrome 34.4 ms; no JS fallbacks) | The reference dashboard on `wasmBackend`, unchanged except the table's backend option: measure one interaction in Chrome and Firefox against the 50 ms target, and the load time of the routes file. Record the result in `docs/BENCHMARKS.md` | T-405, T-406, T-408 |
| T-414 (done) | String expressions over dictionary columns (`lower`, `contains`, `starts_with`, `ends_with`, `upper`, `length`, `eq` and `in` on strings, `coalesce` on strings). Strings stay on the host (D-060), so the host evaluates such an expression once per dictionary entry and gives the engine a per-code table; the engine then evaluates the expression as a lookup by code. Needed by the dashboard's name search | T-404 |
| T-415 (done, D-072) | `date_trunc` and `extract` for date32 and timestamp (UTC calendar arithmetic, C-TIME) | T-404 |
| T-417 (closed: not needed; T-413 met the 50 ms target with no JS fallbacks) | Engine support for comparisons (`eq`, `lt`...) and `coalesce` between two string columns, on canonical ids (they are ordered as strings are, D-063), so the golden plans that now fall back stay in the engine. Do it only if T-413 shows the dashboard needs it | T-408 |
| T-416 (done: confirmed on the owner's machine, Firefox 38 to 39 ms and Chrome 34.4 ms with a selection; built D-070, measured in sandbox and headless Chrome; Firefox with a selection was 48 to 50 ms at T-413, so this is the attempted fix; the owner's Firefox run of `bun run bench:browser` is the acceptance) | Only if T-413 misses the 50 ms target: evaluate the dashboard's controls once per interaction and share the result between charts (D-056) | T-413 |

## Later

| ID | Task |
| --- | --- |
| T-501 (done; `src/substrait.ts`, pinned Substrait 0.108.0, 14 tests) | Substrait export and import; verify the registry's Substrait names against a pinned spec version |
| T-502 (done, C-LIVE-KEY, D-075) | Keyed live tables |
| T-503 (done, C-JOIN, C-WINDOW, D-076, D-077; 456 tests pass, core 29.7 KB gzipped; WASM rejects both nodes with PlanError until the engine supports them. Follow-up D-078: the WASM fallback check now inspects the derived plan, so the dashboard stays in the engine: Chrome selected interaction 37.7 ms, 0 fallbacks) | Joins, then window functions |
| T-504 (done, D-079; 461 tests pass, core 29.7 KB gzipped; real rrc00 dump gives 80,226 ASes and 122,862 directed edges in a 6.4 MB `data/graph.bin`) | AS-adjacency graph data: keep AS_PATH sequences from the MRT dump, build weighted directed edges and node labels, write `data/graph.bin` from `prep-bgp` (D-079) |
| T-505 (done, D-080; 464 tests pass, core 29.7 KB gzipped; headless Chrome on real `graph.bin`: loaded in 97 ms, overview 127 ms, AS13335 neighbourhood 70 ms, no console errors) | Static graph view in the dashboard: sigma.js + graphology WebGL renderer, simplified default, click-to-expand neighbourhood (D-080) |
| T-506 (done, D-081; 465 tests pass, core 29.7 KB gzipped; Chrome overview 107–145 ms, neighbourhood 61–75 ms, all data 1,419 ms; Firefox 133–138 ms, 109–137 ms, 1,634 ms; both 60 fps while panning, no console errors) | All-data graph mode and browser measurements, recorded in `docs/BENCHMARKS.md` (D-081) |
| T-507 (done, D-082; 469 tests pass, core 29.7 KB gzipped; Chrome and Firefox show 200 hot edges and about 200 hot ASes from `?live=sim`, no console errors, and sample the eased zoom in and out frame by frame) | RIS Live overlay: hot edges and nodes from the stream on the frozen layout, with the simulator as fallback (D-082) |
| T-508 (done, D-083; 472 tests pass, core 29.7 KB gzipped; Chrome and Firefox sample the 450 ms focus from ratio 0.70 to 0.42 and back, Chrome wheel changes ratio by 1.35 per notch, graph.bin with 241 countries loads in 110 ms, no console errors) | Geographic AS layout and more sensitive zoom: keep the country from `asn.txt`, place nodes around country centroids, and zoom in when an AS is clicked |
| T-509 (done, D-084; 472 tests pass, core 29.7 KB gzipped; Chrome and Firefox draw 800 nodes and 884 local edges over a synced world outline, hover explains nodes and edges, click focuses at ratio 0.42, All data draws 79,882 ASes and 122,862 edges, no console errors) | Map-first AS view: reduce overview clutter with local-first edge selection, fewer/larger nodes, a synced world outline, and an edge explainer/tooltips |
| T-510 (done, D-085; 476 tests pass, core 29.7 KB gzipped, lint clean, 39 Rust tests pass; Chrome and Firefox draw the dark deck, matching answers, map-first graph and 200 simulated hot edges with 0 console errors; measured WASM wins 1.8×/1.6× in Chrome and 1.2×/1.3× in Firefox, missing-engine page checked separately) | Redesign the demo from scratch as a dark, data-first signal deck with a live JS-vs-WASM race panel driven by the real worker engine |
| T-511 (done, D-086; 480 tests pass, core 29,690 B gzipped, lint clean, 39 Rust tests pass; `ZGR4` graph.bin is 6.8 MB with 12,859 PeeringDB facility points, 66,899 country centres and 468 unmapped; Natural Earth 1:50m outline has 1,421 rings and 46,136 points; Chrome and Firefox wheel-zoomed and dragged before clicking, kept the camera exactly and showed 0 console errors) | Sharper map and real AS location points: Natural Earth 1:50m land, PeeringDB facility centroids with a registered-country fallback, and click-to-expand that keeps the current camera instead of resetting zoom |
