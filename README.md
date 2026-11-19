# zamda

Typed, declarative columnar pipelines for JavaScript.

You describe a query with a typed DSL. zamda compiles it to a small intermediate
representation (IR) and runs it on a backend. The same compiled plan gives the
same result on every backend.

```ts
import { count, list, pipe, schema, t, table } from 'zamda';

const Users = schema({ name: t.utf8, country: t.utf8, age: t.int32, active: t.bool });
const users = table(Users, rows);

const plan = pipe(Users)
  .filter(c => c.active.eq(true).and(c.age.gte(18)))
  .select(c => ({ name: c.name, next: c.age.add(1) }))
  .limit(10)
  .compile();

const out = await plan.execute(users);
out.toArray(); // { name: string | null; next: number | null }[]
```

## Status

Milestone 1 (the core) is complete: every rule in the contract is implemented on
the JS backend and pinned by a test. See [docs/MILESTONE-1.md](docs/MILESTONE-1.md)
for the gate review and [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for numbers.
Milestone 2, the JS release, is under way: execution is now chunked and
cancellable. See [docs/ROADMAP.md](docs/ROADMAP.md).

## What you can write

```ts
const Routes = schema({ origin_as: t.uint32, path_len: t.uint8, rir: t.dictionary });

// Top 20 networks by route count, with parameters a dashboard can change.
const top = pipe(Routes, { minLen: t.uint8, maxLen: t.uint8, regions: list(t.dictionary) })
  .filter((c, p) => c.path_len.between(p.minLen, p.maxLen).and(c.rir.isIn(p.regions)))
  .groupBy(c => ({ origin_as: c.origin_as }))
  .agg(() => ({ routes: count() }))
  .sort(c => c.routes.desc())
  .limit(20)
  .compile();

await top.execute(routes, { params: { minLen: 2, maxLen: 6, regions: ['APNIC'] } });
```

### Keyed live tables

`keyedTable(schema, keyFields, data)` creates a live table with at most one row
per key. `upsert(rows)` inserts new keys and replaces whole rows for existing
keys in place; `delete(keys)` returns how many rows it removed. A key with a null
component, or bad row data, is rejected without changing the table. A run sees
the table exactly as it stood when it started (C-LIVE-KEY). The WASM backend
provides its own bound factory on the object returned by `createWasmBackend(host)`.

### Joins and window functions

`join(right, keys, how)` binds a right table when the pipeline is compiled. It
matches rows on equal, non-null key columns (`utf8` and `dictionary` compare by
value) and outputs the left columns followed by the right columns; duplicate
output names are rejected. `how` is `inner` (default), `left`, `right` or
`full`. `window({ partitionBy, orderBy, functions })` keeps the input rows in
order and appends `int64` columns computed over each partition's peer groups:
`row_number`, `rank` or `dense_rank`. Both run on the JS backend; the WASM
backend raises `PlanError` for these nodes rather than changing their meaning
(C-JOIN, C-WINDOW, D-076, D-077).

| Area | Available |
| --- | --- |
| Pipeline | `filter`, `select`, `withColumns`, `rename`, `groupBy().agg()`, `agg()`, `distinct`, `sort`, `limit`, `join`, `window` |
| Comparison and logic | `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `between`, `isIn`, `isNull`, `isNaN`, `and`, `or`, `not`, `ifElse`, `coalesce` |
| Arithmetic | `add`, `sub`, `mul`, `div`, `intDiv`, `mod`, `neg`, `abs`, `floor`, `ceil`, `round`, `bin`, `cast`, and wrapping forms |
| Strings | `lower`, `upper`, `length`, `startsWith`, `endsWith`, `contains` |
| Dates | `dateTrunc`, `extract` |
| Aggregates | `count`, `countDistinct`, `sum`, `avg`, `min`, `max` |
| Input | row objects, or one array per column (typed arrays are used without copying) |
| Live tables | `table.append(rows)`, with an optional `retain: { rows }` rolling window; each run sees the table as it was when the run started |
| Keyed live tables | `keyedTable(schema, keyFields, data)`: `upsert(rows)` replaces whole rows by key in place, `delete(keys)` removes them, and mutation is atomic |
| Output | `toArray()` rows, `columns()`, `column(name)` |
| Running | Chunked and cooperative: `signal` to cancel, `onProgress`, and `latest(plan)` so a new run cancels the previous one |

## Develop

```sh
bun install
bun run check     # typecheck + tests + size budget
```

| Command | What it does |
| --- | --- |
| `bun test` | Unit, slice and golden contract tests |
| `bun run lint` | ESLint over the repo with the zamda accessor-callback rule |
| `bun run typecheck` | `tsc --noEmit`, including the type-inference tests |
| `bun run build` | ESM bundle and `.d.ts` files in `dist/` for publishing |
| `bun run publish:alpha` | Build and publish the package to npm under the `alpha` tag |
| `bun run size` | Fails if the core exceeds 40 KB gzipped |
| `bun run bench` | Group-by benchmark against plain JS and Arquero |
| `bun run wasm:build` | Builds the engine as WebAssembly (`dist/zamda-engine.wasm`), runs `wasm-opt` if installed, prints the size and fails above 400 KB gzipped. Needs `rustup target add wasm32-unknown-unknown` once |
| `bun run wasm:measure` | `wasm:build`, then the reference queries and dashboard interactions on the JS backend and on the WASM module in Bun, checking every answer against the JS backend |
| `bun run bench:native` | The same measurement with the engine as a native library (no WASM toolchain needed): an upper bound |
| `bun run bench:compare` | The reference queries and the dashboard's interactions under Bun, with and without time slicing; compare with `bun run bench:browser` (a page to open in any browser; it also measures the WASM engine if `dist/zamda-engine.wasm` exists) |
| `bun run bench:browser` (page `/worker.html`) | The engine in a Web Worker in the real browser: the page thread stays free, transfer, abort, a byte limit. Needs `bun run wasm:build` first. |
| `bun run spike:build`, `bun run spike`, `bun run spike:browser` | The WASM spike (S-301, throwaway): build the Rust kernels for wasm32 and as a native library (needs `rustup target add wasm32-unknown-unknown`), time them against the JS executor under Bun, or in a browser |
| `bun run gen:engine` | Regenerate `engine/src/signatures.rs` and the plan corpus the Rust tests read; `cd engine && cargo test --release` runs them |
| `bun run engine:test` | Build the engine natively, run the JS tests that load tables, evaluate expressions and run plans in it through bun:ffi, then the Rust tests |
| `bun run bench:ref` | Reference benchmark: seven queries at 10k, 100k and 1M routes, zamda vs Arquero, answers checked first; writes `bench/results/` |
| `bun run prep-bgp` | Download a RIPE RIS routing table dump, the registry files and PeeringDB's public facility data, then build `data/routes.bin` and `data/graph.bin` for the demo |
| `bun run gen:map` | Regenerate the demo's committed Natural Earth 1:50m land outline (`demo/world-map.ts`) |
| `bun run fake-routes` | Write a synthetic `data/routes.bin` (a million routes) for trying the demo offline |
| `bun run demo` | The dark routing signal deck on http://localhost:3000. The same compiled chart plans run on the JS table and, after `bun run wasm:build`, in a WASM worker; WASM is timed first, JS second, and the page shows the measured times, speedup, answer check and engine counters. It keeps the map-first AS graph from `data/graph.bin` and the RIS Live overlay; add `?live=sim` for a simulated feed, `?live=off` for none. Nodes sit at PeeringDB facility centroids where an AS publishes one, otherwise at its registered country's centre; clicking one expands its neighbourhood without moving the camera. Without the engine module the page says so and stays on JS. |
| `bun run scripts/inspect-routes.ts` | Run the dashboard's queries on `data/routes.bin` and time them |
| `bun run scripts/check-dump.ts <dump.gz>` | Check the MRT reader gives the same answer however a dump is split |

## Documentation

| Read | For |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Rules for anyone, human or agent, changing this repo |
| [docs/API.md](docs/API.md) | The public API reference |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, modules and how to extend them |
| [docs/CONTRACT.md](docs/CONTRACT.md) | The semantics every backend must implement |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and their gates |
| [docs/TASKS.md](docs/TASKS.md) | Work packages, ready to pick up |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are |

## Licence

MIT
