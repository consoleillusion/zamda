// The page's state and the work behind it: loading, the two engines, the replay clock, the live feed and
// the queries each frame runs. Components only read this and call its methods.

import { ARC_LIMIT, compileOriginsOfPrefixPlan, compileRoutePlans, compileTimelinePlan, compileUpdatePlans } from './plans';
import { loadAll, prefixSize } from './data';
import type { Networks, RouteColumns, UpdateColumns, ObservedIp, ObservedRoute } from './data';
import { Engines } from './engines';
import type { EngineName, EngineTables } from './engines';
import { startFeed } from './live';
import type { Feed, FeedSource, LiveRow } from './live';
import { NONE } from './schemas';
import { num, parseIp } from './format';

export type Mode = 'replay' | 'live';
export type Projection = 'globe' | 'mercator';

export interface OriginRow {
  readonly asn: number;
  readonly updates: number;
  readonly withdraws: number;
  readonly prefixes: number;
}

export interface ArcRow {
  readonly peer: number;
  readonly origin: number;
  readonly updates: number;
  readonly withdraws: number;
}

export interface NetworkResult {
  readonly asn: number;
  readonly name: string;
  readonly country: string;
}

export interface MoasRow {
  readonly addr: number;
  readonly len: number;
  readonly origins: number;
  readonly updates: number;
}

export interface Totals {
  readonly updates: number;
  readonly withdraws: number;
  readonly prefixes: number;
  readonly networks: number;
  readonly peers: number;
}

export interface Pulse {
  readonly lon: number;
  readonly lat: number;
  readonly kind: number;
  readonly born: number;
}

type LiveIp = { -readonly [K in keyof ObservedIp]: ObservedIp[K] };
type LiveRoute = { -readonly [K in keyof ObservedRoute]: ObservedRoute[K] };

const HISTORY = 90;
const TIMELINE_BUCKET = 20;
const LIVE_WINDOW = 120;

const updatePlans = compileUpdatePlans();
const routePlans = compileRoutePlans();
const timelinePlan = compileTimelinePlan();
const originsOfPrefix = compileOriginsOfPrefixPlan();

export class Model {
  phase = $state<'loading' | 'ready' | 'error'>('loading');
  loadText = $state('starting');
  loadFraction = $state(0);
  error = $state<string | null>(null);

  engine = $state<EngineName>('wasm');
  wasmStatus = $state('waiting for data');
  wasmReady = $state(false);
  projection = $state<Projection>('globe');
  mode = $state<Mode>('live');
  autoRotate = $state(false);

  // Filters.
  kinds = $state<number[]>([0, 1]);
  country = $state<number | null>(null);
  lenRange = $state<[number, number]>([0, 32]);

  // The replay clock: the window [t - span, t] in seconds from the recording's start.
  t = $state(300);
  span = $state(60);
  playing = $state(false);
  speed = $state(20);

  // Physical-IP view: every BGP-speaking IP we have observed and the paths it advertised.
  selectedAsn = $state<number | null>(null);
  showCables = $state(true);
  pathDetail = $state<'as-paths' | 'ips-geoip'>('ips-geoip');
  observedIps = $state.raw<ObservedIp[]>([]);
  observedRoutes = $state.raw<ObservedRoute[]>([]);

  // Results the map and panels draw.
  origins = $state.raw<OriginRow[]>([]);
  arcs = $state.raw<ArcRow[]>([]);
  countryActivity = $state.raw<Map<number, { updates: number; withdraws: number; networks: number }>>(new Map());
  moas = $state.raw<MoasRow[]>([]);
  totals = $state.raw<Totals>({ updates: 0, withdraws: 0, prefixes: 0, networks: 0, peers: 0 });
  timeline = $state.raw<{ announce: Float64Array; withdraw: Float64Array; bucket: number }>({ announce: new Float64Array(0), withdraw: new Float64Array(0), bucket: TIMELINE_BUCKET });
  routeCountries = $state.raw<Map<number, { routes: number; addresses: number; networks: number }>>(new Map());
  routeTotals = $state.raw({ routes: 0, addresses: 0, networks: 0 });
  pulses = $state.raw<Pulse[]>([]);

