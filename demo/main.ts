// Wires the dashboard page: loads the routes file, runs each chart's plan
// through latest() whenever a control changes, and feeds the live panel.

import { latest } from '../src';
import { formatPrefix, loadRoutes } from '../scripts/bgp/file';
import { createHistogram, drawActivity, drawRegions, drawTopNetworks, formatCount } from './charts';
import type { ActivityBucket } from './charts';
import { startGraph } from './graph-panel';
import type { GraphPanel } from './graph-panel';
import { hotKeys } from './graph-data';
import { EMPTY_SELECTION, affectedBy, compilePlans, nameIndex, paramsFor, parseAddressRange, summariseNetworks } from './dashboard';
import type { ChartId, RoutesTable, Selection } from './dashboard';
import type { WasmSession } from '../src/backends/wasm';
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

function range(from: number, to: number): number[] {
  // Purpose: the integers from..to inclusive
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function showMs(id: string, ms: number): void {
  // Purpose: show a chart's last run time beside its title
  byId<HTMLElement>(`ms-${id}`).textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

async function start(): Promise<void> {
  // Purpose: load data, build the charts, and run them all once
  const loadStart = performance.now();
  const response = await fetch('/data/routes.bin');
  if (!response.ok) {
    byId<HTMLElement>('source').textContent = await response.text();
    return;
  }
  const { table: routes, header } = loadRoutes(new Uint8Array(await response.arrayBuffer()));
  const loadMs = performance.now() - loadStart;
  const source = header.source;
  const where = source.synthetic ? 'synthetic data' : `RIPE RIS ${String(source.rrc ?? '')} ${String(source.date ?? '')} ${String(source.time ?? '')}`;
  byId<HTMLElement>('source').textContent = `${header.rowCount.toLocaleString()} IPv4 routes from ${where} · loaded in ${Math.round(loadMs)} ms`;

  // The live panel labels networks with names the first unfiltered chart run fills in.
  const names = new Map<number, string>();
  const dashboard = createDashboard(routes, names);
  dashboard.runAll();
  let graph: GraphPanel | null = null;
  void startGraph().then(function (panel: GraphPanel): void {
    // Purpose: hand the loaded graph to the live panel for the overlay and simulator
    graph = panel;
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

function createDashboard(routes: RoutesTable, names: Map<number, string>) {
  // Purpose: the four linked charts, the totals line and the controls
  const plans = compilePlans();
  const runs = {
    networks: latest(plans.networks),
    prefixLen: latest(plans.prefixLen),
    pathLen: latest(plans.pathLen),
    regions: latest(plans.regions),
  };
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

  const run = function (chart: ChartId, session?: WasmSession, finished?: () => void): void {
    // Purpose: run one chart's plan with the current selection and draw the result
    const began = performance.now();
    const options = { params: paramsFor(selection, chart), ...(session === undefined ? {} : { session }) };
    const done = function (): void {
      // Purpose: record the run time
      showMs(chart, performance.now() - began);
      finished?.();
    };
    const failed = function (error: unknown): void {
      // Purpose: ignore runs replaced by newer ones; report anything else
      if (!isAbort(error)) console.error(`${chart} failed`, error);
      finished?.();
    };
    if (chart === 'networks') {
      runs.networks(routes, options).then(function (result) {
        // Purpose: draw the top networks and the totals line from one per-network result
        const summary = summariseNetworks(result);
        drawTopNetworks(byId('chart-top'), summary.top);
        byId<HTMLElement>('total-routes').textContent = summary.routes.toLocaleString();
        byId<HTMLElement>('total-networks').textContent = summary.networks.toLocaleString();
        // With nothing selected this lists every network with its name.
        if (selection === EMPTY_SELECTION && names.size === 0) for (const [k, v] of nameIndex(result)) names.set(k, v);
        done();
      }, failed);
    } else if (chart === 'prefixLen') {
      runs.prefixLen(routes, options).then(function (result) {
        // Purpose: draw the prefix-length histogram, leaving out the /0 default route
        prefixCounts = new Map();
        for (const r of result.toArray()) if (r.prefix_len) prefixCounts.set(r.prefix_len, r.routes ?? 0);
        prefix.draw(prefixCounts, selection.prefixLen);
        done();
      }, failed);
    } else if (chart === 'pathLen') {
      runs.pathLen(routes, options).then(function (result) {
        // Purpose: draw the path-length histogram, folding long paths into the last column
        pathCounts = new Map();
        for (const r of result.toArray()) {
          if (!r.path_len) continue;
          const bin = Math.min(r.path_len, PATH_BINS);
          pathCounts.set(bin, (pathCounts.get(bin) ?? 0) + (r.routes ?? 0));
        }
        path.draw(pathCounts, pathSelected());
        done();
      }, failed);
    } else if (chart === 'regions') {
      runs.regions(routes, options).then(function (result) {
        // Purpose: draw the regions, largest first, unknown last
        regionRows = result
          .toArray()
          .map(r => ({ rir: r.rir, routes: r.routes ?? 0, networks: r.networks ?? 0 }))
          .sort((a, b) => (a.rir === null ? 1 : b.rir === null ? -1 : b.routes - a.routes));
        drawRegions(byId('chart-regions'), regionRows, selection.regions, toggleRegion);
        done();
      }, failed);
    }
  };

  const describeSelection = function (): void {
    // Purpose: a one-line summary of what is selected
    const parts: string[] = [];
    if (selection.prefixLen) parts.push(`prefix /${selection.prefixLen[0]}–/${selection.prefixLen[1]}`);
    if (selection.pathLen) {
      const [lo, hi] = selection.pathLen;
      parts.push(`path ${lo}${hi === 255 ? '+' : hi === lo ? '' : `–${hi}`}`);
    }
    if (selection.regions) parts.push(selection.regions.join(', '));
    if (selection.search.trim()) parts.push(`name contains "${selection.search.trim()}"`);
    if (selection.addr) parts.push(`inside ${formatPrefix(selection.addr[0], 32 - Math.log2(selection.addr[1] - selection.addr[0] + 1))}`);
    byId<HTMLElement>('selection').textContent = parts.length ? `Showing: ${parts.join(' · ')}` : '';
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
    // Purpose: run the charts of one interaction, sharing the engine's cached filter pass between them (T-416) when the table's backend supports sessions, and closing it once they all settle
    const backend = routes.backend as typeof routes.backend & { session?(): WasmSession };
    const session = typeof backend.session === 'function' ? backend.session() : undefined;
    let open = charts.length;
    const finished = function (): void {
      open -= 1;
      if (open === 0) session?.close();
    };
    for (const chart of charts) run(chart, session, finished);
  };
  const runAll = function (): void {
    // Purpose: run every chart
    interaction(['networks', 'prefixLen', 'pathLen', 'regions']);
  };
  window.addEventListener('resize', function onResize() {
    // Purpose: charts are drawn at the page width, so redraw on resize
    runAll();
  });
  return { runAll };
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

start().catch(function (error: unknown) {
  // Purpose: show a load failure on the page
  byId<HTMLElement>('source').textContent = `Failed to load: ${String(error)}`;
  console.error(error);
});
