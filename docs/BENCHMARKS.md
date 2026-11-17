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

## After chunked execution (task T-201)

The same queries, with execution now chunked and yielding to the event loop
about every 8 ms. One run:

| Query | Before | After |
| --- | --- | --- |
| Q1 count per network | 19 to 20 | 22.5 |
| Q2 count per prefix length | 4 to 5 | 4.1 |
| Q3 filter, count and distinct per region | 29 to 41 | 34.1 |
| Q4 top 20 networks | 21 | 29.0 |

Chunking costs a few milliseconds on the longer queries: each pause is a trip
through the event loop, and the sort now gathers its input before sorting. In
exchange a run can be cancelled within a time slice and the page stays responsive.

## Reference dataset (2026-11-18)

Built by `bun run prep-bgp --date 20261116` from RIPE RIS rrc00, dump
`bview.20261116.0000.gz`:

| Measure | Value |
| --- | --- |
| IPv4 prefixes in the dump | 1,165,516 |
| Peers | 109 |
| Routes written | 1,165,315 |
| Skipped: no single origin AS | 201 |
| Path lengths over 255 (stored as 255) | 2 |
| Decompressed dump read | about 3.8 GB |
| Routes file | 19.7 MB |
| Total time, including the download | 171 s |

## Real routing data (2026-11-18)

`scripts/inspect-routes.ts` on the reference dataset (1,165,315 routes), run on
the owner's machine, median of five runs:

| Query | Time |
| --- | --- |
| Load `data/routes.bin` into a table | 114 ms (once) |
| Top 10 networks by route count, grouped by network and name | 193.6 ms (before D-043) |
| Prefix-length histogram | 3.3 ms |
| Path-length histogram | 2.5 ms |
| Routes and distinct networks by region | 17.4 ms |
| Longest paths (30 or more), top 5 | 1.9 ms |

The top-10 query took the string-keyed path for two-column grouping. On a
synthetic dataset of the same shape on the development machine (about six
times slower than the owner's), that query went from 1,301 ms to 63 to 90 ms
after D-043. Re-run `scripts/inspect-routes.ts` to get the real figure.

## The reference dashboard, first measurements (sandbox only)

Measured in headless Chrome and in Bun in the build sandbox, which is about six
times slower than the owner's machine, on the synthetic routes file
(`bun run fake-routes`: a million routes, 75,000 networks) with the simulated
live feed. Task T-217 replaces these with real data on real hardware.

Each chart alone, Bun, median of 9 runs, no selection / prefix /22–/24 /
region ARIN plus name search "cloud":

| Chart | Plan | ms |
| --- | --- | --- |
| Totals | filter, count and distinct networks | 37 / 39 / 20 |
| Top 20 networks | filter, group by (origin, name), top 20 | 62 / 70 / 31 |
| Prefix length | filter, group by length | 14 / 14 / 27 |
| Path length | filter, group by length | 14 / 20 / 22 |
| Regions | filter, group by region, count and distinct networks | 39 / 42 / 22 |

The evaluation shortcuts in D-045 took these from 60 to 150 ms each. The name
search alone went from 44 ms to 10 ms, and a switched-off filter now costs
almost nothing.

In Chrome the five charts run at once and interleave in 8 ms slices, so each
chart's time is close to the whole interaction's: 250 to 350 ms per
interaction here, down from 550 to 800 ms before D-045. Divided by the
sandbox's slowness that is roughly 40 to 60 ms on the owner's machine, inside
the 200 ms target, but that is an estimate until T-217 measures it. The live
panel's three queries take 2 to 6 ms per second.

What remains is aggregation, not filtering: the two distinct counts and the
two-key group. Sharing one filter pass across the five charts is T-218.

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
