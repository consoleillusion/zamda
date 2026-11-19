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

### Measured in headless Firefox (real data, real RIS Live; T-217)

The same page, driven in headless Firefox 158 against the real rrc00 dump
(1,163,624 routes) and the real RIS Live feed, first loaded its charts in 91,
34, 15 and 69 ms (networks, prefix length, path length, regions). After typing
`cloud` in the name search the four charts took 75, 36, 14 and 8 ms; the live
panel refresh was 4 ms. All stayed under the 200 ms target. Raw result and
detail: `bench/results/t217-firefox.md`. These are one headless run on the
development machine, not repeated medians on the owner's hardware.

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

### Owner's machine: the dashboard on the spike's WASM kernels (S-302)

`bench/results/spike-my-laptop-2.md` (i5-14500, real RIPE data; module 45,008 bytes). One
interaction, four charts, 1M rows, with results copied out of module memory:

| | zamda JS | WASM | Ratio |
| --- | ---: | ---: | ---: |
| Chrome, nothing selected | 61.2 ms | 16.6 ms | 3.7x |
| Chrome, prefix /22-/24, ARIN, "cloud" | 85.3 ms | 4.8 ms | 17.8x |
| Firefox, nothing selected | 58 ms | 17 ms | 3.4x |
| Firefox, same selections | 61 ms | 5 ms | 12x |
| Bun, nothing selected | 47.5 ms | 30.4 ms | 1.6x |
| Bun, same selections | 51.0 ms | 7.8 ms | 6.5x |

- **Both targets are met:** the JS backend is under 200 ms in every case (the D-052 estimate of
  50 to 65 ms for Chrome with nothing selected was close: 61 ms), and WASM is far under 50 ms
  in both browsers.
- **Bun is the outlier:** its WASM and its native build are both 30.4 ms, against 17 in the
  browsers, so the cost is something the two Bun runs share, not WASM. Unexplained and not
  important for a browser dashboard.
- **A ceiling, not a forecast:** the kernels know the dashboard's five controls in advance. A
  general engine (T-404 to T-406) will be slower; T-413 measures that.
- Gate numbers were stable between the two runs (Chrome 3.5x, Firefox 3.5x, Bun 4.2x with loading).

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

## The dashboard on WASM with a shared filter pass (T-416)

Sandbox Xeon, 2026-11-19, synthetic millions of routes from the reference file, `bun run
bench:wasm` (engine as WebAssembly) and `bun run bench:native` (native library), same harness
before and after (the session runs of the four WASM charts are wrapped in one
`backend.session()` per interaction, T-416, D-070; nothing-selected rows are unchanged because
the filter folds away):

| Four charts together / one by one, with /22-/24, ARIN and "cloud" | native library, session | WASM module, no session | WASM module, session |
| --- | ---: | ---: | ---: |
| nothing selected | 27 / 27 | 35 / 33 | 34 / 33 |
| prefix /22-/24, region ARIN, name "cloud" | 22 / 18 | 37 / 38 | 28 / 27 |

(The WASM "no session" column was measured by commenting the `session` option out of the
benchmark target and re-running the same harness; the "session" column is the default. Native
without a session was not measured. Numbers move by 10 to 30% between runs.)

The charts whose filter is identical (networks and pathLen) evaluate nothing but their own
aggregate; the prefixLen and regions charts share the region and name lookups and re-evaluate
only the subtrees whose parameters differ. The benchmark page now logs
`WASM session cache over these runs: <hits> hits, <misses> misses`. With nothing selected the
cache is idle (0 hits). Errors, rows and ordering are checked against the JS backend on every
run, and 331 tests pass including the golden suite and the new `tests/wasm-session.test.ts`.
Firefox on the owner's machine is the acceptance run: `bun run bench:browser`, in particular
`prefix /22-/24, region ARIN, name "cloud"` in the last two columns of the dashboard
interaction. The engine steps for that case were 46.2 ms there (D-069 addendum); the same
sharing should land it well inside the 50 ms target. In headless Chrome (sandbox) at 1,000,000
rows the WASM pair is 38 and 37 ms with nothing selected and 36 and 33 ms with the selection
(JS is at 87 to 91 in the same run); in headless Chrome at 200,000 rows it is 11 ms with nothing
selected and 6.8 ms with the selection. The cross-checks against the JS backend and JS executor
pass there and inside the page (`window.__benchResult` set, `WASM backend runs: 287 in the
engine`).

## Reference queries in Chrome and Firefox (T-210)

Measured on 2026-11-19 on this machine with headless Chromium 156.0.8078.47 and Firefox
158.0.1, using the real `data/routes.bin` from RIPE RIS rrc00 (1,165,315 routes) sampled to
1,000,000 rows. `bench/reference/browser/main.ts` ran the same seven queries and two dashboard
scenarios in each browser, seven timed runs after two warm-ups; every answer was checked against
Arquero, and every WASM answer against the JS backend, before timing. Raw results are
`bench/results/t210-chrome.json` and `t210-firefox.json`; the tables are in
`bench/results/t210-browsers.md`.

| Query (JS backend median, ms) | Chrome | Firefox |
| --- | ---: | ---: |
| Q1 routes per network | 24 | 28 |
| Q2 routes per prefix length | 1.9 | 2 |
| Q3 routes and distinct networks per region | 19 | 16 |
| Q4 top 20 networks | 15 | 14 |
| Q5 filtered region chart | 30 | 25 |
| Q6 name search | 7.5 | 6 |
| Q7 full sort | 62 | 72 |

