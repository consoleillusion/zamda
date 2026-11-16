# Benchmarks

Run with `bun run bench`. Source: `bench/groupby.ts`.

## Group-by and top-k, 1,000,000 rows (2026-11-16, end of Milestone 1)

Synthetic routing-table rows: 74,813 distinct networks with a skewed
distribution, prefix length, path length, and one of five regions. All three
contenders start from the same array of row objects, and their results are
checked against each other before timing. Times are milliseconds, the median of
9 runs after 3 warm-ups. The suite was run three times; where runs differed
noticeably the range is shown.

| Query | Plain JS loop | Arquero | zamda (JS backend) | zamda vs plain | zamda vs Arquero |
| --- | --- | --- | --- | --- | --- |
| Q1 count per network (74,813 groups) | 46 to 58 | 274 to 295 | 19 to 20 | 2.3x to 3x faster | 14x to 15x faster |
| Q2 count per prefix length (9 groups) | 10 | 48 to 55 | 4 to 5 | 1.9x to 2.8x faster | 11x to 13x faster |
| Q3 filter, then count and distinct networks per region | 32 | 125 to 146 | 29 to 41 | level (0.8x to 1.1x) | 3.5x to 4.3x faster |
| Q4 top 20 networks by route count | 76 | 327 | 21 | 3.6x faster | 15x faster |
| Load rows into columns (paid once per table) | none | 39 to 52 | 53 to 73 | | 1.4x to 1.6x slower |

Q4 was measured in one of the three runs.

## What the numbers say

- zamda's JS backend beats Arquero on every query, by 3.5x to 15x.
- It beats a hand-written loop on plain group-by and on the full top-20 query.
- On filter-then-group (Q3) it is level with the hand-written loop. Before
  selection vectors (task T-113) it was 1.5x slower.
- Loading is still slower than Arquero's because every value is validated. It
  was 2.9x slower before task T-114.

## Where the speed comes from

No WASM is involved. The gains are data layout and specialised loops:

- columns are typed arrays, so loops read contiguous numbers;
- group-by on 32-bit keys uses an open-addressing hash table over typed arrays
  instead of `Map`, and keys of 16 bits or fewer use a direct lookup table;
- dictionary-encoded strings group and compare by integer code;
- `filter` hands a list of row indexes to the next operator instead of copying rows;
- `sort().limit(k)` keeps a heap of `k` rows instead of sorting everything.

## Limits of this benchmark

- Synthetic data, one machine. Timings move by 10 to 30% between runs.
- Measured on Bun, which uses JavaScriptCore. Chrome and Node use V8 and may
  rank differently; the reference dashboard must be measured in browsers.
- The plain JS loops are written for exactly these queries. They are a ceiling
  for hand-tuned code, not what typical application code looks like.