  // How long each engine took for one frame's queries, most recent last.
  history = $state.raw<Record<EngineName, number[]>>({ js: [], wasm: [] });
  frameMs = $state(0);
  framesPerSecond = $state(0);
  rowsPerFrame = $state(0);

  // Live feed.
  liveSource = $state<FeedSource | null>(null);
  liveMessage = $state('');
  liveRate = $state(0);
  liveRows = $state(0);
  liveNow = $state(0);
  routeChanges = $state(0);

  // Detail views.
  selectedMoas = $state.raw<{ row: MoasRow; origins: { asn: number; updates: number }[] } | null>(null);
  lookup = $state.raw<{ ip: number; matches: { addr: number; len: number; origin: number; pathLen: number }[] } | null>(null);
  focus = $state.raw<{ lon: number; lat: number; zoom: number; at: number } | null>(null);
  hoverNetwork = $state.raw<{ asn: number; routes: number; addresses: number; longest: number; shortest: number } | null>(null);

  networks: Networks | null = null;
  routes: RouteColumns | null = null;
  updates: UpdateColumns | null = null;
  engines: Engines | null = null;
  countryNames = new Map<string, string>();
  countryIndex = new Map<string, number>();

  private feed: Feed | null = null;
  private busy = false;
  private scheduled = false;
  private pendingFrame = false;
  private lastClock = 0;
  private frameStamps: number[] = [];
  private livePeers = new Map<number, Set<number>>();
  private liveRateWindow: number[] = [];
  private routesRefreshed = 0;
  private observedIpIndex = new Map<number, LiveIp>();
  private observedRouteIndex = new Map<string, LiveRoute>();
  private observedRoutesByOrigin = new Map<number, ObservedRoute[]>();
  private lastObservedPublish = 0;

  async start(): Promise<void> {
    // Purpose: load the data, build the JS tables, then start the WASM engine in the background
    try {
      const [data, countries] = await Promise.all([
        loadAll((text, fraction) => {
          this.loadText = text;
          this.loadFraction = fraction;
        }),
        fetch('/countries.geojson').then(r => r.json() as Promise<{ features: { properties: { iso: string; name: string } }[] }>),
      ]);
      this.networks = data.networks;
      this.routes = data.routes;
      this.updates = data.updates;
      this.observedIps = data.observed.ips;
      this.observedRoutes = data.observed.routes;
      for (const row of data.observed.ips) this.observedIpIndex.set(row.ip, { ...row });
      for (const row of data.observed.routes) {
        this.observedRouteIndex.set(this.routeKey(row.originAs, row.peerAs, row.peerIp, row.localIp, row.nextHop), { ...row });
      }
      this.publishObserved();
      for (const f of countries.features) this.countryNames.set(f.properties.iso, f.properties.name);
      data.networks.countries.forEach((iso, i) => this.countryIndex.set(iso, i));
      this.loadText = 'building the JS tables';
      this.engines = Engines.createJs(data.routes, data.updates);
      this.engine = 'js';
      this.phase = 'ready';
      this.wasmStatus = 'starting';
      void this.engines.startWasm(data.routes, data.updates, text => (this.wasmStatus = text)).then(() => {
        if (this.engines!.wasm !== null) {
          this.wasmReady = true;
          this.wasmStatus = 'ready';
          this.setEngine('wasm');
        } else {
          this.wasmStatus = `unavailable: ${this.engines!.wasmError}`;
        }
      });
      await this.refreshTimeline();
      await this.refreshRoutes();
      if (this.mode === 'live') this.startLive();
      this.requestFrame();
      this.loop();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = 'error';
    }
  }

  get duration(): number {
    // Purpose: seconds in the recording
    return (this.updates?.minutes ?? 60) * 60;
  }

  setEngine(name: EngineName): void {
    // Purpose: switch which engine answers; everything is recomputed on it
    if (name === 'wasm' && !this.wasmReady) return;
    this.engine = name;
    void this.refreshTimeline();
    void this.refreshRoutes();
    this.requestFrame();
  }

  setMode(mode: Mode): void {
    // Purpose: replay the recorded hour, or follow live updates
    if (this.mode === mode) return;
    this.mode = mode;
    this.playing = false;
    if (mode === 'live') this.startLive();
    else this.stopLive();
    this.requestFrame();
  }

