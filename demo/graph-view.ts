// The graph panel's WebGL renderer. Graphology holds the simplified graph;
// sigma.js draws it. Positions come from graph.bin, so there is no layout pass
// in the browser and live updates never move a node. One renderer stays alive
// across views: a click eases the camera onto the chosen AS before the data is
// replaced, and Overview or All data eases back out first.

import Graph from 'graphology';
import Sigma from 'sigma';
import type { GraphEdgeView, GraphViewData } from './graph-data';

export interface GraphView {
  show(data: GraphViewData): void;
  jump(data: GraphViewData): void;
  frame(data: GraphViewData): Promise<void>;
  focus(asn: number): Promise<void>;
  setLive(hot: ReadonlyMap<string, number>): void;
  camera(): { x: number; y: number; ratio: number };
  destroy(): void;
}

const RIR_COLORS: Readonly<Record<string, string>> = {
  ARIN: '#2f6fdb',
  RIPE: '#d0573c',
  APNIC: '#2e9e6b',
  LACNIC: '#9b59b6',
  AFRINIC: '#d69a00',
};
const FALLBACK_COLOR = '#8a8a82';
const LIVE_COLOR = '#e83e3e';
const EDGE_COLOR = 'rgba(113, 128, 150, 0.28)';
const LIVE_EDGE_COLOR = 'rgba(232, 62, 62, 0.95)';
const LABEL_LIMIT = 8;
const ZOOM_DURATION = 550;
const FOCUS_RATIO = 1.8;

interface CameraView {
  x: number;
  y: number;
  ratio: number;
}

type Camera = ReturnType<Sigma['getCamera']>;

function nodeColor(rir: string | null): string {
  // Purpose: one stable colour per regional registry
  return rir === null ? FALLBACK_COLOR : (RIR_COLORS[rir] ?? FALLBACK_COLOR);
}

function edgeWidth(weight: number, density: number): number {
  // Purpose: a log scale keeps a few very heavy edges from hiding the rest, and a dense view keeps them hairline
  return (0.18 + Math.min(1.4, Math.log2(weight + 1) / 3)) * density;
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
      size: (1.1 + 2.4 * Math.sqrt(node.paths / maxPaths)) * density,
      color: nodeColor(node.rir),
      label: labelled.has(node.asn) ? node.label : '',
      asn: node.asn,
      paths: node.paths,
      rir: node.rir,
    });
  }
  for (const edge of data.edges) {
    if (!graph.hasNode(String(edge.from)) || !graph.hasNode(String(edge.to))) continue;
    if (graph.hasEdge(String(edge.from), String(edge.to))) continue;
    graph.addEdge(String(edge.from), String(edge.to), {
      size: edgeWidth(edge.weight, density),
      color: EDGE_COLOR,
      weight: edge.weight,
      key: edge.key,
    });
  }
}

function targetCamera(data: GraphViewData): CameraView {
  // Purpose: frame the nodes of a view without moving their frozen positions
  if (data.nodes.length === 0) return { x: 0.5, y: 0.5, ratio: 1 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of data.nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  const x = (minX + maxX + 2) / 4;
  const y = (minY + maxY + 2) / 4;
  const span = Math.max(maxX - minX, maxY - minY, 0.05);
  return { x, y, ratio: Math.min(4, Math.max(0.8, 2 / span)) };
}

function focusTarget(graph: Graph, asn: number): CameraView | null {
  // Purpose: centre the camera on a clicked AS so the zoom keeps that node in view
  if (!graph.hasNode(String(asn))) return null;
  const attributes = graph.getNodeAttributes(String(asn));
  return { x: (Number(attributes.x) + 1) / 2, y: (Number(attributes.y) + 1) / 2, ratio: FOCUS_RATIO };
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

export function createGraphView(container: HTMLElement, onSelect: (asn: number) => void): GraphView {
  // Purpose: own one sigma renderer over the graph panel, animating without replacing the canvas
  let renderer: Sigma | null = null;
  let graph: Graph | null = null;

  const ensureRenderer = function (): void {
    // Purpose: create the renderer once, on the first draw
    if (renderer && graph) return;
    graph = new Graph({ type: 'directed', multi: false });
    container.replaceChildren();
    renderer = new Sigma(graph, container, {
      settings: {
        itemSizesReference: 'screen',
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 2.4,
        labelDensity: 0.02,
        labelGridCellSize: 90,
        minCameraRatio: 0.2,
        maxCameraRatio: 12,
        stagePadding: 24,
        zoomDuration: ZOOM_DURATION,
        zoomingRatio: 1.12,
        inertiaDuration: 350,
        inertiaRatio: 0.8,
      },
    });
    renderer.on('clickNode', function (event) {
      // Purpose: drill into the network the user clicked
      onSelect(Number(event.node));
    });
  };

  const destroy = function (): void {
    // Purpose: release WebGL resources only when the panel itself is torn down
    renderer?.kill();
    renderer = null;
    graph = null;
  };

  return {
    show(data) {
      // Purpose: draw one snapshot on fixed positions, leaving the camera where it is
      ensureRenderer();
      populateGraph(graph!, data);
      renderer!.refresh();
    },
    jump(data) {
      // Purpose: draw the first snapshot and frame it without animating
      ensureRenderer();
      renderer!.getCamera().cancelAnimation();
      renderer!.getCamera().setState(targetCamera(data));
      populateGraph(graph!, data);
      renderer!.refresh();
    },
    frame(data) {
      // Purpose: ease the camera out to a view before its nodes are shown
      ensureRenderer();
      return animateTo(renderer!.getCamera(), targetCamera(data));
    },
    focus(asn) {
      // Purpose: ease the camera onto a clicked AS before its neighbourhood is shown
      ensureRenderer();
      const target = focusTarget(graph!, asn);
      return target ? animateTo(renderer!.getCamera(), target) : Promise.resolve();
    },
    camera() {
      // Purpose: the current camera state, for checking that a browser interaction really moved it
      return renderer
        ? (({ x, y, ratio }) => ({ x, y, ratio }))(renderer.getCamera().getState())
        : { x: 0.5, y: 0.5, ratio: 1 };
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
