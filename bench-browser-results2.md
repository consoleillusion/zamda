$ bun spike/run.ts --out "spike-my-laptop-2"
100,000 rows
1,000,000 rows

# Spike S-301: Rust kernels against the JS executor

- label: spike-my-laptop-2
- source: RIPE RIS
- runtime: Bun 1.4.2
- cpu: Intel(R) Core(TM) i5-14500
- cores: 20
- memoryGB: 31
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | wasm (ms) | native (ms) |
| --- | ---: | ---: | ---: |
| load from row objects | 7.36 | 5.00 | 4.48 |
| load from columns (strings encoded) |  | 4.36 | 3.86 |
| Q1 routes per network | 3.72 | 0.89 | 0.78 |
| Q3 routes and distinct networks per region | 1.70 | 0.61 | 0.50 |
| Q4 top 20 networks | 2.06 | 0.97 | 1.08 |
| Q7 full sort, radix | 6.75 | 1.02 | 0.95 |
| Q7 full sort, pdqsort |  | 0.29 | 0.22 |

| Dashboard interaction (four charts) | zamda JS (ms) | wasm (ms) | native (ms) |
| --- | ---: | ---: | ---: |
| nothing selected | 9.68 | 3.56 (2.7x) | 3.54 (2.7x) |
| prefix /22-/24, region ARIN, name "cloud" | 8.09 | 0.97 (8.4x) | 0.96 (8.4x) |

**wasm:** gate queries 14.2 ms in JS against 2.75 ms (5.2x); with row loading 21.6 against 7.75 ms (**2.8x**).
**native:** gate queries 14.2 ms in JS against 2.59 ms (5.5x); with row loading 21.6 against 7.07 ms (**3.1x**).

## 1,000,000 rows

| Step | zamda JS (ms) | wasm (ms) | native (ms) |
| --- | ---: | ---: | ---: |
| load from row objects | 76.7 | 23.8 | 29.1 |
| load from columns (strings encoded) |  | 21.3 | 23.6 |
| Q1 routes per network | 17.9 | 5.43 | 4.54 |
| Q3 routes and distinct networks per region | 13.3 | 5.25 | 3.99 |
| Q4 top 20 networks | 10.3 | 6.95 | 5.57 |
| Q7 full sort, radix | 67.5 | 10.3 | 13.3 |
| Q7 full sort, pdqsort |  | 2.67 | 2.38 |

| Dashboard interaction (four charts) | zamda JS (ms) | wasm (ms) | native (ms) |
| --- | ---: | ---: | ---: |
| nothing selected | 47.5 | 30.4 (1.6x) | 30.4 (1.6x) |
| prefix /22-/24, region ARIN, name "cloud" | 51.0 | 7.82 (6.5x) | 7.77 (6.6x) |

**wasm:** gate queries 109 ms in JS against 20.3 ms (5.4x); with row loading 186 against 44.1 ms (**4.2x**).
**native:** gate queries 109 ms in JS against 16.5 ms (6.6x); with row loading 186 against 45.6 ms (**4.1x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.

**Chromium**

zamda WASM spike (S-301)
Done.

Options in the address: ?rows=100000,1000000&runs=7. Runs start automatically; keep this tab in the foreground.

100,000 rows
1,000,000 rows
# Spike S-301: Rust kernels against the JS executor

- runtime: Chrome/156.0.0.0
- wasm size (bytes, uncompressed): 45008
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 8.80 | 4.20 |
| load from columns (strings encoded) |  | 3.30 |
| Q1 routes per network | 4.40 | 0.90 |
| Q3 routes and distinct networks per region | 2.80 | 0.60 |
| Q4 top 20 networks | 2.50 | 1.00 |
| Q7 full sort, radix | 2.80 | 1.00 |
| Q7 full sort, pdqsort |  | 0.30 |

| Dashboard interaction (four charts) | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| nothing selected | 9.70 | 2.30 (4.2x) |
| prefix /22-/24, region ARIN, name "cloud" | 10.1 | 0.60 (16.8x) |

**wasm:** gate queries 12.5 ms in JS against 2.80 ms (4.5x); with row loading 21.3 against 7.00 ms (**3.0x**).

## 1,000,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 73.7 | 24.7 |
| load from columns (strings encoded) |  | 21.7 |
| Q1 routes per network | 21.3 | 5.60 |
| Q3 routes and distinct networks per region | 19.7 | 5.10 |
| Q4 top 20 networks | 13.6 | 6.50 |
| Q7 full sort, radix | 27.5 | 10.5 |
| Q7 full sort, pdqsort |  | 2.60 |

| Dashboard interaction (four charts) | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| nothing selected | 61.2 | 16.6 (3.7x) |
| prefix /22-/24, region ARIN, name "cloud" | 85.3 | 4.80 (17.8x) |

**wasm:** gate queries 82.1 ms in JS against 19.8 ms (4.1x); with row loading 156 against 44.5 ms (**3.5x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.

**Firefox**


zamda WASM spike (S-301)

Done.

Options in the address: ?rows=100000,1000000&runs=7. Runs start automatically; keep this tab in the foreground.

100,000 rows
1,000,000 rows

# Spike S-301: Rust kernels against the JS executor

- runtime: Firefox/158.0
- wasm size (bytes, uncompressed): 45008
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 6.00 | 3.00 |
| load from columns (strings encoded) |  | 5.00 |
| Q1 routes per network | 4.00 | 1.00 |
| Q3 routes and distinct networks per region | 2.00 | 1.00 |
| Q4 top 20 networks | 3.00 | 1.00 |
| Q7 full sort, radix | 3.00 | 1.00 |
| Q7 full sort, pdqsort |  | 0.00 |

| Dashboard interaction (four charts) | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| nothing selected | 8.00 | 2.00 (4.0x) |
| prefix /22-/24, region ARIN, name "cloud" | 9.00 | 1.00 (9.0x) |

**wasm:** gate queries 12.0 ms in JS against 3.00 ms (4.0x); with row loading 18.0 against 6.00 ms (**3.0x**).

## 1,000,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 60.0 | 23.0 |
| load from columns (strings encoded) |  | 31.0 |
| Q1 routes per network | 26.0 | 6.00 |
| Q3 routes and distinct networks per region | 18.0 | 5.00 |
| Q4 top 20 networks | 13.0 | 7.00 |
| Q7 full sort, radix | 38.0 | 10.0 |
| Q7 full sort, pdqsort |  | 3.00 |

| Dashboard interaction (four charts) | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| nothing selected | 58.0 | 17.0 (3.4x) |
| prefix /22-/24, region ARIN, name "cloud" | 61.0 | 5.00 (12.2x) |

**wasm:** gate queries 95.0 ms in JS against 21.0 ms (4.5x); with row loading 155 against 44.0 ms (**3.5x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.


