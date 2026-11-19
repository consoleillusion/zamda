# The semantics contract

This document, not any backend, defines what zamda operations mean. Every rule
must hold bit for bit on every backend. Each rule has an ID; golden tests in
`tests/golden/` are named by it.

Where Substrait's standard function extensions define a behaviour, zamda follows
them unless a rule here says otherwise.

**Status:** every rule below is `pinned`: a golden test enforces it on the JS
backend. A new rule starts as `todo` with a task in `docs/TASKS.md`.

## Supported types

| Type | JS value | Storage in the JS backend |
| --- | --- | --- |
| `bool` | `boolean` | `Uint8Array` of 0 or 1 |
| `int8`, `int16`, `int32` | `number` | matching typed array |
| `uint8`, `uint16`, `uint32` | `number` | matching typed array |
| `int64`, `uint64` | `bigint` | `BigInt64Array`, `BigUint64Array` |
| `float32`, `float64` | `number` | `Float32Array`, `Float64Array` |
| `utf8` | `string` | `string[]` |
| `dictionary` | `string` | `Int32Array` of codes plus a list of unique strings |
| `date32` | `Date` at UTC midnight | `Int32Array` of days since the Unix epoch |
| `timestamp` | `Date` | `Float64Array` of whole milliseconds since the Unix epoch, UTC |

Every column is nullable. Any other type raises `SchemaError` at load. A value
that does not fit its column's type raises `SchemaError` at load, naming the row
and column. `utf8` and `dictionary` behave identically; they differ only in storage.

## Rules

### Rows, nulls and logic

| ID | Rule |
| --- | --- |
| C-FILTER | `filter` keeps only rows where the predicate is true. Null and false are dropped. |
| C-NULL-LOGIC | Logic is three-valued (Kleene). `and`: false if either side is false, else null if either is null. `or`: true if either side is true, else null if either is null. `not` of null is null. A comparison or arithmetic operation with a null operand is null. `isNull` is never null. |
| C-ROW-ORDER | `filter`, `select`, `withColumns`, `rename` and `limit` preserve input order. |
| C-IF | `ifElse(cond, a, b)` is `a` where `cond` is true and `b` where it is false or null. `x.coalesce(y)` is `x` where `x` is not null, else `y`. |
| C-IN | `x.isIn(list)` is true where `x` equals any list entry, false otherwise, and null where `x` is null. An empty list matches nothing. NaN never matches. `-0.0` matches `0.0`. |
| C-PARAM | A parameter is declared with a type and bound at execution. A missing, extra or wrongly typed parameter rejects the run before any work starts. |

### Numbers

| ID | Rule |
| --- | --- |
| C-OVERFLOW | Integer `add`, `sub`, `mul`, `neg`, `abs`, `intDiv` and integer `sum` raise `ExecutionError` when the result does not fit the type. A `sum` is checked on every partial sum in row order, so it raises even if later rows would bring it back in range. A null row never raises. Floats follow IEEE 754 and never raise. `wrappingAdd`, `wrappingSub` and `wrappingMul` wrap modulo 2^width instead. `neg` is not defined for unsigned types. |
| C-PROMOTION | When a binary numeric operation or comparison has two expression operands of different types, both are cast to the smallest type that holds both: the wider of two signed or two unsigned integers; for a signed with an unsigned integer, the smallest signed type holding both; `float64` for any integer with a float, or `float32` with `float64`. `int64` with `uint64` has no common type and requires an explicit cast. A JavaScript literal operand takes the type of the expression it is combined with and must fit it. Operands of the same type are never widened. The table is `src/promotion.ts`. |
| C-CAST | `cast` converts between numeric types only. Integer to a wider integer or to a float is value-preserving up to float precision. Float to integer truncates toward zero. A value that does not fit the target, including NaN and infinities cast to an integer, raises `ExecutionError`. Null stays null. |
| C-DIV | `div` on integers yields `float64`; on floats it keeps the float type. `intDiv` truncates toward zero. `mod` has the sign of the dividend. An integer zero divisor raises `ExecutionError` in `div`, `intDiv` and `mod`. Float division and float `mod` follow IEEE 754. |
| C-ROUND | `floor`, `ceil` and `round` are defined for floats. `round` goes to the nearest integer with ties to even. NaN and infinities pass through; the sign of zero is kept. |
| C-BIN | `x.bin(width, origin)` is `origin + floor((x - origin) / width) * width`, with `origin` defaulting to 0 and `width` greater than 0. For integers the floor is exact for negative values too. |
| C-NAN-PREDICATE | In predicates, IEEE 754 applies: NaN is not equal to, less than or greater than anything, and `neq` with NaN is true. Use `isNaN()`. |
| C-NAN-ORDER | For grouping, distinct counts, `min`, `max` and sorting, NaN equals NaN and is greater than every number. `-0.0` and `0.0` are one group, reported as `0.0`. |
| C-INT64-JS | `int64` and `uint64` values are `bigint` in JS. A safe-integer `number` is accepted where a 64-bit value is expected. |

### Sorting

| ID | Rule |
| --- | --- |
| C-SORT-STABLE | Sort is stable: rows with equal keys keep their input order. `sort().limit(k)` returns exactly the first `k` rows of the full sort. |
| C-NULL-SORT | Sort places nulls last in both directions unless `nullsFirst()` is set, which places them first in both directions. |

### Grouping and aggregates

