# Binary IR

The byte form of an IR plan (`docs/IR.md`), written by `encodePlan` and read by
`decodePlan` in `src/ir-binary.ts`. The Rust engine (T-402) reads the same bytes.
Decision D-058.

Properties:

- **Exact.** Decoding what was encoded gives back an equal plan: `-0`, `NaN`,
  infinities, 64-bit literals and every string survive.
- **One encoding per plan.** Every number is written in its shortest form and
  the decoder refuses anything else, so equal plans give equal bytes and the
  bytes can be used as a cache key.
- **Safe to read.** All reads are bounds-checked, a list cannot be longer than
  the bytes left, expressions nest at most 200 deep, and a malformed input is a
  `PlanError`, never a crash. The decoder checks the bytes are well formed; the
  validator checks the plan makes sense (types, column and parameter references).

## Primitives

| Name | Bytes |
| --- | --- |
| byte | one byte |
| varint | a non-negative integer below 2^53, little-endian base 128: seven bits per byte, the high bit set on every byte but the last; at most 8 bytes; the last byte is never 0 unless the number is a single byte |
| zigzag | a signed integer of at most 2^52 - 1 in magnitude, as the varint of `2n` for `n >= 0` and `-2n - 1` for `n < 0` |
| u64 | 8 bytes, little-endian |
| f64 | 8 bytes, IEEE 754 binary64, little-endian, bit-exact |
| string | varint length, then that many UTF-8 bytes (invalid UTF-8 and lone surrogates are errors) |
| list of X | varint count, then that many X |

## Plan

```
plan    = "ZIR" 0x01                 magic and format version
          varint                     IR version (2)
          list of field              plan input
          list of node
          varint                     root node index
          list of field              plan output
          list of param
field   = string name, type
param   = string name, type, byte list (0 or 1)
```

## Types

One byte each. The numbers are part of the format and are never reused.

| 0 bool | 1 int8 | 2 int16 | 3 int32 | 4 int64 |
| --- | --- | --- | --- | --- |
| 5 uint8 | 6 uint16 | 7 uint32 | 8 uint64 | 9 float32 |
| 10 float64 | 11 utf8 | 12 dictionary | 13 date32 | 14 timestamp |

## Nodes

```
node    = byte op, list of field (output schema), then by op:
  0 scan       nothing
  1 filter     varint input, expr predicate
  2 project    varint input, list of expr
  3 aggregate  varint input, list of expr (keys),
               list of agg: string fn, type, byte has-argument (0 or 1), expr if 1
  4 sort       varint input, list of sortkey: byte flags (1 descending, 2 nulls first), expr
  5 limit      varint input, varint count
```

## Expressions

```
expr    = byte kind, type (the result type), then by kind:
  0 field    varint column index
  1 literal  literal
  2 param    string name
  3 call     string function name, list of expr
  4 cast     expr
  5 in       expr, byte form: 0 = list of literal, 1 = string parameter name
```

## Literals

A literal is tagged by its JavaScript kind, not by the expression's type, so it
comes back as the same value.

| Tag | Meaning | Then |
| --- | --- | --- |
| 0 | false | |
| 1 | true | |
| 2 | integer number, magnitude at most 2^52 - 1 (never -0) | zigzag |
| 3 | any other number: fractions, NaN, infinities, -0, larger integers | f64 |
| 4 | bigint, zero or positive | u64 magnitude |
| 5 | bigint, negative | u64 magnitude (the value is its negative) |
| 6 | string | string |

Every plan has exactly one encoding, and the decoder refuses the others: an
integer that fits tag 2 is never written as tag 3, a NaN is always
`0x7ff8000000000000`, a varint has no extra zero bytes and stays below 2^53, and
a string keeps a leading byte order mark. The Rust engine (`engine/`) decodes
the same bytes; its error codes are in `engine/src/error.rs` (1-19 decoding,
101-122 validation).

## Parameter values

The values a run gives the engine are a separate byte string, not part of the
plan: for each parameter the plan declares, in the order it declares them, one
literal (a scalar parameter) or a count followed by that many literals (a list
parameter). Literals use the table above. Nothing precedes or follows them.

## Changing the format

Append new type numbers, ops, expression kinds or literal tags; never reorder or
reuse one. A change that old readers cannot read bumps the format byte after
"ZIR". A change to the plan itself bumps `IR_VERSION`.
