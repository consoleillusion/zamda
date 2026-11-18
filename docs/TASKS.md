# Tasks

Work packages, sized so one agent can finish one in a single session. Read
`AGENTS.md` first. Take a task only when everything in its "Needs" column is done.

**IDs.** The prefix says where a task sits: `T-1xx` Milestone 1, `T-2xx`
Milestone 2, `S-3xx` the spike, `T-5xx` later work. Numbers are given out in the
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

T-201, T-202, T-204 to T-207, T-215, T-216, T-218 and T-221 are done, and T-217 is done except Firefox. T-222, T-223 and T-224 are done. Ready now: T-208, T-203, T-220. The spike (S-301) is done and the gate is met.
T-215 needs someone with network access to RIPE. T-203 changes `src/optimize.ts`; the rest are independent.

| ID | Task | Needs |
| --- | --- | --- |
| T-201 | Chunked, resumable execution: 64k-row chunks, yield about every 8 ms, abort within one time slice, progress callback. **Done.** | T-112 |
| T-202 | `latest(plan)` helper: a new run aborts the one in flight. **Done.** | T-201 |
| T-203 | Optimizer passes: constant folding, filter and project fusion, projection pushdown, limit pushdown; golden suite runs with passes on and off | T-112 |
| T-204 | Append-only live tables: `table.append(rows)`, rolling `retain` window, a run sees the table as of its start. **Done.** | T-201 |
| T-205 | `scripts/prep-bgp.ts`: download one RIPE RIS snapshot and write the routes file matching the reference schema. **Done; not yet run against a real dump.** | T-112 |
| T-206 | Reference dashboard under `demo/`: four linked charts, controls as parameters, live panel on RIPE RIS Live. **Done** (`bun run demo`); checked in headless Chrome on synthetic data with the simulated feed, not yet on real data or the real feed. | T-202, T-204, T-205 |
| T-207 | Benchmark harness under `bench/reference/`: seven reference queries, zamda vs Arquero at 10k, 100k and 1M rows, every answer checked against the other engine before timing, results written to `bench/results/` as JSON and markdown. **Done** (`bun run bench:ref`); sandbox results in `bench/results/sandbox.md`. | T-205 |
| T-208 | ESLint rule flagging `&&`, `\|\|`, `!` and `===` in accessor callbacks; API reference docs | T-112 |
| T-209 | Build and publish: ESM output with `.d.ts`, npm alpha | T-206, T-208 |
| T-210 | Measure the reference queries in Chrome and Firefox, not only Bun (the dashboard part is T-217) | T-207 |
| T-211 | Allow `utf8` and `dictionary` expressions to be mixed in one operation | T-112 |
| T-215 | Run `bun run prep-bgp` against a real RIS dump; record row count, skipped prefixes and timings in `docs/BENCHMARKS.md`. **Done** (`docs/BENCHMARKS.md`). | T-205 |
| T-216 | The first real run stopped at ~930k prefixes with "Path attribute runs past the entry"; a second run of the same dump found no bad entries. **Closed:** `scripts/check-dump.ts` gave identical results under four different splits of the same dump, with no bad entries; the first failure was most likely damage in that one download. | T-205 |
| T-217 | Run `bun run demo` on a real `data/routes.bin` with the real RIS Live feed. **Done in Chromium** (owner, real RIPE data, real feed): 109 to 123 ms per interaction against the 200 ms target; live refresh 20 to 40 ms. Firefox not yet measured. | T-206 |
| T-218 | Cut the work in one dashboard interaction. **Done:** the top-20 chart and the totals line share one per-network query (they apply identical filters), the top 20 is picked in JS, and the live panel's name table is read from the first unfiltered result instead of its own pass over every route. About 20% less work per interaction in the sandbox (161 to 124 ms, 180 to 143 ms, 117 to 94 ms). | T-206 |
| T-220 | What is left per interaction: the per-network group-by (about 40 ms of a million rows), the distinct-network count in the regions chart (about 20 ms) and five filter passes (about 11 ms each). Ideas: share one filter pass across charts with a per-row bitmask of failing controls; cache chart results by parameter values; a cheaper distinct count for 32-bit keys. Only worth doing if the spike gate needs it | T-218 |
| T-221 | Full sort was zamda's weakest query: 87 ms for 1M rows on the owner's machine against Arquero's 31 ms, and two thirds of the spike gate's JS time. **Done as far as it goes:** the sort itself was slow (3 closure calls per comparison); integer and boolean keys now use a stable LSD radix sort (D-051), 4x faster than the comparison sort on random order and 2.5x on address-ordered data in the sandbox. On the owner's real data the full sort only went from 87 to 72 ms (`my-laptop-2.md`) and Arquero still wins it (31 ms): the real table is already in address order, which native comparison sorts exploit, and about half of what remains is gathering the sorted columns. Not worth more work now. | T-207 |
| T-223 | Why is the same dashboard work slower in Chromium than in Bun? **Done:** `bun run bench:compare` and `bun run bench:browser` run the same measurements under Bun (JavaScriptCore) and Chrome (V8). Same machine, 1M rows: not time slicing (identical with it off), but V8 is about 2x slower on the filter path (the dashboard's four charts started together: Chrome 241 to 301 ms, Bun 108 to 137 ms; the filtered query Q5: 88 against 41 ms) while plain group-bys are about equal (Q1 68 against 63 ms) and the full sort is faster in V8 (78 against 160 ms). Results in `docs/BENCHMARKS.md`. Firefox not measured. | T-207 |
| T-224 | The dashboard's four charts cost about twice what the same queries cost alone, because every chart carries all five filter controls and each was evaluated over a million rows even when switched off (the owner's real numbers, `bench/results/browser-my-laptop.md`: interaction 96 to 103 ms in Chrome, 67 to 92 ms in Firefox, against about 41 ms of single queries). **Done** (D-052): a comparison that every row answers the same way (a range covering the column's whole integer type) is now a constant, `and`/`or` skip the other side, and a constant filter keeps all rows or none without reading anything. In the sandbox the interaction fell from 241 to 125 ms (nothing selected) and 301 to 180 ms (with selections) in Chrome, and from 137 to 104 and 108 to 87 ms in Bun. Not yet measured on the owner's machine. | T-223 |
| T-222 | `table()` from columns took 172 ms at 1M rows (sandbox) when a column is a `string[]`, because every string is re-encoded into a dictionary. **Done** (D-055): `{ codes, dictionary, nullCode? }` is accepted for dictionary columns and the routes file loads through it: 172 ms down to 32 ms in the sandbox, 5 new tests (a mutation of each check is caught). Not yet measured on the owner's machine (was 42 to 45 ms). | T-207 |
| T-219 | `lower`/`upper` on a dictionary column return `utf8`, so the strings are materialised per row. Keep dictionary encoding through them (entries must be re-deduplicated: "A" and "a" both lower to "a"). The shortcut in D-045 covers the dashboard's search, so this only matters when the result is stored or grouped | T-211 |
| T-212 | Sort directly over a large table copies every needed column once before sorting; sort a selection over the source instead | T-201 |

## Spike

| ID | Task | Needs |
| --- | --- | --- |
| S-301 | Under `spike/`: Rust/WASM prototypes of group-by and sort, measured against the spike gate with JS row loading included. **Done, gate met** (D-053, D-054): 4.2x Bun, 3.4x Chrome, 3.5x Firefox at 1M rows, 42.9 KB module, ahead at 100k (`bench/results/spike-my-laptop.md`). Not done and not needed for the gate: arrow-rs and DataFusion comparisons (the hand-written kernels fit the size limit by a wide margin). Throwaway code. | T-207 |
| S-302 | The dashboard on WASM, first slice (D-056): a per-row failed-controls mask and the four chart kernels (per-network counts, prefix and path length histograms, routes and distinct networks per region), each checked against zamda's answers for two selections. **Built and measured natively in the sandbox only** (1M rows: 94 to 28 ms with nothing selected, 104 to 6.8 ms with selections); the WASM numbers and the 50 ms target check need `bun run spike:build` and `bun run spike` on the owner's machine, and Chrome and Firefox through `bun run spike:browser`. Not covered: the live panel, top-20 selection in JS, parameter binding through the IR. | S-301 |

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