| ID | Rule |
| --- | --- |
| C-GROUP-ORDER | Groups, and `distinct` rows, come out in order of first occurrence. Null keys form one group. |
| C-AGG-TYPES | `count()` counts rows; `c.x.count()` counts non-null values; both are `uint32`. `sum` of signed integers is `int64`, of unsigned `uint64`, of floats `float64`. `avg` is `float64`: it sums the values as `float64` (C-FLOAT-SUM) and divides by the non-null count. `min` and `max` keep the input type. `countDistinct` is exact, counts non-null values, and is `uint32`. All aggregates except `count()` skip nulls. |
| C-FLOAT-SUM | Float sums use Neumaier compensated summation in row order. A backend may not reorder a float sum. If the running sum becomes infinite or NaN, that running sum is the result and the compensation term is discarded. |
| C-EMPTY-AGG | Over no values (no rows, or only nulls), `count` is 0 and `sum`, `min`, `max` and `avg` are null. Grouping zero rows yields zero groups. Aggregating without keys yields exactly one row, even over zero rows. |

### Strings

| ID | Rule |
| --- | --- |
| C-STR-ORDER | Strings compare by Unicode code point. This is bytewise UTF-8 order and differs from JavaScript's default UTF-16 order above U+FFFF. |
| C-STR-LENGTH | `length` counts code points, not UTF-16 units, and is `int32`. |
| C-STR-CASE | `lower` and `upper` use locale-independent Unicode case mapping and keep the input storage type. A dictionary result is re-deduplicated, so different entries that map to the same string share one code. |
| C-STR-MATCH | `startsWith`, `endsWith` and `contains` match literally; there are no patterns. The empty string matches everything. |
| C-STR-MIX | `utf8` and `dictionary` expressions are interchangeable in one operation: comparisons, string functions, `coalesce`, `ifElse` and `isIn` treat both as strings. A string-producing result keeps the storage type of its first string operand. |

### Dates and times

| ID | Rule |
| --- | --- |
| C-TIME | `date32` is a calendar day; loading a `Date` with a time of day raises `SchemaError`. `timestamp` is an instant with millisecond precision. All calendar arithmetic is in UTC; there are no time zones. `dateTrunc(unit)` rounds down to the start of the unit, also before the epoch. `extract(unit)` returns one calendar field as `int32`; month and day start at 1. Units: `year`, `month`, `day` for both types, plus `hour`, `minute`, `second` for `timestamp`. |

### General

| ID | Rule |
| --- | --- |
| C-LIVE | `append` adds rows at the end of a table. A run sees the table exactly as it stood when the run started: rows appended, or dropped by the retain window, during the run do not affect it. A table built by appends gives the same results as one built from the same rows at once. With `retain: { rows: N }` the table holds exactly the most recent `N` rows. An `append` with a bad value is rejected whole and leaves the table unchanged. |
| C-LIVE-KEY | A keyed live table keeps at most one row per key. `upsert(rows)` inserts new keys and replaces whole rows for existing keys, preserving an existing key's position; `delete(keys)` removes matching rows and returns the removed count. A key with a null or missing component is rejected. Key components are compared by their typed value: `bigint`, `Date`, string, number and boolean values of the same written form are distinct keys. Mutations are atomic: invalid input changes nothing. A run that has started sees the table exactly as it stood when it started, as C-LIVE requires. Deleting and re-inserting the same key moves it to the end. A rejected mutation raises `SchemaError` saying what was expected, what was found and where (row, key, component). |
| C-CHUNK | A result never depends on how execution is chunked or sliced. An aborted run rejects with `AbortError` and leaves the table unchanged. A run that raises does so whatever the chunk size. |
| C-BETWEEN | `between(low, high)` is inclusive at both ends and equals `gte(low).and(lte(high))`. |
| C-DETERMINISM | Every registry function is deterministic. Non-deterministic functions are excluded from the MVP. |
### Joins and windows

| C-JOIN | `join(right, keys, how)` matches a left row with a right row when every key component is non-null and equal. Strings compare by value whether stored as `utf8` or `dictionary`; other components compare by their typed value. Duplicate keys produce every matching pair. The output columns are the left columns followed by the right columns; duplicate names are rejected. `inner` emits matched pairs in left order, then right order within each left row. `left` and `full` append unmatched left rows in left order; `right` and `full` append unmatched right rows in right order, with the other side's columns null. The right table is bound when the plan is compiled and a run sees both tables as they stood when it started. A backend that cannot run a join raises `PlanError`; it never substitutes another semantics. |
| C-WINDOW | `window({ partitionBy, orderBy, functions })` keeps the input rows and columns in order and adds one `int64` column per function: `row_number`, `rank` or `dense_rank`. Null partition keys group together; order keys place nulls as their sort key says, and rows equal on every order key (nulls equal) form one peer group. Within a partition, `row_number` counts 1..n in order with input order breaking ties, `rank` is one plus the number of rows before the first row of the peer group, and `dense_rank` is one plus the number of earlier peer groups. An empty input gives no rows. A backend that cannot run a window raises `PlanError`; it never substitutes another semantics. |

## Permitted divergence

There is exactly one. Case mapping follows the Unicode version of the runtime,
so `lower` and `upper` may differ between backends for recently added
characters. Cross-backend tests exclude those characters.

## Known limits

- `avg` and `sum` of 64-bit integers convert through `float64` only for `avg`;
  values above 2^53 lose precision there.
- Casts exist between numeric types only.

## Changing the contract

A rule changes only with the owner's agreement. Record the change in
`docs/DECISIONS.md`, update this file, then update the golden tests, then the code.
