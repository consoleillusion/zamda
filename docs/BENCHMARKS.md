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

### Measured by the owner (real data, Chromium)

On a real `data/routes.bin` from `bun run prep-bgp`, with the real RIS Live feed
(collector rrc00): first load, 111 to 225 ms per chart; after typing a name and
selecting in each chart, 109 to 123 ms per chart; live panel refresh 20 to 40 ms
(5 to 12 ms at first, before the window filled). Each chart's time is close to
the whole interaction's, because the five charts share the page's time slices.
This was before T-218. In the sandbox that change cut the work of one
interaction by about 20% (161 to 124 ms with nothing selected, 180 to 143 ms
with a prefix brush, 117 to 94 ms with a region and a search).

## Reference benchmark (T-207)

`bun run bench:ref` runs seven queries (group-bys, distinct counts, top-k, a
filter, a case-insensitive search, a full sort) on 10k, 100k and 1M routes from
`data/routes.bin`, in zamda and Arquero, after checking that both give the same
answer. Results go to `bench/results/<name>.md` and `.json`; `--out my-laptop`
names them. This is the harness the WASM spike runs, and the zamda column at
1M rows is the number it must beat by 3x.

Owner's machine (`bench/results/my-laptop.md`: Bun 1.4.2, Intel Core i5-14500,
20 threads, 31 GB, real RIPE RIS data), 1,000,000 rows, medians in ms:

| Query | zamda | Arquero |
| --- | ---: | ---: |
| Q1 routes per network | 19 | 180 |
| Q3 routes and distinct networks per region | 13 | 92 |
| Q4 top 20 networks | 10 | 94 |
| Q6 name search | 4.0 | 109 |
| Q7 full sort of every route | **87** | **31** |

The spike gate's set (Q1, Q3, Q4, Q7) takes 129 ms in zamda, 197 ms with the 68 ms
to load row objects. At 3x, WASM would have to do all of it in about 66 ms.
Two thirds of the 129 ms is the sort. This machine is about 3x faster than the
sandbox, not the 6x assumed earlier.

The same table measured in the sandbox on synthetic routes
(`bench/results/sandbox.md`), 1,000,000 rows, medians in ms:

| Query | zamda | Arquero |
| --- | ---: | ---: |
| Q1 routes per network | 57 | 489 |
| Q3 routes and distinct networks per region | 27 | 255 |
| Q4 top 20 networks | 38 | 407 |
| Q6 name search | 9.4 | 112 |
| Q7 full sort of every route | **1,422** | **604** |

Before T-221, zamda was 4x to 18x faster than Arquero on every query except the
full sort, where it was 2.4x to 2.8x slower. T-221 (D-051, a radix sort) made the
sort 4x faster than the old comparison sort on the sandbox's random-order data, so
there it now beats Arquero (zamda 149 ms, Arquero 841 ms). On the owner's real
routing table, which is already in address order, it improved only from 87 to
72 ms and Arquero's 31 ms still wins (`my-laptop-2.md`). Native comparison sorts
speed up on partly ordered input and radix sorts do not, so synthetic random data
flatters the change. Real data is the one to quote. Building a zamda table from columns costs
127 ms when a column holds strings, against none for Arquero (T-222). The
gate's sort component is zamda's weakest spot: on real data the gate queries take
112 ms (`my-laptop-2.md`), 72 of it the sort.

## Bun against Chrome (T-223)

`bun run bench:compare` (Bun, JavaScriptCore) and `bun run bench:browser` (open the
page in any browser) run the same measurements: every reference query with and
without the executor's time slicing, and the dashboard's four charts started
together, as the page starts them. Same sandbox, 1,000,000 synthetic rows,
medians in ms (`bench/results/compare-bun.json`, `compare-chrome.json`):

| | Bun | Chrome |
| --- | ---: | ---: |
| Q1 routes per network | 63 | 68 |
| Q3 routes and distinct networks per region | 31 | 35 |
| Q4 top 20 networks | 38 | 49 |
| Q5 filtered region chart | 41 | **88** |
| Q6 name search | 9.1 | **19** |
| Q7 full sort | 160 | **78** |
| Dashboard interaction, nothing selected | 137 | **241** |
| Dashboard interaction, brush, region and name | 108 | **301** |

- **Time slicing is not the cause:** the dashboard interaction takes the same
  time with slicing off, in both runtimes.
- **V8 is about 2x slower on the filter path** (Q5, Q6 and the interaction),
  about equal on group-by, and faster on the sort. The owner's 109 to 123 ms in
  Chromium against roughly 60 to 75 ms of work in Bun fits this.
- Aggregate the same way and the engines tie, so the loss is in the filtering
  kernels' code shape, which can be changed (T-224).
- Why it matters for the WASM question: a browser's JS engine is a moving
  target and WASM is not, so a WASM filter would be steadier. But the JS gap is
  a fixable 2x, found cheaply, before a second engine is considered.

### In browsers, on the owner's machine (T-223, T-224)

`bench/results/browser-my-laptop.md`: Chrome 156 and Firefox 158, 1,000,000 real
routes, before D-052, medians in ms:

| | Chrome | Firefox |
| --- | ---: | ---: |
| Q1 routes per network | 21 | 23 |
| Q5 filtered region chart | 25 | 20 |
| Q6 name search | 6.2 | 3.0 |
| Q7 full sort | 27 (Arquero 128) | 37 (Arquero 45) |
| Dashboard interaction, nothing selected | 96 | 67 |
| Dashboard interaction, brush, region and name | 103 | 92 |

