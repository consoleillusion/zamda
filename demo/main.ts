// Wires the signal deck: loads one routes file into the JS reference table and
// the WASM worker, runs each chart's compiled plan on both, draws the JS result
// and publishes the measured comparison. The graph and live feed stay as they
// were; only the shell and the engine readout are new.

import { latest, table } from '../src';
import { decodeRoutes, formatPrefix, Routes } from '../scripts/bgp/file';
import type { RouteArrays } from '../scripts/bgp/file';
import { createHistogram, drawActivity, drawRegions, drawTopNetworks, formatCount } from './charts';
import type { ActivityBucket } from './charts';
import { EMPTY_SELECTION, affectedBy, compilePlans, nameIndex, paramsFor, parseAddressRange, summariseNetworks } from './dashboard';
import type { ChartId, Plans, RoutesTable, Selection } from './dashboard';
import { routeColumns, startEngine } from './engine';
import type { EngineSession } from './engine';
import { formatMs } from './performance';
import type { PhaseTimes } from './performance';
import { createRacePanel } from './race-panel';
import type { RacePanel } from './race-panel';
import { startGraph } from './graph-panel';
import type { GraphPanel } from './graph-panel';
import { hotKeys } from './graph-data';
import type { ManagedSession } from '../src/backends/wasm/managed';
import {
  ACTIVITY_BUCKET,
  ACTIVITY_SECONDS,
  HOT_EDGE_SECONDS,
  compileLivePlans,
  connectRisLive,
  createEdgeUpdatesTable,
  createUpdatesTable,
  simulateFeed,
} from './live';
import type { LiveEdgeRow, UpdateRow } from './live';

// Path lengths above this are drawn in the last column, labelled "N+".
const PATH_BINS = 16;

interface Timed<T> {
  readonly result: T | null;
  readonly ms: number | null;
  readonly error: unknown | null;
}

interface ChartRun {
  readonly js: Promise<Timed<unknown>>;
  readonly wasm: Promise<Timed<unknown> | null>;
  readonly match: Promise<boolean | null>;
}