  searchNetworks(query: string, limit = 8): NetworkResult[] {
    // Purpose: find an AS by number, name or country for the drawer's network focus search
    const n = this.networks;
    const q = query.trim().toLowerCase();
    if (n === null || q.length === 0) return [];
    const found: NetworkResult[] = [];
    for (let i = 0; i < n.count; i++) {
      const asn = n.asn[i]!;
      const name = n.names[n.nameCode[i]!] || '';
      const iso = n.cc[i] === NONE ? '' : n.countries[n.cc[i]!] ?? '';
      if (!String(asn).includes(q) && !name.toLowerCase().includes(q) && !iso.toLowerCase().includes(q) && !(this.countryNames.get(iso) ?? '').toLowerCase().includes(q)) continue;
      found.push({ asn, name, country: iso });
      if (found.length >= limit) break;
    }
    return found;
  }

  selectAsn(asn: number | null): void {
    // Purpose: focus the whole globe on one network's IPs and originated routes
    if (this.selectedAsn === asn) return;
    this.selectedAsn = asn;
    this.requestFrame();
  }

  private routeKey(originAs: number, peerAs: number, peerIp: number, localIp: number, nextHop: number): string {
    // Purpose: a stable identity for announcements sharing an origin and an observed BGP hop
    return `${originAs}|${peerAs}|${peerIp}|${localIp}|${nextHop}`;
  }

  private recordIp(ip: number, asn: number, role: number, source: number, second: number): void {
    // Purpose: merge a live sighting into the same per-IP table prep-globe writes
    if (ip === 0 || asn === 0) return;
    let row = this.observedIpIndex.get(ip);
    if (row === undefined) {
      const at = this.networks?.index.get(asn);
      row = {
        ip,
        asn,
        roleMask: 0,
        source,
        precision: at === undefined ? 0 : this.networks!.precision[at]!,
        lon: at === undefined ? 0 : this.networks!.lon[at]!,
        lat: at === undefined ? 0 : this.networks!.lat[at]!,
        count: 0,
        first: second,
        last: second,
      };
      this.observedIpIndex.set(ip, row);
    }
    if (source < row.source) {
      const at = this.networks?.index.get(asn);
      row.source = source;
      row.asn = asn;
      row.precision = at === undefined ? 0 : this.networks!.precision[at]!;
      row.lon = at === undefined ? 0 : this.networks!.lon[at]!;
      row.lat = at === undefined ? 0 : this.networks!.lat[at]!;
    }
    row.roleMask |= role;
    row.count++;
    row.first = Math.min(row.first, second);
    row.last = Math.max(row.last, second);
  }

  private recordRoute(originAs: number, peerAs: number, peerIp: number, localIp: number, nextHop: number, prefixes: number, path: string, second: number): void {
    // Purpose: count announcements seen live on an observed hop, matching the prep-globe aggregation
    const key = this.routeKey(originAs, peerAs, peerIp, localIp, nextHop);
    let row = this.observedRouteIndex.get(key);
    if (row === undefined) {
      row = { originAs, peerAs, peerIp, localIp, nextHop, prefixes, path, count: 0, first: second, last: second };
      this.observedRouteIndex.set(key, row);
    }
    row.count++;
    row.last = Math.max(row.last, second);
  }

  observedRoutesFor(asn: number): readonly ObservedRoute[] {
    // Purpose: only the paths an AS originated, pre-indexed so selecting it never scans the whole table
    return this.observedRoutesByOrigin.get(asn) ?? [];
  }

  private publishObserved(): void {
    // Purpose: publish immutable arrays and the origin index; called at load and on a slow live throttle
    this.observedIps = [...this.observedIpIndex.values()];
    this.observedRoutes = [...this.observedRouteIndex.values()];
    const byOrigin = new Map<number, ObservedRoute[]>();
    for (const row of this.observedRoutes) {
      let list = byOrigin.get(row.originAs);
      if (list === undefined) byOrigin.set(row.originAs, list = []);
      list.push(row);
    }
    this.observedRoutesByOrigin = byOrigin;
  }

