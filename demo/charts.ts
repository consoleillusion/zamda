// Small SVG charts for the dashboard. No chart library: each chart is a
// function that redraws an <svg> from rows, plus the event handling its
// control needs (brushing a range, toggling a category).

const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
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

function clear(svg: SVGSVGElement): void {
  // Purpose: remove everything drawn in a chart
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

export function formatCount(n: number): string {
  // Purpose: a compact count: 1,234 / 12.3k / 1.17M
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Top networks: horizontal bars
// ---------------------------------------------------------------------------

export interface NetworkBar {
  readonly origin: number;
  readonly name: string | null;
  readonly routes: number;
}

export function drawTopNetworks(svg: SVGSVGElement, rows: readonly NetworkBar[]): void {
  // Purpose: one bar per network, longest first, labelled with AS number and name
  clear(svg);
  const width = svg.clientWidth || 560;
  const rowHeight = 22;
  const labelWidth = Math.min(300, width * 0.52);
  const height = Math.max(rows.length, 1) * rowHeight + 8;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', String(height));
  if (rows.length === 0) {
    el('text', { x: 8, y: 20, class: 'empty' }, svg, 'No routes match');
    return;
  }
  const max = rows[0]!.routes;
  const barSpace = width - labelWidth - 64;
  rows.forEach(function (row, i) {
    const y = i * rowHeight + 4;
    const label = `AS${row.origin}  ${row.name ?? '(no name)'}`;
    const text = el('text', { x: labelWidth - 8, y: y + 15, 'text-anchor': 'end', class: 'label' }, svg);
    text.textContent = label.length > 44 ? `${label.slice(0, 43)}…` : label;
    el('title', {}, text, label);
    const w = Math.max(1, (row.routes / max) * barSpace);
    el('rect', { x: labelWidth, y: y + 3, width: w, height: rowHeight - 7, rx: 2, class: 'bar' }, svg);
    el('text', { x: labelWidth + w + 6, y: y + 15, class: 'value' }, svg, formatCount(row.routes));
  });
}

// ---------------------------------------------------------------------------
// Histogram with a brushable range
// ---------------------------------------------------------------------------

export interface HistogramOptions {
  // The bins to draw, in order; every bin is drawn even when its count is 0.
  readonly bins: readonly number[];
  // Label for a bin on the axis; return '' to leave it unlabelled.
  readonly binLabel: (bin: number) => string;
  // Called with the selected [first, last] bins, or null when cleared.
  readonly onSelect: (range: readonly [number, number] | null) => void;
}

export interface Histogram {
  draw(counts: ReadonlyMap<number, number>, selected: readonly [number, number] | null): void;
}

export function createHistogram(svg: SVGSVGElement, options: HistogramOptions): Histogram {
  // Purpose: a column chart over fixed bins; drag across columns to select a range, click one to select it alone
  const height = 170;
  const axis = 22;
  const top = 16;
  let dragFrom: number | null = null;
  let lastCounts: ReadonlyMap<number, number> = new Map();
  let lastSelected: readonly [number, number] | null = null;

  const geometry = function () {
    // Purpose: current width and column positions
    const width = svg.clientWidth || 520;
    const step = width / options.bins.length;
    return { width, step };
  };

  const binAt = function (event: PointerEvent): number {
    // Purpose: the bin under the pointer, clamped to the chart
    const rect = svg.getBoundingClientRect();
    const { step } = geometry();
    const index = Math.min(options.bins.length - 1, Math.max(0, Math.floor((event.clientX - rect.left) / step)));
    return options.bins[index]!;
  };

  const rangeOf = function (a: number, b: number): readonly [number, number] {
    // Purpose: an ordered [low, high] pair
    return a <= b ? [a, b] : [b, a];
  };

  svg.addEventListener('pointerdown', function onDown(event) {
    // Purpose: start a brush at the bin under the pointer
    dragFrom = binAt(event);
    svg.setPointerCapture(event.pointerId);
    options.onSelect(rangeOf(dragFrom, dragFrom));
  });
  svg.addEventListener('pointermove', function onMove(event) {
    // Purpose: extend the brush; every move re-runs the linked charts
    if (dragFrom === null) return;
    const range = rangeOf(dragFrom, binAt(event));
    if (!lastSelected || range[0] !== lastSelected[0] || range[1] !== lastSelected[1]) options.onSelect(range);
  });
  svg.addEventListener('pointerup', function onUp() {
    // Purpose: finish the brush
    dragFrom = null;
  });
  svg.addEventListener('dblclick', function onDouble() {
    // Purpose: double-click clears the selection
    options.onSelect(null);
  });

  return {
    draw(counts, selected) {
      // Purpose: redraw the columns, dimming those outside the selected range
      lastCounts = counts;
      lastSelected = selected;
      clear(svg);
      const { width, step } = geometry();
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('height', String(height));
      let max = 1;
      for (const bin of options.bins) max = Math.max(max, lastCounts.get(bin) ?? 0);
      // A square-root scale keeps the small bins visible next to /24's three-quarters of a million.
      const scale = (height - axis - top) / Math.sqrt(max);
      options.bins.forEach(function (bin, i) {
        const n = lastCounts.get(bin) ?? 0;
        const h = Math.sqrt(n) * scale;
        const inside = !selected || (bin >= selected[0] && bin <= selected[1]);
        const x = i * step;
        const rect = el(
          'rect',
          { x: x + 1, y: height - axis - h, width: Math.max(1, step - 2), height: h, rx: 1, class: inside ? 'bar' : 'bar dim' },
          svg,
        );
        el('title', {}, rect, `${options.binLabel(bin) || bin}: ${n.toLocaleString()} routes`);
        const label = options.binLabel(bin);
        if (label) el('text', { x: x + step / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis' }, svg, label);
      });
      if (selected) {
        const first = options.bins.indexOf(selected[0]);
        const last = options.bins.indexOf(selected[1]);
        if (first !== -1 && last !== -1) {
          el(
            'rect',
            { x: first * step, y: top - 6, width: (last - first + 1) * step, height: height - axis - top + 6, class: 'brush' },
            svg,
          );
        }
      }
      el('text', { x: width - 4, y: 11, 'text-anchor': 'end', class: 'axis' }, svg, `max ${formatCount(max)} (√ scale)`);
    },
  };
}

// ---------------------------------------------------------------------------
// Regions: clickable bars
// ---------------------------------------------------------------------------

export interface RegionRow {
  readonly rir: string | null;
  readonly routes: number;
  readonly networks: number;
}

export function drawRegions(
  svg: SVGSVGElement,
  rows: readonly RegionRow[],
  selected: readonly string[] | null,
  onToggle: (rir: string) => void,
): void {
  // Purpose: one bar per region with its route and network counts; click a region to add or remove it
  clear(svg);
  const width = svg.clientWidth || 520;
  const rowHeight = 30;
  const height = Math.max(rows.length, 1) * rowHeight + 6;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', String(height));
  const max = Math.max(1, ...rows.map(r => r.routes));
  const labelWidth = 92;
  const barSpace = width - labelWidth - 170;
  rows.forEach(function (row, i) {
    const y = i * rowHeight + 4;
    const name = row.rir ?? 'unknown';
    const chosen = row.rir !== null && (selected === null || selected.includes(row.rir));
    const group = el('g', { class: row.rir === null ? 'region fixed' : 'region' }, svg);
    el('rect', { x: 0, y, width, height: rowHeight - 2, class: 'hit' }, group);
    el('text', { x: 4, y: y + 18, class: 'label' }, group, name);
    const w = Math.max(1, (row.routes / max) * barSpace);
    el('rect', { x: labelWidth, y: y + 6, width: w, height: rowHeight - 14, rx: 2, class: chosen || selected === null ? 'bar' : 'bar dim' }, group);
    el(
      'text',
      { x: labelWidth + w + 6, y: y + 18, class: 'value' },
      group,
      `${formatCount(row.routes)} routes · ${formatCount(row.networks)} networks`,
    );
    if (row.rir !== null) {
      const rir = row.rir;
      group.addEventListener('click', function onClick() {
        // Purpose: toggle this region in the selection
        onToggle(rir);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Live activity: stacked columns over time
// ---------------------------------------------------------------------------

export interface ActivityBucket {
  readonly bucket: number;
  readonly announce: number;
  readonly withdraw: number;
}

export function drawActivity(svg: SVGSVGElement, buckets: readonly ActivityBucket[], from: number, to: number, step: number): void {
  // Purpose: announcements and withdrawals per time bucket, newest on the right
  clear(svg);
  const width = svg.clientWidth || 520;
  const height = 130;
  const axis = 18;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', String(height));
  const count = Math.max(1, Math.round((to - from) / step));
  const columnWidth = width / count;
  let max = 1;
  for (const b of buckets) max = Math.max(max, b.announce + b.withdraw);
  const scale = (height - axis - 8) / max;
  for (const b of buckets) {
    const i = Math.floor((b.bucket - from) / step);
    if (i < 0 || i >= count) continue;
    const x = i * columnWidth;
    const hw = b.withdraw * scale;
    const ha = b.announce * scale;
    el('rect', { x: x + 0.5, y: height - axis - hw, width: Math.max(1, columnWidth - 1), height: hw, class: 'withdraw' }, svg);
    el('rect', { x: x + 0.5, y: height - axis - hw - ha, width: Math.max(1, columnWidth - 1), height: ha, class: 'announce' }, svg);
  }
  el('text', { x: 2, y: height - 4, class: 'axis' }, svg, `${Math.round((to - from) / 60)} min ago`);
  el('text', { x: width - 2, y: height - 4, 'text-anchor': 'end', class: 'axis' }, svg, 'now');
  el('text', { x: 2, y: 11, class: 'axis' }, svg, `max ${formatCount(max)} per ${step} s`);
}
