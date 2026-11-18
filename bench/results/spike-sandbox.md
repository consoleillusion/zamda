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
| load from row objects | 20.9 | 10.4 |
| load from columns (strings encoded) |  | 9.82 |
| Q1 routes per network | 10.7 | 1.96 |
| Q3 routes and distinct networks per region | 4.20 | 1.17 |
| Q4 top 20 networks | 6.38 | 1.93 |
| Q7 full sort, radix | 14.4 | 1.60 |
| Q7 full sort, pdqsort |  | 2.02 |

**native:** gate queries 35.6 ms in JS against 6.65 ms (5.4x); with row loading 56.5 against 17.0 ms (**3.3x**).

## 1,000,000 rows

| Step | zamda JS (ms) | native (ms) |
| --- | ---: | ---: |
| load from row objects | 176 | 61.4 |
| load from columns (strings encoded) |  | 52.5 |
| Q1 routes per network | 63.0 | 11.3 |
| Q3 routes and distinct networks per region | 37.4 | 10.4 |
| Q4 top 20 networks | 27.9 | 16.0 |
| Q7 full sort, radix | 159 | 18.9 |
| Q7 full sort, pdqsort |  | 27.4 |

**native:** gate queries 288 ms in JS against 56.6 ms (5.1x); with row loading 464 against 118 ms (**3.9x**).

The gate needs 3x or more at 1,000,000 rows with loading included, and a win from 100,000 rows. Every spike answer was checked against zamda's before timing.
