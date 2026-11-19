# Chrome rerun after the WASM fallback fix (T-211, T-219, D-078)

Measured on 2026-11-19 on this machine with the same harness and data as `t210-browsers.md` (headless Chromium 156.0.8078.47, real `data/routes.bin` sampled to 1,000,000 rows, seven timed runs after two warm-ups per measurement, answers cross-checked before timing). The only code change from the run reported there is D-078: the WASM backend now checks the plan *after* constant folding and lookups are derived when deciding whether to fall back. That run recorded 109 ms for the selected WASM interaction; this one records 37.7 ms together and 34.0 ms one by one, with 295 engine runs and **no** JS fallbacks. Raw result: `t210-chrome-fallback-fix.json`.

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 24 | 23 | 134 | 16 |
| Q2 routes per prefix length | 2.7 | 2.6 | 13 | 3.8 |
| Q3 routes and distinct networks per region | 19 | 20 | 74 | 13 |
| Q4 top 20 networks (group, sort, limit) | 14 | 14 | 61 | 8.5 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 31 | 29 | 71 | 15 |
| Q6 name search ("cloud", case-insensitive) | 7.4 | 7.1 | 60 | 4.6 |
| Q7 full sort of every route (prefix length, address) | 36 | 37 | 145 | 11 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 69 | 68 | 68 | 39 | 37 |
| prefix /22-/24, region ARIN, name "cloud" | 89 | 89 | 87 | 38 | 34 |

WASM backend runs: 295 in the engine, 0 on the JS executor (none of the fallback paths of D-074 and T-219 were taken).