  setFilter(change: { kinds?: number[]; country?: number | null; lenRange?: [number, number] }): void {
    // Purpose: change a filter; every view re-runs with the new parameter values
    if (change.kinds !== undefined) this.kinds = change.kinds.length === 0 ? [0, 1] : change.kinds;
    if (change.country !== undefined) this.country = change.country;
    if (change.lenRange !== undefined) this.lenRange = change.lenRange;
    void this.refreshTimeline();
    this.requestFrame();
  }

  seek(t: number): void {
    // Purpose: move the replay window's end
    this.t = Math.max(this.span, Math.min(this.duration, t));
    this.requestFrame();
  }

  setSpan(span: number): void {
    // Purpose: change the replay window's length
    this.span = span;
    this.seek(this.t);
  }

  togglePlay(): void {
    // Purpose: play or pause the replay
    if (this.t >= this.duration) this.t = this.span;
    this.playing = !this.playing;
  }

  flyTo(lon: number, lat: number, zoom = 3): void {
    // Purpose: ask the map to move
    this.focus = { lon, lat, zoom, at: performance.now() };
  }

  flyToNetwork(asn: number): void {
    // Purpose: center the map on a network
    const i = this.networks?.index.get(asn);
    if (i === undefined || this.networks === null) return;
    this.flyTo(this.networks.lon[i]!, this.networks.lat[i]!, 3.2);
  }

  requestFrame(): void {
    // Purpose: recompute the views as soon as the engine is free (frames never queue up)
    if (this.busy || this.scheduled) {
      this.pendingFrame = true;
      return;
    }
    // Let the page paint and take input between frames, whichever engine computes them.
    this.scheduled = true;
    requestAnimationFrame(() =>
      setTimeout(() => {
        this.scheduled = false;
        void this.frame();
      }, 0),
    );
  }

  private params(): Record<string, unknown> {
    // Purpose: the window and filter parameters every update query takes
    const live = this.mode === 'live';
    // Parameters are typed (uint32): the replay clock runs in fractions of a second, the queries in whole ones.
    const hi = Math.floor(live ? this.liveNow : this.t);
    const lo = Math.max(0, hi - (live ? LIVE_WINDOW : this.span));
    return {
      lo,
      hi,
      kinds: this.kinds,
      anyCountry: this.country === null,
      countries: this.country === null ? [] : [this.country],
      lenLo: this.lenRange[0],
      lenHi: this.lenRange[1],
    };
  }

  private async frame(): Promise<void> {
    // Purpose: run every per-frame query together on the selected engine and publish the results
    if (this.engines === null) return;
    this.busy = true;
    this.pendingFrame = false;
    const engine = this.engine;
    const params = this.params();
    const source = (t: EngineTables) => (this.mode === 'live' ? t.live : t.replay);
    try {
      const out = await this.engines.run('frame', engine, [
        { plan: updatePlans.origins, table: source, params },
        { plan: updatePlans.arcs, table: source, params },
        { plan: updatePlans.countries, table: source, params },
        { plan: updatePlans.moas, table: source, params },
        { plan: updatePlans.totals, table: source, params },
      ] as const);
      if (out === null) return;
      const [origins, arcs, countries, moas, totals] = out.results;
      const o = origins.columns() as Record<string, ArrayLike<unknown>>;
      const originRows: OriginRow[] = new Array(origins.rowCount);
      for (let i = 0; i < origins.rowCount; i++) {
        originRows[i] = { asn: num(o.origin_as![i]), updates: num(o.updates![i]), withdraws: num(o.withdraws![i]), prefixes: num(o.prefixes![i]) };
      }
      this.origins = originRows;
      const a = arcs.columns() as Record<string, ArrayLike<unknown>>;
      const arcRows: ArcRow[] = new Array(arcs.rowCount);
      for (let i = 0; i < arcs.rowCount; i++) arcRows[i] = { peer: num(a.peer_as![i]), origin: num(a.origin_as![i]), updates: num(a.updates![i]), withdraws: num(a.withdraws![i]) };
      this.arcs = arcRows;
      const activity = new Map<number, { updates: number; withdraws: number; networks: number }>();
      for (const row of countries.toArray() as { cc: number; updates: number; withdraws: bigint; networks: number }[]) {
        activity.set(row.cc, { updates: row.updates, withdraws: num(row.withdraws), networks: row.networks });
      }
      this.countryActivity = activity;
      this.moas = (moas.toArray() as { prefix_addr: number; prefix_len: number; origins: number; updates: number }[]).map(r => ({ addr: r.prefix_addr, len: r.prefix_len, origins: r.origins, updates: r.updates }));
      const total = totals.toArray()[0] as Record<string, unknown> | undefined;
      this.totals = { updates: num(total?.updates), withdraws: num(total?.withdraws), prefixes: num(total?.prefixes), networks: num(total?.networks), peers: num(total?.peers) };
      this.frameMs = out.ms;
      this.rowsPerFrame = 5 * (this.mode === 'live' ? this.liveRows : (this.updates?.rows ?? 0));
      this.history = { ...this.history, [engine]: [...this.history[engine], out.ms].slice(-HISTORY) };
      const now = performance.now();
      this.frameStamps = [...this.frameStamps.filter(s => now - s < 2000), now];
      this.framesPerSecond = this.frameStamps.length / 2;
      if (this.selectedMoas !== null) void this.selectMoas(this.selectedMoas.row);
    } catch (error) {
      console.error(error);
    } finally {
      this.busy = false;
      if (this.pendingFrame) this.requestFrame();
    }
  }

