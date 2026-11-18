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

| Area | Available |
| --- | --- |
| Pipeline | `filter`, `select`, `withColumns`, `rename`, `groupBy().agg()`, `agg()`, `distinct`, `sort`, `limit` |
| Comparison and logic | `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `between`, `isIn`, `isNull`, `isNaN`, `and`, `or`, `not`, `ifElse`, `coalesce` |
| Arithmetic | `add`, `sub`, `mul`, `div`, `intDiv`, `mod`, `neg`, `abs`, `floor`, `ceil`, `round`, `bin`, `cast`, and wrapping forms |
| Strings | `lower`, `upper`, `length`, `startsWith`, `endsWith`, `contains` |
| Dates | `dateTrunc`, `extract` |
| Aggregates | `count`, `countDistinct`, `sum`, `avg`, `min`, `max` |
| Input | row objects, or one array per column (typed arrays are used without copying) |
| Live tables | `table.append(rows)`, with an optional `retain: { rows }` rolling window; each run sees the table as it was when the run started |
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
| `bun run typecheck` | `tsc --noEmit`, including the type-inference tests |
| `bun run size` | Fails if the core exceeds 40 KB gzipped |
| `bun run bench` | Group-by benchmark against plain JS and Arquero |
| `bun run bench:compare` | The reference queries and the dashboard's interactions under Bun, with and without time slicing; compare with `bun run bench:browser` (a page to open in any browser) |
| `bun run spike:build`, `bun run spike`, `bun run spike:browser` | The WASM spike (S-301, throwaway): build the Rust kernels for wasm32 and as a native library (needs `rustup target add wasm32-unknown-unknown`), time them against the JS executor under Bun, or in a browser |
| `bun run gen:engine` | Regenerate `engine/src/signatures.rs` and the plan corpus the Rust tests read; `cd engine && cargo test --release` runs them |
| `bun run bench:ref` | Reference benchmark: seven queries at 10k, 100k and 1M routes, zamda vs Arquero, answers checked first; writes `bench/results/` |
| `bun run prep-bgp` | Download a RIPE RIS routing table dump and build `data/routes.bin` for the demo |
| `bun run fake-routes` | Write a synthetic `data/routes.bin` (a million routes) for trying the demo offline |
| `bun run demo` | The reference dashboard on http://localhost:3000; add `?live=sim` for a simulated live feed, `?live=off` for none |
| `bun run scripts/inspect-routes.ts` | Run the dashboard's queries on `data/routes.bin` and time them |
| `bun run scripts/check-dump.ts <dump.gz>` | Check the MRT reader gives the same answer however a dump is split |

## Documentation

| Read | For |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Rules for anyone, human or agent, changing this repo |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, modules and how to extend them |
| [docs/CONTRACT.md](docs/CONTRACT.md) | The semantics every backend must implement |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and their gates |
| [docs/TASKS.md](docs/TASKS.md) | Work packages, ready to pick up |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are |

## Licence

MIT
