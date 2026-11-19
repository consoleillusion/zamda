## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 22 | 187 | 16 |
| Q2 routes per prefix length | 2.0 | 2.0 | 13 | 4.0 |
| Q3 routes and distinct networks per region | 17 | 16 | 83 | 13 |
| Q4 top 20 networks (group, sort, limit) | 12 | 12 | 80 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 21 | 22 | 94 | 16 |
| Q6 name search ("cloud", case-insensitive) | 6.0 | 6.0 | 48 | 5.0 |
| Q7 full sort of every route (prefix length, address) | 39 | 39 | 45 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 50 | 50 | 51 | 39 | 38 |
| prefix /22-/24, region ARIN, name "cloud" | 69 | 68 | 67 | 48 | 47 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 23 | 187 | 17 |
| Q2 routes per prefix length | 2.0 | 2.0 | 13 | 4.0 |
| Q3 routes and distinct networks per region | 16 | 16 | 82 | 13 |
| Q4 top 20 networks (group, sort, limit) | 13 | 12 | 87 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 21 | 22 | 94 | 16 |
| Q6 name search ("cloud", case-insensitive) | 6.0 | 5.0 | 49 | 5.0 |
| Q7 full sort of every route (prefix length, address) | 38 | 38 | 44 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 51 | 50 | 50 | 38 | 38 |
| prefix /22-/24, region ARIN, name "cloud" | 67 | 67 | 67 | 50 | 49 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 22 | 123 | 15 |
| Q2 routes per prefix length | 2.5 | 2.4 | 12 | 3.5 |
| Q3 routes and distinct networks per region | 19 | 18 | 82 | 12 |
| Q4 top 20 networks (group, sort, limit) | 14 | 14 | 59 | 8.4 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 29 | 29 | 83 | 14 |
| Q6 name search ("cloud", case-insensitive) | 7.8 | 7.6 | 58 | 4.0 |
| Q7 full sort of every route (prefix length, address) | 29 | 28 | 137 | 9.8 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 63 | 63 | 63 | 34 | 33 |
| prefix /22-/24, region ARIN, name "cloud" | 84 | 85 | 86 | 41 | 41 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 22 | 189 | 17 |
| Q2 routes per prefix length | 2.0 | 2.0 | 13 | 4.0 |
| Q3 routes and distinct networks per region | 17 | 16 | 82 | 14 |
| Q4 top 20 networks (group, sort, limit) | 14 | 13 | 81 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 20 | 22 | 94 | 16 |
| Q6 name search ("cloud", case-insensitive) | 5.0 | 5.0 | 48 | 5.0 |
| Q7 full sort of every route (prefix length, address) | 39 | 38 | 45 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 50 | 50 | 50 | 39 | 39 |
| prefix /22-/24, region ARIN, name "cloud" | 69 | 68 | 68 | 48 | 47 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 22 | 21 | 125 | 15 |
| Q2 routes per prefix length | 2.6 | 2.5 | 12 | 3.4 |
| Q3 routes and distinct networks per region | 19 | 19 | 80 | 12 |
| Q4 top 20 networks (group, sort, limit) | 14 | 14 | 58 | 8.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 28 | 28 | 76 | 14 |
| Q6 name search ("cloud", case-insensitive) | 7.4 | 7.3 | 57 | 3.9 |
| Q7 full sort of every route (prefix length, address) | 28 | 28 | 154 | 9.7 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 62 | 63 | 61 | 34 | 34 |
| prefix /22-/24, region ARIN, name "cloud" | 87 | 86 | 85 | 42 | 41 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).

## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 23 | 183 | 16 |
| Q2 routes per prefix length | 2.0 | 3.0 | 12 | 4.0 |
| Q3 routes and distinct networks per region | 16 | 16 | 81 | 14 |
| Q4 top 20 networks (group, sort, limit) | 14 | 12 | 81 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 20 | 22 | 93 | 16 |
| Q6 name search ("cloud", case-insensitive) | 6.0 | 6.0 | 48 | 5.0 |
| Q7 full sort of every route (prefix length, address) | 39 | 39 | 45 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 51 | 49 | 48 | 38 | 38 |
| prefix /22-/24, region ARIN, name "cloud" | 68 | 68 | 67 | 48 | 49 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).
