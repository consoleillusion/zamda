# Roadmap

Three milestones, with one go/no-go spike before the third. Milestones 1 and 2
are TypeScript only and produce a usable library on their own.

```
 [1 Core] ----> [2 JS release] ----> <Spike> --pass--> [3 WASM engine] ----> [Later]
    done                                |
                                        +--fail--> stop at 2; zamda is a JS library
```

**Current position:** Milestone 2. Chunked execution (T-201), `latest()` (T-202), live tables (T-204) and the dataset script (T-205) are done. The dashboard (T-206) is built and measured by the owner on real data in Chromium: 109 to 123 ms per interaction, inside the 200 ms target (T-217). The benchmark harness (T-207) is done and the WASM spike (S-301) has started: Rust kernels exist under `spike/` and are checked against the JS answers; the WASM build awaits measurement on the owner's machine.

## Milestones

| Milestone | Delivers | Done when |
| --- | --- | --- |
| **1 Core** | Typed DSL, IR, compiler, JS executor for every MVP operator and function | Every rule in `docs/CONTRACT.md` is `pinned` and passes on the JS backend; core is 40 KB gzipped or less |
| **2 JS release** | Chunked execution, cancellation, parameters, optimizer, append-only live tables, reference dashboard, docs, public alpha on npm | The routing dashboard meets its JS target; an outside developer ships a pipeline without help |
| **Spike** | Throwaway WASM prototypes of group-by and sort; kernels vs DataFusion; row-loading and overflow cost | See "Spike gate" below. If it fails, stop here |
| **3 WASM engine** | Rust kernel engine in a worker, row loading, memory budget, failure model | The same golden suite passes on WASM; random plans match the JS backend |
| **Later** | Keyed live tables, then Substrait export, then joins and window functions | Each ships with its own contract rules and golden tests |

## Targets

Accepted by the owner. They are goals, not measurements.

| Target | Measure | Value |
| --- | --- | --- |
| Core size | DSL + compiler + JS executor, gzipped | 40 KB or less (enforced by `bun run size`) |
| WASM engine size | Gzipped `.wasm` plus glue, MVP operators | 400 KB or less |
| WASM speed | Grouped aggregate and sort at 1M rows vs the JS executor, loading included | 3x or more |
| Crossover | Row count where WASM beats the JS executor, loading included | 100k rows or fewer, published |
| Dashboard latency, JS | One interaction on the reference dashboard | 200 ms or less |
| Dashboard latency, WASM | One interaction on the reference dashboard | 50 ms or less |

## Spike gate

The spike passes only if all of these hold, measured on the reference dataset
with the cost of loading JS rows included:

1. Grouped aggregate and sort are at least 3x faster than the JS executor at 1M rows.
2. The engine is 400 KB gzipped or less.
3. WASM is ahead from 100k rows or fewer.

Checked arithmetic stays the default whatever the spike measures; the spike
records its cost for the record.

## Reference dashboard

The acceptance test for Milestone 2 and the benchmark for the spike.

- **Data:** one snapshot of the global IPv4 BGP routing table from RIPE RIS
  (collector rrc00), about a million routes. `bun run prep-bgp` downloads it
  and writes `data/routes.bin`; no data is redistributed with zamda.
- **Columns:** `prefix_addr` uint32, `prefix_len` uint8, `origin_as` uint32,
  `as_name` dictionary, `path_len` uint8, `rir` dictionary.
- **Charts:** top 20 networks by route count; prefix-length histogram;
  path-length histogram; routes and distinct networks by region.
- **Controls:** range brushes (`between`), region multi-select (`isIn`), name
  search (`contains`), address range. Every control is a plan parameter.
- **One interaction** re-runs the three charts other than the one being touched.
- **Live panel:** a rolling-window table fed by a public stream of BGP updates
  (RIPE RIS Live), showing announcements and withdrawals per 5 seconds over the
  last 5 minutes and the most active networks. `?live=sim` uses a simulated feed.

## Non-goals for v1

JS callbacks during execution, SQL parsing, persistence, joins, window
functions, incremental query maintenance, threads, decimals, distributed or GPU
execution.

## After the MVP, in order

1. **Keyed live tables:** insert, replace and delete rows by key, so the
   snapshot charts can track a live routing table.
2. **Substrait export:** built when there is a specific engine to send plans to.
3. **Joins and window functions,** one at a time.
