// Wires the dashboard page: loads the routes file, runs each chart's plan
// through latest() whenever a control changes, and feeds the live panel.

import { latest } from '../src';
import { formatPrefix, loadRoutes } from '../scripts/bgp/file';
import { createHistogram, drawActivity, drawRegions, drawTopNetworks, formatCount } from './charts';
import type { ActivityBucket } from './charts';
import { EMPTY_SELECTION, affectedBy, compilePlans, nameIndex, paramsFor, parseAddressRange } from './dashboard';
import type { ChartId, RoutesTable, Selection } from './dashboard';
import {
  ACTIVITY_BUCKET,
  ACTIVITY_SECONDS,
  compileLivePlans,
  connectRisLive,
  createUpdatesTable,
  simulateFeed,
} from './live';
import type { UpdateRow } from './live';

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

  const dashboard = createDashboard(routes);
  dashboard.runAll();
  void startLive(routes);
}

function createDashboard(routes: RoutesTable) {
  // Purpose: the four linked charts, the totals line and the controls
  const plans = compilePlans();
  const runs = {
    top: latest(plans.top),
    prefixLen: latest(plans.prefixLen),
    pathLen: latest(plans.pathLen),
    regions: latest(plans.regions),
    totals: latest(plans.totals),
  };
  let selection: Selection = EMPTY_SELECTION;

  const set = function (control: keyof Selection, value: Selection[keyof Selection]): void {
    // Purpose: change one control and re-run the charts that depend on it
    selection = { ...selection, [control]: value };
    describeSelection();
    for (const chart of affectedBy(control)) run(chart);
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

  const run = function (chart: ChartId): void {
    // Purpose: run one chart's plan with the current selection and draw the result
    const began = performance.now();
    const options = { params: paramsFor(selection, chart) };
    const done = function (): void {
      // Purpose: record the run time
      showMs(chart, performance.now() - began);
    };
    const failed = function (error: unknown): void {
      // Purpose: ignore runs replaced by newer ones; report anything else
      if (!isAbort(error)) console.error(`${chart} failed`, error);
    };
    if (chart === 'top') {
      runs.top(routes, options).then(function (result) {
        // Purpose: draw the top networks
        drawTopNetworks(
          byId('chart-top'),
          result.toArray().map(r => ({ origin: r.origin_as ?? 0, name: r.as_name, routes: r.routes ?? 0 })),
        );
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
    } else {
      runs.totals(routes, options).then(function (result) {
        // Purpose: show the matching route and network counts
        const row = result.toArray()[0];
        byId<HTMLElement>('total-routes').textContent = (row?.routes ?? 0).toLocaleString();
        byId<HTMLElement>('total-networks').textContent = (row?.networks ?? 0).toLocaleString();
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

  const runAll = function (): void {
    // Purpose: run every chart
    for (const chart of ['totals', 'top', 'prefixLen', 'pathLen', 'regions'] as const) run(chart);
  };
  window.addEventListener('resize', function onResize() {
    // Purpose: charts are drawn at the page width, so redraw on resize
    runAll();
  });
  return { runAll };
}

async function startLive(routes: RoutesTable): Promise<void> {
  // Purpose: stream updates into a live table and redraw the live panel every second
  const names = await nameIndex(routes);
  const live = createUpdatesTable();
  const plans = compileLivePlans();
  const runs = { activity: latest(plans.activity), active: latest(plans.active), totals: latest(plans.totals) };
  let pending: UpdateRow[] = [];
  const handlers = {
    onRows(rows: UpdateRow[]) {
      // Purpose: buffer rows until the next append, so the table grows in batches
      pending = pending.concat(rows);
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
    const origins = Array.from(names.keys()).slice(0, 400);
    simulateFeed(origins.length ? origins : [64512], 400, handlers);
  } else {
    connectRisLive(new URLSearchParams(location.search).get('host') ?? 'rrc00', handlers);
  }

  setInterval(function tick() {
    // Purpose: append the buffered rows and re-run the live queries
    if (pending.length > 0) {
      live.append(pending);
      pending = [];
    }
    const began = performance.now();
    const now = Math.floor(Date.now() / 1000);
    const from = now - ACTIVITY_SECONDS;
    const options = { params: { since: from } };
    const failed = function (error: unknown): void {
      // Purpose: ignore replaced runs
      if (!isAbort(error)) console.error('live query failed', error);
    };
    Promise.all([runs.activity(live, options), runs.active(live, options), runs.totals(live, options)]).then(function ([
      activity,
      active,
      totals,
    ]) {
      // Purpose: draw the live panel from the three results
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
      showMs('live', performance.now() - began);
    }, failed);
  }, 1000);
}

start().catch(function (error: unknown) {
  // Purpose: show a load failure on the page
  byId<HTMLElement>('source').textContent = `Failed to load: ${String(error)}`;
  console.error(error);
});
