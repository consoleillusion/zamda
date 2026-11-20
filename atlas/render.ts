// A from-scratch Canvas renderer for the single BGP topology view. It owns its
// camera, hit testing, pan/zoom, and tooltip. Every mark comes from a compiled
// scene value; the lane layout makes direction and grouping legible at a glance.

import type { AsNode, Flow, Hub, Point, Scene } from './layout';
import { distanceTo, pointOn, sceneBounds } from './layout';

export interface Pick {
  readonly kind: 'empty' | 'hub' | 'node' | 'flow';
  readonly hub?: Hub;
  readonly node?: AsNode;
  readonly flow?: Flow;
}

export interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly ratio: number;
}

export interface Renderer {
  setScene(scene: Scene, fit?: boolean): void;
  setSelection(asn: number | null): void;
  focusHub(key: string): void;
  fit(): void;
  camera(): CameraState;
  nodeScreen(asn: number): Point | null;
  describe(pick: Pick): string;
  destroy(): void;
}

const MIN_RATIO = 0.18;
const MAX_RATIO = 1.4;
const EMPTY_PICK: Pick = { kind: 'empty' };

function clamp(value: number, low: number, high: number): number {
  // Purpose: keep the camera inside its supported zoom and pan range
  return Math.max(low, Math.min(high, value));
}

function shortName(label: string): string {
  // Purpose: keep node labels readable beside a dense lane of dots
  const clean = label.split(/[·,]/)[0]!.trim();
  return clean.length > 17 ? `${clean.slice(0, 16)}…` : clean;
}

