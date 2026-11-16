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
Next is Milestone 2, the JS release: [docs/ROADMAP.md](docs/ROADMAP.md).

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
| Output | `toArray()` rows, `columns()`, `column(name)` |

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
