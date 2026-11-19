# Substrait export and import

`src/substrait.ts` converts an `IrPlan` to and from a plain JSON object. There
is no runtime dependency: the file uses only `errors`, `ir`, `registry`,
`schema` and `types`. `importPlan(exportPlan(plan))` deep-equals `plan`,
including literal kinds, nulls, declarations and field order.

## Pinned version

`SUBSTRAIT_VERSION = '0.108.0'`. This is the release of
[substrait-io/substrait](https://github.com/substrait-io/substrait/tree/v0.108.0)
whose `extensions/*.yaml` files and `proto/substrait/algebra.proto` were used
to check every function name in `src/registry.ts`. The allowlist lives in
`tests/substrait.test.ts`, and the exported version object is
`{ major_number: 0, minor_number: 108, patch_number: 0, producer: "zamda" }`.
Import rejects any other version.

## JSON shape

The top-level object has `version`, `ir_version`, `input`, `relations`, `root`,
`output` and `params`. `relations` is the flat IR node table; relation `i` is
node `i` and names its input by index. The relation names follow Substrait:

| IR node | `rel` | Other fields |
| --- | --- | --- |
| `scan` | `read` | `schema` |
| `filter` | `filter` | `input`, `schema`, `condition` |
| `project` | `project` | `input`, `schema`, `expressions` |
| `aggregate` | `aggregate` | `input`, `schema`, `groupings`, `measures` |
| `sort` | `sort` | `input`, `schema`, `sorts` |
| `limit` | `fetch` | `input`, `schema`, `count` |

Expressions use `expr` as the tag: `field`, `literal`, `param`, `call`,
`ifThen` (Substrait's IfThen, for the registry's `if_else`), `cast` and `in`
(Substrait's SingularOrList). A `call` carries both `fn` (the zamda registry
name, so shared Substrait names stay distinct) and `substrait` (the pinned
extension name, e.g. `functions_arithmetic:add`). Aggregates do the same; their
`distinct` flag is Substrait's `DISTINCT` invocation for `count_distinct`.
An `in` expression has either `values` or `param`, never both; an aggregate
has `arg: null` for a row count.

Types are `{ "substrait": "i32", "zamda": "int32", "nullable": true }`.
Substrait's unsigned integers and the `dictionary` string are type
variations; the `zamda` name records which one is meant. Every zamda column is
nullable.

Literal values are tagged:

| JS value | JSON |
| --- | --- |
| `true` / `false` | `{ "kind": "boolean", "value": true }` / `false` |
| `number` | `{ "kind": "number", "value": "1.5" }` |
| `bigint` | `{ "kind": "bigint", "value": "9223372036854775807" }` |
| `string` | `{ "kind": "string", "value": "..." }` |

Numbers are canonical decimal strings, with `-0`, `NaN`, `Infinity` and
`-Infinity` written as those exact strings. Bigints are canonical decimal
integer strings. This keeps JSON free of values that lose information in
`JSON.stringify`, and lets the importer reject alternate spellings.

## Import checks

`importPlan` accepts `unknown` and checks every object's exact field set,
types, versions, registry names, Substrait names, node indices, null forms,
literal encodings and expression depth. It throws `PlanError` naming what was
expected, what was found and where (for example
`plan.relations[2].condition.args[0].expr`). It does not run the IR validator;
call `validate()` on the result if semantic checks are wanted.
