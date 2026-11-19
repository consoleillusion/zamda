# Reference dashboard in Firefox (T-217)

`bun run demo` was driven in headless Firefox 158.0.1 on 2026-11-19 against a real
`data/routes.bin` (1,163,624 IPv4 routes from the RIPE RIS rrc00 dump of
2026-11-18) and the real RIS Live feed (collector rrc00, not the simulated feed).
The page reported `live from RIS Live, collector rrc00`; the routes loaded in
63 ms. Raw result: `t217-firefox.json`.

| Chart | First load | After typing `cloud` in the name search |
| --- | ---: | ---: |
| Networks | 91 ms | 75 ms |
| Prefix length | 34 ms | 36 ms |
| Path length | 15 ms | 14 ms |
| Regions | 69 ms | 8.0 ms |
| Live panel refresh | 4.0 ms | 4.0 ms |

The search's selection was reported as `Showing: name contains "cloud"`. Every
chart stayed under the 200 ms-per-interaction target; the slowest first-load
chart was 91 ms and the slowest selected chart was 75 ms. This completes the
Firefox half of T-217. The numbers are from one headless run on the development
machine, not repeated medians on the owner's hardware.
