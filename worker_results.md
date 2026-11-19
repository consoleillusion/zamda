## Chromium 

zamda worker check
Some checks FAILED.

Options in the address: ?rows=1000000&runs=5. Runs start automatically; keep this tab in the foreground. The engine runs in a Web Worker; each check below prints its measured value and its limit.

PASS  worker starts and answers: measured 18 ms; limit starts
PASS  transfer moves the typed arrays to the worker: measured 4 of 4 arrays detached on the page; limit all detached
PASS  worker answers equal the JS backend: measured 7 of 7 queries equal; limit all equal
PASS  page thread gap while the worker runs plans: measured 15.0 ms longest gap between 4 ms timer ticks; limit under 50 ms (a 4 ms tick that is 50 ms late is visible jank)
  control: the same plans on this thread leave a gap of 0.0 ms
  median per query: Q1 worker 19.3 ms, this thread 17.7 ms; Q2 worker 3.2 ms, this thread 3.2 ms; Q3 worker 12.5 ms, this thread 12.1 ms; Q4 worker 10.1 ms, this thread 10.0 ms; Q5 worker 14.6 ms, this thread 14.3 ms; Q6 worker 5.1 ms, this thread 4.9 ms; Q7 worker 125.0 ms, this thread 125.6 ms
FAIL  abort rejects at once, the worker stays usable: measured other outcome 0.2 ms after abort(); next run correct; limit AbortError within 50 ms of abort(); next run correct
PASS  byte limit raises MemoryError and keeps the engine: measured MemoryError; engine replaced 0 times; first table still correct; limit MemoryError; 0 replacements; first table still correct
PASS  worker starts and answers
      measured: 18 ms
      limit:    starts
PASS  transfer moves the typed arrays to the worker
      measured: 4 of 4 arrays detached on the page
      limit:    all detached
PASS  worker answers equal the JS backend
      measured: 7 of 7 queries equal
      limit:    all equal
PASS  page thread gap while the worker runs plans
      measured: 15.0 ms longest gap between 4 ms timer ticks
      limit:    under 50 ms (a 4 ms tick that is 50 ms late is visible jank)
FAIL  abort rejects at once, the worker stays usable
      measured: other outcome 0.2 ms after abort(); next run correct
      limit:    AbortError within 50 ms of abort(); next run correct
PASS  byte limit raises MemoryError and keeps the engine
      measured: MemoryError; engine replaced 0 times; first table still correct
      limit:    MemoryError; 0 replacements; first table still correct

1,000,000 rows
control: the same plans on this thread leave a gap of 0.0 ms (no limit; it shows what the worker saves)
median per query: Q1 worker 19.3 ms, this thread 17.7 ms; Q2 worker 3.2 ms, this thread 3.2 ms; Q3 worker 12.5 ms, this thread 12.1 ms; Q4 worker 10.1 ms, this thread 10.0 ms; Q5 worker 14.6 ms, this thread 14.3 ms; Q6 worker 5.1 ms, this thread 4.9 ms; Q7 worker 125.0 ms, this thread 125.6 ms

## Firefox

zamda worker check

Some checks FAILED.

Options in the address: ?rows=1000000&runs=5. Runs start automatically; keep this tab in the foreground. The engine runs in a Web Worker; each check below prints its measured value and its limit.

PASS  worker starts and answers: measured 38 ms; limit starts
PASS  transfer moves the typed arrays to the worker: measured 4 of 4 arrays detached on the page; limit all detached
PASS  worker answers equal the JS backend: measured 7 of 7 queries equal; limit all equal
PASS  page thread gap while the worker runs plans: measured 5.0 ms longest gap between 4 ms timer ticks; limit under 50 ms (a 4 ms tick that is 50 ms late is visible jank)
  control: the same plans on this thread leave a gap of 0.0 ms
  median per query: Q1 worker 21.0 ms, this thread 19.0 ms; Q2 worker 4.0 ms, this thread 4.0 ms; Q3 worker 14.0 ms, this thread 14.0 ms; Q4 worker 11.0 ms, this thread 10.0 ms; Q5 worker 16.0 ms, this thread 16.0 ms; Q6 worker 6.0 ms, this thread 7.0 ms; Q7 worker 128.0 ms, this thread 126.0 ms
FAIL  abort rejects at once, the worker stays usable: measured other outcome 0.0 ms after abort(); next run correct; limit AbortError within 50 ms of abort(); next run correct
PASS  byte limit raises MemoryError and keeps the engine: measured MemoryError; engine replaced 0 times; first table still correct; limit MemoryError; 0 replacements; first table still correct

PASS  worker starts and answers
      measured: 38 ms
      limit:    starts
PASS  transfer moves the typed arrays to the worker
      measured: 4 of 4 arrays detached on the page
      limit:    all detached
PASS  worker answers equal the JS backend
      measured: 7 of 7 queries equal
      limit:    all equal
PASS  page thread gap while the worker runs plans
      measured: 5.0 ms longest gap between 4 ms timer ticks
      limit:    under 50 ms (a 4 ms tick that is 50 ms late is visible jank)
FAIL  abort rejects at once, the worker stays usable
      measured: other outcome 0.0 ms after abort(); next run correct
      limit:    AbortError within 50 ms of abort(); next run correct
PASS  byte limit raises MemoryError and keeps the engine
      measured: MemoryError; engine replaced 0 times; first table still correct
      limit:    MemoryError; 0 replacements; first table still correct

1,000,000 rows
control: the same plans on this thread leave a gap of 0.0 ms (no limit; it shows what the worker saves)
median per query: Q1 worker 21.0 ms, this thread 19.0 ms; Q2 worker 4.0 ms, this thread 4.0 ms; Q3 worker 14.0 ms, this thread 14.0 ms; Q4 worker 11.0 ms, this thread 10.0 ms; Q5 worker 16.0 ms, this thread 16.0 ms; Q6 worker 6.0 ms, this thread 7.0 ms; Q7 worker 128.0 ms, this thread 126.0 ms
