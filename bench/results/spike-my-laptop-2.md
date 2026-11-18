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
