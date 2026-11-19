# Reference queries in Chrome and Firefox (T-210)

Measured on 2026-11-19 on this machine (headless Chromium 156.0.8078.47 and Firefox 158.0.1) against the real `data/routes.bin` from RIPE RIS rrc00 (1,165,315 routes), sampled to 1,000,000 rows. Seven timed runs after two warm-ups per measurement; every answer was cross-checked between zamda and Arquero, and the WASM backend was cross-checked against the JS backend, before timing. Raw results: `t210-chrome.json` and `t210-firefox.json`.

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 24 | 24 | 175 | 16 |
| Q2 routes per prefix length | 1.9 | 1.9 | 12 | 3.1 |
| Q3 routes and distinct networks per region | 19 | 18 | 122 | 12 |
| Q4 top 20 networks (group, sort, limit) | 15 | 15 | 106 | 8.7 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 30 | 30 | 73 | 13 |
| Q6 name search ("cloud", case-insensitive) | 7.5 | 7.7 | 37 | 4.6 |
| Q7 full sort of every route (prefix length, address) | 62 | 61 | 372 | 113 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 67 | 68 | 68 | 95 | 94 |
| prefix /22-/24, region ARIN, name "cloud" | 80 | 81 | 87 | 105 | 102 |

WASM backend runs: 127 in the engine, 168 on the JS executor (the string fallbacks of D-074 and T-219).

---

## Firefox/158.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero | WASM |
| --- | ---: | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 28 | 27 | 231 | 18 |
| Q2 routes per prefix length | 2.0 | 2.0 | 12 | 3.0 |
| Q3 routes and distinct networks per region | 16 | 16 | 129 | 13 |
| Q4 top 20 networks (group, sort, limit) | 14 | 14 | 161 | 10 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 25 | 24 | 94 | 15 |
| Q6 name search ("cloud", case-insensitive) | 6.0 | 6.0 | 36 | 7.0 |
| Q7 full sort of every route (prefix length, address) | 72 | 72 | 403 | 117 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing | WASM together | WASM one by one |
| --- | ---: | ---: | ---: | ---: | ---: |
| nothing selected | 58 | 59 | 59 | 87 | 88 |
| prefix /22-/24, region ARIN, name "cloud" | 53 | 49 | 51 | 75 | 78 |

WASM backend runs: 127 in the engine, 168 on the JS executor (the string fallbacks of D-074 and T-219).
