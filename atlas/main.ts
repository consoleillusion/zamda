// The whole standalone demo: load one graph file, run one compiled plan at a
// time, and show the answer as a single explainable topology. No other tables,
// panels, or demo modules are involved.

import type { Table } from '../src';
import { GraphEdges, loadGraph } from '../scripts/bgp/graph-file';
import type { GraphArrays } from '../scripts/bgp/graph-file';
import { startGraphEngine } from './engine';
import type { GraphEngine } from './engine';
import { buildScene } from './layout';
import type { Scene } from './layout';
import { compileCountPlan, compileNeighbourPlan, compileOverviewPlan } from './plans';
import type { AtlasRow } from './plans';
import { createRenderer } from './render';
import type { Pick, Renderer } from './render';

interface CountRow {
  readonly pairs: number;
  readonly observations: bigint;
}

interface AtlasProbe {
  readonly mode: string;
  readonly nodes: number;
  readonly flows: number;
  readonly beams: number;
  readonly hubs: number;
  readonly engine: string;
  camera(): { x: number; y: number; ratio: number };
  nodeScreen(asn: number): { x: number; y: number } | null;
  anyNode(): { asn: number; x: number; y: number } | null;
  select(asn: number): Promise<void>;
  overview(): Promise<void>;
}

declare global {
  interface Window {
    __atlas?: AtlasProbe;
  }
}

const statusLine = document.getElementById('status') as HTMLElement | null;
const engineLine = document.getElementById('engine') as HTMLElement | null;
const canvas = document.getElementById('topology') as HTMLCanvasElement | null;
if (!statusLine || !engineLine || !canvas) throw new Error('The topology page is missing its canvas');

let arrays: GraphArrays | null = null;
let engine: GraphEngine | null = null;
let renderer: Renderer | null = null;
let summary = '';
let engineStatus = 'compiled plans: JS reference';
let modeText = '';
let mode = 'loading';
let generation = 0;
let currentRows: readonly AtlasRow[] = [];
let currentScene: Scene | null = null;

function sameRows(a: readonly object[], b: readonly object[]): boolean {
  // Purpose: compare two plan results without assuming BigInt can be JSON stringified
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as Record<string, unknown>;
    const right = b[i] as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!(key in right) || String(left[key]) !== String(right[key])) return false;
    }
  }
  return true;
}

async function executeRows(
  read: (table: Table<typeof GraphEdges.fields>) => Promise<readonly object[]>,
): Promise<readonly AtlasRow[]> {
  // Purpose: run one compiled read in WASM and JS, and use WASM only on an exact match
  const edges = (await loadCache()).edges;
  const js = await read(edges);
  let rows = js as unknown as readonly AtlasRow[];
  if (engine) {
    const wasm = await read(engine.table);
    if (sameRows(js, wasm)) {
      engineStatus = 'WASM plan active · answer matches JS reference';
      rows = wasm as unknown as readonly AtlasRow[];
    } else {
      engineStatus = 'WASM answer differed · showing JS reference';
    }
  }
  return rows;
}

let cached: Awaited<ReturnType<typeof loadGraph>> | null = null;
function loadCache(): Promise<Awaited<ReturnType<typeof loadGraph>>> {
  // Purpose: keep the single decoded graph table for every later plan
  if (cached) return Promise.resolve(cached);
  return fetch('/data/graph.bin').then(function (response): Promise<Response> {
    if (!response.ok) throw new Error(`No graph.bin (${response.status}). Run \`bun run prep-bgp\`.`);
    return Promise.resolve(response);
  }).then(async function (response) {
    const decoded = loadGraph(new Uint8Array(await response.arrayBuffer()));
    cached = decoded;
    return decoded;
  });
}

function sceneSummary(): string {
  // Purpose: say exactly how much of the plan is drawn and how much is bundled
  const scene = currentScene;
  if (!scene) return '';
  if (scene.tailCount === 0) return `${scene.visibleCount.toLocaleString()} strongest hops drawn individually.`;
  return `${scene.visibleCount.toLocaleString()} strongest hops drawn; ${scene.tailCount.toLocaleString()} other pairs (${scene.tailWeight.toLocaleString()} prefix appearances) grouped into ${scene.beams.length} bottom bundles.`;
}

function caption(): void {
  // Purpose: one honest line of provenance and one line of engine state
  statusLine!.textContent = `${summary} ${sceneSummary()} ${modeText}`.trim();
  engineLine!.textContent = engineStatus;
}

function draw(rows: readonly AtlasRow[], nextMode: string, fit: boolean): Scene {
  // Purpose: convert one plan result into the single drawable scene
  const scene = buildScene(arrays!, rows);
  renderer!.setScene(scene, fit);
  currentRows = rows;
  currentScene = scene;
  mode = nextMode;
  caption();
  return scene;
}

