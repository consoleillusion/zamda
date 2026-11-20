# The IR

The IR is the one format every backend consumes. Types are in `src/ir.ts`.
Current version: `IR_VERSION = 2`. Bump it on any incompatible change.

## Plan

| Field | Meaning |
| --- | --- |
| `version` | IR version |
| `input` | Schema the plan expects from the table |
| `nodes` | Flat node table; node 0 is the scan |
| `root` | Index of the node whose output is the result |
| `output` | Schema of the result |
| `params` | Declared parameters: name, type, and whether it is a list |

## Nodes

Every node carries `schema`, its output schema. Every node except `scan` has
`input`, the index of an earlier node. A plan may hold more than one `scan`:
`join` binds a second table through an extra scan node at `right`, and the
pipeline carries that table alongside the plan (D-076).

| `op` | Fields | Output schema | Substrait relation |
| --- | --- | --- | --- |
| `scan` | none | the table's | Read |
| `filter` | `predicate` (bool) | same as input | Filter |
| `project` | `exprs` | one column per expression | Project |
| `aggregate` | `keys`, `aggs` | keys, then aggregates | Aggregate |
| `sort` | `keys` (expr, descending, nullsFirst) | same as input | Sort |
| `limit` | `count` | same as input | Fetch |
| `join` | `right` (scan index), `leftKeys`, `rightKeys`, `how` | left columns then right columns | Join |
| `window` | `partitions`, `sorts`, `functions` | input columns then one int64 per function | ConsistentPartitionWindow |

How the DSL lowers to nodes:

| DSL | Node |
| --- | --- |
| `select`, `withColumns`, `rename` | `project` |
| `groupBy().agg()` | `aggregate` |
| `agg()` without `groupBy` | `aggregate` with no keys |
| `distinct()` | `aggregate` with every column as a key and no aggregates |
| `sort().limit(k)` | `sort` then `limit`; a backend may fuse them into a top-k |
| `join(right, keys, how)` | extra `scan` for the right table, then `join` |
| `window({ partitionBy, orderBy, functions })` | `window` |

## Expressions

| `kind` | Fields | Meaning | Substrait |
| --- | --- | --- | --- |
| `field` | `index`, `type` | Column `index` of the input node's schema | FieldReference |
| `literal` | `value`, `type` | A typed constant | Literal |
| `param` | `name`, `type` | A scalar value supplied at `execute()` | Literal, bound on export |
| `call` | `fn`, `args`, `type` | A registry function applied to arguments | ScalarFunction |
| `cast` | `arg`, `type` | Checked numeric conversion | Cast |
| `in` | `arg`, `values` or `param`, `type` | List membership; exactly one of `values` and `param` is set | SingularOrList |

Every expression carries its result `type`. The validator recomputes call types
from the registry and rejects a plan whose stated types disagree.

Literal values are `boolean`, `number`, `bigint` or `string`. Dates are numbers:
days for `date32`, milliseconds for `timestamp`.

Sugar never reaches the IR: `between` is `gte` and `lte`; `bin` is arithmetic
plus `if_else`; numeric promotion is `cast` nodes around the operands.

## Example

```ts
pipe(Users).filter(c => c.age.gt(1)).limit(3).compile().explain();
```

```
#0 scan -> [name:utf8, country:utf8, age:int32, active:bool]
#1 filter gt($2, 1) -> [name:utf8, country:utf8, age:int32, active:bool]
#2 limit 3 -> [name:utf8, country:utf8, age:int32, active:bool]
```

## Serialization

The IR is plain data today and passes to the JS backend as objects. A compact
binary encoding is designed with the WASM backend (Milestone 3), where decode
speed and untrusted-input validation matter.

## Limits

The validator caps a plan at 1,024 nodes, expressions at 256 levels of nesting,
and a literal in-list at 65,536 values.
