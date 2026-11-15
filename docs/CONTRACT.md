# The semantics contract

This document, not any backend, defines what zamda operations mean. Every rule
must hold bit for bit on every backend. Each rule has an ID; golden tests in
`tests/golden/contract.test.ts` are named by it.

Where Substrait's standard function extensions define a behaviour, zamda follows
them unless a rule here says otherwise.

**Status:** `pinned` means a golden test enforces the rule today. `todo` means
the rule is decided but its implementation is a task in `docs/TASKS.md`.

## Supported types

| Type | JS value | Storage in the JS backend | Status |
| --- | --- | --- | --- |
| `bool` | `boolean` | `Uint8Array` of 0 or 1 | pinned |
| `int8`, `int16`, `int32` | `number` | matching typed array | pinned |
| `uint8`, `uint16`, `uint32` | `number` | matching typed array | pinned |
| `int64`, `uint64` | `bigint` | `BigInt64Array`, `BigUint64Array` | pinned |
| `float32`, `float64` | `number` | `Float32Array`, `Float64Array` | pinned |
| `utf8` | `string` | `string[]` | pinned |
| `dictionary` | `string` | `string[]` today; codes plus dictionary after T-107 | todo |
| `date32` | `Date` | not yet | todo, T-108 |
| `timestamp` | `Date` | not yet | todo, T-108 |

Every column is nullable. Any other type raises `SchemaError` at load.

## Rules

| ID | Rule | Status | Task |
| --- | --- | --- | --- |
| C-FILTER | `filter` keeps only rows where the predicate is true. Null and false are dropped. | pinned | |
| C-NULL-LOGIC | Logic is three-valued (Kleene). `and`: false if either side is false, else null if either is null. `or`: true if either side is true, else null if either is null. `not` of null is null. Comparison with null is null. `isNull` is never null. | pinned | |
| C-OVERFLOW | Integer `add`, `sub`, `mul` and integer `sum` raise `ExecutionError` when the result does not fit the type. A null row never raises. Floats follow IEEE 754 and never raise. Wrapping and saturating forms are separate, explicit methods. | pinned for add, sub, mul | T-103, T-106 |
| C-DIV | `div` on integers yields `float64`. `intDiv` is explicit. Integer divide by zero raises `ExecutionError`; float division follows IEEE 754. | todo | T-106 |
| C-PROMOTION | Binary numeric operations widen to the smallest type that holds both operands. Integer with float gives `float64`. `int64` with `uint64` requires a cast. Until T-102, operands must have the same type. | todo | T-102 |
| C-NAN-PREDICATE | In predicates, IEEE 754 applies: NaN is not equal to, less than or greater than anything, and `neq` with NaN is true. Use `isNaN()`. | pinned | |
| C-NAN-ORDER | For grouping, distinct and sorting, NaN equals NaN and sorts after all numbers. `-0.0` and `0.0` are one group. | todo | T-103, T-104 |
| C-ROW-ORDER | `filter`, `select` and `limit` preserve input order. | pinned | |
| C-SORT-STABLE | Sort is stable: rows with equal keys keep their input order. | todo | T-104 |
| C-NULL-SORT | Sort places nulls last in both directions unless `nullsFirst()` is set. | todo | T-104 |
| C-GROUP-ORDER | Groups, and distinct rows, come out in order of first occurrence. Null keys form one group. | todo | T-103 |
| C-AGG-TYPES | `count()` counts rows; `c.x.count()` counts non-null values; both are `uint32`. `sum` of signed integers is `int64`, of unsigned `uint64`, of floats `float64`. `avg` is `float64`. `min` and `max` keep the input type. All aggregates except `count` skip nulls. | todo | T-103 |
| C-FLOAT-SUM | Float sums use Neumaier compensated summation in row order. A backend may not reorder a float sum. | todo | T-103 |
| C-EMPTY-AGG | Over no rows (or only nulls), `count` is 0 and `sum`, `min`, `max` and `avg` are null. | todo | T-103 |
| C-STR-ORDER | Strings compare by Unicode code point. This is bytewise UTF-8 order and differs from JavaScript's default UTF-16 order above U+FFFF. | pinned | |
| C-STR-LENGTH | `length` counts code points, not UTF-16 units. | todo | T-105 |
| C-STR-CASE | `lower` and `upper` use locale-independent Unicode case mapping. | todo | T-105 |
| C-INT64-JS | `int64` and `uint64` values are `bigint` in JS. | pinned | |
| C-BETWEEN | `between(low, high)` is inclusive at both ends and equals `gte(low).and(lte(high))`. | pinned by construction | |
| C-DETERMINISM | Every registry function is deterministic. Non-deterministic functions are excluded from the MVP. | pinned | |
| C-PARAM | A parameter is a typed literal bound at execution. A missing, extra or wrongly typed parameter rejects the run before any work starts. | pinned | |

## Permitted divergence

There is exactly one. Case mapping follows the Unicode version of the runtime,
so `lower` and `upper` may differ between backends for recently added
characters. Cross-backend tests exclude those characters.

## Changing the contract

A rule changes only with the owner's agreement. Record the change in
`docs/DECISIONS.md`, update this file, then update the golden tests, then the code.
