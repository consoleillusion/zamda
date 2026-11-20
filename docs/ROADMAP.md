# Roadmap

Three milestones, with one go/no-go spike before the third. Milestones 1 and 2
are TypeScript only and produce a usable library on their own.

```
 [1 Core] ----> [2 JS release] ----> <Spike> --pass--> [3 WASM engine] ----> [Later]
    done                                |
                                        +--fail--> stop at 2; zamda is a JS library
```

**Current position:** Milestones 1 and 3 are done; Milestone 2 is done except the npm alpha (T-209, blocked on npm auth). The general WASM engine meets the 50 ms dashboard target on the owner's machine (D-069, D-070) with no JS fallbacks, and `zamda/wasm` is the public entry (D-089). Since then: Substrait (T-501), keyed live tables (T-502), joins and windows on the JS backend (T-503), and the AS-graph demo work (T-504 to T-513), none of which is in spec v4.

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
- **Graph data:** `bun run prep-bgp` also writes `data/graph.bin`: one row per
  AS and one weighted directed edge per consecutive pair in the chosen route's
  `AS_PATH`, with labels, frozen positions and approximate country-centre spans
  (D-079, D-084). The same dump produced 80,226 nodes and 122,862 edges on
  18 November 2026.
- **Charts:** top 20 networks by route count; prefix-length histogram;
  path-length histogram; routes and distinct networks by region.
- **Controls:** range brushes (`between`), region multi-select (`isIn`), name
  search (`contains`), address range. Every control is a plan parameter.
- **One interaction** re-runs the three charts other than the one being touched.
- **Live panel:** a rolling-window table fed by a public stream of BGP updates
  (RIPE RIS Live), showing announcements and withdrawals per 5 seconds over the
  last 5 minutes and the most active networks. `?live=sim` uses a simulated feed.

## Non-goals for v1

JS callbacks during execution, SQL parsing, persistence, incremental query
maintenance, threads, decimals, distributed or GPU execution.

## After the MVP, in order

1. **Keyed live tables (T-502, done):** insert, replace and delete rows by key,
   so the snapshot charts can track a live routing table.
2. **Substrait export (T-501, done):** built when there is a specific engine to
   send plans to.
3. **Joins and window functions (T-503, done):** joins first, then windows,
   with contract rules C-JOIN and C-WINDOW. The JS backend runs both; the WASM
   engine rejects them with `PlanError` until it supports them (D-077).
