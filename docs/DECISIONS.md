# Decisions

Settled questions and why. Add an entry when you change one; do not reopen one
in code. Newest last.

| ID | Decision | Why |
| --- | --- | --- |
| D-001 | The product is the DSL, the IR and the contract. Engines are backends. | Useful from the first milestone; the project survives if the WASM spike fails. |
| D-002 | The JS backend ships first and is the reference for every other backend. | No WASM risk early; it doubles as the test oracle; it serves small data. |
| D-003 | Expressions are type-checked eagerly, when each DSL method is called, through the registry. `compile()` then assembles, optimizes and validates. | Errors point at the user's line; the validator still re-checks everything, so the IR is safe from any source. |
| D-004 | JS-side validity is one byte per row, not a bit-packed bitmap. | Simpler and faster in JS. Bit-packing is an internal detail of the WASM backend. |
| D-005 | The type-mismatch error is named `TypeCheckError`. | The spec called it `TypeError`, which would shadow the JS built-in. |
| D-006 | `count` returns `uint32`. Row count is the free function `count()`; non-null count is `c.x.count()`. | Counts come back as plain JS numbers. A method on the accessor (`c.count()`) would collide with a column named `count`. No in-memory table here can exceed 4.29 billion rows. On Substrait export it is cast to `i64`. |
| D-007 | `groupBy` takes an object of named keys, `groupBy(c => ({ country: c.country }))`, not an array. | Output column names and types are inferred exactly, and computed keys get names. |
| D-008 | Until task T-102, binary operations need operands of the same type. | Keeps the first slice small. Promotion rules are already in the contract. |
| D-009 | Apache Arrow is an internal detail of the WASM backend. Users pass rows or typed arrays. Type names follow Arrow. | It is what front-end developers have; Arrow is still the right layout inside the engine. |
| D-010 | Integer arithmetic is checked by default. This is final. | The owner's first priority is reliability. Wrapping forms exist as explicit methods. |
| D-011 | Execution is chunked and cooperative; cancelling leaves tables intact. | Dashboards cancel on every interaction; reloading data each time is unusable. |
| D-012 | Groups come out in first-occurrence order. Float sums use Neumaier summation in row order. | Both make results identical across backends without extra sorting. |
| D-013 | Sugar lowers in the DSL. `between` becomes `gte` and `lte`; `bin` becomes arithmetic. | Fewer functions for every backend to implement and for Substrait to map. |
| D-014 | The runtime and toolchain is Bun, with `tsc` for type checking. | Owner's choice. |
| D-015 | Name: zamda. Licence: MIT. | Owner's choice. |
| D-016 | Append-only live tables are in Milestone 2; keyed live tables come first after the MVP. | A dashboard that moves is a stronger first release; keyed updates are a much larger engine feature. |
| D-017 | Contract refinements made while building aggregates: a `sum` is overflow-checked on every partial sum; a non-finite float running sum is returned as is; `-0.0` keys are reported as `0.0`; `avg` sums as `float64`; NaN is greatest for `min` and `max`. | Each was a gap in the contract that two backends could have filled differently. |
| D-018 | Group-by on 32-bit integer keys and integer distinct counts use open-addressing hash tables over typed arrays, not `Map` and `Set`. | Measured: 2.4x faster than `Map` on 75k groups over a million rows. See `docs/BENCHMARKS.md`. |
| D-019 | The executor skips copying columns no later node reads. | Cheap, and it never changes results. |
| D-020 | Parameters are declared on `pipe(schema, { name: type })` and reach callbacks as a second argument, `(c, p) => ...`. There is no free `param()` function. | The declaration gives `execute()` an exact parameter type with no extra machinery in every expression type. |
| D-021 | `cast` and `in` are IR expression kinds, not registry functions. | Each needs information a function signature cannot carry (a target type, a list), and each maps to its own Substrait expression. |
| D-022 | `timestamp` is whole milliseconds since the Unix epoch in UTC, with no unit or time zone parameter. `date32` rejects a `Date` that has a time of day. | It is exactly what a JS `Date` holds, so nothing is lost or guessed on the way in or out. Finer units can be added as new types. |
| D-023 | `lower` and `upper` return `utf8` even for a dictionary input. | Case mapping can merge entries, which would break the rule that dictionary entries are unique. |
| D-024 | `round` rounds ties to even. | It is the IEEE 754 default and avoids the upward bias of JS's `Math.round`. |
| D-025 | A JS literal operand takes the type of the expression it meets; only two expressions are promoted. Comparisons promote like arithmetic. | `c.small.add(1)` staying `int8` is predictable; widening on every literal would make result types depend on literal size. |
| D-026 | `filter` and `sort` produce a selection (row indexes) over their input; rows are copied only when a later operator needs dense columns. | Removes the copy that made filter-then-group slower than a hand-written loop. |
| D-027 | Dictionary entries are unique within a column, so equal codes mean equal strings. | Lets group-by, distinct counts and equality run on integer codes. |

## Departures from design spec v4

The scaffold differs from the spec's code examples in three places, each
recorded above: D-005 (error name), D-006 (`count()` instead of `c.count()`),
D-007 (`groupBy` takes an object), D-020 (declared parameters) and D-022
(timestamps have no unit or time zone parameter).
