Loaded the WASM engine.
Q1: zamda 23.0 ms, no slicing 22.0 ms, Arquero 186.0 ms, WASM 17.0 ms
Q2: zamda 2.0 ms, no slicing 2.0 ms, Arquero 12.0 ms, WASM 4.0 ms
Q3: zamda 16.0 ms, no slicing 16.0 ms, Arquero 81.0 ms, WASM 13.0 ms
Q4: zamda 13.0 ms, no slicing 13.0 ms, Arquero 86.0 ms, WASM 9.0 ms
Q5: zamda 21.0 ms, no slicing 22.0 ms, Arquero 93.0 ms, WASM 16.0 ms
Q6: zamda 5.0 ms, no slicing 5.0 ms, Arquero 48.0 ms, WASM 5.0 ms
Q7: zamda 40.0 ms, no slicing 38.0 ms, Arquero 44.0 ms, WASM 10.0 ms
  WASM phases per interaction (four runs): prepare 0.0, strings and tables 0.0, start 0.1, steps 33.0, read 4.5 ms
interaction (nothing selected): together 50 ms, together no slicing 50 ms, one by one 50 ms; WASM together 39.0 ms, one by one 38.0 ms
  WASM phases per interaction (four runs): prepare 0.5, strings and tables 0.0, start 0.3, steps 46.2, read 0.0 ms
interaction (prefix /22-/24, region ARIN, name "cloud"): together 69 ms, together no slicing 67 ms, one by one 67 ms; WASM together 48.0 ms, one by one 47.0 ms


## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 22 | 186 | 17 |
| Q2 routes per prefix length | 2.0 | 2.0 | 12 | 4.0 |
| Q3 routes and distinct networks per region | 16 | 16 | 81 | 13 |
| Q4 top 20 networks (group, sort, limit) | 13 | 13 | 86 | 9.0 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 21 | 22 | 93 | 16 |
| Q6 name search ("cloud", case-insensitive) | 5.0 | 5.0 | 48 | 5.0 |
| Q7 full sort of every route (prefix length, address) | 40 | 38 | 44 | 10 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 50 | 50 | 50 | 39 | 38 |
| prefix /22-/24, region ARIN, name "cloud" | 69 | 67 | 67 | 48 | 47 |

WASM backend runs: 237 in the engine, 0 on the JS executor (should be 0).
