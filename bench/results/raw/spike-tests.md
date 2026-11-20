---
$ bun spike/run.ts --out spike-my-laptop
100,000 rows
1,000,000 rows

# Spike S-301: Rust kernels against the JS executor

- label: spike-my-laptop
- source: RIPE RIS
- runtime: Bun 1.4.2
- cpu: Intel(R) Core(TM) i5-14500
- cores: 20
- memoryGB: 31
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | wasm (ms) | native (ms) |
| --- | ---: | ---: | ---: |
| load from row objects | 7.86 | 5.00 | 4.45 |
| load from columns (strings encoded) |  | 4.17 | 3.63 |
| Q1 routes per network | 5.90 | 0.85 | 0.69 |
| Q3 routes and distinct networks per region | 1.83 | 0.58 | 0.47 |
| Q4 top 20 networks | 2.11 | 0.94 | 1.07 |
| Q7 full sort, radix | 7.34 | 0.98 | 0.83 |
| Q7 full sort, pdqsort |  | 0.27 | 0.16 |

**wasm:** gate queries 17.2 ms in JS against 2.64 ms (6.5x); with row loading 25.0 against 7.64 ms (**3.3x**).
**native:** gate queries 17.2 ms in JS against 2.40 ms (7.2x); with row loading 25.0 against 6.85 ms (**3.7x**).

## 1,000,000 rows

| Step | zamda JS (ms) | wasm (ms) | native (ms) |
| --- | ---: | ---: | ---: |
| load from row objects | 69.9 | 24.0 | 27.4 |
| load from columns (strings encoded) |  | 21.0 | 22.3 |
| Q1 routes per network | 15.4 | 5.26 | 4.35 |
| Q3 routes and distinct networks per region | 12.1 | 5.04 | 3.89 |
| Q4 top 20 networks | 9.37 | 6.45 | 5.45 |
| Q7 full sort, radix | 74.4 | 11.0 | 12.6 |
| Q7 full sort, pdqsort |  | 2.90 | 1.54 |

**wasm:** gate queries 111 ms in JS against 19.6 ms (5.7x); with row loading 181 against 43.6 ms (**4.2x**).
**native:** gate queries 111 ms in JS against 15.2 ms (7.3x); with row loading 181 against 42.6 ms (**4.3x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.

---
$ bun run spike:browser

**Chromium**

zamda WASM spike (S-301)
Done.

Options in the address: ?rows=100000,1000000&runs=7. Runs start automatically; keep this tab in the foreground.

100,000 rows
1,000,000 rows

# Spike S-301: Rust kernels against the JS executor

- runtime: Chrome/156.0.0.0
- wasm size (bytes, uncompressed): 42895
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 8.70 | 3.90 |
| load from columns (strings encoded) |  | 3.40 |
| Q1 routes per network | 4.40 | 0.90 |
| Q3 routes and distinct networks per region | 2.70 | 0.60 |
| Q4 top 20 networks | 2.50 | 1.00 |
| Q7 full sort, radix | 2.50 | 1.00 |
| Q7 full sort, pdqsort |  | 0.20 |

**wasm:** gate queries 12.1 ms in JS against 2.70 ms (4.5x); with row loading 20.8 against 6.60 ms (**3.2x**).

## 1,000,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 74.2 | 24.9 |
| load from columns (strings encoded) |  | 20.8 |
| Q1 routes per network | 21.9 | 5.60 |
| Q3 routes and distinct networks per region | 19.9 | 5.20 |
| Q4 top 20 networks | 13.4 | 6.80 |
| Q7 full sort, radix | 25.8 | 10.3 |
| Q7 full sort, pdqsort |  | 2.60 |

**wasm:** gate queries 81.0 ms in JS against 20.2 ms (4.0x); with row loading 155 against 45.1 ms (**3.4x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.


**Firefox**

zamda WASM spike (S-301)

Done.

Options in the address: ?rows=100000,1000000&runs=7. Runs start automatically; keep this tab in the foreground.

100,000 rows
1,000,000 rows

# Spike S-301: Rust kernels against the JS executor

- runtime: Firefox/158.0
- wasm size (bytes, uncompressed): 42895
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 6.00 | 4.00 |
| load from columns (strings encoded) |  | 4.00 |
| Q1 routes per network | 4.00 | 1.00 |
| Q3 routes and distinct networks per region | 2.00 | 1.00 |
| Q4 top 20 networks | 2.00 | 1.00 |
| Q7 full sort, radix | 4.00 | 1.00 |
| Q7 full sort, pdqsort |  | 0.00 |

**wasm:** gate queries 12.0 ms in JS against 3.00 ms (4.0x); with row loading 18.0 against 7.00 ms (**2.6x**).

## 1,000,000 rows

| Step | zamda JS (ms) | wasm (ms) |
| --- | ---: | ---: |
| load from row objects | 62.0 | 24.0 |
| load from columns (strings encoded) |  | 32.0 |
| Q1 routes per network | 26.0 | 6.00 |
| Q3 routes and distinct networks per region | 18.0 | 6.00 |
| Q4 top 20 networks | 14.0 | 7.00 |
| Q7 full sort, radix | 39.0 | 11.0 |
| Q7 full sort, pdqsort |  | 3.00 |

**wasm:** gate queries 97.0 ms in JS against 22.0 ms (4.4x); with row loading 159 against 46.0 ms (**3.5x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.