export function createRenderer(canvas: HTMLCanvasElement, onPick: (pick: Pick) => void): Renderer {
  // Purpose: build one long-lived renderer over the topology canvas
  const maybeContext = canvas.getContext('2d');
  if (!maybeContext) throw new Error('This browser cannot create a 2D canvas context');
  const context: CanvasRenderingContext2D = maybeContext;
  const host = canvas.parentElement ?? document.body;
  const tooltip = document.createElement('div');
  tooltip.setAttribute('role', 'tooltip');
  tooltip.style.cssText =
    'position:absolute;z-index:5;max-width:300px;padding:8px 10px;border:1px solid #31506d;' +
    'border-radius:8px;background:rgba(7,13,22,.97);color:#dce8f6;font:11px/1.5 system-ui,sans-serif;' +
    'white-space:pre-line;pointer-events:none;box-shadow:0 12px 30px #0009';
  tooltip.hidden = true;
  host.appendChild(tooltip);

  let scene: Scene | null = null;
  let selection: number | null = null;
  let hover: Pick = EMPTY_PICK;
  let camera: CameraState = { x: 0.5, y: 0.5, ratio: 0.5 };
  let width = 1;
  let height = 1;
  let animation = 0;
  let lastPaint = 0;
  let dragStart: { x: number; y: number; camera: CameraState } | null = null;
  let moved = false;

  function resize(): void {
    // Purpose: match the backing store to the CSS size at the current device scale
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    const nextWidth = Math.round(width * dpr);
    const nextHeight = Math.round(height * dpr);
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function scale(): number {
    // Purpose: screen pixels per graph unit at the current zoom
    return Math.min(width, height) / (2 * camera.ratio);
  }

  function toScreen(point: Point): Point {
    // Purpose: graph coordinates to canvas pixels
    const amount = scale();
    return {
      x: width / 2 + (point.x - (camera.x * 2 - 1)) * amount,
      y: height / 2 - (point.y - (camera.y * 2 - 1)) * amount,
    };
  }

  function toGraph(x: number, y: number): Point {
    // Purpose: canvas pixels to graph coordinates
    const amount = scale();
    return {
      x: x / amount - width / (2 * amount) + camera.x * 2 - 1,
      y: -(y / amount - height / (2 * amount)) + camera.y * 2 - 1,
    };
  }

  function nodeRadius(node: AsNode): number {
    // Purpose: an AS dot grows with incident route weight but stays clickable
    return Math.max(2.6, node.radius * scale());
  }

  function fitCamera(): void {
    // Purpose: frame all lanes, hops, and bundles without changing their geometry
    if (!scene) return;
    const bounds = sceneBounds(scene);
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const centreX = (bounds.minX + bounds.maxX) / 2;
    const centreY = (bounds.minY + bounds.maxY) / 2;
    camera = {
      x: clamp((centreX + 1) / 2, 0.05, 0.95),
      y: clamp((centreY + 1) / 2, 0.05, 0.95),
      ratio: clamp(Math.max(spanX, spanY, 0.25) * 0.56, MIN_RATIO, MAX_RATIO),
    };
  }

  function drawBackground(): void {
    // Purpose: a quiet field so the data marks carry the picture
    const gradient = context.createRadialGradient(width / 2, height * 0.35, 10, width / 2, height * 0.5, Math.max(width, height) * 0.8);
    gradient.addColorStop(0, '#0c1928');
    gradient.addColorStop(1, '#050a12');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  function strokeCurve(
    shape: { p0: Point; p1: Point; p2: Point },
    fromColor: string,
    toColor: string,
    px: number,
    alpha: number,
  ): void {
    // Purpose: paint one quadratic route with a source-to-target colour ramp
    const a = toScreen(shape.p0);
    const b = toScreen(shape.p1);
    const c = toScreen(shape.p2);
    const gradient = context.createLinearGradient(a.x, a.y, c.x, c.y);
    gradient.addColorStop(0, fromColor);
    gradient.addColorStop(1, toColor);
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = gradient;
    context.lineWidth = px;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.quadraticCurveTo(b.x, b.y, c.x, c.y);
    context.stroke();
    context.restore();
  }

  function drawArrow(shape: { p0: Point; p1: Point; p2: Point }, color: string, size: number, t: number): void {
    // Purpose: make the AS_PATH direction unambiguous at the target end
    const tip = toScreen(pointOn(shape, t));
    const before = toScreen(pointOn(shape, Math.max(0, t - 0.05)));
    const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
    context.save();
    context.fillStyle = color;
    context.globalAlpha = 0.95;
    context.beginPath();
    context.moveTo(tip.x, tip.y);
    context.lineTo(tip.x - Math.cos(angle - 0.55) * size, tip.y - Math.sin(angle - 0.55) * size);
    context.lineTo(tip.x - Math.cos(angle + 0.55) * size, tip.y - Math.sin(angle + 0.55) * size);
    context.closePath();
    context.fill();
    context.restore();
  }

  function drawLanes(): void {
    // Purpose: draw the regional columns that give the topology its reading order
    if (!scene) return;
    for (const hub of scene.hubs) {
      const top = toScreen({ x: hub.x, y: 0.66 });
      const bottom = toScreen({ x: hub.x, y: -0.6 });
      const half = Math.max(28, Math.min(82, scale() * 0.075));
      context.save();
      context.globalAlpha = 0.045;
      context.fillStyle = hub.color;
      context.fillRect(top.x - half, top.y, half * 2, bottom.y - top.y);
      context.globalAlpha = 0.18;
      context.strokeStyle = hub.color;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(top.x, top.y);
      context.lineTo(bottom.x, bottom.y);
      context.stroke();
      context.restore();
    }
  }

  function drawHeaders(): void {
    // Purpose: label each RIR lane with the whole-file counts it represents
    if (!scene) return;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const hub of scene.hubs) {
      const point = toScreen({ x: hub.x, y: 0.84 });
      const active = hover.kind === 'hub' && hover.hub?.key === hub.key;
      context.fillStyle = active ? hub.color : '#dce8f6';
      context.font = '600 12px system-ui, sans-serif';
      context.fillText(hub.label, point.x, point.y - 10);
      context.fillStyle = hub.color;
      context.font = '10px system-ui, sans-serif';
      context.fillText(`${hub.code} · ${hub.ases.toLocaleString()} ASes`, point.x, point.y + 7);
      context.fillStyle = '#8198b1';
      context.fillText(`${hub.shown} shown here`, point.x, point.y + 20);
    }
  }

  function drawBeams(): void {
    // Purpose: show every hidden pair as one labelled regional bundle, not as fake cables
    if (!scene) return;
    for (const beam of scene.beams) {
      const from = scene.hubs.find(hub => hub.key === beam.fromHub);
      const to = scene.hubs.find(hub => hub.key === beam.toHub);
      if (!from || !to) continue;
      const share = beam.weight / scene.maxBeamWeight;
      strokeCurve(beam, from.color, to.color, beam.width, 0.04 + share * 0.1);
      drawArrow(beam, to.color, 3.5 + share * 3, 0.94);
    }
  }

  function drawFlows(): void {
    // Purpose: draw the strongest directed AS hops, with heavy hops on top
    if (!scene) return;
    const ordered = [...scene.flows].sort((a, b) => a.weight - b.weight);
    for (const flow of ordered) {
      const target = scene.hubs.find(hub => hub.key === flow.toHub);
      const color = target?.color ?? '#94a8c0';
      const share = flow.weight / scene.maxWeight;
      const hot = hover.kind === 'flow' && hover.flow?.key === flow.key;
      const selected = selection === flow.from || selection === flow.to;
      strokeCurve(flow, flow.color, color, Math.max(0.9, flow.width), (hot ? 0.95 : 0.26 + share * 0.45) * (selected ? 1 : 0.82));
      drawArrow(flow, color, 4 + Math.min(5, flow.width * 0.65), 0.9);
    }
  }

  function drawMarkers(now: number): void {
    // Purpose: moving dots make hop direction visible without claiming a live feed
    if (!scene || scene.flows.length === 0) return;
    const count = Math.min(14, scene.flows.length);
    for (let i = 0; i < count; i++) {
      const flow = scene.flows[i]!;
      const t = (now / 2600 + i * 0.173) % 1;
      const point = toScreen(pointOn(flow, t));
      const target = scene.hubs.find(hub => hub.key === flow.toHub);
      context.save();
      context.fillStyle = target?.color ?? '#ffffff';
      context.globalAlpha = 0.5 + 0.4 * Math.sin(t * Math.PI);
      context.beginPath();
      context.arc(point.x, point.y, 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  function drawNodes(): void {
    // Purpose: draw one dot per visible AS and name only the heaviest few
    if (!scene) return;
    for (const node of scene.nodes) {
      const point = toScreen(node);
      const radius = nodeRadius(node);
      const hub = scene.hubs.find(item => item.key === node.hub);
      const chosen = selection === node.asn;
      const active = hover.kind === 'node' && hover.node?.asn === node.asn;
      context.save();
      context.fillStyle = hub?.color ?? '#94a8c0';
      context.globalAlpha = chosen || active ? 1 : 0.82;
      context.beginPath();
      context.arc(point.x, point.y, radius + (chosen || active ? 3 : 0), 0, Math.PI * 2);
      context.fill();
      if (chosen) {
        context.strokeStyle = '#ffffff';
        context.lineWidth = 1.4;
        context.beginPath();
        context.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
    }
    context.textBaseline = 'middle';
    for (const node of scene.nodes) {
      if (node.rank >= 8 && selection !== node.asn) continue;
      const point = toScreen(node);
      const radius = nodeRadius(node);
      const right = point.x < width - 120;
      context.fillStyle = selection === node.asn ? '#ffffff' : '#c5d7ea';
      context.font = selection === node.asn ? '600 11px system-ui, sans-serif' : '11px system-ui, sans-serif';
      context.textAlign = right ? 'left' : 'right';
      context.fillText(`AS${node.asn} ${shortName(node.label)}`, point.x + (right ? radius + 4 : -radius - 4), point.y - 8);
    }
  }

  function drawLegend(): void {
    // Purpose: state what the marks mean inside the one visualization
    if (!scene) return;
    const lines = [
      'READ THIS GRAPH',
      'Dot = AS · arrow = consecutive AS_PATH hop',
      'Line width = prefix appearances',
      `Bottom bands = ${scene.tailCount.toLocaleString()} other pairs, grouped by region`,
    ];
    const boxWidth = 372;
    const x = Math.max(12, width - boxWidth - 18);
    context.fillStyle = 'rgba(5, 11, 19, 0.82)';
    context.fillRect(x, 12, boxWidth, 72);
    context.textAlign = 'left';
    context.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      context.fillStyle = i === 0 ? '#8fd6ff' : i === 3 ? '#9fb5cc' : '#c7d8ea';
      context.font = i === 0 ? '600 10px system-ui, sans-serif' : '10px system-ui, sans-serif';
      context.fillText(lines[i]!, x + 10, 21 + i * 15);
    }
  }

  function paint(now: number): void {
    // Purpose: draw one frame of the topology at the current camera and time
    resize();
    drawBackground();
    drawLanes();
    drawBeams();
    drawFlows();
    drawMarkers(now);
    drawHeaders();
    drawNodes();
    drawLegend();
  }

  function tick(now: number): void {
    // Purpose: cap the animation to about 30 fps while keeping direction markers moving
    if (now - lastPaint >= 32) {
      paint(now);
      lastPaint = now;
    }
    animation = requestAnimationFrame(tick);
  }

  function hubAt(x: number, y: number): Hub | undefined {
    // Purpose: pick a region header rather than its whole lane, so lanes stay clickable through
    if (!scene) return undefined;
    const half = Math.max(28, Math.min(82, scale() * 0.075));
    for (const hub of scene.hubs) {
      const centre = toScreen({ x: hub.x, y: 0.84 });
      if (Math.abs(x - centre.x) <= half && Math.abs(y - centre.y) <= 22) return hub;
    }
    return undefined;
  }

  function hitTest(x: number, y: number): Pick {
    // Purpose: pick the nearest meaningful mark under a pointer
    if (!scene) return EMPTY_PICK;
    for (let i = scene.nodes.length - 1; i >= 0; i--) {
      const node = scene.nodes[i]!;
      const screenPoint = toScreen(node);
      if (Math.hypot(screenPoint.x - x, screenPoint.y - y) <= nodeRadius(node) + 5) {
        return { kind: 'node', node };
      }
    }
    const point = toGraph(x, y);
    const tolerance = 0.011 / camera.ratio;
    for (let i = scene.flows.length - 1; i >= 0; i--) {
      const flow = scene.flows[i]!;
      if (distanceTo(flow, point) <= tolerance) return { kind: 'flow', flow };
    }
    const hub = hubAt(x, y);
    return hub ? { kind: 'hub', hub } : EMPTY_PICK;
  }

  function showTooltip(pick: Pick, x: number, y: number): void {
    // Purpose: explain the exact mark under the pointer in plain BGP language
    if (pick.kind === 'empty') {
      tooltip.hidden = true;
      return;
    }
    tooltip.textContent = describe(pick);
    tooltip.hidden = false;
    const bounds = canvas.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(bounds.width - 310, x + 14))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(bounds.height - 90, y - 46))}px`;
  }

  const onPointerDown = function (event: PointerEvent): void {
    // Purpose: begin a camera drag unless the pointer starts a selection
    canvas.setPointerCapture(event.pointerId);
    dragStart = { x: event.clientX, y: event.clientY, camera };
    moved = false;
  };
  const onPointerMove = function (event: PointerEvent): void {
    // Purpose: pan on drag, otherwise update the hover explanation
    if (dragStart) {
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      if (moved) {
        const amount = scale();
        camera = {
          x: clamp(dragStart.camera.x - dx / amount / 2, 0.02, 0.98),
          y: clamp(dragStart.camera.y + dy / amount / 2, 0.02, 0.98),
          ratio: dragStart.camera.ratio,
        };
        tooltip.hidden = true;
      }
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    hover = hitTest(event.clientX - bounds.left, event.clientY - bounds.top);
    showTooltip(hover, event.clientX - bounds.left, event.clientY - bounds.top);
  };
  const onPointerUp = function (event: PointerEvent): void {
    // Purpose: turn a non-drag pointer release into a selection
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const drag = dragStart;
    dragStart = null;
    if (!drag || moved) return;
    const bounds = canvas.getBoundingClientRect();
    onPick(hitTest(event.clientX - bounds.left, event.clientY - bounds.top));
  };
  const onPointerLeave = function (): void {
    // Purpose: clear the hover mark when the pointer leaves the canvas
    if (!dragStart) {
      hover = EMPTY_PICK;
      tooltip.hidden = true;
    }
  };
  const onWheel = function (event: WheelEvent): void {
    // Purpose: zoom around the pointer, keeping the graph point under it fixed
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const before = toGraph(x, y);
    const factor = event.deltaY < 0 ? 1.22 : 1 / 1.22;
    const ratio = clamp(camera.ratio / factor, MIN_RATIO, MAX_RATIO);
    const amount = Math.min(width, height) / (2 * ratio);
    camera = {
      x: clamp((before.x - (x - width / 2) / amount + 1) / 2, 0.02, 0.98),
      y: clamp((before.y + (y - height / 2) / amount + 1) / 2, 0.02, 0.98),
      ratio,
    };
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  animation = requestAnimationFrame(tick);

  function describe(pick: Pick): string {
    // Purpose: one short, honest explanation of a region, AS, or observed hop
    if (pick.kind === 'hub' && pick.hub) {
      const hub = pick.hub;
      return `${hub.label} · ${hub.code}\n${hub.ases.toLocaleString()} ASes in the source · ${hub.routes.toLocaleString()} route observations\n${hub.shown} ASes drawn in this lane. Click to zoom into the group.`;
    }
    if (pick.kind === 'node' && pick.node) {
      const node = pick.node;
      return `${node.label} · AS${node.asn}\n${node.weight.toLocaleString()} prefix appearances on drawn hops · ${node.origins.toLocaleString()} originated prefixes\nClick to see its strongest observed neighbours.`;
    }
    if (pick.kind === 'flow' && pick.flow) {
      const flow = pick.flow;
      return `AS${flow.from} → AS${flow.to}\n${flow.weight.toLocaleString()} prefix appearances on this consecutive BGP hop\nMapped points ~${flow.spanKm.toLocaleString()} km apart; this is adjacency, not a cable.`;
    }
    return '';
  }

  return {
    setScene(next, fit = false) {
      // Purpose: replace the drawable data while keeping pan and zoom unless asked to fit
      scene = next;
      selection = null;
      hover = EMPTY_PICK;
      tooltip.hidden = true;
      if (fit) fitCamera();
    },
    setSelection(asn) {
      // Purpose: mark the AS whose neighbourhood is being shown
      selection = asn;
    },
    focusHub(key) {
      // Purpose: zoom into one regional lane without moving its data
      if (!scene) return;
      const hub = scene.hubs.find(item => item.key === key);
      if (!hub) return;
      camera = {
        x: clamp((hub.x + 1) / 2, 0.05, 0.95),
        y: 0.5,
        ratio: 0.45,
      };
    },
    fit() {
      // Purpose: return to a view containing every visible mark
      fitCamera();
    },
    camera() {
      // Purpose: expose the camera for verification
      return { ...camera };
    },
    nodeScreen(asn) {
      // Purpose: expose an AS dot's screen point for verification
      const node = scene?.nodes.find(item => item.asn === asn);
      return node ? toScreen(node) : null;
    },
    describe,
    destroy() {
      // Purpose: stop the animation and remove only this renderer's listeners
      cancelAnimationFrame(animation);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      tooltip.remove();
    },
  };
}
