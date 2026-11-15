# zamda

Typed, declarative columnar pipelines for JavaScript.

You describe a query with a typed DSL. zamda compiles it to a small intermediate
representation (IR) and runs it on a backend. The same compiled plan gives the
same result on every backend.

```ts
import { count, pipe, schema, t, table } from 'zamda';

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

Milestone 1 is in progress. Working today: schemas, the typed DSL, the IR, the
validator, and `filter`, `select` and `limit` on the JS backend. `groupBy().agg()`
and `sort()` compile but do not execute yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
