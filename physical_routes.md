# Physical BGP routes: what the current data can and cannot show

This app currently draws **logical BGP relationships**, not physical paths. An arc means “this RIS peer told us about a prefix originated by this AS”. It does not mean the update travelled along that great-circle line, or even that the two ASes are directly connected. A true physical-route view needs different data.

## Data available today

The prepared app inputs are `data/globe-routes.zcl`, `data/globe-updates.zcl` and `data/globe-as.zcl`. Their columns (defined in `apps/bgp-globe/src/lib/schemas.ts`, built by `packages/bgp-data/scripts/prep-globe.ts`) are:

- prefix: `prefix_addr`, `prefix_len`, `prefix_end`, `addresses`
- BGP facts: `origin_as`, `peer_as`, `path_len`, `kind`, `second`
- coarse geography: `cc` (country code of the origin AS), RIR, AS name, approximate AS longitude/latitude and a `precision` field

The live feed (`apps/bgp-globe/src/lib/live.ts`) exposes the same logical fields (`peer_asn`, `path` → origin and length, announced prefixes). It reads but currently discards `next_hop`.

The prepared tables **do not contain**:

- the IP address of a router or RIS peer
- BGP next-hop addresses
- the full AS path (only its length)
- interface addresses, link types, cable/facility IDs, or longitude/latitude for individual hops

The UI's IP lookup takes an arbitrary address from the user; it is not router metadata.

The raw MRT inputs under `/workspace/zamda/data/` do contain more:

- `PEER_INDEX_TABLE` entries include peer addresses (for example `2001:678:118c:ffff:0:0:0:254`).
- BGP4MP records include `peerIP` and `localIP` (for example `5.255.90.109` and `193.0.4.28`).
- AS-path segments can be retained (the low-level parser `packages/bgp-data/src/mrt.ts` already decodes them).

However, `packages/bgp-data/scripts/prep-bgp.ts` keeps only the **peer count** from the peer table, and `packages/bgp-data/src/updates.ts` skips the peer/local IP bytes. So none of this survives into the app.

## What would be needed for physical paths

### 1. Router/session endpoints

To map an update's origin you need, at minimum, the IP of the peer/router that announced it and a geolocation source for that IP. Options:

- Retain the MRT `peerIP`/`localIP` and `PEER_INDEX_TABLE` addresses, then enrich them with a commercial IP geolocation database. Public geolocation is often only city/country level and misses the actual PoP.
- Use the RIS collector's own location as the arc endpoint. This is easy but represents the collector, not where the neighbouring network's router sits.
- Use RIPE RIS data that already publishes peer geocoordinates where available, or PeeringDB facility coordinates keyed by peer AS. PeeringDB gives a network's facility presence, not the specific session interface, so it is still an approximation.

The app's existing AS points come from PeeringDB facilities or country centres (`precision 2 = facility`, `1 = country`, `0 = region`) and should be labelled as approximate.

### 2. The actual hop-by-hop path

`path_len` is not a path. To show the sequence of networks an advertisement traverses, preserve `AS_PATH` segments from the MRT data (the parser can already return `sequences`) and store them per update. Then you can draw an AS-level path: peer AS → intermediate ASes → origin AS. This is a logical inter-domain path, not a physical one, but it is much closer to “how the route travels” than a single peer→origin arc.

For true router/link-level paths you would need traceroute or MPLS/segment-routing telemetry, which BGP updates alone do not provide. Public datasets such as RIPE Atlas traceroutes, CAIDA Ark/ITDK, or Internet2/ESnet topology are the usual sources. They are measured paths between specific hosts, and they change over time.

### 3. Where cables and land paths fit

Undersea cable and terrestrial fibre maps (for example TeleGeography's submarine cable map, open datasets like `cablemap`, or national fibre maps) describe **physical infrastructure**, not BGP routes. Linking them to BGP requires a mapping from network hops or router PoPs to cable landing stations and fibre routes. Public data rarely provides that mapping at global scale.

Without such a mapping, the honest visualization is two layers:

- logical control plane: AS paths from BGP (`AS_PATH`), with approximate AS locations
- physical underlay: cable/fibre geometry, shown as background context only

Do not connect two AS dots and call the line a cable: an AS pair may be connected over many possible facilities, circuits and carriers.

## Practical options, ranked

1. **Cheapest and most defensible:** preserve full `AS_PATH` sequences in the update table and draw multi-hop AS chains between the existing approximate AS points. Keep the current dot locations, and say clearly that lines are AS relationships, not fibre.
2. **Better endpoints:** additionally retain peer/local IPs from MRT and enrich them with an IP-to-facility source (commercial GeoIP, RIPE peer geolocation, or PeeringDB). This improves where the first and last points of each path sit.
3. **True physical underlay:** join traceroute-derived router/link data (RIPE Atlas/CAIDA) to cable and terrestrial fibre datasets, then draw measured paths over the map. This is a substantial separate data pipeline and will always be partial.

## Relevant code locations

- App schemas and columns: `apps/bgp-globe/src/lib/schemas.ts`, `apps/bgp-globe/src/lib/data.ts`
- Live field parsing: `apps/bgp-globe/src/lib/live.ts`
- Queries that only use peer/origin/length: `apps/bgp-globe/src/lib/plans.ts`
- MRT decoding (can retain paths and peer addresses): `packages/bgp-data/src/mrt.ts`
- Where peer addresses are dropped: `packages/bgp-data/scripts/prep-bgp.ts`
- Where peer/local IPs are skipped: `packages/bgp-data/src/updates.ts`
- Where globe update columns are written: `packages/bgp-data/scripts/prep-globe.ts`
- AS location precision notes: `packages/bgp-data/src/graph-file.ts`, `packages/bgp-data/src/peeringdb.ts`, `packages/zamda/docs/BENCHMARKS.md`

## Bottom line

No, the current collected data does not show the specific IP addresses making route advertisements. The raw MRT files do, but the preparation pipeline discards them before the app sees them. Adding physical paths requires preserving router/session IPs and/or full AS paths, plus a geolocation source and, for cables/fibre, a separate infrastructure dataset. The existing arcs should be described as logical BGP relationships, not physical routes.
