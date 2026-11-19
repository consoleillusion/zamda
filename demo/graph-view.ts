// The graph panel's WebGL renderer. Graphology holds the simplified graph;
// sigma.js draws it. Positions come from graph.bin, so there is no layout pass
// in the browser and live updates never move a node.

import Graph from 'graphology';
import Sigma from 'sigma';
import type { GraphEdgeView, GraphViewData } from './graph-data';

export interface GraphView {
  show(data: GraphViewData): void;
  setLive(hot: ReadonlyMap<string, number>): void;
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
const EDGE_COLOR = '#aab4c4';
const LIVE_EDGE_COLOR = '#e83e3e';

function nodeColor(rir: string | null): string {
  // Purpose: one stable colour per regional registry
  return rir === null ? FALLBACK_COLOR : (RIR_COLORS[rir] ?? FALLBACK_COLOR);
}

function edgeWidth(weight: number): number {
  // Purpose: a log scale keeps a few very heavy edges from hiding the rest
  return 0.5 + Math.min(4, Math.log2(weight + 1) / 2);
}

function buildGraph(data: GraphViewData): Graph {
  // Purpose: a directed graphology graph with the renderer's attributes on each node and edge
  const graph = new Graph({ type: 'directed', multi: false });
  let maxPaths = 1;
  for (const node of data.nodes) maxPaths = Math.max(maxPaths, node.paths);
  const labelled = new Set(
    [...data.nodes]
      .sort((a, b) => b.paths - a.paths || a.asn - b.asn)
      .slice(0, 12)
      .map(node => node.asn),
  );
  for (const node of data.nodes) {
    graph.addNode(String(node.asn), {
      x: node.x,
      y: node.y,
      size: 3 + 9 * Math.sqrt(node.paths / maxPaths),
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
      size: edgeWidth(edge.weight),
      color: EDGE_COLOR,
      weight: edge.weight,
      key: edge.key,
    });
  }
  return graph;
}

export function createGraphView(container: HTMLElement, onSelect: (asn: number) => void): GraphView {
  // Purpose: own one sigma renderer over the graph panel, replacing its graph when the view changes
  let renderer: Sigma | null = null;
  let graph: Graph | null = null;

  const destroy = function (): void {
    // Purpose: release WebGL resources before a new graph is shown
    renderer?.kill();
    renderer = null;
    graph = null;
  };

  return {
    show(data) {
      // Purpose: draw one snapshot of nodes and edges on fixed positions
      destroy();
      container.replaceChildren();
      graph = buildGraph(data);
      renderer = new Sigma(graph, container, {
        settings: {
          renderEdgeLabels: false,
          labelRenderedSizeThreshold: 9,
          labelDensity: 0.02,
          labelGridCellSize: 90,
          minCameraRatio: 0.2,
          maxCameraRatio: 12,
          stagePadding: 24,
        },
      });
      renderer.on('clickNode', function (event) {
        // Purpose: drill into the network the user clicked
        onSelect(Number(event.node));
      });
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
      graph.forEachEdge(function (_, attributes) {
        // Purpose: restore an edge's colour, or mark it hot
        const color = hot.has(String(attributes.key)) ? LIVE_EDGE_COLOR : EDGE_COLOR;
        if (attributes.color !== color) {
          graph!.setEdgeAttribute(String(attributes.source), String(attributes.target), 'color', color);
          changed = true;
        }
      });
      if (changed) renderer.refresh();
    },
    destroy,
  };
}

export function edgeKey(from: number, to: number): string {
  // Purpose: the key the live overlay uses for one directed edge
  return `${from}:${to}`;
}

export type { GraphEdgeView };