interface Dashboard {
  runAll(): void;
  wasmReady(engine: EngineSession): void;
  noWasm(message: string): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function byId<T extends Element>(id: string): T {
  // Purpose: an element that the page is known to contain
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as unknown as T;
}

function isAbort(error: unknown): boolean {
  // Purpose: true for the rejection latest() causes when a newer run replaces this one
  return error instanceof Error && error.name === 'AbortError';
}

function describeError(error: unknown): string {
  // Purpose: a short, honest reason an engine run did not answer
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function deferred<T>(): Deferred<T> {
  // Purpose: a promise whose resolver can be held until the other engine has finished
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(function (settle): void {
    // Purpose: capture the resolver of the gate that sequences the two engines
    resolve = settle;
  });
  return { promise, resolve };
}

function range(from: number, to: number): number[] {
  // Purpose: the integers from..to inclusive
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<Timed<T>> {
  // Purpose: time one plan once and keep its error so one failed chart cannot lose the others
  const began = performance.now();
  try {
    const result = await work();
    return { result, ms: performance.now() - began, error: null };
  } catch (error) {
    if (!isAbort(error)) console.error(label, error);
    return { result: null, ms: null, error };
  }
}

function maxMs(values: readonly (number | null)[]): number | null {
  // Purpose: the wall time of a group of plans started together
  const real = values.filter((value): value is number => value !== null);
  return real.length === 0 ? null : Math.max(...real);
}

function zeroPhases(): PhaseTimes {
  // Purpose: an empty phase breakdown before any WASM run has answered
  return { prepare: 0, tables: 0, start: 0, steps: 0, read: 0 };
}

function canonicalRow(row: object): string {
  // Purpose: a stable text form of one result row, with bigints kept exact
  return JSON.stringify(row, function (_key, value: unknown) {
    // Purpose: JSON has no bigint, so tag it rather than losing precision
    return typeof value === 'bigint' ? `${value}n` : value;
  }) ?? 'null';
}

function sameRows(js: object | null, wasm: object | null): boolean | null {
  // Purpose: check that both engines returned the same rows, in the same order
  if (js === null || wasm === null) return null;
  const left = (js as { toArray(): readonly object[] }).toArray();
  const right = (wasm as { toArray(): readonly object[] }).toArray();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (canonicalRow(left[i]!) !== canonicalRow(right[i]!)) return false;
  }
  return true;
}

function showMs(id: string, ms: number | null): void {
  // Purpose: show a chart's last JS run time beside its title
  byId<HTMLElement>(`ms-${id}`).textContent = ms === null ? '—' : formatMs(ms);
}

async function start(): Promise<void> {
  // Purpose: load data, build the charts, start the worker, and run them all once
  const loadStart = performance.now();
  const response = await fetch('/data/routes.bin');
  if (!response.ok) {
    byId<HTMLElement>('source').textContent = await response.text();
    return;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { arrays, header } = decodeRoutes(bytes);
  const routes = table(Routes, routeColumns(arrays));
  const loadMs = performance.now() - loadStart;
  const source = header.source;
  const where = source.synthetic ? 'synthetic data' : `RIPE RIS ${String(source.rrc ?? '')} ${String(source.date ?? '')} ${String(source.time ?? '')}`;
  byId<HTMLElement>('source').textContent = `${header.rowCount.toLocaleString()} IPv4 routes from ${where} · loaded in ${Math.round(loadMs)} ms`;

  // The live panel labels networks with names the first unfiltered chart run fills in.
  const names = new Map<number, string>();
  const panel = createRacePanel();
  const dashboard = createDashboard(routes, names, panel, arrays);
  dashboard.runAll();
  void startEngine(arrays, function onEngineStatus(message: string): void {
    // Purpose: show the worker's progress before the first measured comparison
    panel.setStatus(message, 'loading');
  }).then(dashboard.wasmReady, function onEngineFailure(error: unknown): void {
    // Purpose: a missing engine is a visible state, not a hidden fallback
    dashboard.noWasm(describeError(error));
  });
  let graph: GraphPanel | null = null;
  void startGraph().then(function (loaded: GraphPanel): void {
    // Purpose: hand the loaded graph to the live panel for the overlay and simulator
    graph = loaded;
  }, function (error: unknown): void {
    // Purpose: a graph failure must not take the route charts down with it
    byId<HTMLElement>('graph-status').textContent = `Graph failed: ${String(error)}`;
    console.error('graph failed', error);
  });
  startLive(names, function (): GraphPanel | null {
    // Purpose: read the graph panel after its file has loaded
    return graph;
  });
}

function createDashboard(
  routes: RoutesTable,
  names: Map<number, string>,
  panel: RacePanel,
  arrays: RouteArrays,
): Dashboard {
  // Purpose: the linked charts, the engine race, the totals line and the controls
  const plans: Plans = compilePlans();
  const runs = {
    networks: latest(plans.networks),
    prefixLen: latest(plans.prefixLen),
    pathLen: latest(plans.pathLen),
    regions: latest(plans.regions),
  };
  let wasmRuns: typeof runs | null = null;
  let engineSession: EngineSession | null = null;
  let raceGeneration = 0;
  let selection: Selection = EMPTY_SELECTION;

  const set = function (control: keyof Selection, value: Selection[keyof Selection]): void {
    // Purpose: change one control and re-run the charts that depend on it
    selection = { ...selection, [control]: value };
    describeSelection();
    interaction(affectedBy(control));
    // A chart's own selection only changes how it is drawn.
    if (control === 'prefixLen' || control === 'pathLen' || control === 'regions') redrawOwn(control);
  };

  const prefixBins = range(1, 32);
  const prefix = createHistogram(byId('chart-prefixLen'), {
    bins: prefixBins,
    binLabel: bin => (bin % 4 === 0 ? `/${bin}` : ''),
    onSelect: r => set('prefixLen', r),
  });
  const pathBins = range(1, PATH_BINS);
  const path = createHistogram(byId('chart-pathLen'), {
    bins: pathBins,
    binLabel: bin => (bin === PATH_BINS ? `${bin}+` : bin % 2 === 1 ? String(bin) : ''),
    // Selecting the last column means "this many or more".
    onSelect: r => set('pathLen', r && [r[0], r[1] === PATH_BINS ? 255 : r[1]]),
  });

  let prefixCounts = new Map<number, number>();
  let pathCounts = new Map<number, number>();
  let regionRows: { rir: string | null; routes: number; networks: number }[] = [];

  const pathSelected = function (): readonly [number, number] | null {
    // Purpose: the path selection in column terms (255 drawn as the last column)
    const s = selection.pathLen;
    return s && [s[0], Math.min(s[1], PATH_BINS)];
  };

  const toggleRegion = function (rir: string): void {
    // Purpose: add or remove a region; removing the last one clears the filter
    const current = selection.regions;
    let next: string[] | null;
    if (current === null) next = [rir];
    else if (current.includes(rir)) next = current.filter(r => r !== rir);
    else next = [...current, rir];
    set('regions', next && next.length > 0 ? next : null);
  };

  const redrawOwn = function (chart: 'prefixLen' | 'pathLen' | 'regions'): void {
    // Purpose: redraw a chart after its own selection changed, from the counts it already has
    if (chart === 'prefixLen') prefix.draw(prefixCounts, selection.prefixLen);
    else if (chart === 'pathLen') path.draw(pathCounts, pathSelected());
    else drawRegions(byId('chart-regions'), regionRows, selection.regions, toggleRegion);
  };

  const run = function (chart: ChartId, session: ManagedSession | undefined, jsGate: Promise<void>): ChartRun {
    // Purpose: run one chart's plan on WASM first, then JS on the main thread with the same parameters
    const options = { params: paramsFor(selection, chart) };
    const wasmOptions = { ...options, ...(session === undefined ? {} : { session }) };
    let wasm: Promise<Timed<unknown> | null> = Promise.resolve(null);

    const startJs = function (): Promise<Timed<unknown>> {
      // Purpose: time the JS reference after the worker's reply, so neither clock carries the other's work
      if (chart === 'networks') {
        const started = timed(`${chart} failed`, () => runs.networks(routes, options));
        return started.then(function (done) {
          // Purpose: draw the top networks and the totals line from one per-network result
          if (done.result !== null) {
            const summary = summariseNetworks(done.result);
            drawTopNetworks(byId('chart-top'), summary.top);
            byId<HTMLElement>('total-routes').textContent = summary.routes.toLocaleString();
            byId<HTMLElement>('total-networks').textContent = summary.networks.toLocaleString();
            // With nothing selected this lists every network with its name.
            if (selection === EMPTY_SELECTION && names.size === 0) for (const [k, v] of nameIndex(done.result)) names.set(k, v);
            showMs(chart, done.ms);
          }
          return done;
        });
      } else if (chart === 'prefixLen') {
        const started = timed(`${chart} failed`, () => runs.prefixLen(routes, options));
        return started.then(function (done) {
          // Purpose: draw the prefix-length histogram, leaving out the /0 default route
          if (done.result !== null) {
            prefixCounts = new Map();
            for (const r of done.result.toArray()) if (r.prefix_len) prefixCounts.set(r.prefix_len, r.routes ?? 0);
            prefix.draw(prefixCounts, selection.prefixLen);
            showMs(chart, done.ms);
          }
          return done;
        });
      } else if (chart === 'pathLen') {
        const started = timed(`${chart} failed`, () => runs.pathLen(routes, options));
        return started.then(function (done) {
          // Purpose: draw the path-length histogram, folding long paths into the last column
          if (done.result !== null) {
            pathCounts = new Map();
            for (const r of done.result.toArray()) {
              if (!r.path_len) continue;
              const bin = Math.min(r.path_len, PATH_BINS);
              pathCounts.set(bin, (pathCounts.get(bin) ?? 0) + (r.routes ?? 0));
            }
            path.draw(pathCounts, pathSelected());
            showMs(chart, done.ms);
          }
          return done;
        });
      }
      const started = timed(`${chart} failed`, () => runs.regions(routes, options));
      return started.then(function (done) {
        // Purpose: draw the regions, largest first, unknown last
        if (done.result !== null) {
          regionRows = done.result
            .toArray()
            .map(r => ({ rir: r.rir, routes: r.routes ?? 0, networks: r.networks ?? 0 }))
            .sort((a, b) => (a.rir === null ? 1 : b.rir === null ? -1 : b.routes - a.routes));
          drawRegions(byId('chart-regions'), regionRows, selection.regions, toggleRegion);
          showMs(chart, done.ms);
        }
        return done;
      });
    };

    if (chart === 'networks' && wasmRuns !== null && engineSession !== null) {
      const target = wasmRuns;
      wasm = timed(`wasm ${chart} failed`, () => target.networks(engineSession!.table, wasmOptions));
    } else if (chart === 'prefixLen' && wasmRuns !== null && engineSession !== null) {
      const target = wasmRuns;
      wasm = timed(`wasm ${chart} failed`, () => target.prefixLen(engineSession!.table, wasmOptions));
    } else if (chart === 'pathLen' && wasmRuns !== null && engineSession !== null) {
      const target = wasmRuns;
      wasm = timed(`wasm ${chart} failed`, () => target.pathLen(engineSession!.table, wasmOptions));
    } else if (wasmRuns !== null && engineSession !== null) {
      const target = wasmRuns;
      wasm = timed(`wasm ${chart} failed`, () => target.regions(engineSession!.table, wasmOptions));
    }

    const js = jsGate.then(startJs);
    const match = Promise.all([js, wasm]).then(function ([fromJs, fromWasm]) {
      // Purpose: compare the two engines' answers outside the timed region
      return sameRows(fromJs.result as object | null, fromWasm?.result === null || fromWasm === null ? null : (fromWasm.result as object));
    });
    return { js, wasm, match };
  };

  const describeSelection = function (): string {
    // Purpose: a one-line summary of what is selected
    const parts: string[] = [];
    if (selection.prefixLen) parts.push(`prefix /${selection.prefixLen[0]}–/${selection.prefixLen[1]}`);
    if (selection.pathLen) {
      const [lo, hi] = selection.pathLen;
      parts.push(`path ${lo}${hi === 255 ? '+' : hi === lo ? '' : `–${hi}`}`);
    }
    if (selection.regions) parts.push(selection.regions.join(', '));
    if (selection.search.trim()) parts.push(`name "${selection.search.trim()}"`);
    if (selection.addr) parts.push(`inside ${formatPrefix(selection.addr[0], 32 - Math.log2(selection.addr[1] - selection.addr[0] + 1))}`);
    const label = parts.length ? parts.join(' · ') : 'all routes';
    byId<HTMLElement>('selection').textContent = parts.length ? `Showing: ${label}` : '';
    return label;
  };

  const search = byId<HTMLInputElement>('search');
  search.addEventListener('input', function onSearch() {
    // Purpose: filter by network name as the user types
    set('search', search.value);
  });
  const addr = byId<HTMLInputElement>('addr');
  addr.addEventListener('input', function onAddr() {
    // Purpose: filter by address block once the text is a valid prefix
    const parsed = parseAddressRange(addr.value);
    addr.classList.toggle('invalid', parsed === 'invalid');
    if (parsed !== 'invalid') set('addr', parsed);
  });
  byId<HTMLButtonElement>('reset').addEventListener('click', function onReset() {
    // Purpose: clear every selection
    search.value = '';
    addr.value = '';
    addr.classList.remove('invalid');
    selection = EMPTY_SELECTION;
    describeSelection();
    runAll();
  });

  const interaction = function (charts: readonly ChartId[]): void {
    // Purpose: run one interaction on both engines, then report measured times and engine counters
    if (charts.length === 0) return;
    const label = describeSelection();
    const mine = ++raceGeneration;
    const active = engineSession;
    const session = active === null ? undefined : active.backend.session();
    const before = active === null ? Promise.resolve(null) : active.backend.stats();
    const jsGate = deferred<void>();
    const started = charts.map(chart => run(chart, session, jsGate.promise));
    const jsDone = Promise.all(started.map(s => s.js));
    const wasmDone = Promise.all(started.map(s => s.wasm));
    void wasmDone.then(function (): void {
      // Purpose: release the JS pass only once the worker's reply is in, keeping both clocks clean
      jsGate.resolve();
    }, function (): void {
      // Purpose: a failed worker reply must not leave the JS charts waiting forever
      jsGate.resolve();
    });
    const matchDone = Promise.all(started.map(s => s.match));

    void Promise.all([jsDone, wasmDone, matchDone, before])
      .then(async function ([jsResults, wasmResults, matches, statsBefore]) {
        // Purpose: close the shared filter session only after the worker's last chart settles
        session?.close();
        if (mine !== raceGeneration || active === null) return;
        const failed = wasmResults.find(function (r): r is Timed<unknown> {
          // Purpose: the first WASM run that failed for a reason other than a newer run
          return r !== null && r.error !== null && !isAbort(r.error);
        });
        const error = failed === undefined ? null : describeError(failed.error);
        let engine = 0;
        let fallbacks = 0;
        let cacheHits = 0;
        let phases = zeroPhases();
        try {
          const statsAfter = await active.backend.stats();
          if (statsBefore !== null) {
            engine = statsAfter.engine - statsBefore.engine;
            fallbacks = statsAfter.fallback - statsBefore.fallback;
            cacheHits = statsAfter.cache.hits - statsBefore.cache.hits;
            phases = {
              prepare: statsAfter.phasesMs.prepare - statsBefore.phasesMs.prepare,
              tables: statsAfter.phasesMs.tables - statsBefore.phasesMs.tables,
              start: statsAfter.phasesMs.start - statsBefore.phasesMs.start,
              steps: statsAfter.phasesMs.steps - statsBefore.phasesMs.steps,
              read: statsAfter.phasesMs.read - statsBefore.phasesMs.read,
            };
          }
        } catch (statsError) {
          console.error('wasm stats failed', statsError);
        }
        if (mine !== raceGeneration) return;
        const allMatch = matches.length > 0 && matches.every(m => m !== null) ? matches.every(m => m === true) : null;
        panel.record({
          label,
          jsMs: maxMs(jsResults.map(r => r.ms)),
          wasmMs: maxMs(wasmResults.map(r => r === null ? null : r.ms)),
          engine,
          fallbacks,
          cacheHits,
          phases,
          match: allMatch,
          error,
        });
      })
      .catch(function (error: unknown) {
        // Purpose: an engine or DOM failure must not become an unhandled rejection
        console.error('race failed', error);
        panel.fail(describeError(error));
      });
  };

  const runAll = function (): void {
    // Purpose: run every chart
    interaction(['networks', 'prefixLen', 'pathLen', 'regions']);
  };

  window.addEventListener('resize', function onResize() {
    // Purpose: charts are drawn at the page width, so redraw on resize
    runAll();
  });

  return {
    runAll,
    wasmReady(engine: EngineSession) {
      // Purpose: warm the engine once uncounted, then start timing every interaction
      engineSession = engine;
      wasmRuns = {
        networks: latest(plans.networks),
        prefixLen: latest(plans.prefixLen),
        pathLen: latest(plans.pathLen),
        regions: latest(plans.regions),
      };
      panel.setStatus('warming engine…', 'loading');
      const session = engine.backend.session();
      const warm = [
        plans.networks.execute(engine.table, { params: paramsFor(EMPTY_SELECTION, 'networks'), session }),
        plans.prefixLen.execute(engine.table, { params: paramsFor(EMPTY_SELECTION, 'prefixLen'), session }),
        plans.pathLen.execute(engine.table, { params: paramsFor(EMPTY_SELECTION, 'pathLen'), session }),
        plans.regions.execute(engine.table, { params: paramsFor(EMPTY_SELECTION, 'regions'), session }),
      ];
      void Promise.all(warm).then(function () {
        // Purpose: drop the warm-up session and run the first measured comparison
        session.close();
        panel.setStatus(`worker ready · ${engine.table.rowCount.toLocaleString()} rows`, 'ready');
        runAll();
      }, function (error: unknown) {
        // Purpose: a warm-up failure is reported before any measurement is printed
        session.close();
        console.error('wasm warm-up failed', error);
        panel.fail(describeError(error));
      });
    },
    noWasm(message: string) {
      // Purpose: keep the failed engine visible while the JS charts remain authoritative
      panel.fail(message);
    },
  };
}

function startLive(names: ReadonlyMap<number, string>, graphNow: () => GraphPanel | null): void {
  // Purpose: stream updates into live tables, redraw the panel and overlay the graph every second
  const live = createUpdatesTable();
  const edges = createEdgeUpdatesTable();
  const plans = compileLivePlans();
  const runs = {
    activity: latest(plans.activity),
    active: latest(plans.active),
    totals: latest(plans.totals),
    hotEdges: latest(plans.hotEdges),
  };
  let pending: UpdateRow[] = [];
  let pendingEdges: LiveEdgeRow[] = [];
  const handlers = {
    onRows(rows: UpdateRow[]) {
      // Purpose: buffer rows until the next append, so the table grows in batches
      pending = pending.concat(rows);
    },
    onEdges(next: LiveEdgeRow[]) {
      // Purpose: buffer the AS pairs that the graph overlay will count
      pendingEdges = pendingEdges.concat(next);
    },
    onStatus(status: string) {
      // Purpose: show the feed's state
      byId<HTMLElement>('live-status').textContent = status;
    },
  };
  const mode = new URLSearchParams(location.search).get('live');
  if (mode === 'off') {
    handlers.onStatus('live feed off (?live=off)');
    return;
  }
  if (mode === 'sim') {
    let known: number[] = [];
    simulateFeed(
      function originsNow() {
        // Purpose: the first 400 networks once their names are known, one placeholder until then
        if (known.length === 0 && names.size > 0) known = Array.from(names.keys()).slice(0, 400);
        return known.length ? known : [64512];
      },
      400,
      handlers,
      function pairsNow() {
        // Purpose: the simulator borrows pairs the graph is actually drawing
        return graphNow()?.visiblePairs() ?? [];
      },
    );
  } else {
    connectRisLive(new URLSearchParams(location.search).get('host') ?? 'rrc00', handlers);
  }

  setInterval(function tick() {
    // Purpose: append the buffered rows and re-run the live queries and graph overlay
    if (pending.length > 0) {
      live.append(pending);
      pending = [];
    }
    if (pendingEdges.length > 0) {
      edges.append(pendingEdges);
      pendingEdges = [];
    }
    const began = performance.now();
    const now = Math.floor(Date.now() / 1000);
    const from = now - ACTIVITY_SECONDS;
    const options = { params: { since: from } };
    const hotOptions = { params: { since: now - HOT_EDGE_SECONDS } };
    const failed = function (error: unknown): void {
      // Purpose: ignore replaced runs
      if (!isAbort(error)) console.error('live query failed', error);
    };
    Promise.all([
      runs.activity(live, options),
      runs.active(live, options),
      runs.totals(live, options),
      runs.hotEdges(edges, hotOptions),
    ]).then(function ([activity, active, totals, hot]) {
      // Purpose: draw the live panel and colour the graph's hot edges and nodes
      const buckets = new Map<number, ActivityBucket>();
      for (const r of activity.toArray()) {
        const key = r.bucket ?? 0;
        const b = buckets.get(key) ?? { bucket: key, announce: 0, withdraw: 0 };
        buckets.set(key, r.kind === 'withdraw' ? { ...b, withdraw: r.updates ?? 0 } : { ...b, announce: r.updates ?? 0 });
      }
      const step = ACTIVITY_BUCKET;
      drawActivity(byId('chart-activity'), [...buckets.values()], Math.floor(from / step) * step, now + 1, step);
      let announce = 0;
      let withdraw = 0;
      for (const r of totals.toArray()) {
        if (r.kind === 'withdraw') withdraw = r.updates ?? 0;
        else announce = r.updates ?? 0;
      }
      byId<HTMLElement>('live-announce').textContent = formatCount(announce);
      byId<HTMLElement>('live-withdraw').textContent = formatCount(withdraw);
      byId<HTMLElement>('live-kept').textContent = live.rowCount.toLocaleString();
      const list = byId<HTMLOListElement>('live-active');
      list.replaceChildren(
        ...active.toArray().map(function (r) {
          // Purpose: one list item per active network
          const li = document.createElement('li');
          const name = names.get(r.origin_as ?? 0);
          li.textContent = `AS${r.origin_as}${name ? ` ${name}` : ''} `;
          const n = document.createElement('span');
          n.className = 'n';
          n.textContent = formatCount(r.updates ?? 0);
          li.appendChild(n);
          return li;
        }),
      );
      graphNow()?.setLive(hotKeys(hot.toArray()));
      showMs('live', performance.now() - began);
    }, failed);
  }, 1000);
}

void start().catch(function (error: unknown) {
  // Purpose: show a load failure on the page
  byId<HTMLElement>('source').textContent = `Failed to load: ${String(error)}`;
  console.error(error);
});
