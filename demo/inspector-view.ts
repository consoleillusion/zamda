// T-512: the DOM half of the route inspector. Only the small visible window of
// routes is drawn; the geometry and copy come from inspector.ts.

import { formatCount } from './charts';
import {
  conceptFor,
  riverLayout,
  windowRows,
} from './inspector';
import type {
  ConceptKey,
  FlowRow,
  RiverLayout,
  RouteRow,
} from './inspector';

const SVG = 'http://www.w3.org/2000/svg';
const ROW_HEIGHT = 26;

export interface InspectorCallbacks {
  readonly onPrefix: (row: RouteRow) => void;
  readonly onOrigin: (origin: number, name: string | null) => void;
}

export interface InspectorProbe {
  routeRows: number;
  renderedRows: number;
  firstPrefix: string | null;
  riverRibbons: number;
  riverNodes: number;
  conceptTitle: string;
  clickRoute(index: number): void;
  clickOrigin(origin: number): void;
}

export interface Inspector {
  table(rows: readonly RouteRow[]): void;
  river(rows: readonly FlowRow[]): void;
  concept(key: ConceptKey, detail?: string | number): void;
  probe(): InspectorProbe;
}

declare global {
  interface Window {
    __zamdaInspector?: InspectorProbe;
  }
}

function byId<T extends Element>(id: string): T {
  // Purpose: an inspector element that the page is known to contain
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as unknown as T;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent: Element,
  text?: string,
): SVGElementTagNameMap[K] {
  // Purpose: create an SVG element with attributes, append it, and return it
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function shortName(name: string | null): string {
  // Purpose: keep a network label inside one table cell
  if (!name) return 'unnamed network';
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

export function createInspector(callbacks: InspectorCallbacks): Inspector {
  // Purpose: build the table, river and concept card once, then redraw them from plan results
  const scroller = byId<HTMLDivElement>('route-table');
  const spacerTop = document.createElement('div');
  const spacerBottom = document.createElement('div');
  const rowHost = document.createElement('div');
  scroller.append(spacerTop, rowHost, spacerBottom);
  const riverSvg = svgEl('svg', { class: 'river-svg', viewBox: '0 0 480 180', preserveAspectRatio: 'none' }, byId('path-river'));
  const conceptTitle = byId<HTMLElement>('concept-title');
  const conceptBody = byId<HTMLElement>('concept-body');
  let routeData: readonly RouteRow[] = [];
  let flowData: readonly FlowRow[] = [];
  let layout: RiverLayout = { origins: [], paths: [], ribbons: [], maxRoutes: 0, droppedOrigins: 0 };

  const drawRows = function (): void {
    // Purpose: replace only the rows near the scroll position, keeping the list virtualized
    const window = windowRows(routeData, scroller.scrollTop, scroller.clientHeight || 260, ROW_HEIGHT);
    spacerTop.style.height = `${window.padTop}px`;
    spacerBottom.style.height = `${window.padBottom}px`;
    rowHost.replaceChildren(...window.visible.map(function (row): HTMLElement {
      // Purpose: one clickable route line
      const line = document.createElement('div');
      line.className = 'route-row';
      line.tabIndex = 0;
      line.setAttribute('role', 'button');
      line.title = `${row.prefix} · AS${row.origin} ${row.name ?? ''} · ${row.pathLen} hops`;
      const cells = [row.prefix, `AS${row.origin}`, shortName(row.name), row.rir ?? '—', String(row.pathLen)];
      for (const value of cells) {
        // Purpose: one cell in the route line
        const cell = document.createElement('span');
        cell.textContent = value;
        line.appendChild(cell);
      }
      line.addEventListener('click', function onClick(): void {
        // Purpose: focus the clicked prefix and explain what it means
        callbacks.onPrefix(row);
      });
      line.addEventListener('keydown', function onKey(event: KeyboardEvent): void {
        // Purpose: make the row keyboard-operable
        if (event.key === 'Enter' || event.key === ' ') callbacks.onPrefix(row);
      });
      return line;
    }));
  };

  const drawRiver = function (): void {
    // Purpose: redraw the ribbons and nodes from the last bounded layout
    while (riverSvg.firstChild) riverSvg.removeChild(riverSvg.firstChild);
    const width = riverSvg.clientWidth || 480;
    layout = riverLayout(flowData, width, 180);
    riverSvg.setAttribute('viewBox', `0 0 ${width} 180`);
    const defs = svgEl('defs', {}, riverSvg);
    const gradient = svgEl('linearGradient', { id: 'river-gradient', x1: '0', y1: '0', x2: '1', y2: '0' }, defs);
    svgEl('stop', { offset: '0', 'stop-color': '#5da7ff' }, gradient);
    svgEl('stop', { offset: '1', 'stop-color': '#4de0c6' }, gradient);
    if (layout.ribbons.length === 0) {
      svgEl('text', { x: 12, y: 26, class: 'axis' }, riverSvg, 'No paths match these filters');
      return;
    }
    for (const ribbon of layout.ribbons) {
      // Purpose: one wide, translucent flow and a thin animated trace of the same curve
      svgEl('path', { d: ribbon.d, class: 'river-band', 'stroke-width': ribbon.width }, riverSvg);
      svgEl('path', { d: ribbon.d, class: 'river-pulse' }, riverSvg);
    }
    for (const node of [...layout.origins, ...layout.paths]) {
      // Purpose: one origin or hop-count node, clickable when it names an AS
      const group = svgEl('g', { class: node.id.startsWith('AS') ? 'river-node origin' : 'river-node' }, riverSvg);
      svgEl('rect', { x: node.x - 5, y: node.y, width: 10, height: Math.max(4, node.height), rx: 3 }, group);
      const label = node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label;
      const anchor = node.x < width / 2 ? 'start' : 'end';
      svgEl('text', { x: node.x + (anchor === 'start' ? 10 : -10), y: node.y - 3, 'text-anchor': anchor, class: 'river-label' }, group, `${label} · ${formatCount(node.total)}`);
      const origin = node.id.startsWith('AS') ? Number(node.id.slice(2)) : null;
      if (origin !== null) {
        const name = flowData.find(row => row.origin === origin)?.name ?? null;
        group.addEventListener('click', function onClick(): void {
          // Purpose: trace the clicked origin on the frozen map
          callbacks.onOrigin(origin, name);
        });
      }
    }
  };

  scroller.addEventListener('scroll', function onScroll(): void {
    // Purpose: draw the next window as the user scrolls
    drawRows();
  });

  const probe: InspectorProbe = {
    routeRows: 0,
    renderedRows: 0,
    firstPrefix: null,
    riverRibbons: 0,
    riverNodes: 0,
    conceptTitle: '',
    clickRoute(index) {
      // Purpose: let a browser harness exercise a row without synthetic pointer geometry
      const row = routeData[index];
      if (row) callbacks.onPrefix(row);
    },
    clickOrigin(origin) {
      // Purpose: let a browser harness trace an origin without SVG geometry
      const name = flowData.find(row => row.origin === origin)?.name ?? null;
      callbacks.onOrigin(origin, name);
    },
  };
  window.__zamdaInspector = probe;

  return {
    table(rows) {
      // Purpose: show a new bounded route result from the top
      routeData = rows;
      scroller.scrollTop = 0;
      drawRows();
      probe.routeRows = rows.length;
      probe.renderedRows = rowHost.childElementCount;
      probe.firstPrefix = rows[0]?.prefix ?? null;
    },
    river(rows) {
      // Purpose: show a new bounded origin-to-hop-count result
      flowData = rows;
      drawRiver();
      probe.riverRibbons = layout.ribbons.length;
      probe.riverNodes = layout.origins.length + layout.paths.length;
    },
    concept(key, detail) {
      // Purpose: replace the teaching card after a gesture
      const card = conceptFor(key, detail);
      conceptTitle.textContent = card.title;
      conceptBody.textContent = card.body;
      probe.conceptTitle = card.title;
    },
    probe() {
      // Purpose: publish the last drawn state for the browser harness
      return probe;
    },
  };
}
