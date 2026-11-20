# Milestone 1 gate review

Date: 2026-11-16. Result: **passed.**

The gate, from `docs/ROADMAP.md`: every rule in `docs/CONTRACT.md` is pinned and
passes on the JS backend, and the core is 40 KB gzipped or less.

## Evidence

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passes, including the type-inference tests in `tests/types/inference.ts` |
| `bun test` | 130 tests pass, none skipped or marked todo |
| Contract rules | 28 rules, all pinned by golden tests in `tests/golden/` |
| `bun run size` | 15.9 KB gzipped, 39% of the 40 KB budget |
| Registry | 35 scalar and 6 aggregate functions; each has a Substrait mapping and a JS kernel, enforced by `tests/registry.test.ts` |
| Purpose comments | Every named function, method and constructor in `src/` opens with one |

## What Milestone 1 delivered

- The typed DSL: nine pipeline operations, typed parameters, numeric promotion
  at the type level, and guards against JavaScript operators on expressions.
- The IR (version 2) and its validator.
- The JS backend: every operator and function in the contract, dictionary
  encoding, selection vectors, hash group-by and heap top-k.
- Benchmarks against a hand-written loop and Arquero (`docs/BENCHMARKS.md`).

## Not verified, or short of target

- **Browsers.** Everything was run on Bun (JavaScriptCore) only. Nothing has
  been run in Chrome, Firefox or Node. Task T-210.
- **Loading speed.** Target was within 1.5x of Arquero; measured 1.4x to 1.6x
  across three runs.
- **Substrait names.** The registry's Substrait mappings are from memory and
  have not been checked against a pinned Substrait release. Task T-501.
- **`date_trunc` mapping.** Mapped to Substrait `round_temporal`; that choice in
  particular needs checking.
- **Mixed string types.** A `utf8` expression cannot be combined with a
  `dictionary` expression. Task T-211.
- **The contract's newest rules** (C-CAST, C-ROUND, C-BIN, C-IN, C-IF, C-TIME,
  C-STR-MATCH and the promotion details) were written by the implementer while
  the owner was away. They follow the design spec where it spoke, and common
  database behaviour where it did not. The owner should read them.

## Decisions taken during the milestone

D-017 to D-027 in `docs/DECISIONS.md`. The ones that change the public API from
design spec v4 are D-020 (parameters are declared on `pipe()`) and D-022
(timestamps are milliseconds in UTC with no unit parameter).