async function showOverview(fit = true): Promise<void> {
  // Purpose: draw the strongest observed hops from the whole graph
  const mine = ++generation;
  modeText = 'Click a dot or arrow to isolate its observed neighbours.';
  caption();
  const plan = compileOverviewPlan();
  const rows = await executeRows(async function read(table) {
    // Purpose: read the strongest-hop result from either engine table
    return (await plan.execute(table)).toArray() as unknown as readonly object[];
  });
  if (mine !== generation) return;
  draw(rows, 'overview', fit);
}

async function showNeighbour(asn: number): Promise<void> {
  // Purpose: replace the overview with one AS's observed neighbours, keeping the camera
  const mine = ++generation;
  modeText = `Following hops into and out of AS${asn}. Click empty space to return.`;
  caption();
  const plan = compileNeighbourPlan();
  const rows = await executeRows(async function read(table) {
    // Purpose: read one AS's observed neighbours from either engine table
    return (await plan.execute(table, { params: { asns: [asn] } })).toArray() as unknown as readonly object[];
  });
  if (mine !== generation) return;
  const scene = draw(rows, `neighbour:${asn}`, false);
  const node = scene.nodes.find(item => item.asn === asn);
  if (node) {
    renderer!.setSelection(asn);
    modeText = `${node.label} · AS${asn}: ${scene.visibleCount.toLocaleString()} strongest matching hops shown around it. Click empty space to return.`;
    caption();
  }
}

function onPick(pick: Pick): void {
  // Purpose: turn a click on an AS, hop, hub, or empty space into one clear action
  if (pick.kind === 'node' && pick.node) {
    void showNeighbour(pick.node.asn);
    return;
  }
  if (pick.kind === 'flow' && pick.flow) {
    void showNeighbour(pick.flow.from);
    return;
  }
  if (pick.kind === 'hub' && pick.hub) {
    renderer!.focusHub(pick.hub.key);
    modeText = `Zoomed into ${pick.hub.label}. Click empty space to return.`;
    caption();
    return;
  }
  if (mode !== 'overview') void showOverview(true);
}

async function boot(): Promise<void> {
  // Purpose: load the graph once, count the whole file, then paint and attach the worker
  statusLine!.textContent = 'Loading the observed graph…';
  engineLine!.textContent = 'compiled plans: starting…';
  const decoded = await loadCache();
  arrays = decoded.arrays;
  const countRows = (await compileCountPlan().execute(decoded.edges)).toArray() as unknown as readonly CountRow[];
  const count = countRows[0];
  summary = count
    ? `${count.pairs.toLocaleString()} observed directed AS pairs · ${count.observations.toLocaleString()} prefix appearances in the source.`
    : 'Observed BGP adjacency graph loaded.';

  renderer = createRenderer(canvas!, onPick);
  await showOverview(true);

  window.__atlas = {
    get mode() { return mode; },
    get nodes() { return currentScene?.nodes.length ?? 0; },
    get flows() { return currentScene?.flows.length ?? 0; },
    get beams() { return currentScene?.beams.length ?? 0; },
    get hubs() { return currentScene?.hubs.length ?? 0; },
    get engine() { return engineStatus; },
    camera() { return renderer!.camera(); },
    nodeScreen(asn) {
      // Purpose: expose an AS dot's viewport point for browser checks
      const point = renderer!.nodeScreen(asn);
      if (!point) return null;
      const bounds = canvas!.getBoundingClientRect();
      return { x: bounds.left + point.x, y: bounds.top + point.y };
    },
    anyNode() {
      // Purpose: expose one visible AS for browser interaction checks
      const node = currentScene?.nodes[0];
      if (!node) return null;
      const point = window.__atlas!.nodeScreen(node.asn);
      return point ? { asn: node.asn, ...point } : null;
    },
    select(asn) { return showNeighbour(asn); },
    overview() { return showOverview(true); },
  };

  try {
    engine = await startGraphEngine(arrays, function onEngineStatus(message) {
      engineStatus = `compiled plans: ${message}`;
      caption();
    });
    engineStatus = 'WASM worker ready · rerunning the current plan';
    caption();
    if (mode.startsWith('neighbour:')) {
      await showNeighbour(Number(mode.slice('neighbour:'.length)));
    } else {
      await showOverview(false);
    }
  } catch (error) {
    engineStatus = `JS reference only · WASM unavailable: ${String(error)}`;
    caption();
  }
}

window.addEventListener('keydown', function onKey(event): void {
  // Purpose: Escape is the only navigation control besides the canvas itself
  if (event.key === 'Escape' && mode !== 'overview') void showOverview(true);
});

void boot().catch(function onBootError(error): void {
  // Purpose: a missing data file or engine never leaves the page silently blank
  statusLine!.textContent = `Could not start the topology: ${String(error)}`;
  engineLine!.textContent = 'compiled plans: unavailable';
});
