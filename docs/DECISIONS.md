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

## Departures from design spec v4

The scaffold differs from the spec's code examples in three places, each
recorded above: D-005 (error name), D-006 (`count()` instead of `c.count()`),
D-007 (`groupBy` takes an object). The spec should be updated to match.
