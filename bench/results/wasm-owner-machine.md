## Bun 1.4.2 (JavaScriptCore) with the engine as WebAssembly: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 19 | 18 | 180 | 14 |
| Q2 routes per prefix length | 2.8 | 2.9 | 30 | 3.5 |
| Q3 routes and distinct networks per region | 13 | 13 | 95 | 12 |
| Q4 top 20 networks (group, sort, limit) | 10 | 10 | 94 | 8.3 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 18 | 17 | 96 | 13 |
| Q6 name search ("cloud", case-insensitive) | 4.0 | 4.0 | 111 | 3.4 |
| Q7 full sort of every route (prefix length, address) | 59 | 50 | 30 | 9.2 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 44 | 44 | 42 | 33 | 33 |
| prefix /22-/24, region ARIN, name "cloud" | 52 | 47 | 46 | 37 | 36 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 21 | 21 | 120 | 15 |
| Q2 routes per prefix length | 2.4 | 2.4 | 11 | 3.5 |
| Q3 routes and distinct networks per region | 19 | 19 | 71 | 12 |
| Q4 top 20 networks (group, sort, limit) | 14 | 14 | 60 | 8.4 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 28 | 28 | 68 | 14 |
| Q6 name search ("cloud", case-insensitive) | 7.7 | 7.6 | 54 | 4.0 |
| Q7 full sort of every route (prefix length, address) | 29 | 29 | 138 | 9.7 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 64 | 63 | 63 | 35 | 33 |
| prefix /22-/24, region ARIN, name "cloud" | 86 | 85 | 85 | 41 | 42 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 23 | 182 | 16 |
| Q2 routes per prefix length | 2.0 | 2.0 | 13 | 4.0 |
| Q3 routes and distinct networks per region | 16 | 16 | 83 | 14 |
| Q4 top 20 networks (group, sort, limit) | 13 | 13 | 81 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 21 | 22 | 94 | 15 |
| Q6 name search ("cloud", case-insensitive) | 5.0 | 5.0 | 49 | 5.0 |
| Q7 full sort of every route (prefix length, address) | 39 | 38 | 45 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 50 | 51 | 51 | 39 | 38 |
| prefix /22-/24, region ARIN, name "cloud" | 69 | 68 | 67 | 49 | 48 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

