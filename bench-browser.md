## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

zamda reference benchmark
Done.

Options in the address: ?rows=1000000&runs=7. Runs start automatically; keep this tab in the foreground.

Loaded the WASM engine.
Q1: zamda 21.7 ms, no slicing 21.2 ms, Arquero 121.8 ms, WASM 15.3 ms
Q2: zamda 2.5 ms, no slicing 2.5 ms, Arquero 11.4 ms, WASM 3.4 ms
Q3: zamda 19.1 ms, no slicing 18.1 ms, Arquero 72.0 ms, WASM 12.1 ms
Q4: zamda 14.4 ms, no slicing 13.4 ms, Arquero 57.6 ms, WASM 8.0 ms
Q5: zamda 29.6 ms, no slicing 28.7 ms, Arquero 75.1 ms, WASM 13.9 ms
Q6: zamda 7.6 ms, no slicing 7.6 ms, Arquero 56.6 ms, WASM 4.4 ms
Q7: zamda 28.7 ms, no slicing 28.4 ms, Arquero 137.6 ms, WASM 10.0 ms
  WASM phases per interaction (four runs): prepare 0.4, strings and tables 0.0, start 0.1, steps 29.4, read 3.4 ms
  WASM session cache over these runs: 0 hits, 7040 misses
interaction (nothing selected): together 64 ms, together no slicing 64 ms, one by one 64 ms; WASM together 34.9 ms, one by one 33.2 ms
  WASM phases per interaction (four runs): prepare 0.4, strings and tables 1.0, start 0.2, steps 30.4, read 0.1 ms
  WASM session cache over these runs: 560 hits, 6080 misses
interaction (prefix /22-/24, region ARIN, name "cloud"): together 86 ms, together no slicing 86 ms, one by one 86 ms; WASM together 34.4 ms, one by one 32.2 ms
  WASM one filter condition alone, counting rows (median ms): no filter 0.1, prefix length 22-24 1.8, region is ARIN 4.5, name contains cloud 4.4, all three 12.5

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 22 | 21 | 122 | 15 |
| Q2 routes per prefix length | 2.5 | 2.5 | 11 | 3.4 |
| Q3 routes and distinct networks per region | 19 | 18 | 72 | 12 |
| Q4 top 20 networks (group, sort, limit) | 14 | 13 | 58 | 8.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 30 | 29 | 75 | 14 |
| Q6 name search ("cloud", case-insensitive) | 7.6 | 7.6 | 57 | 4.4 |
| Q7 full sort of every route (prefix length, address) | 29 | 28 | 138 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 64 | 64 | 64 | 35 | 33 |
| prefix /22-/24, region ARIN, name "cloud" | 86 | 86 | 86 | 34 | 32 |

WASM backend runs: 295 in the engine, 0 on the JS executor (should be 0).

## Firefox/158.0: 1,000,000 rows (medians, ms)

Loaded the WASM engine.
Q1: zamda 21.0 ms, no slicing 21.0 ms, Arquero 192.0 ms, WASM 17.0 ms
Q2: zamda 2.0 ms, no slicing 2.0 ms, Arquero 15.0 ms, WASM 4.0 ms
Q3: zamda 17.0 ms, no slicing 17.0 ms, Arquero 98.0 ms, WASM 14.0 ms
Q4: zamda 13.0 ms, no slicing 13.0 ms, Arquero 85.0 ms, WASM 9.0 ms
Q5: zamda 21.0 ms, no slicing 21.0 ms, Arquero 107.0 ms, WASM 17.0 ms
Q6: zamda 3.0 ms, no slicing 3.0 ms, Arquero 141.0 ms, WASM 6.0 ms
Q7: zamda 39.0 ms, no slicing 39.0 ms, Arquero 50.0 ms, WASM 10.0 ms
  WASM phases per interaction (four runs): prepare 0.4, strings and tables 0.1, start 0.1, steps 33.4, read 4.4 ms
  WASM session cache over these runs: 0 hits, 7040 misses
interaction (nothing selected): together 50 ms, together no slicing 49 ms, one by one 47 ms; WASM together 41.0 ms, one by one 38.0 ms
  WASM phases per interaction (four runs): prepare 0.1, strings and tables 1.1, start 0.1, steps 34.2, read 0.1 ms
  WASM session cache over these runs: 560 hits, 6080 misses
interaction (prefix /22-/24, region ARIN, name "cloud"): together 61 ms, together no slicing 61 ms, one by one 62 ms; WASM together 39.0 ms, one by one 35.0 ms
  WASM one filter condition alone, counting rows (median ms): no filter 0.0, prefix length 22-24 2.0, region is ARIN 6.0, name contains cloud 6.0, all three 14.0


| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 21 | 21 | 192 | 17 |
| Q2 routes per prefix length | 2.0 | 2.0 | 15 | 4.0 |
| Q3 routes and distinct networks per region | 17 | 17 | 98 | 14 |
| Q4 top 20 networks (group, sort, limit) | 13 | 13 | 85 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 21 | 21 | 107 | 17 |
| Q6 name search ("cloud", case-insensitive) | 3.0 | 3.0 | 141 | 6.0 |
| Q7 full sort of every route (prefix length, address) | 39 | 39 | 50 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 50 | 49 | 47 | 41 | 38 |
| prefix /22-/24, region ARIN, name "cloud" | 61 | 61 | 62 | 39 | 35 |

WASM backend runs: 295 in the engine, 0 on the JS executor (should be 0).

## Firefox/158.0: 1,000,000 rows (medians, ms)