  private loop(): void {
    // Purpose: the replay clock, driven by animation frames; when playing, every free engine moment computes a frame
    const step = (now: number): void => {
      const dt = this.lastClock === 0 ? 0 : (now - this.lastClock) / 1000;
      this.lastClock = now;
      if (this.mode === 'replay' && this.playing) {
        const next = this.t + dt * this.speed;
        if (next >= this.duration) {
          this.t = this.duration;
          this.playing = false;
        } else this.t = next;
        this.requestFrame();
      }
      if (this.pulses.length > 0) {
        const cutoff = performance.now() - 6000;
        if (this.pulses[0]!.born < cutoff) this.pulses = this.pulses.filter(p => p.born >= cutoff);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async refreshTimeline(): Promise<void> {
    // Purpose: updates per bucket over the whole recording, for the timeline under the replay
    if (this.engines === null) return;
    const params = this.params();
    const out = await this.engines.run('timeline', this.engine, [
      { plan: timelinePlan, table: (t: EngineTables) => t.replay, params: { width: TIMELINE_BUCKET, kinds: params.kinds, anyCountry: params.anyCountry, countries: params.countries, lenLo: params.lenLo, lenHi: params.lenHi } },
    ] as const);
    if (out === null) return;
    const buckets = Math.ceil(this.duration / TIMELINE_BUCKET);
    const announce = new Float64Array(buckets);
    const withdraw = new Float64Array(buckets);
    for (const row of out.results[0].toArray() as { bucket: number; kind: number; updates: number }[]) {
      if (row.bucket >= buckets) continue;
      (row.kind === 0 ? announce : withdraw)[row.bucket] = row.updates;
    }
    this.timeline = { announce, withdraw, bucket: TIMELINE_BUCKET };
  }

  async refreshRoutes(): Promise<void> {
    // Purpose: the routing table per country (the choropleth in live mode) and its totals
    if (this.engines === null) return;
    const out = await this.engines.run('routes', this.engine, [
      { plan: routePlans.countries, table: (t: EngineTables) => t.routes },
      { plan: routePlans.totals, table: (t: EngineTables) => t.routes },
    ] as const);
    if (out === null) return;
    const map = new Map<number, { routes: number; addresses: number; networks: number }>();
    for (const row of out.results[0].toArray() as { cc: number; routes: number; addresses: number; networks: number }[]) map.set(row.cc, row);
    this.routeCountries = map;
    const t = out.results[1].toArray()[0] as { routes: number; addresses: number; networks: number } | undefined;
    if (t) this.routeTotals = t;
  }

  async inspectNetwork(asn: number | null): Promise<void> {
    // Purpose: how much of the routing table a hovered network originates (one query, on hover)
    if (asn === null || this.engines === null) {
      this.hoverNetwork = null;
      return;
    }
    const out = await this.engines.run('hover', this.engine, [{ plan: routePlans.ofNetwork, table: (t: EngineTables) => t.routes, params: { asn } }] as const);
    if (out === null) return;
    const row = out.results[0].toArray()[0] as { routes: number; addresses: number; longest: number | null; shortest: number | null } | undefined;
    this.hoverNetwork = { asn, routes: row?.routes ?? 0, addresses: row?.addresses ?? 0, longest: row?.longest ?? 0, shortest: row?.shortest ?? 0 };
  }

  async lookupIp(ip: number): Promise<void> {
    // Purpose: longest-prefix match: which routes cover an address, most specific first
    if (this.engines === null) return;
    const out = await this.engines.run('lookup', this.engine, [{ plan: routePlans.lookup, table: (t: EngineTables) => t.routes, params: { ip } }] as const);
    if (out === null) return;
    const matches = (out.results[0].toArray() as { prefix_addr: number; prefix_len: number; origin_as: number; path_len: number }[]).map(r => ({ addr: r.prefix_addr, len: r.prefix_len, origin: r.origin_as, pathLen: r.path_len }));
    this.lookup = { ip, matches };
    if (matches[0]) this.flyToNetwork(matches[0].origin);
  }

  async selectMoas(row: MoasRow | null): Promise<void> {
    // Purpose: which networks announced a contested prefix in the window
    if (row === null || this.engines === null) {
      this.selectedMoas = null;
      return;
    }
    const p = this.params();
    const out = await this.engines.run('moas', this.engine, [
      { plan: originsOfPrefix, table: (t: EngineTables) => (this.mode === 'live' ? t.live : t.replay), params: { lo: p.lo, hi: p.hi, addr: row.addr, len: row.len } },
    ] as const);
    if (out === null) return;
    const origins = (out.results[0].toArray() as { origin_as: number; updates: number }[]).map(r => ({ asn: r.origin_as, updates: r.updates }));
    this.selectedMoas = { row, origins };
  }

  // Live mode.

  private startLive(): void {
    // Purpose: connect the live feed; every batch goes into both engines' update logs and routing tables
    if (this.updates === null || this.feed !== null) return;
    this.liveNow = Math.floor(Date.now() / 1000);
    this.feed = startFeed(this.updates, {
      onStatus: (source, message) => {
        this.liveSource = source;
        this.liveMessage = message;
      },
      onBatch: rows => void this.onLiveBatch(rows),
    });
  }

  private stopLive(): void {
    // Purpose: disconnect the live feed
    this.feed?.stop();
    this.feed = null;
    this.liveSource = null;
  }

  private observeLiveRows(rows: LiveRow[]): void {
    // Purpose: preserve RIS Live's peer IP, next hop and full path for the physical-IP view
    for (const row of rows) {
      const peerIp = parseIp(row.peer_ip ?? '');
      const localIp = parseIp(row.local_ip ?? '');
      if (peerIp !== null) this.recordIp(peerIp, row.peer_as, 1, 4, row.second);
      if (localIp !== null) this.recordIp(localIp, 0, 4, 3, row.second);
      const nextHop = parseIp(row.next_hop ?? '');
      if (nextHop === null) continue;
      const seen = this.observedIpIndex.get(nextHop);
      const exact = nextHop === peerIp;
      const asn = exact ? row.peer_as : (seen?.asn ?? row.peer_as);
      const source = exact ? 0 : (seen === undefined ? 2 : Math.min(seen.source, 4));
      this.recordIp(nextHop, asn, 2, source, row.second);
      if (row.kind === 0 && row.origin_as > 0 && peerIp !== null) {
        this.recordRoute(row.origin_as, row.peer_as, peerIp, localIp ?? 0, nextHop, 1, row.as_path, row.second);
      }
    }
    // The IP layer is a slowly-changing background, not a per-second event: republishing 100k rows
    // on every batch made the globe stutter. Five seconds keeps live discoveries timely and smooth.
    if (performance.now() - this.lastObservedPublish >= 5000) {
      this.publishObserved();
      this.lastObservedPublish = performance.now();
    }
  }

  private async onLiveBatch(rows: LiveRow[]): Promise<void> {
    // Purpose: one second of live updates: log them, apply them to the routing table, pulse them on the map
    const engines = this.engines;
    const networks = this.networks;
    if (engines === null || networks === null || this.mode !== 'live') return;
    this.observeLiveRows(rows);
    const n = rows.length;
    const cols = {
      second: new Uint32Array(n),
      kind: new Uint8Array(n),
      prefix_addr: new Uint32Array(n),
      prefix_len: new Uint8Array(n),
      origin_as: new Uint32Array(n),
      peer_as: new Uint32Array(n),
      path_len: new Uint8Array(n),
      cc: new Uint8Array(n),
      pkey: new Float64Array(n),
    };
    // A prefix leaves the routing table only when every peer that announced it this session withdrew
    // it; prefixes from the snapshot stay (the snapshot does not say which peers had them).
    const upserts = new Map<number, LiveRow>();
    const deletes: [number, number][] = [];
    const now = performance.now();
    const pulses: Pulse[] = [];
    rows.forEach((row, i) => {
      const key = row.prefix_addr * 64 + row.prefix_len;
      if (row.kind === 1) {
        const current = engines.js.routes.get([row.prefix_addr, row.prefix_len]);
        if (current) row.origin_as = current.origin_as ?? 0;
        const peers = this.livePeers.get(key);
        if (peers !== undefined) {
          peers.delete(row.peer_as);
          if (peers.size === 0) {
            this.livePeers.delete(key);
            upserts.delete(key);
            deletes.push([row.prefix_addr, row.prefix_len]);
          }
        }
      } else {
        let peers = this.livePeers.get(key);
        if (peers === undefined) this.livePeers.set(key, (peers = new Set()));
        peers.add(row.peer_as);
        upserts.set(key, row);
      }
      const at = networks.index.get(row.origin_as);
      cols.second[i] = row.second;
      cols.kind[i] = row.kind;
      cols.prefix_addr[i] = row.prefix_addr;
      cols.prefix_len[i] = row.prefix_len;
      cols.origin_as[i] = row.origin_as;
      cols.peer_as[i] = row.peer_as;
      cols.path_len[i] = row.path_len;
      cols.cc[i] = at === undefined ? NONE : networks.cc[at]!;
      cols.pkey[i] = key;
      if (at !== undefined && i % 3 === 0) pulses.push({ lon: networks.lon[at]!, lat: networks.lat[at]!, kind: row.kind, born: now + (i / n) * 900 });
    });
    const up = [...upserts.values()];
    const routeCols =
      up.length === 0
        ? null
        : {
            prefix_addr: Uint32Array.from(up, r => r.prefix_addr),
            prefix_len: Uint8Array.from(up, r => r.prefix_len),
            prefix_end: Uint32Array.from(up, r => r.prefix_addr + prefixSize(r.prefix_len) - 1),
            origin_as: Uint32Array.from(up, r => r.origin_as),
            path_len: Uint8Array.from(up, r => r.path_len),
            cc: Uint8Array.from(up, r => {
              const at = networks.index.get(r.origin_as);
              return at === undefined ? NONE : networks.cc[at]!;
            }),
            rir: Uint8Array.from(up, r => {
              const at = networks.index.get(r.origin_as);
              return at === undefined ? NONE : networks.rir[at]!;
            }),
            addresses: Float64Array.from(up, r => prefixSize(r.prefix_len)),
          };
    engines.applyRoutes(routeCols, deletes);
    this.routeChanges += up.length + deletes.length;
    await engines.appendLive(cols);
    this.liveRows = Math.min(this.liveRows + n, 600_000);
    this.liveNow = Math.max(this.liveNow, rows[rows.length - 1]?.second ?? this.liveNow);
    this.liveRateWindow = [...this.liveRateWindow, n].slice(-10);
    this.liveRate = this.liveRateWindow.reduce((s, v) => s + v, 0) / this.liveRateWindow.length;
    this.pulses = [...this.pulses, ...pulses].slice(-3000);
    this.requestFrame();
    // The per-country routing table view is a full pass over 1.2 M routes: every few seconds is enough.
    if (performance.now() - this.routesRefreshed > 5000) {
      this.routesRefreshed = performance.now();
      void this.refreshRoutes();
    }
  }

  arcLimit(): number {
    // Purpose: how many arcs the arcs query returns at most
    return ARC_LIMIT;
  }
}
