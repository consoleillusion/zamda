# Worker host in real browsers (T-409)

`bench/reference/browser/worker.html` was run on 2026-11-19 in headless Chromium 156.0.8078.47
and Firefox 158.0.1 against `dist/zamda-engine.wasm` (732,654 bytes, 146,839 bytes gzipped)
and the real `data/routes.bin` sampled to 1,000,000 rows. Five runs per query. Raw results:
`t409-chrome.json` and `t409-firefox.json`.

| Check | Chrome | Firefox | Limit |
| --- | --- | --- | --- |
| Worker starts and answers | 15 ms | 18 ms | starts |
| Transfer moves typed arrays | 4 of 4 detached | 4 of 4 detached | all detached |
| Worker answers equal JS backend | 7 of 7 queries | 7 of 7 queries | all equal |
| Longest page-thread gap while worker runs plans | 4.2 ms | 5.0 ms | under 50 ms |
| Abort rejects at once, worker stays usable | `AbortError` 0.1 ms after `abort()`, next run correct | `AbortError` 0.0 ms after `abort()`, next run correct | `AbortError` under 50 ms, next run correct |
| Byte limit raises `MemoryError` and keeps engine | `MemoryError`, 0 replacements, first table correct | `MemoryError`, 0 replacements, first table correct | same |

The control measurement (the same plans on the page thread) left gaps of 947.8 ms in Chrome and
1016.0 ms in Firefox; the old 0.0 ms control was the measuring flaw noted in D-071. Median cost
of routing one query through the worker rather than running it on the page thread: Q1 19.3 vs
17.3 ms in Chrome and 21 vs 19 ms in Firefox; Q7 124.3 vs 122 ms and 132 vs 123 ms. All six
checks passed in both browsers.
