# Working on zamda

Read this first. It applies to every contributor, human or AI agent.

## What zamda is

A typed JavaScript DSL for columnar pipelines. The product is three things: the
**DSL**, the **IR** it compiles to, and the **contract** that defines what every
operation means. Execution engines are interchangeable **backends**. The JS
backend ships first and defines correct behaviour; a Rust/WASM backend may follow.

The owner's priorities, in order: **reliable, typed, safe, declarative, fast.**
When they conflict, the earlier one wins.

## Read before you change anything

1. `docs/ARCHITECTURE.md`: where code goes and what may import what.
2. `docs/CONTRACT.md`: the behaviour you must implement. It is the authority.
3. `docs/TASKS.md`: pick a task whose dependencies are done.
4. `docs/DECISIONS.md`: settled questions. Do not reopen them in code.

## Commands

```sh
bun install
bun run check     # in packages/zamda: must pass before you finish: typecheck + tests + size
bun run test:wasm # the same tests on the real WebAssembly module (needs the wasm32 target)
```

## Hard rules

1. **The contract is the authority.** If code and `docs/CONTRACT.md` disagree,
   the code is wrong. If the contract is silent or wrong, stop and write a
   proposed rule in your task notes; do not invent behaviour silently.
2. **Never weaken a golden test to make code pass.** Golden tests in
   `tests/golden/` pin contract rules. Change one only when the contract changes,
   and record that in `docs/DECISIONS.md`.
3. **Tests first.** For a contract rule, turn its `test.todo` into a real test,
   watch it fail, then implement.
4. **No silent fallback.** A backend that cannot run something raises
   `PlanError`. It never substitutes different semantics.
5. **Every function maps to Substrait.** A function without a mapping does not
   enter `src/registry.ts`. Sugar that lowers to existing functions (like
   `between`) needs no entry.
6. **No runtime dependencies in the core.** Adding one needs a decision record.
7. **Stay inside the size budget.** `bun run size` enforces 40 KB gzipped.
8. **No `any`.** Use the loose cell views in `src/column.ts` inside kernels.
9. **Errors are structured.** Throw a class from `src/errors.ts`, with a message
   that says what was expected, what was found, and where (row, column, node).
10. **Public API changes** need a type test in `tests/types/inference.ts` and,
    if they depart from an earlier decision, an entry in `docs/DECISIONS.md`.

## Code conventions

- **Purpose comments.** Every named function, method and constructor opens with
  `// Purpose: ...` as the first line of its body. Short inline callbacks passed
  to `map`, `forEach` and the like are exempt.
- TypeScript strict mode. Explicit return types on exported functions.
- Kernels cite the contract rule they implement, for example `C-OVERFLOW`.
- Clarity over speed in the JS backend: it is the reference other backends are
  tested against. Optimize only with a benchmark that shows the need.
- Keep modules small and single-purpose. Follow the module map in
  `docs/ARCHITECTURE.md`; ask before adding a top-level module.

## How to do a task

1. In `docs/TASKS.md`, set the task's status to `in progress` with your name.
2. Stay within the files the task lists. If you need to touch others, say why in
   the task notes.
3. Finish only when the task's acceptance list is fully met and `bun run check`
   passes.
4. Update the docs the task affects: status in `docs/CONTRACT.md` and
   `docs/TASKS.md`, and `README.md` if user-visible behaviour changed.
5. Report: what you did, what you verified, and anything you could not verify.

## Hot files

Several tasks edit `src/registry.ts`, `src/expr.ts` and
`src/backends/js/kernels.ts`. To keep merges small:

- Put new kernels in a new file, `src/backends/js/kernels-<group>.ts`, and
  register them with one line in `kernels.ts`.
- Append registry entries in the marked scalar or aggregate block; do not
  reorder existing entries.
- Add DSL methods at the end of the relevant class in `expr.ts`.

## Out of scope unless a task says so

Joins, window functions, SQL parsing, JS callbacks during execution, threads,
decimals, persistence. See "Non-goals" in `docs/ROADMAP.md`.