zamda reference benchmark

Done.

Options in the address: ?rows=1000000&runs=7. Runs start automatically; keep this tab in the foreground.

Loaded the WASM engine.
Q1: zamda 24.0 ms, no slicing 23.0 ms, Arquero 193.0 ms, WASM 17.0 ms
Q2: zamda 2.0 ms, no slicing 2.0 ms, Arquero 12.0 ms, WASM 4.0 ms
Q3: zamda 17.0 ms, no slicing 17.0 ms, Arquero 85.0 ms, WASM 14.0 ms
Q4: zamda 13.0 ms, no slicing 13.0 ms, Arquero 83.0 ms, WASM 9.0 ms
Q5: zamda 21.0 ms, no slicing 22.0 ms, Arquero 95.0 ms, WASM 16.0 ms
Q6: zamda 6.0 ms, no slicing 5.0 ms, Arquero 49.0 ms, WASM 6.0 ms
Q7: zamda 39.0 ms, no slicing 38.0 ms, Arquero 45.0 ms, WASM 11.0 ms
  WASM phases per interaction (four runs): prepare 0.2, strings and tables 0.0, start 0.0, steps 32.8, read 4.3 ms
  WASM session cache over these runs: 0 hits, 7040 misses
interaction (nothing selected): together 52 ms, together no slicing 51 ms, one by one 51 ms; WASM together 38.0 ms, one by one 37.0 ms
  WASM phases per interaction (four runs): prepare 0.3, strings and tables 1.1, start 0.1, steps 34.0, read 0.0 ms
  WASM session cache over these runs: 560 hits, 6080 misses
interaction (prefix /22-/24, region ARIN, name "cloud"): together 68 ms, together no slicing 67 ms, one by one 68 ms; WASM together 38.0 ms, one by one 35.0 ms
  WASM one filter condition alone, counting rows (median ms): no filter 0.0, prefix length 22-24 2.0, region is ARIN 6.0, name contains cloud 5.0, all three 15.0


| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 24 | 23 | 193 | 17 |
| Q2 routes per prefix length | 2.0 | 2.0 | 12 | 4.0 |
| Q3 routes and distinct networks per region | 17 | 17 | 85 | 14 |
| Q4 top 20 networks (group, sort, limit) | 13 | 13 | 83 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 21 | 22 | 95 | 16 |
| Q6 name search ("cloud", case-insensitive) | 6.0 | 5.0 | 49 | 6.0 |
| Q7 full sort of every route (prefix length, address) | 39 | 38 | 45 | 11 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 52 | 51 | 51 | 38 | 37 |
| prefix /22-/24, region ARIN, name "cloud" | 68 | 67 | 68 | 38 | 35 |

WASM backend runs: 295 in the engine, 0 on the JS executor (should be 0).

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

zamda reference benchmark
Done.

Options in the address: ?rows=1000000&runs=7. Runs start automatically; keep this tab in the foreground.

Loaded the WASM engine.
Q1: zamda 22.0 ms, no slicing 21.6 ms, Arquero 123.2 ms, WASM 15.4 ms
Q2: zamda 2.5 ms, no slicing 2.5 ms, Arquero 11.6 ms, WASM 3.4 ms
Q3: zamda 19.0 ms, no slicing 18.4 ms, Arquero 76.1 ms, WASM 12.1 ms
Q4: zamda 13.8 ms, no slicing 13.6 ms, Arquero 58.7 ms, WASM 7.9 ms
Q5: zamda 27.3 ms, no slicing 28.3 ms, Arquero 80.1 ms, WASM 13.9 ms
Q6: zamda 7.8 ms, no slicing 7.6 ms, Arquero 57.9 ms, WASM 4.4 ms
Q7: zamda 29.6 ms, no slicing 29.0 ms, Arquero 152.3 ms, WASM 10.0 ms
  WASM phases per interaction (four runs): prepare 0.3, strings and tables 0.0, start 0.1, steps 29.4, read 3.4 ms
  WASM session cache over these runs: 0 hits, 7040 misses
interaction (nothing selected): together 63 ms, together no slicing 63 ms, one by one 65 ms; WASM together 34.3 ms, one by one 33.1 ms
  WASM phases per interaction (four runs): prepare 0.4, strings and tables 1.0, start 0.2, steps 29.9, read 0.1 ms
  WASM session cache over these runs: 560 hits, 6080 misses
interaction (prefix /22-/24, region ARIN, name "cloud"): together 89 ms, together no slicing 85 ms, one by one 86 ms; WASM together 34.4 ms, one by one 31.4 ms
  WASM one filter condition alone, counting rows (median ms): no filter 0.1, prefix length 22-24 1.8, region is ARIN 4.4, name contains cloud 4.3, all three 12.3

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 22 | 22 | 123 | 15 |
| Q2 routes per prefix length | 2.5 | 2.5 | 12 | 3.4 |
| Q3 routes and distinct networks per region | 19 | 18 | 76 | 12 |
| Q4 top 20 networks (group, sort, limit) | 14 | 14 | 59 | 7.9 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 27 | 28 | 80 | 14 |
| Q6 name search ("cloud", case-insensitive) | 7.8 | 7.6 | 58 | 4.4 |
| Q7 full sort of every route (prefix length, address) | 30 | 29 | 152 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 63 | 63 | 65 | 34 | 33 |
| prefix /22-/24, region ARIN, name "cloud" | 89 | 85 | 86 | 34 | 31 |

WASM backend runs: 295 in the engine, 0 on the JS executor (should be 0).
