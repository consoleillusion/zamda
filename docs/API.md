# zamda API reference

The typed surface of zamda: what `import from 'zamda'` gives you, what every
method does, and what it costs you to get it wrong. Semantics (nulls, overflow,
promotion, ordering) live in [CONTRACT.md](CONTRACT.md); this page documents the
functions, with one-line semantics each. Defaults and performance notes are
documented as measured in [BENCHMARKS.md](BENCHMARKS.md). Everything described
here is stable API; the engine internals are not.

## Contents

- [Pitfalls](#pitfalls)
- [Types and values](#types-and-values)
- [Tables](#tables)
- [Pipelines](#pipelines)
- [Groups and aggregates](#groups-and-aggregates)
- [Expressions](#expressions)
- [Parameters](#parameters)
- [Execution](#execution)
- [Results](#results)
- [Errors](#errors)
- [Backends and the IR](#backends-and-the-ir)
- [Linting](#linting)

## Pitfalls

Read this first. Every one of these has "worked" for someone and then silently
produced the wrong answer.

```ts
// WRONG: these are JavaScript operators producing JavaScript booleans
.filter(c => c.active && c.age.gte(18))      // filter keeps only the right branch
.filter(c => !c.active)                      // keeps nothing
.filter(c => c.age === 18)                   // wrong type, wrong meaning
const x = c.a && c.b;                        // always truthy, right-hand side wins

// RIGHT: everything in an accessor callback is a zamda expression
.filter(c => c.active.and(c.age.gte(18)))
.filter(c => c.active.not())
.filter(c => c.age.eq(18))
```

- **Every value in an accessor callback is a zamda expression object.** A `&&`
  between two of them evaluates both as JS booleans (both are truthy objects),
  `!` negates to `false`, and `===` is reference equality on objects. They
  typecheck and produce answers nothing like what was written.
- **`lit(value, type)` is how you put a JS value in an expression.** Passing a
  raw value to a method like `c.age.gte(18)` works (the literal is typed to the
  column), but comparing against `null` does not: `c.age.eq(null)` is rejected;
  use `c.age.isNull()`.
- **Int64 types are `bigint` in JS.** Columns typed `int64`/`uint64` give and
  take `bigint`. A safe integer `number` is accepted where a 64-bit value is
  expected (C-INT64-JS). All other integer columns hold JS `number`s.
- **Null is not false.** Filters keep only rows where the predicate is *true*;
  null and false are dropped (C-FILTER). Comparisons with a null operand are
  null (C-NULL-LOGIC); `and`/`or` are three-valued.
- **Case of the string search is your problem.** `lower()` before `contains` if
  you want case-insensitivity; zamda does not guess.

The ESLint rule `zamda/no-js-boolean-ops-in-accessor-callbacks`
(`bun run lint`) flags exactly the patterns in the first block.

## Types and values

Types are the `t` constants; they are plain frozen objects and names match
Apache Arrow and Substrait.

| Name | JS storage | `t` |
| --- | --- | --- |
| `bool` | boolean | `t.bool` |
| `int8`, `int16`, `int32` | number | `t.int8` … |
| `uint8`, `uint16`, `uint32` | number | `t.uint8` … |
| `int64`, `uint64` | bigint | `t.int64`, `t.uint64` |
| `float32`, `float64` | number | `t.float32`, `t.float64` |
| `utf8` | string | `t.utf8` |
| `dictionary` | string (deduplicated) | `t.dictionary` |
| `date32` | Date | `t.date32` |
| `timestamp` | Date | `t.timestamp` |

```ts
import { t, type JsOf, type TypeName } from 'zamda';
const age: typeof t.int32 = t.int32;
const likeAge: JsOf<typeof t.int32> = 42; // number; for t.int64 it is bigint
```

- `JsOf<D>` maps a data type to its JavaScript type (`date32`/`timestamp` are `Date`).
- `TypeName` is the union of type names (`'bool' | 'int8' | …`).
- `DataType<N extends TypeName>` is the frozen `{ name: N }` descriptor.
- Every column is nullable; there is no non-null type.

## Tables

A **schema** is a frozen map from column name to type:

```ts
import { schema, t } from 'zamda';
const Users = schema({ name: t.utf8, country: t.dictionary, age: t.int32, active: t.bool });
Users.fields.name.type.name;   // 'utf8'
Users.list[0];                 // { name: 'name', type: t.utf8 } — declaration order
```

`schema()` throws `SchemaError` on an empty schema. `Fields` is the record type
of column name to type. `RowOf<F>` is what `table()` rows look like: every
column of the schema, each `JsOf<T> | null`. `Field` is one column's
`{ name, type }`.

Create a table with **row objects** (missing property means null) or **one
array per column**:

```ts
import { table } from 'zamda';

// Rows: every value checked against the column's type.
const t1 = table(Users, [{ name: 'Ada', country: 'GB', age: 36, active: true }]);

// Columns: a typed array of the column's own type (Int32Array for int32, ...) is used
// without copying; a plain array is checked value by value and may hold nulls.
const t2 = table(Users, {
  columns: {
    name: ['Ada', 'Grace'], // utf8 columns are string arrays
    country: { codes: new Int32Array([0, 1]), dictionary: ['GB', 'FR'] }, // dictionary already encoded
    age: new Int32Array([36, 41]),
    active: new Uint8Array([1, 0]),
  },
});
```

- **dictionary columns** can be entered already encoded as
  `{ codes, dictionary, nullCode? }`: the dictionary entries are checked for
  uniqueness, the codes are checked against it once, and `Int32Array` with no
  nulls is not copied. Null rows in the encoded form are a `nullCode` outside
  the dictionary, or a negative code. The routes loader uses this path.
- **`table()` validates every value** at load: ranges for integers, `Date`
  objects with no time-of-day for `date32`, millisecond precision for
  `timestamp`. A bad value throws `SchemaError` (the row index or column, the
  expected type, and what was found) — the load is all-or-nothing.
- **`table()` columns may be reused.** When you hand over a typed array of the
  exact storage type with no nulls to convert, the table reads it in place.
- **`append(rows | columns)`** adds rows forever at the end; `retain: { rows: N }`
  on `TableOptions` keeps the most recent N (C-LIVE). **A run sees the table as
  it stood when the run started.** `append` with a bad value is rejected whole.

`RowInput<F>` is what `table()` accepts for rows: `Partial<RowOf<F>>` — each
property of another type is checked against the column.

### `keyedTable(schema, keyFields, data, options?)`

Creates a `KeyedTable<F>`: a live table with at most one row per key. `keyFields`
is a list of column names. Row objects or one array per column are accepted, as
for `table()`. `upsert(rows)` inserts new keys and replaces whole rows for
existing keys in place; `delete(keys)` returns the number of rows removed;
`get(key)` and `has(key)` read the current rows; `current()` returns the backend
table snapshot; `rowCount` and `rowsDropped` report its size and how many rows
have been removed over its life; `dispose()` frees backend memory. Mutation is
atomic and a started run sees the table as it stood when it started
(C-LIVE-KEY). `Key`, `KeyComponent`, `KeyedTableFactory` and `KeyFields` are the
corresponding types. `createWasmBackend(host).keyedTable` is the WASM-bound factory.

## Pipelines

```ts
import { pipe, t } from 'zamda';
const plan = pipe(Users)
  .filter((c, p) => c.active.and(c.age.gte(18)))
  .groupBy(c => ({ country: c.country, decade: c.age.bin(10) }))
  .agg(() => ({ n: count() }))
  .compile();
```

- **`pipe(schema, params?)`** starts a pipeline. With `params`, it declares the
  parameter types (`{ minLen: t.uint8, ... }`); the callback gets them as the
  second argument (`p.minLen`). Missing or extra values reject the run before it
  starts (C-PARAM). A pipeline is compiled once and re-run with new parameters.
- **`.filter(c => boolExpr)`** keeps rows where the predicate is true; null and
  false are dropped (C-FILTER). `filter` preserves input order (C-ROW-ORDER).
- **`.select(c => ({ ... }))`** keeps only the listed columns, evaluated once per row.
- **`.withColumns(c => ({ ... }))`** replaces and adds columns in one pass; existing names are replaced.
- **`.rename({ old: 'new' })`** renames columns; the IR changes names, nothing is computed.
- **`.distinct()`** drops duplicate rows (on the currently selected columns), order of first occurrence (C-GROUP-ORDER).
- **`.sort(c => key | readonly key[])`** takes a key or several, `.asc()` / `.desc()` per key, `.nullsFirst()` to move nulls (C-NULL-SORT). Stable (C-SORT-STABLE).
- **`.limit(count)`** keeps the first `count` rows; when directly after a `sort`, exactly the first `k` rows of the full sort.
- **`.groupBy(c => ({ ... }))`** starts a grouped pipeline; see [Groups and aggregates](#groups-and-aggregates).
- **`.agg(() => ({ ... }))`** (on the ungrouped pipeline): one row for the whole input, even for zero rows (C-EMPTY-AGG).
- **`.join(right, { left, right }, how?)`** binds a right table at compile time and matches rows on equal, non-null key columns. `how` is `inner` (default), `left`, `right` or `full`; the output has the left columns followed by the right ones, and duplicate names are rejected (C-JOIN). The plan keeps the bound table, so `execute(left)` needs no second argument; the right table must outlive the plan. The WASM backend raises `PlanError` for a join (D-077).
- **`.window({ partitionBy, orderBy, functions })`** keeps the input rows in order and appends one `int64` column per function (`row_number`, `rank` or `dense_rank`) over each partition's peer groups (C-WINDOW). The WASM backend raises `PlanError` for a window (D-077).
- **`.compile()`** builds a reusable `Plan` — validating the whole plan, optimising it, and producing the IR. A pipeline compiles without touching any table, so compilation is the right place to catch DSL mistakes.

Expression callbacks receive `c` (the columns) and, when
parameters are declared, `p` (the parameters). **No JavaScript appears in the
callback except building expressions** — there is no access to row values.

## Groups and aggregates

Group keys are expressions or column references; groups come out in order of
first occurrence (C-GROUP-ORDER); null keys form one group.

```ts
pipe(Routes)
  .groupBy(c => ({ origin_as: c.origin_as, as_name: c.as_name }))
  .agg(() => ({ routes: count(), distinct: c.rir.countDistinct() }))
```

Inside `.agg(() => ...)`, each entry is an `AggExpr` (or a mix of plain
expressions treated as values). Aggregates:

| Aggregate | Type | Notes |
| --- | --- | --- |
| `count()` (top-level) | `uint32` | rows, ignoring validity |
| `c.x.count()` (method) | `uint32` | non-null values |
| `c.x.countDistinct()` (method) | `uint32` | exact; non-null values; NaN counts as itself; `-0`/`0` one |
| `c.x.sum()` | `int64`/`uint64`/`float64` | checked on integer sums every partial sum (C-OVERFLOW); Neumaier in row order for floats (C-FLOAT-SUM); NaN yields NaN, like JS |
| `c.x.avg()` | `float64` | float64 sum / non-null count (C-AGG-TYPES) |
| `c.x.min()` / `c.x.max()` | input type | keeps the input type; NaN is greatest; ties keep the first seen |
| all except `count()` | — | skip nulls |

Groups over zero rows yield zero groups; a non-grouped aggregation always
yields exactly one row (C-EMPTY-AGG). Distinct counts and sums of `bigint`
wider than 2<sup>53</sup> are exact — nothing goes through `number`.

## Expressions

Expression classes by column type: `BoolExpr` (bool), `OrdExpr`
(numbers, strings, dates — anything with an order), `NumExpr` (numbers),
`StrExpr` (strings), `TimeExpr` (date32 and timestamp). `AggExpr` is an
aggregating expression from `.agg`, `SortKey` a key for `.sort()`. `Expr` is the
common base every expression extends.

`lit(value, type)` makes a typed literal; `Operand<D>` in the signatures below
is what methods accept: an expression of that type or a JS value that fits it
(a literal typed to the left side — C-PROMOTION). Mismatched types are rejected
at the line that made them, at compile time.

### Logic (on BoolExpr)

| Method | Value |
| --- | --- |
| `.and(other)` | three-valued AND (C-NULL-LOGIC) |
| `.or(other)` | three-valued OR |
| `.not()` | three-valued NOT (null stays null) |

### Comparison (on OrdExpr and its children)

| Method | Value |
| --- | --- |
| `.eq(other)` | equal; null if either side is null |
| `.neq(other)` | not equal |
| `.lt(other)`, `.lte(other)`, `.gt(other)`, `.gte(other)` | ordering; NaN obeys IEEE in predicates (C-NAN-PREDICATE) |
| `.between(low, high)` | `gte(low).and(lte(high))`; inclusive at both ends (C-BETWEEN) |
| `.isIn(list)` | true where the value equals a list entry; `null` where the value is null; an empty list matches nothing (C-IN) |
| `.isIn(listParam)` | same, against a `list(D)` parameter |
| `.isNull()` | true where the value is null; never null (C-NULL-LOGIC) |
| `.isNaN()` | true where the float is NaN (floats only) |
| `x.coalesce(y)` | x where it is not null, else y (C-IF) |

### Numbers (on NumExpr)

| Method | Value |
| --- | --- |
| `.add`, `.sub`, `.mul` | promotion to the common type (C-PROMOTION); checked: integer overflow raises (C-OVERFLOW); floats follow IEEE 754 |
| `.div`, `.intDiv`, `.mod` | `div` of integers yields `float64`; `intDiv` truncates toward zero; `mod` follows the dividend's sign; integer zero divisor raises (C-DIV) |
| `.wrappingAdd`, `.wrappingSub`, `.wrappingMul` | integer wrap modulo 2<sup>width</sup> instead of raising — used intentionally in projection hashes |
| `.neg()`, `.abs()` | checked (C-OVERFLOW); `neg` not defined for unsigned types |
| `.floor`, `.ceil`, `.round` | floats; `round` is ties-to-even (C-ROUND); sign of zero kept |
| `.isNaN()` | true where NaN (floats only) |
| `.bin(width, origin?)` | the lower edge of the bin `[origin + k*w, origin + (k+1)*w)` holding the value; width > 0 (C-BIN) |
| `.cast(t.x)` | numeric casts only; integer to integer/floats, floats back truncate toward zero; out of range or NaN/inf to integer raises; null stays null (C-CAST) |

### Strings (on StrExpr; utf8 / dictionary)

| Method | Value |
| --- | --- |
| `.lower()`, `.upper()` | locale-independent case mapping (C-STR-CASE) |
| `.length()` | Unicode code points (C-STR-LENGTH), `int32` |
| `.startsWith(s)`, `.endsWith(s)`, `.contains(s)` | literal match, not patterns; empty string matches everything (C-STR-MATCH) |
| `.eq(other)`, `.neq`, `.lt`… | code-point order; differs from JS default above U+FFFF (C-STR-ORDER) |

### Dates (on TimeExpr: date32 and timestamp)

| Method | Value |
| --- | --- |
| `.dateTrunc('year' \| 'month' \| 'day')` | rounds down to the start of the unit, UTC (C-TIME) |
| `.extract('year' \| 'month' \| … 'second')` | one calendar field as `int32`; month and day start at 1; `hour`, `minute`, `second` only for `timestamp` |

Numbers and dates compare with promotion; strings compare in code-point order.
Everything else about equality, ordering and nullability of mixed types follows
the contract.

### `lit`, `ifElse`, `count`, and the method-form aggregates

- **`lit(value, type)`** — a typed literal expression. Passing a raw value into a
  comparison or arithmetic method does the same thing, with the type of the
  literal taken from the column (C-PROMOTION); `lit` is for when you need the
  literal alone, or a different type.
- **`ifElse(cond, whenTrue, otherwise)`** — C-IF exactly; `otherwise` may be an
  expression or a JS value.
- **`count()`** — aggregate of a full pipeline (or `.agg(() => ({ n: count() }))`).
- Method-form aggregates on any expression: `.count()`, `.countDistinct()`, `.sum()`, `.avg()`, `.min()`, `.max()`.

## Parameters

Parameters are declared with `pipe()` and bound at `execute()`:

```ts
const top = pipe(Routes, { minLen: t.uint8, maxLen: t.uint8, regions: list(t.dictionary) })
  .filter((c, p) => c.path_len.between(p.minLen, p.maxLen).and(c.rir.isIn(p.regions)))
  .compile();
await top.execute(routes, { params: { minLen: 2, maxLen: 6, regions: ['APNIC'] } });
```

- **Missing, extra or wrongly typed parameters reject before any work starts** (C-PARAM) — the error names the parameter.
- **`list(D)`** declares a list parameter of type `D`; inside, `.isIn(p.regions)` matches a row against the list. Use `t.dictionary` lists to hold strings.
- Scalar bool params decide `and`/`or` (D-045/D-052): a control left "off" folds away before execution.
- Parameters make one plan reusable across dashboard interactions; the plan is compiled once and parameters cost nothing to bind.

## Execution

```ts
const plan = pipe(Users).filter(c => c.active.eq(true)).compile();
const result = await plan.execute(users);
```

- **Execution is chunked and cooperative by default** (65,536 rows per chunk, yielding to the event loop about every 8 ms). Nothing depends on how it is chunked or sliced (C-CHUNK).
- **`signal`** — an `AbortSignal`; aborting rejects with `AbortError` within one time slice; the table is unchanged.
- **`onProgress`** — `( { rowsScanned, rowsTotal } )` between slices; always called once at the end.
- **`chunkRows`** — rows per chunk (default 65,536; never changes results).
- **`sliceMs`** — ms of work per time slice before yielding (default 8). Set a large number to run without yielding.
- **`session`** — an opaque handle from a backend that offers one (the WASM backend shares work between runs of one interaction). The JS backend ignores it.
- **`latest(plan)`** — wraps a plan so a new run aborts the one in flight; remember `AbortError` from a superseded run.

Plans raising: a run that hits integer overflow, an out-of-range cast, a zero
divisor or a cancelled signal rejects with the typed error. A plan that does not
typecheck is rejected at its own line. Validation of a plan happens once, at
`.compile()` — `execute()` after that only binds parameters.

## Results

```ts
result.rowCount;              // number of rows
result.toArray();             // RowOf<Out>[] — plain row objects; nulls for null values
result.columns();             // typed arrays by name, for charting libraries
result.column('age');         // { values, valid? } for one column; Dictionary columns decode to strings
```

- `toArray()` materialises rows. Every column is `JsOf | null`; dictionary columns decode to strings. Dates for `date32`/`timestamp` columns are `Date` objects.
- `columns()` gives typed arrays without copying when nothing is null:
  `int32` → `Int32Array`, `uint64` → `BigUint64Array`, `bool` → `Uint8Array`, others as documented per type. Date columns come out as numbers (days or milliseconds since the epoch).
- `column(name)` returns `{ values, valid }` for one column; `valid` is `Uint8Array` (1 = present) only when some value is null, and decodes dictionary columns to strings.
- **NaN is handled per type; `int64`/`uint64` hold real `bigint`s everywhere** (toArray, columns, column — no precision loss at any point).

## Errors

All zamda errors derive from `ZamdaError` and carry a `code`:

| Class | Code | Raised |
| --- | --- | --- |
| `SchemaError` | `schema` | a table/row value does not match the declared schema; the message names the row, column, expected type and found value |
| `TypeCheckError` | `type` | a DSL operation combines incompatible types; raised at the line that made it |
| `ExpressionError` | `expression` | the DSL was used in a way that is not an expression (e.g. a JS operator on a zamda value) |
| `PlanError` | `plan` | the IR failed validation, or a backend cannot run the plan |
| `ExecutionError` | `execution` | a runtime contract failure: integer overflow, out-of-range cast, zero divisor, sum overflow (C-OVERFLOW) |
| `MemoryError` | `memory` | the run would exceed the byte limit set on the backend (WASM engines only) |
| `HandleError` | `handle` | a table or engine instance is disposed, or was lost with its engine |
| `AbortError` | `abort` | the run was cancelled through its signal |
| `EngineCrashError` | `crash` | the WASM engine trapped (bug, or an allocation past a limit that could not be refused); the run produced nothing and the instance was replaced |
| `ZamdaError` | any | base class with `.code`; use `instanceof ZamdaError` to catch them all |

Errors are structured: the message says what was expected, what was found, and
where (row, column, node); the `.code` is stable for programmatic handling.

## The WASM accelerator: `zamda/wasm`

```ts
import { wasmEngine } from 'zamda/wasm';

const engine = await wasmEngine();               // a Web Worker in a page, this thread in Bun/Node
const big = await engine.load(Users, rows);      // rows or columns, copied into engine memory once
const out = await plan.execute(big, { signal }); // the same compiled plan, the same result
await big.dispose();                             // or: await using big = await engine.load(...)
```

- **`wasmEngine(options?)`** starts the engine. Options: `wasm` (a URL, bytes or a compiled
  `WebAssembly.Module`; default the `zamda-engine.wasm` shipped beside the entry point), `worker`
  (`true`/`false`, or a function returning your own `Worker` when your bundler needs the URL spelled
  out: `() => new Worker(new URL('zamda/zamda-worker.js', import.meta.url), { type: 'module' })`),
  `memoryLimitBytes` (0 to 4 GiB; past it a load or run raises `MemoryError` and the engine stays
  healthy) and `stallMs` (worker only, default 5000: an aborted run that holds the worker longer is
  treated as a stuck engine, the worker is terminated and replaced).
- **`engine.load(schema, data, options?)`** returns a table resident in the engine. `append()` adds rows
  (C-LIVE); `options.reload` lets the table be rebuilt if the engine has to be replaced after a trap,
  otherwise the table is lost and raises `HandleError`. `options.transfer: true` moves typed arrays to the
  worker instead of copying them (they are detached on the page).
- **`engine.session()`** groups the runs of one interaction so they share filter work; pass it as
  `session` to `execute()`. `engine.stats()` counts engine runs and JS fallbacks (see below).
- **`engine.terminate()`** stops the engine; its tables are gone.
- A plan the engine cannot run yet (for now: string-valued results such as `lower(x)` as an output
  column, comparisons between two string columns) runs on the JS executor over the same snapshot and
  gives the same result (D-067); `stats().fallback` counts those runs. Joins and windows raise
  `PlanError` (D-077).

## Backends and the IR

Nothing about the IR is public API; **`IR_VERSION`** says which IR version the
library reads and writes — bump rule: any change to the binary IR format bumps
this number, and [IR-BINARY.md](IR-BINARY.md) documents the format.

A backend is a `Backend`: `execute(plan, table, options) → Promise<ResultData>`.
The JS backend (`table()`) and the WASM backend (via `zamda/wasm`) both conform
to it, and neither substitutes different semantics: the WASM backend either runs a
plan itself, runs it on the JS executor with the same results (counted in
`stats().fallback`), or raises `PlanError`. `Table` is the abstract handle; `ResultData` is
`{ schema, columns, rowCount }` over the same column storage (see ARCHITECTURE).

The rest — `Backend`, `BackendOptions`, `ResultData`, `Table`, `RunSession`,
the IR types (`IrPlan`, `IrNode`, …) — exists for backend authors and
advanced hosts, and is typed but not stable in the same way the DSL is.

## Type-level helpers

Everything here is erased at run time; nothing in this section costs bytes in your bundle.

| Symbol | What it is |
| --- | --- |
| `Cols<F>` | the columns object a pipeline callback receives: `{ readonly name: ExprFor<type> }` over the schema |
| `FieldsOf<O>` | the schema produced by an object of expressions or aggregates, column by column |
| `ListDecl<D>` | a `list(D)` declaration |
| `ParamDecls` | the shape of a params declaration: a record of name to data type (or a list) |
| `ParamExprs<P>` | what a callback's second argument holds under declaration `P` |
| `ParamValues<P>` | what `execute({ params })` accepts under declaration `P` |
| `NoParams` | the empty params record, default for unparameterised pipelines |
| `ExprFor<D>` | which expression class a column of type D produces (`NumExpr`, `StrExpr`, …) |
| `DateUnit`, `TimeUnit` | the units `dateTrunc`/`extract` accept (`'year'`, `'month'`, `'day'`, …) |
| `ListParam<D>` | a list parameter expression, as seen in a callback; built by `list()` |
| `ExecuteOptions` | the options object `execute()` takes (`params`, `signal`, `onProgress`, `chunkRows`, `sliceMs`, `session`) |
| `ExecuteArgs` | the argument tuple of `execute()`: params are required exactly when the pipeline declares them |
| `LatestRun` | the return type of `latest()` |
| `ColumnValues` | the storage view behind a column: typed arrays for numbers and dates, string arrays for utf8/dictionary |
| `ColumnInput` | the `{ columns: { one: array } }` object `table()` accepts |
| `DictionaryInput` | a dictionary column already encoded: `{ codes, dictionary, nullCode? }` |
| `JsTable` | the JS-backend table class returned by `table()`; implements `Table` |
| `TableInput` | `readonly RowInput[] | ColumnInput<F>` |
| `IrAggregate`, `IrExpr`, `IrParam`, `IrSortKey`, `IrWindowFunction`, `JoinKind`, `WindowFnName` | IR node types (engines and serialisation); unstable |
| `IR_VERSION` | the IR version this library reads and writes |

## Linting

`bun run lint` runs ESLint over this repository with one zamda-specific rule,
`zamda/no-js-boolean-ops-in-accessor-callbacks`. It type-checks accessor
callbacks and flags exactly the JavaScript operators that silently produce wrong
answers there: `&&`, `||`, `!`, `===`, `!==`, `==`, `!=`. It does not flag
native `Array.prototype.filter` calls (a call is only an accessor callback when
its callee's declaration comes from `Pipeline` or `Grouped`), and without type
information it stays silent. The message tells you the DSL spelling to use.
