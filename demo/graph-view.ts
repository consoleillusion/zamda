// The graph panel's WebGL renderer. Graphology holds the simplified graph;
// sigma.js draws it on a canvas over a synced world outline. Positions come from
// graph.bin, so there is no layout pass in the browser and live updates never move
// a node. One renderer stays alive across views: a click keeps the current camera
// while the data is replaced, and Overview or All data eases back out first.

import Graph from 'graphology';
import Sigma from 'sigma';
import { frameCamera, selectionCamera } from './graph-data';
import type { CameraView, GraphEdgeView, GraphViewData } from './graph-data';
import { WORLD_LAND } from './world-map';

export interface GraphView {
  show(data: GraphViewData): void;
  jump(data: GraphViewData): void;
  frame(data: GraphViewData): Promise<void>;
  focus(): Promise<void>;
  setLive(hot: ReadonlyMap<string, number>): void;
  camera(): { x: number; y: number; ratio: number };
  cameraObject(): Camera | null;
  screen(asn: number): Point | null;
  destroy(): void;
}

const RIR_COLORS: Readonly<Record<string, string>> = {
  ARIN: '#63a4ff',
  RIPE: '#ff6b6b',
  APNIC: '#45d4a1',
  LACNIC: '#c792ea',
  AFRINIC: '#ffc857',
};
const FALLBACK_COLOR = '#8799b1';
const LIVE_COLOR = '#ff4d5e';
const EDGE_COLOR = 'rgba(142, 162, 186, 0.28)';
const LIVE_EDGE_COLOR = 'rgba(255, 77, 94, 0.95)';
const LABEL_LIMIT = 8;
const COUNTRY_LABEL_LIMIT = 10;
const COUNTRY_LABEL_RATIO = 0.5;
const ZOOM_DURATION = 450;
const WHEEL_RATIO = 1.35;

type Camera = ReturnType<Sigma['getCamera']>;

export interface Point {
  readonly x: number;
  readonly y: number;
}

function nodeColor(rir: string | null): string {
  // Purpose: one stable colour per regional registry
  return rir === null ? FALLBACK_COLOR : (RIR_COLORS[rir] ?? FALLBACK_COLOR);
}

function edgeWidth(weight: number, density: number): number {
  // Purpose: a log scale keeps a few very heavy edges from hiding the rest, and a dense view keeps them hairline
  return (0.25 + Math.min(1.6, Math.log2(weight + 1) / 3)) * density;
}

function populateGraph(graph: Graph, data: GraphViewData): void {
  // Purpose: replace the displayed nodes and edges while keeping the renderer and its camera
  graph.clear();
  let maxPaths = 1;
  for (const node of data.nodes) maxPaths = Math.max(maxPaths, node.paths);
  const density = Math.min(1, Math.sqrt(1500 / Math.max(1, data.nodes.length)));
  const labelled = new Set(
    [...data.nodes]
      .sort((a, b) => b.paths - a.paths || a.asn - b.asn)
      .slice(0, LABEL_LIMIT)
      .map(node => node.asn),
  );
  for (const node of data.nodes) {
    graph.addNode(String(node.asn), {
      x: node.x,
      y: node.y,
      size: (2.6 + 3.2 * Math.sqrt(node.paths / maxPaths)) * density,
      color: nodeColor(node.rir),
      label: labelled.has(node.asn) ? node.label : '',
      asn: node.asn,
      name: node.name,
      paths: node.paths,
      rir: node.rir,
      country: node.country,
      location: node.location,
    });
  }
  for (const edge of data.edges) {
    if (!graph.hasNode(String(edge.from)) || !graph.hasNode(String(edge.to))) continue;
    if (graph.hasEdge(String(edge.from), String(edge.to))) continue;
    graph.addEdge(String(edge.from), String(edge.to), {
      size: edgeWidth(edge.weight, density),
      color: EDGE_COLOR,
      weight: edge.weight,
      span: edge.spanKm,
      key: edge.key,
    });
  }
}

