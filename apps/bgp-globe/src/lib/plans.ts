// Every question the page asks, as compiled zamda plans. Each is compiled once; a slider, a click or a
// new second of live data only changes parameter values. The same compiled plan runs on the JS table or
// the WASM table, whichever the engine switch selects.

import { count, list, pipe, t } from 'zamda';
import { Routes, Updates } from './schemas';

// The filters every update query shares.
const WINDOW = {
  lo: t.uint32,
  hi: t.uint32,
  kinds: list(t.uint8),
  anyCountry: t.bool,
  countries: list(t.uint8),
  lenLo: t.uint8,
  lenHi: t.uint8,
};

function windowed() {
  // Purpose: the updates inside the time window that pass the kind, country and prefix-length filters
  return pipe(Updates, WINDOW).filter((c, p) =>
    c.second
      .between(p.lo, p.hi)
      .and(c.kind.isIn(p.kinds))
      .and(p.anyCountry.or(c.cc.isIn(p.countries)))
      .and(c.prefix_len.between(p.lenLo, p.lenHi)),
  );
}

export const ARC_LIMIT = 1500;
export const MOAS_LIMIT = 30;

export function compileUpdatePlans() {
  // Purpose: the per-frame questions about the update log
  return {
    // Activity per originating network: the bubbles.
    origins: windowed()
      .groupBy(c => ({ origin_as: c.origin_as }))
      .agg(c => ({ updates: count(), withdraws: c.kind.sum(), prefixes: c.pkey.countDistinct() }))
      .compile(),
    // Who heard what from whom: RIS peer to origin, the strongest pairs: the arcs.
    arcs: windowed()
      .groupBy(c => ({ peer_as: c.peer_as, origin_as: c.origin_as }))
      .agg(c => ({ updates: count(), withdraws: c.kind.sum() }))
      .sort(c => [c.updates.desc(), c.peer_as.asc(), c.origin_as.asc()])
      .limit(ARC_LIMIT)
      .compile(),
    // Activity per country: the choropleth.
    countries: windowed()
      .groupBy(c => ({ cc: c.cc }))
      .agg(c => ({ updates: count(), withdraws: c.kind.sum(), networks: c.origin_as.countDistinct() }))
      .compile(),
    // Prefixes announced by more than one origin network in the window: possible hijacks or leaks (MOAS).
    moas: windowed()
      .filter(c => c.kind.eq(0))
      .groupBy(c => ({ prefix_addr: c.prefix_addr, prefix_len: c.prefix_len }))
      .agg(c => ({ origins: c.origin_as.countDistinct(), updates: count() }))
      .filter(c => c.origins.gt(1))
      .sort(c => [c.origins.desc(), c.updates.desc(), c.prefix_addr.asc()])
      .limit(MOAS_LIMIT)
      .compile(),
    totals: windowed()
      .agg(c => ({ updates: count(), withdraws: c.kind.sum(), prefixes: c.pkey.countDistinct(), networks: c.origin_as.countDistinct(), peers: c.peer_as.countDistinct() }))
      .compile(),
  };
}

export function compileTimelinePlan() {
  // Purpose: updates per time bucket over the whole log, split by kind (the timeline under the replay)
  return pipe(Updates, { width: t.uint32, kinds: list(t.uint8), anyCountry: t.bool, countries: list(t.uint8), lenLo: t.uint8, lenHi: t.uint8 })
    .filter((c, p) => c.kind.isIn(p.kinds).and(p.anyCountry.or(c.cc.isIn(p.countries))).and(c.prefix_len.between(p.lenLo, p.lenHi)))
    .groupBy((c, p) => ({ bucket: c.second.intDiv(p.width), kind: c.kind }))
    .agg(() => ({ updates: count() }))
    .compile();
}

export function compileOriginsOfPrefixPlan() {
  // Purpose: which networks announced one prefix in the window, for a possible hijack's detail
  return pipe(Updates, { lo: t.uint32, hi: t.uint32, addr: t.uint32, len: t.uint8 })
    .filter((c, p) => c.second.between(p.lo, p.hi).and(c.kind.eq(0)).and(c.prefix_addr.eq(p.addr)).and(c.prefix_len.eq(p.len)))
    .groupBy(c => ({ origin_as: c.origin_as }))
    .agg(c => ({ updates: count(), first: c.second.min(), last: c.second.max() }))
    .sort(c => [c.updates.desc(), c.origin_as.asc()])
    .compile();
}

export function compileRoutePlans() {
  // Purpose: questions about the current routing table
  return {
    countries: pipe(Routes)
      .groupBy(c => ({ cc: c.cc }))
      .agg(c => ({ routes: count(), addresses: c.addresses.sum(), networks: c.origin_as.countDistinct() }))
      .compile(),
    totals: pipe(Routes)
      .agg(c => ({ routes: count(), addresses: c.addresses.sum(), networks: c.origin_as.countDistinct() }))
      .compile(),
    // Longest-prefix match: the most specific route covering an address, as a router would choose.
    lookup: pipe(Routes, { ip: t.uint32 })
      .filter((c, p) => c.prefix_addr.lte(p.ip).and(c.prefix_end.gte(p.ip)))
      .sort(c => [c.prefix_len.desc(), c.prefix_addr.asc()])
      .limit(8)
      .compile(),
    ofNetwork: pipe(Routes, { asn: t.uint32 })
      .filter((c, p) => c.origin_as.eq(p.asn))
      .agg(c => ({ routes: count(), addresses: c.addresses.sum(), longest: c.prefix_len.max(), shortest: c.prefix_len.min() }))
      .compile(),
    prefixLengths: pipe(Routes)
      .groupBy(c => ({ prefix_len: c.prefix_len }))
      .agg(() => ({ routes: count() }))
      .compile(),
  };
}

export type UpdatePlans = ReturnType<typeof compileUpdatePlans>;
export type RoutePlans = ReturnType<typeof compileRoutePlans>;
