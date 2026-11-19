// Wires the AS graph card: loads graph.bin, runs a compiled plan to choose the
// simplified overview, and draws it on fixed positions. A click replaces the
// view with the clicked AS's neighbourhood.

import { loadGraph } from '../scripts/bgp/graph-file';
import type { GraphArrays, GraphHeader } from '../scripts/bgp/graph-file';
import {
  OVERVIEW_EDGES,
  OVERVIEW_NODES,
  allEdges,
  buildViewData,
  compileGraphPlans,
  neighbourhoodEdges,
  overviewEdges,
} from './graph-data';
import type { EdgeTable, GraphPlans } from './graph-data';
import { createGraphView } from './graph-view';
import type { GraphView } from './graph-view';

export interface GraphPanel {
  setLive(hot: ReadonlyMap<string, number>): void;
}

export interface GraphProbe {
  mode: 'overview' | 'neighbourhood' | 'all';
  nodes: number;
  edges: number;
  lastMs: number;
  camera(): { x: number; y: number; ratio: number };
  select(asn: number): Promise<void>;
  overview(): Promise<void>;
  all(): Promise<void>;
}

declare global {
  interface Window {
    __zamdaGraph?: GraphProbe;
  }
}

const NOOP_PANEL: GraphPanel = {
  setLive() {
    // Purpose: keep the live feed simple when no graph file is available
  },
};

function byId<T extends Element>(id: string): T {
  // Purpose: an element that the graph card is known to contain
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as unknown as T;
}

interface GraphDraw {
  readonly rows: number;
  readonly nodes: number;
  readonly edges: number;
  readonly ms: number;
}

function sourceText(header: GraphHeader): string {
  // Purpose: name the collector and dump behind the graph file
  const source = header.source;
  return `${String(source.collector ?? 'unknown collector')} ${String(source.dump ?? '')}`.trim();
}

async function showOverview(
  edges: EdgeTable,
  arrays: GraphArrays,
  plans: GraphPlans,
  view: GraphView,
  hot: ReadonlyMap<string, number>,
  current: () => boolean,
): Promise<GraphDraw | null> {
  // Purpose: draw the strongest edges, with a bounded node count for a readable first view
  const began = performance.now();
  const rows = await overviewEdges(edges, OVERVIEW_EDGES, plans.overview);
  if (!current()) return null;
  const data = buildViewData(arrays, rows, { nodeLimit: OVERVIEW_NODES });
  view.show(data);
  view.setLive(hot);
  byId<HTMLElement>('graph-detail').textContent =
    `${data.edges.length.toLocaleString()} edges drawn from the ${rows.length.toLocaleString()} strongest · ` +
    `${data.nodes.length.toLocaleString()} ASes · click a node to expand`;
  const ms = Math.round(performance.now() - began);
  byId<HTMLElement>('ms-graph').textContent = `${ms} ms`;
  return { rows: rows.length, nodes: data.nodes.length, edges: data.edges.length, ms };
}

async function showAll(
  edges: EdgeTable,
  arrays: GraphArrays,
  plans: GraphPlans,
  view: GraphView,
  hot: ReadonlyMap<string, number>,
  current: () => boolean,
): Promise<GraphDraw | null> {
  // Purpose: draw every node and edge, with no LOD budget, for explicit inspection
  const began = performance.now();
  const rows = await allEdges(edges, plans.all);
  if (!current()) return null;
  const data = buildViewData(arrays, rows, { nodeLimit: arrays.rowCount });
  view.show(data);
  view.setLive(hot);
  byId<HTMLElement>('graph-detail').textContent =
    `All ${data.edges.length.toLocaleString()} directed edges · ${data.nodes.length.toLocaleString()} ASes · pan and zoom to inspect`;
  const ms = Math.round(performance.now() - began);
  byId<HTMLElement>('ms-graph').textContent = `${ms} ms`;
  return { rows: rows.length, nodes: data.nodes.length, edges: data.edges.length, ms };
}