The four-chart "nothing selected" interaction took 67 ms in Chrome and 58 ms in Firefox;
with /22-/24, ARIN and "cloud" it took 80 ms and 53 ms. On this machine the WASM backend was
faster than JS on six queries in both browsers, but slower on the full sort (113 ms in Chrome,
117 ms in Firefox). The T-210 run recorded 95 to 105 ms in Chrome and 75 to 88 ms in Firefox
for the four-chart WASM interaction: every chart fell back to JS because the fallback check
looked at the original plan, where the name search mixes `dictionary` and `utf8`, instead of
the plan after folding and lookups that the engine actually receives (127 engine runs and 168
JS runs; D-078 fixed this). A Chrome rerun with the fix, on the same data and harness, gives
38.7 ms together / 36.7 ms one by one with nothing selected and 37.7 / 34.0 ms with /22-/24,
ARIN and "cloud": 295 engine runs and no fallbacks. Raw result and table:
`bench/results/t210-chrome-fallback-fix.json` and `.md`.

These are headless-browser numbers on the development machine, not the owner's machine, and
they use the saved RIPE file rather than the live RIS feed. They close T-210's gap of having no
browser numbers for the reference queries; T-217's Firefox acceptance still needs the real feed.

## AS graph load, drill-down and all-data mode (T-506)

Measured on 2026-11-20 on this machine with headless Chromium 156 and Firefox 158 against the
real `data/graph.bin` from RIPE RIS rrc00 (80,226 ASes, 122,862 directed edges, 6.4 MB). Each
browser did three cold page loads, five alternating AS13335/AS15169 neighbourhood clicks, one
All data redraw, and 90 animation frames of wheel zoom plus pointer pan after the full graph was
on screen. Raw results are `bench/results/t506-graph-chrome.json` and
`bench/results/t506-graph-firefox.json`. No console errors were captured in either browser.

| Browser | Load + first overview (ms) | Warm overview (ms) | Neighbourhood (ms) | All data (ms) | Zoom/pan frame median, p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chrome | 108 + 145 | 84 + 116, 88 + 107 | 69, 63, 63, 75, 61 | 1,419 | 16.7, 16.7 |
| Firefox | 92 + 567 | 82 + 133, 72 + 138 | 137, 110, 119, 117, 109 | 1,634 | 17.1, 17.1 |

The first Firefox overview includes shader start-up; its two warm redraws are 133 and 138 ms.
All data draws 79,882 nodes rather than all 80,226 because 344 ASes have no edge in this dump;
the status line still reports the file's full node count. The bounded overview draws 3,881 of
the 10,000 strongest edges because 6,119 of those edges touch an AS outside the 2,000-node
budget; the panel says so instead of implying all 10,000 are visible. Wheel and pointer events
move the camera in both browsers, and the full graph stays at a 60 fps frame cadence while
panning in this headless run. These are development-machine numbers, not the owner's machine.

## RIS Live overlay and animated zoom (T-507)

Measured on 2026-11-20 with the same `data/graph.bin` and `?live=sim` on port 3101. Both
browsers loaded the file in about 99 ms, the simulator filled the 60-second hot-edge query to
its 200-pair cap, and the graph panel reported roughly 200 hot ASes without a console error.
The camera samples are from a click on AS13335, followed by Overview:

| Browser | Ratio at 40 / 160 / 320 / 540 ms into zoom-in | Ratio at 40 / 160 / 320 / 540 ms back out | Errors |
| --- | --- | --- | --- |
| Chrome 156 | 1.036, 1.211, 1.707, 1.800 | 1.800, 1.682, 1.234, 1.036 | 0 |
| Firefox 158 | 1.043, 1.153, 1.530, 1.799 | 1.799, 1.708, 1.344, 1.041 | 0 |

The camera also moves from `(0.493, 0.489)` to `(0.646, 0.798)` in both browsers, so the zoom
keeps the clicked node centred rather than switching canvases. Raw samples are
`bench/results/t507-graph-live-chrome.json` and `bench/results/t507-graph-live-firefox.json`.
These are development-machine numbers from the simulated feed, not the owner's machine or the
real RIS Live socket.

## Country layout and responsive zoom (T-508)

Measured on 2026-11-20 after regenerating `data/graph.bin` from the same rrc00 dump with country
codes from the current `asn.txt` and pinned country centroids. The file now stores 241 country
codes and country-centred positions, and loads in 103 ms in Chrome. The panel states that nodes
are grouped by registered country. All positions are still fixed in the file; only the camera
moves.

| Browser | Ratio at 40 / 160 / 320 / 540 ms into click zoom | Ratio at 40 / 160 / 320 / 540 ms back out | Errors |
| --- | --- | --- | --- |
| Chrome 156 | 1.270, 1.686, 2.747, 2.800 | 2.800, 2.478, 1.456, 1.270 | 0 |
| Firefox 158 | 1.290, 1.619, 2.541, 2.800 | 2.797, 2.537, 1.610, 1.270 | 0 |

The focus now ends at ratio 2.8 in 450 ms, and the clicked AS's screen position is kept centred
while the overview moves from `(0.547, 0.563)` to `(0.238, 0.702)`. One wheel notch in Chrome
changes the camera ratio by exactly 1.35 in both directions (1.270 to 0.941 and back), up from
1.12. The simulator still fills the live query to 200 hot edges with no console error. Raw
samples are `bench/results/t508-graph-geo-chrome.json`,
`bench/results/t508-graph-geo-firefox.json` and `bench/results/t508-graph-wheel-chrome.json`.
These are development-machine numbers; the country centres are approximate, not city locations.