- Single queries are within about 1.3x of Bun on the same machine, so the browser
  is not much slower than Bun on the engine's own work. (The sandbox showed a 2x
  gap on filtering; the owner's machine shows about 1.3x.)
- The full sort is not a problem in browsers: 27 ms in Chrome and 37 ms in
  Firefox. It was 72 ms in Bun on real data, so the sort that looked slow was
  Bun-specific.
- The interaction was about twice the sum of its single queries (96 ms against
  about 41 ms in Chrome). The reason was the five filter controls evaluated for
  every chart even when off, fixed by D-052.

Same sandbox, before and after D-052 (`compare-chrome.json`, `compare-bun.json`),
dashboard interaction, ms:

| | Chrome before | Chrome after | Bun before | Bun after |
| --- | ---: | ---: | ---: | ---: |
| Nothing selected | 241 | 125 | 137 | 104 |
| Brush, region and name | 301 | 180 | 108 | 87 |

Applying the same proportions to the owner's Chrome numbers gives roughly 50 to
65 ms per interaction. That is an estimate until measured.

## WASM spike, native upper bound (S-301)

`spike/` holds Rust versions of the gate queries (Q1, Q3, Q4, Q7; D-053). The sandbox cannot
download the wasm32 target (`static.rust-lang.org` is not reachable from it), so these numbers
are the same Rust code built **natively** and called through Bun FFI. WASM runs that code at
or below native speed, so this is the best case, not the answer. Synthetic data, the sandbox's
2-core Xeon, Bun. Every answer was checked against zamda's before timing. Full tables:
`bench/results/spike-sandbox.md`.

| 1,000,000 rows | zamda JS (ms) | Rust native (ms) |
| --- | ---: | ---: |
| load from row objects | 176 | 61 |
| Q1 routes per network | 63 | 11.3 |
| Q3 routes and distinct networks per region | 37 | 10.4 |
| Q4 top 20 networks | 28 | 16.0 |
| Q7 full sort (radix) | 159 | 18.9 |
| **Gate queries** | **288** | **56.6** (5.1x) |
| **With row loading** | **464** | **118** (3.9x) |

At 100,000 rows the same comparison is 3.3x with loading. What it shows:

- **The queries are not the limit; loading is.** Half of the Rust total is the JS loop that
  copies row objects into the module and encodes two string columns (61 ms). WASM cannot
  speed that up, so the 3x gate is mostly a test of the loader.
- **Overflow checking is free in this measurement.** Checked and wrapping counters differ by
  less than the run-to-run noise (`native` against `native-wrapping`).
- **Not measured yet:** the WASM build itself (expected 1x to 2x slower than native on the
  query part), the module size, and the owner's machine, where zamda's own sort and group-bys
  are faster than in the sandbox (`my-laptop.md`), so the ratio will be lower there.

## WASM spike on the owner's machine (S-301)

i5-14500, real RIPE data, `bench/results/spike-my-laptop.md`. The module is **42,895 bytes**
uncompressed for the four gate kernels. Every answer was checked against zamda's first.

| 1,000,000 rows | zamda JS | WASM | Ratio |
| --- | ---: | ---: | ---: |
| Bun: gate queries | 111 ms | 19.6 ms | 5.7x |
| Bun: with row loading | 181 ms | 43.6 ms | **4.2x** |
| Chrome: gate queries | 81.0 ms | 20.2 ms | 4.0x |
| Chrome: with row loading | 155 ms | 45.1 ms | **3.4x** |
| Firefox: gate queries | 97 ms | 22 ms | 4.4x |
| Firefox: with row loading | 159 ms | 46 ms | **3.5x** |

At 100,000 rows with loading: 3.3x (Bun), 3.2x (Chrome), 2.6x (Firefox). WASM was within about
1.3x of the native build on the queries. All three gate conditions hold: 3x at 1M, far under
400 KB, ahead at 100k. What the table hides:

- **The sort carries the result.** The spike's Q7 is 2.9 ms because pdqsort is adaptive and the
  real table is already in address order; zamda's radix sort is not adaptive (74 ms in Bun, 26 in
  Chrome). On unordered data the Rust sort takes 19 to 27 ms (sandbox). Without Q7, the ratio
  with loading is 2.6x (Bun), 3.0x (Chrome) and 2.8x (Firefox): at or under the gate.
- **Loading is about half of the WASM time** (24 ms of 44). Loading from columns with strings
  encoded is 21 ms. Ready-made dictionary columns (T-222) would remove most of it.
- **Not measured:** the filter path (Q5), so the dashboard's 50 ms target is unconfirmed; sizes
  below 100,000 rows; Firefox timings are rounded to whole milliseconds.

## The dashboard on WASM kernels, native upper bound (S-302)

Same method as the section above: the Rust kernels built natively, sandbox Xeon, synthetic
data, every chart checked against zamda's before timing. One interaction is the four charts
together, with the copy of each result out of module memory included and the top-20 pick in JS
left out (zamda's number leaves it out too). `bench/results/spike-sandbox.md`.

| One interaction | 100,000 rows | 1,000,000 rows |
| --- | ---: | ---: |
| nothing selected: zamda JS | 29.3 ms | 93.8 ms |
| nothing selected: Rust native | 5.6 ms (5.2x) | 27.9 ms (3.4x) |
| prefix /22-/24, ARIN, "cloud": zamda JS | 22.7 ms | 104 ms |
| prefix /22-/24, ARIN, "cloud": Rust native | 1.5 ms (15x) | 6.8 ms (15x) |

The no-selection case is the slow one for both engines: every row passes, so the per-network
count hashes a million rows. The WASM target is 50 ms per interaction. Measure on the owner's
machine before reading anything into the margin.

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
