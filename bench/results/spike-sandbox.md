# Spike S-301: Rust kernels against the JS executor

- label: spike-sandbox
- source: synthetic routes (scripts/fake-routes.ts)
- runtime: Bun 1.4.4
- cpu: Intel(R) Xeon(R) Processor @ 2.10GHz
- cores: 2
- memoryGB: 8
- date: 2026-11-18

## 100,000 rows

| Step | zamda JS (ms) | native (ms) |
| --- | ---: | ---: |
| load from row objects | 26.0 | 20.6 |
| load from columns (strings encoded) |  | 15.0 |
| Q1 routes per network | 10.1 | 2.66 |
| Q3 routes and distinct networks per region | 4.04 | 1.69 |
| Q4 top 20 networks | 6.85 | 2.75 |
| Q7 full sort, radix | 20.3 | 2.61 |
| Q7 full sort, pdqsort |  | 2.94 |

| Dashboard interaction (four charts) | zamda JS (ms) | native (ms) |
| --- | ---: | ---: |
| nothing selected | 29.3 | 5.64 (5.2x) |
| prefix /22-/24, region ARIN, name "cloud" | 22.7 | 1.48 (15.3x) |

**native:** gate queries 41.2 ms in JS against 9.71 ms (4.2x); with row loading 67.3 against 30.3 ms (**2.2x**).

## 1,000,000 rows

| Step | zamda JS (ms) | native (ms) |
| --- | ---: | ---: |
| load from row objects | 192 | 60.4 |
| load from columns (strings encoded) |  | 58.8 |
| Q1 routes per network | 41.2 | 10.5 |
| Q3 routes and distinct networks per region | 24.8 | 10.7 |
| Q4 top 20 networks | 23.5 | 16.5 |
| Q7 full sort, radix | 217 | 19.9 |
| Q7 full sort, pdqsort |  | 32.9 |

| Dashboard interaction (four charts) | zamda JS (ms) | native (ms) |
| --- | ---: | ---: |
| nothing selected | 93.8 | 27.9 (3.4x) |
| prefix /22-/24, region ARIN, name "cloud" | 104 | 6.80 (15.2x) |

**native:** gate queries 307 ms in JS against 57.6 ms (5.3x); with row loading 499 against 118 ms (**4.2x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.