async function showNeighbourhood(
  edges: EdgeTable,
  arrays: GraphArrays,
  plans: GraphPlans,
  view: GraphView,
  hot: ReadonlyMap<string, number>,
  asn: number,
  current: () => boolean,
): Promise<GraphDraw | null> {
  // Purpose: draw the strongest edges within two hops of a clicked AS
  const began = performance.now();
  const rows = await neighbourhoodEdges(edges, plans, asn);
  if (!current()) return null;
  const data = buildViewData(arrays, rows);
  view.show(data);
  view.setLive(hot);
  byId<HTMLElement>('graph-detail').textContent =
    `Neighbourhood of AS${asn}: ${data.nodes.length.toLocaleString()} ASes, ${data.edges.length.toLocaleString()} edges · click Overview to return`;
  const ms = Math.round(performance.now() - began);
  byId<HTMLElement>('ms-graph').textContent = `${ms} ms`;
  return { rows: rows.length, nodes: data.nodes.length, edges: data.edges.length, ms };
}

export async function startGraph(): Promise<GraphPanel> {
  // Purpose: load the graph file and keep its WebGL view in step with the card's controls
  const status = byId<HTMLElement>('graph-status');
  const began = performance.now();
  const response = await fetch('/data/graph.bin');
  if (!response.ok) {
    status.textContent = (await response.text()).trim() || `No graph file (${response.status})`;
    return NOOP_PANEL;
  }
  const { arrays, header, edges } = loadGraph(new Uint8Array(await response.arrayBuffer()));
  const loadMs = Math.round(performance.now() - began);
  status.textContent =
    `${arrays.rowCount.toLocaleString()} ASes · ${arrays.edgeCount.toLocaleString()} directed edges from ` +
    `${sourceText(header)} · loaded in ${loadMs} ms`;

  const plans = compileGraphPlans();
  const hot = new Map<string, number>();
  let generation = 0;
  const probe: GraphProbe = {
    mode: 'overview',
    nodes: 0,
    edges: 0,
    lastMs: 0,
    camera: function () {
      // Purpose: expose the renderer's camera state to the browser harness
      return view.camera();
    },
    select: runNeighbourhood,
    overview: runOverview,
    all: runAll,
  };
  window.__zamdaGraph = probe;

  async function runOverview(): Promise<void> {
    // Purpose: show the bounded overview and publish its counts and timing for the browser harness
    const mine = ++generation;
    const draw = await showOverview(edges, arrays, plans, view, hot, function () {
      // Purpose: suppress an overview that a later action has replaced
      return mine === generation;
    });
    if (!draw) return;
    probe.mode = 'overview';
    probe.nodes = draw.nodes;
    probe.edges = draw.edges;
    probe.lastMs = draw.ms;
  }

  async function runAll(): Promise<void> {
    // Purpose: show every edge and publish its counts and timing
    const mine = ++generation;
    const draw = await showAll(edges, arrays, plans, view, hot, function () {
      // Purpose: suppress an all-data view that a later action has replaced
      return mine === generation;
    });
    if (!draw) return;
    probe.mode = 'all';
    probe.nodes = draw.nodes;
    probe.edges = draw.edges;
    probe.lastMs = draw.ms;
  }

  async function runNeighbourhood(asn: number): Promise<void> {
    // Purpose: show one AS's neighbourhood and publish its counts and timing
    const mine = ++generation;
    const draw = await showNeighbourhood(edges, arrays, plans, view, hot, asn, function () {
      // Purpose: suppress a neighbourhood that a later action has replaced
      return mine === generation;
    });
    if (!draw) return;
    probe.mode = 'neighbourhood';
    probe.nodes = draw.nodes;
    probe.edges = draw.edges;
    probe.lastMs = draw.ms;
  }

  function fail(label: string): (error: unknown) => void {
    // Purpose: report a failed graph interaction in the card
    return function onError(error: unknown): void {
      status.textContent = `Graph ${label} failed: ${String(error)}`;
      console.error(`graph ${label} failed`, error);
    };
  }

  const view = createGraphView(byId('graph-canvas'), function onSelect(asn: number) {
    // Purpose: replace the overview with the clicked AS's neighbourhood
    void runNeighbourhood(asn).catch(fail('neighbourhood'));
  });
  byId<HTMLButtonElement>('graph-overview').addEventListener('click', function onOverview() {
    // Purpose: return to the bounded overview
    void runOverview().catch(fail('overview'));
  });
  byId<HTMLButtonElement>('graph-all').addEventListener('click', function onAll() {
    // Purpose: show the full graph, at the cost of a denser picture
    void runAll().catch(fail('all-data view'));
  });

  await runOverview();
  return {
    setLive(next) {
      // Purpose: pass the current live hot set to the renderer without reloading the graph
      hot.clear();
      for (const [key, count] of next) hot.set(key, count);
      view.setLive(hot);
    },
  };
}
