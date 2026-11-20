# zamda workspace

Two projects in one repository, kept apart on purpose:

| Path | What | Published |
| --- | --- | --- |
| [`packages/zamda/`](packages/zamda/) | **The library**: typed columnar pipelines for JavaScript, with a JS executor and a Rust/WASM engine (`zamda`, `zamda/wasm`) | npm |
| [`packages/bgp-data/`](packages/bgp-data/) | BGP data for the demo and benchmarks: MRT reader (RIB dumps and update dumps), file formats, prep scripts | no |
| [`bench/`](bench/) | Benchmarks of the library (JS vs WASM vs Arquero) on the BGP reference dataset | no |
| [`apps/bgp-globe/`](apps/bgp-globe/) | **Live Internet**: the global routing table and an hour of BGP updates on a globe (Astro + Svelte + deck.gl), with a JS/WASM switch | no |

The library never imports anything else here (a lint rule enforces it).

```sh
bun install
bun run build          # the WASM engine and the library bundles (needs rustup target wasm32-unknown-unknown)
bun run prep-bgp       # download a RIPE RIS dump and build data/routes.bin and data/graph.bin
bun run prep-globe     # an hour of RIS updates and the globe's data files
bun run demo           # http://localhost:4321
bun run check          # every workspace's typecheck and tests
bun run lint
```

Contributor rules for the library are in [`packages/zamda/AGENTS.md`](packages/zamda/AGENTS.md).
