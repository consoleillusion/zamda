# The IR

The IR is the one format every backend consumes. Types are in `src/ir.ts`.
Current version: `IR_VERSION = 1`. Bump it on any incompatible change.

## Plan

| Field | Meaning |
| --- | --- |
| `version` | IR version |
| `input` | Schema the plan expects from the table |
| `nodes` | Flat node table; node 0 is the scan |
| `root` | Index of the node whose output is the result |
| `output` | Schema of the result |
| `params` | Parameters the plan needs at execution, with types |

## Nodes

Every node carries `schema`, its output schema. Every node except `scan` has
`input`, the index of an earlier node.

| `op` | Fields | Output schema | Substrait relation |
| --- | --- | --- | --- |
| `scan` | none | the table's | Read |
| `filter` | `predicate` (bool) | same as input | Filter |
| `project` | `exprs` | one column per expression | Project |
| `aggregate` | `keys`, `aggs` | keys, then aggregates | Aggregate |
| `sort` | `keys` (expr, descending, nullsFirst) | same as input | Sort |
| `limit` | `count` | same as input | Fetch |

## Expressions

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `field` | `index`, `type` | Column `index` of the input node's schema |
| `literal` | `value`, `type` | A typed constant |
| `param` | `name`, `type` | A value supplied at `execute()` |
| `call` | `fn`, `args`, `type` | A registry function applied to arguments |

Every expression carries its result `type`. The validator recomputes call types
from the registry and rejects a plan whose stated types disagree.

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

The validator caps a plan at 1,024 nodes and expressions at 256 levels of nesting.