function reduceMotion(): boolean {
  // Purpose: respect the browser's reduced-motion setting for camera transitions
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function animateTo(camera: Camera, target: CameraView): Promise<void> {
  // Purpose: ease the shared camera to a view, or jump there when motion is reduced
  if (reduceMotion()) {
    camera.setState(target);
    return Promise.resolve();
  }
  return camera.animate(target, { duration: ZOOM_DURATION });
}

function drawMap(
  canvas: HTMLCanvasElement,
  renderer: Sigma,
  data: GraphViewData | null,
  camera: CameraView,
): void {
  // Purpose: paint a faint world outline in the same projection, following sigma's camera
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.beginPath();
  for (const ring of WORLD_LAND) {
    for (let i = 0; i < ring.length; i += 2) {
      const point = renderer.graphToViewport({ x: ring[i]!, y: ring[i + 1]! });
      if (i === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.closePath();
  }
  context.fillStyle = dark ? 'rgba(255, 255, 255, 0.035)' : 'rgba(41, 62, 84, 0.055)';
  context.strokeStyle = dark ? 'rgba(190, 205, 220, 0.22)' : 'rgba(80, 95, 115, 0.26)';
  context.lineWidth = 0.7;
  context.fill('evenodd');
  context.stroke();
  if (!data || camera.ratio > COUNTRY_LABEL_RATIO) return;
  const groups = new Map<string, { count: number; x: number; y: number }>();
  for (const node of data.nodes) {
    if (node.country === null) continue;
    const group = groups.get(node.country) ?? { count: 0, x: 0, y: 0 };
    group.count++;
    group.x += node.x;
    group.y += node.y;
    groups.set(node.country, group);
  }
  const shown = [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, COUNTRY_LABEL_LIMIT);
  context.font = '600 10px system-ui, sans-serif';
  context.fillStyle = dark ? 'rgba(220, 225, 230, 0.55)' : 'rgba(62, 74, 88, 0.65)';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const [country, group] of shown) {
    const point = renderer.graphToViewport({ x: group.x / group.count, y: group.y / group.count });
    context.fillText(country, point.x, point.y - 8);
  }
}

function nodeTooltip(graph: Graph, node: string): string {
  // Purpose: explain a clicked network without guessing a physical location
  const attributes = graph.getNodeAttributes(node);
  const asn = `AS${String(attributes.asn)}`;
  const label = String(attributes.label ?? '');
  const title = label === '' || label === asn ? asn : `${label} · ${asn}`;
  const place = attributes.country === null || attributes.country === undefined ? 'unknown country' : String(attributes.country);
  const rir = attributes.rir === null || attributes.rir === undefined ? 'unknown registry' : String(attributes.rir);
  const precision = Number(attributes.location);
  const mapped =
    precision === 2
      ? 'Mapped from PeeringDB facilities'
      : precision === 1
        ? 'Mapped from the registered country centre'
        : 'No mapped point; shown at a regional fallback';
  const routes = Number(attributes.paths);
  return `${title}\n${place} · ${rir} · ${routes.toLocaleString()} ${routes === 1 ? 'route' : 'routes'}\n${mapped}; click to expand its neighbourhood`;
}

function edgeTooltip(graph: Graph, edge: string): string {
  // Purpose: state what an edge means and how its thickness and colour are chosen
  const attributes = graph.getEdgeAttributes(edge);
  const from = String(attributes.key).split(':')[0]!;
  const to = String(attributes.key).split(':')[1]!;
  const fromLabel = graph.hasNode(from) ? String(graph.getNodeAttributes(from).label || `AS${from}`) : `AS${from}`;
  const toLabel = graph.hasNode(to) ? String(graph.getNodeAttributes(to).label || `AS${to}`) : `AS${to}`;
  return `${fromLabel} → ${toLabel}\n${Number(attributes.weight).toLocaleString()} prefixes on this hop · mapped points about ${Number(attributes.span).toLocaleString()} km apart\nConsecutive hops in observed BGP paths, not physical circuits`;
}

export function createGraphView(container: HTMLElement, onSelect: (asn: number) => void): GraphView {
  // Purpose: own one sigma renderer over the graph panel, animating without replacing the canvas
  let renderer: Sigma | null = null;
  let graph: Graph | null = null;
  let mapCanvas: HTMLCanvasElement | null = null;
  let tooltip: HTMLDivElement | null = null;
  let currentData: GraphViewData | null = null;

  const hideTooltip = function (): void {
    // Purpose: clear the last hover explanation when the pointer leaves the item
    if (tooltip) tooltip.hidden = true;
  };

  const moveTooltip = function (event: PointerEvent): void {
    // Purpose: keep a visible tooltip beside the pointer without eating sigma's events
    if (!tooltip || tooltip.hidden) return;
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    tooltip.style.left = `${Math.min(bounds.width - 240, x + 14)}px`;
    tooltip.style.top = `${Math.max(6, y - 44)}px`;
  };

  const showTooltip = function (text: string, point: Point): void {
    // Purpose: show one short explanation of the node or edge under the pointer
    if (!tooltip) return;
    tooltip.textContent = text;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(container.clientWidth - 240, point.x + 14)}px`;
    tooltip.style.top = `${Math.max(6, point.y - 44)}px`;
  };

  const ensureRenderer = function (): void {
    // Purpose: create the map layer, renderer and tooltip once, on the first draw
    if (renderer && graph) return;
    graph = new Graph({ type: 'directed', multi: false });
    container.replaceChildren();
    mapCanvas = document.createElement('canvas');
    mapCanvas.className = 'graph-world-map';
    container.appendChild(mapCanvas);
    renderer = new Sigma(graph, container, {
      settings: {
        itemSizesReference: 'screen',
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 3,
        labelDensity: 0.02,
        labelGridCellSize: 90,
        minCameraRatio: 0.2,
        maxCameraRatio: 12,
        stagePadding: 24,
        zoomDuration: ZOOM_DURATION,
        zoomingRatio: WHEEL_RATIO,
        inertiaDuration: 350,
        inertiaRatio: 0.8,
      },
    });
    tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.hidden = true;
    container.appendChild(tooltip);
    container.addEventListener('pointermove', moveTooltip);
    renderer.on('afterRender', function () {
      // Purpose: keep the outline exactly under the graph after every pan and zoom
      if (mapCanvas && renderer) drawMap(mapCanvas, renderer, currentData, renderer.getCamera().getState());
    });
    renderer.on('clickNode', function (event) {
      // Purpose: drill into the network the user clicked
      onSelect(Number(event.node));
    });
    renderer.on('enterNode', function (event) {
      // Purpose: name the network, its registered country and what a click does
      showTooltip(nodeTooltip(graph!, event.node), event.event);
    });
    renderer.on('leaveNode', hideTooltip);
    renderer.on('enterEdge', function (event) {
      // Purpose: explain that the line is BGP adjacency, not a physical circuit
      showTooltip(edgeTooltip(graph!, event.edge), event.event);
    });
    renderer.on('leaveEdge', hideTooltip);
    renderer.on('leaveStage', hideTooltip);
  };

  const destroy = function (): void {
    // Purpose: release WebGL resources only when the panel itself is torn down
    container.removeEventListener('pointermove', moveTooltip);
    renderer?.kill();
    renderer = null;
    graph = null;
    mapCanvas = null;
    tooltip = null;
    currentData = null;
  };

  return {
    show(data) {
      // Purpose: draw one snapshot on fixed positions, leaving the camera where it is
      ensureRenderer();
      currentData = data;
      populateGraph(graph!, data);
      hideTooltip();
      renderer!.refresh();
    },
    jump(data) {
      // Purpose: draw the first snapshot and frame it without animating
      ensureRenderer();
      currentData = data;
      renderer!.getCamera().cancelAnimation();
      renderer!.getCamera().setState(frameCamera(data));
      populateGraph(graph!, data);
      renderer!.refresh();
    },
    frame(data) {
      // Purpose: ease the camera out to a view before its nodes are shown
      ensureRenderer();
      return animateTo(renderer!.getCamera(), frameCamera(data));
    },
    focus() {
      // Purpose: freeze the current view before a clicked AS's neighbourhood replaces the data
      ensureRenderer();
      const camera = renderer!.getCamera();
      camera.cancelAnimation();
      camera.setState(selectionCamera(camera.getState()));
      return Promise.resolve();
    },
    camera() {
      // Purpose: the current camera state, for checking that a browser interaction really moved it
      return renderer
        ? (({ x, y, ratio }) => ({ x, y, ratio }))(renderer.getCamera().getState())
        : { x: 0.5, y: 0.5, ratio: 1 };
    },
    cameraObject() {
      // Purpose: the live camera, so a browser check can start from a panned and zoomed view
      return renderer?.getCamera() ?? null;
    },
    screen(asn) {
      // Purpose: a node's viewport point, for checking hover and camera behaviour in a browser
      if (!renderer || !graph?.hasNode(String(asn))) return null;
      const attributes = graph.getNodeAttributes(String(asn));
      const point = renderer.graphToViewport({ x: Number(attributes.x), y: Number(attributes.y) });
      const bounds = container.getBoundingClientRect();
      return { x: bounds.left + point.x, y: bounds.top + point.y };
    },
    setLive(hot) {
      // Purpose: colour the edges and nodes currently active in RIS Live, without moving anything
      if (!graph || !renderer) return;
      let changed = false;
      graph.forEachNode(function (_, attributes) {
        // Purpose: restore a node's registry colour, or mark it hot
        const asn = Number(attributes.asn);
        const color = hot.has(String(asn)) ? LIVE_COLOR : nodeColor(attributes.rir === null ? null : String(attributes.rir));
        if (attributes.color !== color) {
          graph!.setNodeAttribute(String(asn), 'color', color);
          changed = true;
        }
      });
      graph.forEachEdge(function (edge, attributes) {
        // Purpose: restore an edge's colour, or mark it hot
        const color = hot.has(String(attributes.key)) ? LIVE_EDGE_COLOR : EDGE_COLOR;
        if (attributes.color !== color) {
          graph!.setEdgeAttribute(edge, 'color', color);
          changed = true;
        }
      });
      if (changed) renderer.refresh();
    },
    destroy,
  };
}

export type { GraphEdgeView };
