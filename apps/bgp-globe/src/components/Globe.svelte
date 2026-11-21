<script lang="ts">
  // The map: a WebGL globe or a Mercator map (deck.gl), drawing what the model's queries returned.
  import { onMount } from 'svelte';
  import { Deck, FlyToInterpolator, MapView, _GlobeView as GlobeView } from '@deck.gl/core';
  import { TileLayer } from '@deck.gl/geo-layers';
  import { ArcLayer, BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
  import type { Model } from '../lib/model.svelte';
  import type { ObservedIp, ObservedRoute, AsIpPoint } from '../lib/data';
  import { compact, flag } from '../lib/format';
  import { NONE } from '../lib/schemas';

  let { model, light = false }: { model: Model; light?: boolean } = $props();

  let host: HTMLDivElement;
  let deck: Deck<GlobeView | MapView> | null = null;
  let countriesGeo: { type: string; features: { properties: { iso: string; name: string } }[] } | null = null;
  let cablesGeo: { type: string; features: { geometry: { type: string; coordinates: number[][][] } }[] } | null = null;
  let cableLandings: [number, number][] = [];
  let viewState: Record<string, unknown> = { longitude: 10, latitude: 25, zoom: 1.55, pitch: 0, bearing: 0 };
  let lastInteraction = 0;
  let fading = $state(false);
  let now = $state(0);

  // Globe colours follow the theme: neutral land and water, semantic colours for activity.
  type RGB = [number, number, number];

  function lift(c: RGB): RGB {
    // Purpose: raise a base colour by one point of HSL saturation and lightness, keeping its hue.
    const [r, g, b] = c.map(v => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;
    const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h = (h * 60 + 360) % 360;
    }
    const s2 = Math.min(1, s + 0.01);
    const l2 = Math.min(1, l + 0.01);
    const chroma = (1 - Math.abs(2 * l2 - 1)) * s2;
    const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l2 - chroma / 2;
    const sector = Math.floor(h / 60) % 6;
    const out = [
      [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
      [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
    ][sector]!;
    return out.map(v => Math.min(255, Math.round((v + m) * 255))) as RGB;
  }

  const DARK_OCEAN: RGB = lift([21, 29, 39]);
  const LIGHT_OCEAN: RGB = lift([172, 206, 238]);
  // Terrain relief is a multiplier on the base colour, never a grey paint layer.
  const DARK_ANNOUNCE: RGB = [56, 224, 214];
  const DARK_WITHDRAW: RGB = [255, 92, 138];
  const LIGHT_ANNOUNCE: RGB = [0, 105, 92];
  const LIGHT_WITHDRAW: RGB = [183, 28, 76];
  // Land is green in both themes: dim and low-saturation in dark, bright and
  // high-saturation in light. Activity moves up the green ramp, never toward red.
  const DARK_STOPS: [number, RGB][] = [
    [0, lift([44, 56, 48])],
    [0.35, lift([52, 72, 60])],
    [0.65, lift([62, 94, 74])],
    [0.85, lift([76, 116, 90])],
    [1, lift([92, 136, 106])],
  ];
  const LIGHT_STOPS: [number, RGB][] = [
    [0, lift([90, 170, 114])],
    [0.35, lift([73, 159, 98])],
    [0.65, lift([57, 147, 83])],
    [0.85, lift([47, 133, 71])],
    [1, lift([40, 120, 61])],
  ];

  function announce(): RGB { return light ? LIGHT_ANNOUNCE : DARK_ANNOUNCE; }
  function withdraw(): RGB { return light ? LIGHT_WITHDRAW : DARK_WITHDRAW; }

  function ramp(x: number): RGB {
    // Purpose: a colour from the sequential palette for x in [0, 1]
    const stops = light ? LIGHT_STOPS : DARK_STOPS;
    const v = Math.max(0, Math.min(1, x));
    for (let i = 1; i < stops.length; i++) {
      const [b, cb] = stops[i]!;
      const [a, ca] = stops[i - 1]!;
      if (v <= b) {
        const f = (v - a) / (b - a);
        return [0, 1, 2].map(k => Math.round(ca[k]! + (cb[k]! - ca[k]!) * f)) as RGB;
      }
    }
    return stops[stops.length - 1]![1];
  }

  function mix(w: number): RGB {
    // Purpose: announce colour to withdraw colour by the share of withdrawals
    const a = announce();
    const b = withdraw();
    return [0, 1, 2].map(k => Math.round(a[k]! + (b[k]! - a[k]!) * Math.min(1, w))) as RGB;
  }

  function hash(n: number): number {
    // Purpose: a stable pseudo-random number in [0, 1) for an AS number
    let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }

  function hsl(h: number, s: number, l: number): RGB {
    // Purpose: HSL to RGB for the categorical AS palette
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const sector = Math.floor(h / 60) % 6;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector]!;
    return rgb.map(v => Math.round((v + m) * 255)) as RGB;
  }

  function asColor(asn: number): RGB {
    // Purpose: one stable, saturated colour per AS on either theme
    return hsl(hash(asn) * 360, light ? 0.68 : 0.72, light ? 0.3 + hash(asn * 7 + 1) * 0.1 : 0.58 + hash(asn * 11 + 3) * 0.12);
  }

  function ipText(addr: number): string {
    // Purpose: dotted-quad text for an observed IP
    return `${addr >>> 24}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}`;
  }

  function roleLabel(mask: number): string {
    // Purpose: which BGP roles an observed IP played
    const roles = [];
    if ((mask & 1) !== 0) roles.push('RIS peer');
    if ((mask & 2) !== 0) roles.push('NEXT_HOP');
    if ((mask & 4) !== 0) roles.push('collector');
    return roles.join(' + ') || 'observed';
  }

  function sourceLabel(source: number): string {
    // Purpose: how confidently an IP was attributed to its AS
    return ['MRT header (exact)', 'RIS peer index (exact)', 'inferred from peer AS', 'RIS collector city', 'RIS Live'][source] ?? 'unknown source';
  }

  type TerrainFetchOptions = { signal?: AbortSignal };

  async function terrainTextureFetch(url: string, options: TerrainFetchOptions = {}): Promise<HTMLCanvasElement> {
    // Purpose: turn a local Terrarium tile into a neutral multiplier that shades the base colour without painting grey.
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('2D canvas unavailable for terrain texture');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = image;
    const width = canvas.width;
    const height = canvas.height;
    const elevation = new Float32Array(width * height);
    for (let i = 0; i < elevation.length; i++) {
      const p = i * 4;
      elevation[i] = data[p]! * 256 + data[p + 1]! + data[p + 2]! / 256 - 32768;
    }
    const at = (x: number, y: number): number => elevation[
      Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))
    ]!;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
        const edge = Math.min(1, Math.min(x, y, width - 1 - x, height - 1 - y) / 4);
        const altitude = Math.max(0, Math.min(1, (elevation[y * width + x]! + 5000) / 11000));
        const relief = Math.max(-1, Math.min(1, (dx + dy) / 600)) * edge;
        const multiplier = Math.max(0.76, Math.min(1, 0.78 + altitude * 0.22 + relief * 0.07));
        const value = Math.round(multiplier * 255);
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function position(asn: number): [number, number] | null {
    // Purpose: where a network is drawn
    const n = model.networks;
    const i = n?.index.get(asn);
    if (n === null || i === undefined) return null;
    return [n.lon[i]!, n.lat[i]!];
  }

  function extractLandings(geo: typeof cablesGeo): [number, number][] {
    // Purpose: deduplicated cable endpoints, the only points where a cable can plausibly meet a router
    if (geo === null) return [];
    const seen = new Set<string>();
    const out: [number, number][] = [];
    for (const feature of geo.features) {
      for (const line of feature.geometry.coordinates ?? []) {
        if (line.length === 0) continue;
        for (const point of [line[0]!, line[line.length - 1]!]) {
          const lon = point[0]!, lat = point[1]!;
          const key = `${Math.round(lon * 2)},${Math.round(lat * 2)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push([lon, lat]);
        }
      }
    }
    return out;
  }

  function nearestLanding(pos: [number, number]): [number, number] | null {
    // Purpose: the closest cable landing to an observed IP, as an explicitly weak inference
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    const cos = Math.cos(pos[1] * Math.PI / 180);
    for (const landing of cableLandings) {
      const dx = (landing[0] - pos[0]) * cos;
      const dy = landing[1] - pos[1];
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = landing;
      }
    }
    return best;
  }

  function dashedSegments(from: [number, number], to: [number, number]): [number, number, number][][] {
    // Purpose: draw an inferred link as dashes so it never reads as an observed path
    const points = arcPath(from, to, 0);
    const segments: [number, number, number][][] = [];
    for (let i = 0; i + 1 < points.length; i += 2) segments.push([points[i]!, points[i + 1]!]);
    return segments;
  }

  function arcPath(from: [number, number], to: [number, number], lift: number): [number, number, number][] {
    // Purpose: a great-circle arc raised off the sphere (the globe draws arcs as 3D paths)
    const rad = Math.PI / 180;
    const v = ([lon, lat]: [number, number]) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
    const a = v(from);
    const b = v(to);
    const dot = Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
    const omega = Math.acos(dot);
    const steps = Math.max(4, Math.ceil(omega * 12));
    const out: [number, number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const s1 = omega < 1e-6 ? 1 - t : Math.sin((1 - t) * omega) / Math.sin(omega);
      const s2 = omega < 1e-6 ? t : Math.sin(t * omega) / Math.sin(omega);
      const x = s1 * a[0]! + s2 * b[0]!;
      const y = s1 * a[1]! + s2 * b[1]!;
      const z = s1 * a[2]! + s2 * b[2]!;
      let lon = Math.atan2(y, x) / rad;
      // Keep longitude continuous along the path (181 rather than -179), or a segment would wrap the globe.
      const prev = out[out.length - 1];
      if (prev !== undefined) lon += Math.round((prev[0] - lon) / 360) * 360;
      out.push([lon, Math.atan2(z, Math.hypot(x, y)) / rad, Math.sin(Math.PI * t) * omega * 6_371_000 * lift]);
    }
    return out;
  }

  function surfacePath(points: [number, number][], lift: number): [number, number, number][] {
    // Purpose: turn a precomputed 2D cable path into surface-hugging 3D segments for the globe
    const out: [number, number, number][] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const segment = arcPath(points[i]!, points[i + 1]!, lift);
      out.push(...(i === 0 ? segment : segment.slice(1)));
    }
    return out;
  }

  const graticule = (() => {
    // Purpose: faint lines every 30 degrees, for a sense of the sphere
    const lines: [number, number][][] = [];
    for (let lon = -180; lon <= 180; lon += 30) lines.push(Array.from({ length: 37 }, (_, i) => [lon, -90 + i * 5] as [number, number]));
    for (let lat = -60; lat <= 60; lat += 30) lines.push(Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat] as [number, number]));
    return lines;
  })();

  function countryValue(iso: string): { value: number; label: string } | null {
    // Purpose: what colours a country: update activity in the window, or routes in live mode with no activity yet
    const code = model.countryIndex.get(iso);
    if (code === undefined) return null;
    const a = model.countryActivity.get(code);
    if (a !== undefined) return { value: a.updates, label: `${compact(a.updates)} updates · ${compact(a.withdraws)} withdrawals · ${a.networks.toLocaleString('en')} networks` };
    return null;
  }

  type ArcDraw = { peer: number; origin: number; updates: number; withdraws: number; from: [number, number] | null; to: [number, number] | null };
  type IpDraw = ObservedIp & { pos: [number, number] };
  type InferredDraw = { path: [number, number, number][]; ip: IpDraw; landing: [number, number] };
  type RouteDraw = {
    path: [number, number, number][];
    originAs: number;
    peerAs: number;
    nextHop: number;
    peerIp: number;
    localIp: number;
    count: number;
    prefixes: number;
    source: string;
    asPath: string;
    routerDetail: string;
    origin: [number, number];
    nextHopPoint: [number, number];
    collector: [number, number];
    physicalPath: [number, number][] | null;
  };
  type AsIpDraw = AsIpPoint & { pos: [number, number] };
  // Drawn data, rebuilt only when a result changes (not on every animation frame).
  let drawn: {
    arcs: ArcDraw[];
    maxArc: number;
    origins: OriginLike[];
    maxOrigin: number;
    maxCountry: number;
    routeMax: number;
    moasArcs: { from: [number, number]; to: [number, number] }[];
    paths: { path: [number, number, number][]; arc: ArcDraw }[];
    ips: IpDraw[];
    maxIp: number;
    asIps: AsIpDraw[];
    inferred: InferredDraw[];
    routePaths: RouteDraw[];
    maxRoute: number;
  } = { arcs: [], maxArc: 1, origins: [], maxOrigin: 1, maxCountry: 1, routeMax: 1, moasArcs: [], paths: [], ips: [], maxIp: 1, asIps: [], inferred: [], routePaths: [], maxRoute: 1 };

  // Deck.gl reuses layer instances cheaply; rebuilding them every pulse frame re-uploads the terrain and
  // country textures. Keep every layer that does not animate in one cache, keyed by its inputs.
  let staticLayers: { deps: unknown[]; layers: unknown[] } | null = null;

  function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
    // Purpose: compare layer inputs by identity, so a new object every frame still invalidates the cache.
    return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  }

  function rebuild(): void {
    // Purpose: positions and scales for the latest results, including the physical-IP and selected-route layers
    const hasSelection = model.hasSelection;
    const arcs = !hasSelection
      ? model.arcs.map(a => ({ ...a, from: position(a.peer), to: position(a.origin) })).filter(a => a.from !== null && a.to !== null)
      : [];
    const origins = model.origins.filter(o => position(o.asn) !== null && model.matchesSelection(o.asn));
    const moasArcs: { from: [number, number]; to: [number, number] }[] = [];
    if (model.selectedMoas !== null) {
      const pts = model.selectedMoas.origins.map(o => position(o.asn)).filter((p): p is [number, number] => p !== null);
      for (let i = 1; i < pts.length; i++) moasArcs.push({ from: pts[0]!, to: pts[i]! });
    }
    let maxArc = 1;
    for (const a of arcs) maxArc = Math.max(maxArc, a.updates);
    let maxOrigin = 1;
    for (const o of origins) maxOrigin = Math.max(maxOrigin, o.updates);
    let maxCountry = 1;
    for (const v of model.countryActivity.values()) maxCountry = Math.max(maxCountry, v.updates);
    let routeMax = 1;
    for (const v of model.routeCountries.values()) routeMax = Math.max(routeMax, v.routes);
    // The globe gets the strongest 400 event arcs; fewer, shorter paths keep the 3D render cheap.
    const paths = model.projection === 'globe' ? arcs.slice(0, 400).map(arc => ({ path: arcPath(arc.from!, arc.to!, 0.07), arc })) : [];

    const allIpIndex = new Map<number, IpDraw>();
    for (const ip of model.observedIps) {
      if (ip.precision > 0) allIpIndex.set(ip.ip, { ...ip, pos: [ip.lon, ip.lat] });
    }
    const selectedRoutes = model.routesForSelection();
    // Show the selected ASes' IPs and every next hop / collector address their routes actually use —
    // including next hops in other countries, which is the point of following the path.
    const endpointIps = new Set<number>();
    for (const route of selectedRoutes) {
      endpointIps.add(route.nextHop);
      endpointIps.add(route.localIp);
    }
    const ips = [...allIpIndex.values()].filter(ip => !hasSelection || model.matchesSelection(ip.asn) || endpointIps.has(ip.ip));
    let maxIp = 1;
    for (const ip of ips) maxIp = Math.max(maxIp, ip.count);

    // Geolocated address blocks for the selected ASes: their own IP space, at city level.
    const asIps = hasSelection ? model.asIps.filter(point => model.matchesSelection(point.asn)) : [];

    type Group = RouteDraw & { originLabel: string };
    const groups = new Map<string, Group>();
    for (const route of selectedRoutes) {
      const origin: [number, number] | null = Number.isFinite(route.originLon) && Number.isFinite(route.originLat)
        ? [route.originLon, route.originLat]
        : position(route.originAs);
      const nextHopPoint = allIpIndex.get(route.nextHop)?.pos ?? position(route.peerAs);
      const collector = allIpIndex.get(route.localIp)?.pos ?? position(route.peerAs);
      if (origin === null || nextHopPoint === null || nextHopPoint === undefined || collector === null || collector === undefined) continue;
      const key = `${origin[0].toFixed(2)},${origin[1].toFixed(2)}>${nextHopPoint[0].toFixed(2)},${nextHopPoint[1].toFixed(2)}>${collector[0].toFixed(2)},${collector[1].toFixed(2)}`;
      let group = groups.get(key);
      if (group === undefined) {
        const next = allIpIndex.get(route.nextHop);
        const local = allIpIndex.get(route.localIp);
        const geo = (ip: IpDraw | undefined) => ip === undefined
          ? 'no location'
          : `${[ip.country, ip.city].filter(Boolean).join(' · ') || (ip.precision === 1 ? 'country-level fix' : 'unknown')} · ${ip.lat.toFixed(2)}, ${ip.lon.toFixed(2)}`;
        const originLabel = `${[route.originCountry, route.originCity].filter(Boolean).join(' · ') || 'origin prefix'} · ${route.originLat.toFixed(2)}, ${route.originLon.toFixed(2)}`;
        const routerDetail = `${originLabel} origin prefix → ${ipText(route.nextHop)} next hop ${geo(next)} → ${ipText(route.localIp)} collector ${geo(local)}`;
        group = {
          path: [], originAs: route.originAs, peerAs: route.peerAs, nextHop: route.nextHop, peerIp: route.peerIp, localIp: route.localIp,
          count: 0, prefixes: 0, source: route.source, asPath: route.path, routerDetail,
          origin, nextHopPoint, collector, physicalPath: route.physicalPath, originLabel,
        };
        groups.set(key, group);
      }
      group.count += route.count;
      group.prefixes += route.prefixes;
    }
    // Co-located routes share one line; width is logarithmic in how many observations merged into it.
    const routePaths: RouteDraw[] = [...groups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 1200)
      .map(group => ({
        ...group,
        path: surfacePath([group.origin, group.nextHopPoint, group.collector], model.projection === 'globe' ? 0.03 : 0),
      }));
    let maxRoute = 1;
    for (const route of routePaths) maxRoute = Math.max(maxRoute, route.count);

    // Inferred tier: the closest cable landing to each well-observed IP. Dashed, amber and explicitly
    // labelled as a guess — there is no BGP evidence that any of these IPs uses the nearest cable.
    const inferred: InferredDraw[] = [];
    for (const ip of ips.slice(0, 40)) {
      const landing = nearestLanding(ip.pos);
      if (landing === null) continue;
      for (const path of dashedSegments(ip.pos, landing)) inferred.push({ path, ip, landing });
    }

    drawn = { arcs, maxArc, origins, maxOrigin, maxCountry, routeMax, moasArcs, paths, ips, maxIp, asIps: asIps.map(point => ({ ...point, pos: [point.lon, point.lat] })), inferred, routePaths, maxRoute };
  }

  function layers(): unknown[] {
    // Purpose: every layer, with the static ones cached so pulse frames do not re-upload the whole globe.
    const globe = model.projection === 'globe';
    const deps = [globe, light, model.country, model.countryActivity, model.routeCountries, model.selectedMoas, model.selectedAsn, model.selectedCountry, model.showCables, drawn, countriesGeo, cablesGeo];
    if (staticLayers === null || !sameDeps(staticLayers.deps, deps)) {
      const { arcs, maxArc, origins, maxOrigin, maxCountry, routeMax, moasArcs, paths, ips, maxIp, asIps, inferred, routePaths, maxRoute } = drawn;
      const selected = model.country;
      staticLayers = {
        deps,
        layers: [
          // The globe surface is always drawn first, so tiles and data never reveal a grey sphere.
          new SolidPolygonLayer({
            id: 'globe-surface',
            data: [[[-180, 90], [0, 90], [180, 90], [180, -90], [0, -90], [-180, -90]]],
            getPolygon: (d: unknown) => d as [number, number][],
            stroked: false,
            filled: true,
            getFillColor: light ? LIGHT_OCEAN : DARK_OCEAN,
          }),
          globe &&
            new TileLayer({
              id: 'terrain-shade',
              data: '/terrain/{z}/{x}/{y}.png',
              fetch: terrainTextureFetch as never,
              minZoom: 1,
              maxZoom: 3,
              tileSize: 256,
              renderSubLayers: (props: unknown) => {
                const { id, data, tile } = props as {
                  id: string;
                  data: HTMLCanvasElement | null;
                  tile: { bbox: { west: number; south: number; east: number; north: number } };
                };
                return data === null ? null : new BitmapLayer({
                  id: `${id}-shade`,
                  image: data,
                  bounds: [tile.bbox.west, tile.bbox.south, tile.bbox.east, tile.bbox.north],
                  pickable: false,
                  parameters: {
                    blend: true,
                    blendColorOperation: 'add',
                    blendColorSrcFactor: 'dst',
                    blendColorDstFactor: 'zero',
                    blendAlphaOperation: 'add',
                    blendAlphaSrcFactor: 'one',
                    blendAlphaDstFactor: 'zero',
                    depthTest: false,
                  },
                });
              },
            }),
          new PathLayer({ id: 'graticule', data: graticule, getPath: (d: unknown) => d as [number, number][], getColor: light ? [0, 0, 0, 26] : [255, 255, 255, 22], widthMinPixels: 1, parameters: { depthTest: false } }),
          countriesGeo &&
            new GeoJsonLayer({
              id: 'countries',
              data: countriesGeo as never,
              pickable: true,
              stroked: true,
              filled: true,
              lineWidthMinPixels: 0.6,
              getLineColor: (f: { properties: { iso: string } }) => selected !== null && model.countryIndex.get(f.properties.iso) === selected
                ? (light ? [20, 20, 20, 220] : [255, 255, 255, 220])
                : (light ? [0, 0, 0, 70] : [255, 255, 255, 55]),
              getFillColor: (f: { properties: { iso: string } }) => {
                const v = countryValue(f.properties.iso);
                if (v !== null) {
                  const [r, g, b] = ramp(Math.log1p(v.value) / Math.log1p(maxCountry));
                  return [r, g, b, 130];
                }
                const code = model.countryIndex.get(f.properties.iso);
                const routes = code === undefined ? 0 : (model.routeCountries.get(code)?.routes ?? 0);
                const [r, g, b] = ramp(0.25 * (Math.log1p(routes) / Math.log1p(routeMax)));
                return [r, g, b, 120];
              },
              updateTriggers: { getFillColor: [model.countryActivity, model.routeCountries, light], getLineColor: [selected, light] },
              transitions: { getFillColor: 350 },
              // Paint the data ramp over the relief texture instead of hiding behind it.
              parameters: { depthTest: false },
            }),
          model.showCables &&
            cablesGeo !== null &&
            new GeoJsonLayer({
              id: 'submarine-cables',
              data: cablesGeo as never,
              stroked: true,
              filled: false,
              lineWidthUnits: 'pixels',
              getLineWidth: 0.8,
              getLineColor: light ? [70, 86, 102, 90] : [150, 170, 190, 70],
              parameters: { depthTest: false },
              updateTriggers: { getLineColor: [light] },
            }),
          model.showCables &&
            new PathLayer({
              id: 'inferred-cable-links',
              data: inferred,
              pickable: false,
              getPath: (d: InferredDraw) => d.path,
              getColor: [236, 168, 66, 120] as [number, number, number, number],
              getWidth: 1,
              widthUnits: 'pixels',
              capRounded: false,
              wrapLongitude: !globe,
              parameters: { depthTest: false },
            }),
          new PathLayer({
            id: 'physical-routes',
            data: routePaths.filter(route => route.physicalPath !== null && route.physicalPath.length > 1),
            pickable: true,
            getPath: (d: RouteDraw) => surfacePath(d.physicalPath!, globe ? 0.02 : 0),
            getColor: [236, 168, 66, 210] as [number, number, number, number],
            getWidth: (d: RouteDraw) => 2 + 6 * Math.log1p(d.count) / Math.log1p(maxRoute),
            widthUnits: 'pixels',
            capRounded: false,
            wrapLongitude: !globe,
            updateTriggers: { getWidth: [maxRoute], getPath: [globe] },
            parameters: { depthTest: false },
          }),
          new ScatterplotLayer({
            id: 'as-ip-points',
            data: asIps,
            pickable: true,
            radiusUnits: 'pixels',
            getPosition: (d: AsIpDraw) => d.pos,
            getRadius: 4,
            getFillColor: (d: AsIpDraw) => [...asColor(d.asn), 200] as [number, number, number, number],
            getLineColor: light ? [20, 20, 20, 120] : [255, 255, 255, 160],
            stroked: true,
            lineWidthMinPixels: 0.6,
            updateTriggers: { getFillColor: [asIps, light] },
            parameters: { depthTest: false },
          }),
          new PathLayer({
            id: 'advertised-routes',
            data: routePaths,
            pickable: true,
            getPath: (d: RouteDraw) => d.path,
            getColor: (d: RouteDraw) => {
              const [r, g, b] = asColor(d.originAs);
              return [r, g, b, 90 + Math.round(120 * Math.log1p(d.count) / Math.log1p(maxRoute))] as [number, number, number, number];
            },
            getWidth: (d: RouteDraw) => 1 + 7 * Math.log1p(d.count) / Math.log1p(maxRoute),
            widthUnits: 'pixels',
            capRounded: false,
            wrapLongitude: !globe,
            updateTriggers: { getColor: [routePaths, maxRoute, light], getWidth: [routePaths, maxRoute] },
            parameters: { depthTest: false },
          }),
          globe &&
            new PathLayer({
              id: 'arcs',
              data: paths,
              pickable: true,
              getPath: (d: { path: [number, number, number][] }) => d.path,
              getColor: (d: { arc: ArcDraw }) => [...mix(d.arc.withdraws / d.arc.updates), 30 + Math.round(150 * Math.sqrt(d.arc.updates / maxArc))] as [number, number, number, number],
              getWidth: (d: { arc: ArcDraw }) => 0.5 + 2.5 * Math.sqrt(d.arc.updates / maxArc),
              widthUnits: 'pixels',
              capRounded: false,
              wrapLongitude: false,
              updateTriggers: { getColor: [paths, light], getWidth: [maxArc] },
            }),
          !globe && new ArcLayer({
            id: 'arcs',
            data: arcs,
            pickable: true,
            greatCircle: true,
            getSourcePosition: (d: ArcDraw) => d.from!,
            getTargetPosition: (d: ArcDraw) => d.to!,
            getSourceColor: (d: ArcDraw) => [...mix(d.withdraws / d.updates), 40] as [number, number, number, number],
            getTargetColor: (d: ArcDraw) => [...mix(d.withdraws / d.updates), 220] as [number, number, number, number],
            getWidth: (d: ArcDraw) => 0.6 + 3.4 * Math.sqrt(d.updates / maxArc),
            getHeight: 0.35,
            widthUnits: 'pixels',
            updateTriggers: { getSourceColor: [arcs, light], getWidth: [maxArc] },
          }),
          new ScatterplotLayer({
            id: 'origins',
            data: origins,
            pickable: true,
            radiusUnits: 'pixels',
            getPosition: (d: OriginLike) => position(d.asn)!,
            getRadius: (d: OriginLike) => 1.5 + 16 * Math.sqrt(d.updates / maxOrigin),
            getFillColor: (d: OriginLike) => [...mix(d.withdraws / Math.max(1, d.updates)), 150] as [number, number, number, number],
            getLineColor: light ? [20, 20, 20, 110] : [255, 255, 255, 120],
            lineWidthMinPixels: 0.5,
            stroked: true,
            updateTriggers: { getRadius: [maxOrigin], getFillColor: [origins, light] },
            transitions: { getRadius: 250 },
            parameters: { depthTest: false },
          }),
          new ScatterplotLayer({
            id: 'observed-ips',
            data: ips,
            pickable: true,
            radiusUnits: 'pixels',
            getPosition: (d: IpDraw) => d.pos,
            getRadius: (d: IpDraw) => 3 + 11 * Math.log1p(d.count) / Math.log1p(maxIp),
            getFillColor: (d: IpDraw) => [...asColor(d.asn), model.selectedAsn === null ? 170 : 230] as [number, number, number, number],
            getLineColor: light ? [20, 20, 20, 120] : [255, 255, 255, 150],
            lineWidthMinPixels: 0.8,
            stroked: true,
            updateTriggers: { getRadius: [ips, maxIp], getFillColor: [ips, light, model.selectedAsn] },
            parameters: { depthTest: false },
          }),
          globe &&
            new PathLayer({
              id: 'moas',
              data: moasArcs.map(m => arcPath(m.from, m.to, 0.12)),
              getPath: (d: [number, number, number][]) => d,
              wrapLongitude: false,
              getColor: light ? [139, 101, 4, 255] : [255, 170, 60, 255],
              getWidth: 3,
              widthUnits: 'pixels',
            }),
          !globe && new ArcLayer({
            id: 'moas',
            data: moasArcs,
            greatCircle: true,
            getSourcePosition: (d: { from: [number, number] }) => d.from,
            getTargetPosition: (d: { to: [number, number] }) => d.to,
            getSourceColor: light ? [139, 101, 4, 255] : [255, 200, 60, 255],
            getTargetColor: light ? [183, 28, 76, 255] : [255, 70, 70, 255],
            getWidth: 3,
            getHeight: 0.6,
          }),
        ].filter(Boolean),
      };
    }
    const t = now;
    return [
      ...staticLayers.layers,
      new ScatterplotLayer({
        id: 'pulses',
        // Live advertisement pulses are the remaining global event layer: apply the same AS/country,
        // announcement/withdrawal and prefix-length filters as the arc query.
        data: model.pulses.filter(p =>
          (!model.hasSelection || model.matchesSelection(p.asn)) &&
          (model.country === null || p.cc === model.country) &&
          model.kinds.includes(p.kind) &&
          p.prefixLen >= model.lenRange[0] && p.prefixLen <= model.lenRange[1]),
        radiusUnits: 'pixels',
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getRadius: (d: { born: number }) => 2 + Math.min(12, Math.max(0, t - d.born) / 400),
        getFillColor: (d: { born: number; kind: number }) => {
          const age = Math.max(0, t - d.born) / 6000;
          return [...(d.kind === 1 ? withdraw() : announce()), Math.round(200 * Math.max(0, 1 - age))] as [number, number, number, number];
        },
        stroked: false,
        updateTriggers: { getRadius: [t], getFillColor: [t, light] },
        parameters: { depthTest: false },
      }),
    ];
  }

  type OriginLike = { asn: number; updates: number; withdraws: number; prefixes: number };

  function tooltip(info: { layer?: { id: string } | null; object?: unknown }): { html: string; className: string } | null {
    // Purpose: explain what is under the pointer
    if (!info.object || !info.layer) return null;
    const n = model.networks!;
    const nameOf = (asn: number) => {
      const i = n.index.get(asn);
      return i === undefined ? 'unknown network' : (n.names[n.nameCode[i]!] || 'unnamed network');
    };
    const ccOf = (asn: number) => {
      const i = n.index.get(asn);
      return i === undefined || n.cc[i] === NONE ? '' : `${flag(n.countries[n.cc[i]!]!)} ${n.countries[n.cc[i]!]}`;
    };
    if (info.layer.id === 'observed-ips') {
      const ip = info.object as IpDraw;
      const who = ip.asn === 0 ? 'RIS collector' : `<b>AS${ip.asn}</b> ${nameOf(ip.asn)} <span class="muted">${ccOf(ip.asn)}</span>`;
      const at = `${[ip.country, ip.city].filter(Boolean).join(' · ') || 'unknown place'} · ${ip.lat.toFixed(2)}, ${ip.lon.toFixed(2)}`;
      return {
        className: 'tip',
        html: `<b class="mono">${ipText(ip.ip)}</b> ${who}<br>
          ${roleLabel(ip.roleMask)} · ${sourceLabel(ip.source)}<br>
          ${at} · ${ip.precision === 3 ? 'city-level' : ip.precision === 2 ? 'facility-level' : 'country-level'} position<br>
          seen ${ip.count.toLocaleString('en')} times<br><span class="muted">click to focus this network</span>`,
      };
    }
    if (info.layer.id === 'as-ip-points') {
      const point = info.object as AsIpDraw;
      return {
        className: 'tip',
        html: `<b>AS${point.asn}</b> ${nameOf(point.asn)}<br>
          <span class="mono">${ipText(point.addr)}/${point.len}</span> · ${[point.country, point.city].filter(Boolean).join(' · ') || 'located prefix'}<br>
          ${point.lat.toFixed(2)}, ${point.lon.toFixed(2)} · ${point.count.toLocaleString('en')} prefix(es) here<br><span class="muted">Geolocated address space (DB-IP / operator geofeeds), grouped per city. Not one point per machine.</span>`,
      };
    }
    if (info.layer.id === 'physical-routes') {
      const route = info.object as RouteDraw;
      return {
        className: 'tip',
        html: `<b>Inferred physical route</b><br>
          ${route.routerDetail}<br>
          ${route.source}<br>
          ${route.prefixes.toLocaleString('en')} prefix(es) · ${route.count.toLocaleString('en')} observations merged<br>
          <span class="muted">Cable path is the shortest route over public cable geometry between the origin prefix and next-hop landings. BGP did not observe this cable path.</span>`,
      };
    }
    if (info.layer.id === 'advertised-routes') {
      const route = info.object as RouteDraw;
      return {
        className: 'tip',
        html: `<b>AS${route.originAs}</b> ${nameOf(route.originAs)} advertises <b>${route.prefixes.toLocaleString('en')}</b> prefix(es)<br>
          ${route.source} · ${route.count.toLocaleString('en')} observations merged<br>
          ${model.pathDetail === 'ips-geoip' ? `${route.routerDetail}<br>` : ''}
          <span class="mono">${route.asPath || 'path unavailable'}</span><br><span class="muted">Origin prefix → BGP next hop → collector, not a fibre route. Width grows logarithmically with the merged count.</span>`,
      };
    }
    if (info.layer.id === 'origins') {
      const o = info.object as OriginLike;
      const h = model.hoverNetwork?.asn === o.asn ? model.hoverNetwork : null;
      return {
        className: 'tip',
        html: `<b>AS${o.asn}</b> ${nameOf(o.asn)} <span class="muted">${ccOf(o.asn)}</span><br>
          ${o.updates.toLocaleString('en')} updates about ${o.prefixes.toLocaleString('en')} of its prefixes in the window, ${o.withdraws.toLocaleString('en')} withdrawals<br>
          ${h ? `originates <b>${h.routes.toLocaleString('en')}</b> routes in the table (${compact(h.addresses)} addresses, /${h.shortest}–/${h.longest})` : '<span class="muted">looking it up in the routing table…</span>'}`,
      };
    }
    if (info.layer.id === 'arcs') {
      const picked = info.object as { arc?: ArcDraw } & ArcDraw;
      const a = picked.arc ?? picked;
      return {
        className: 'tip',
        html: `<b>AS${a.peer}</b> ${nameOf(a.peer)} → <b>AS${a.origin}</b> ${nameOf(a.origin)}<br>
          ${a.updates.toLocaleString('en')} updates the RIS peer AS${a.peer} sent about prefixes AS${a.origin} originates
          (${a.withdraws.toLocaleString('en')} withdrawals)<br><span class="muted">An arc is not a cable: it says who told the collector about whose routes.</span>`,
      };
    }
    if (info.layer.id === 'countries') {
      const f = info.object as { properties: { iso: string; name: string } };
      const code = model.countryIndex.get(f.properties.iso);
      const routes = code === undefined ? undefined : model.routeCountries.get(code);
      const v = countryValue(f.properties.iso);
      return {
        className: 'tip',
        html: `<b>${flag(f.properties.iso)} ${f.properties.name}</b><br>
          ${routes ? `${routes.routes.toLocaleString('en')} routes · ${compact(routes.addresses)} IPv4 addresses · ${routes.networks.toLocaleString('en')} origin networks<br>` : ''}
          ${v ? `in the window: ${v.label}` : '<span class="muted">no updates in the window</span>'}<br><span class="muted">click to filter</span>`,
      };
    }
    return null;
  }

  function view() {
    // Purpose: the deck.gl view for the chosen projection
    return model.projection === 'globe' ? new GlobeView({ id: 'globe', resolution: 8 }) : new MapView({ id: 'map', repeat: true });
  }

  function apply(): void {
    // Purpose: push the current layers to deck.gl
    deck?.setProps({ layers: layers() as never });
  }

  onMount(() => {
    void Promise.all([
      fetch('/countries.geojson').then(r => r.json()),
      fetch('/cables.geojson').then(r => r.json()),
    ]).then(([geo, cables]) => {
      countriesGeo = geo;
      cablesGeo = cables;
      cableLandings = extractLandings(cables);
      rebuild();
      apply();
    });
    deck = new Deck({
      parent: host,
      views: view(),
      viewState: viewState as never,
      controller: { inertia: 400, scrollZoom: { smooth: true, speed: 0.02 } },
      onViewStateChange: ({ viewState: next, interactionState }: { viewState: Record<string, unknown>; interactionState: { isDragging?: boolean; isZooming?: boolean; isPanning?: boolean } }) => {
        if (interactionState.isDragging || interactionState.isZooming || interactionState.isPanning) lastInteraction = performance.now();
        viewState = next;
        deck?.setProps({ viewState: viewState as never });
      },
      getTooltip: tooltip as never,
      onHover: (info: { layer?: { id: string } | null; object?: unknown }) => {
        const asn = info.layer?.id === 'origins' && info.object ? (info.object as OriginLike).asn : null;
        if (asn !== (model.hoverNetwork?.asn ?? null)) void model.inspectNetwork(asn);
      },
      onClick: (info: { layer?: { id: string } | null; object?: unknown }) => {
        lastInteraction = performance.now();
        if (info.layer?.id === 'countries' && info.object) {
          const code = model.countryIndex.get((info.object as { properties: { iso: string } }).properties.iso) ?? null;
          model.setFilter({ country: model.country === code ? null : code });
          model.selectCountry(model.selectedCountry === code ? null : code);
        } else if (info.layer?.id === 'observed-ips' && info.object) {
          const ip = info.object as IpDraw;
          if (ip.asn !== 0) {
            model.selectAsn(ip.asn);
            model.flyTo(ip.lon, ip.lat, 3);
          }
        } else if ((info.layer?.id === 'advertised-routes' || info.layer?.id === 'physical-routes' || info.layer?.id === 'as-ip-points') && info.object) {
          const picked = info.object as { originAs?: number; asn?: number };
          const asn = picked.originAs ?? picked.asn;
          if (asn !== undefined) model.selectAsn(asn);
        } else if (info.layer?.id === 'origins' && info.object) {
          const asn = (info.object as OriginLike).asn;
          model.selectAsn(asn);
          model.flyToNetwork(asn);
        } else if (model.selectedAsn !== null && !info.object) {
          model.selectAsn(null);
        }
      },
      layers: [],
      parameters: { clearColor: [0, 0, 0, 0] } as never,
    });
    // Exposed for browser checks, alongside the model on App.svelte.
    (globalThis as { zamdaDeck?: Deck<GlobeView | MapView> }).zamdaDeck = deck;
    // Optional slow rotation while nobody touches the globe; off by default, and it stops for 8 s after any interaction.
    let raf = 0;
    let lastPulseFrame = 0;
    const spin = (time: number) => {
      now = performance.now();
      if (model.autoRotate && model.projection === 'globe' && time - lastInteraction > 8000 && !(viewState as { transitionDuration?: number }).transitionDuration) {
        viewState = { ...viewState, longitude: ((Number(viewState.longitude) + 0.025 + 180) % 360) - 180 };
        deck?.setProps({ viewState: viewState as never });
      }
      // Pulse animation needs redraws, but cap them so a busy globe does not starve engine replies.
      if (model.pulses.length > 0 && time - lastPulseFrame > 50) {
        lastPulseFrame = time;
        apply();
      }
      raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);
    return () => {
      cancelAnimationFrame(raf);
      deck?.finalize();
      deck = null;
    };
  });

  $effect(() => {
    // Redraw whenever a result, a filter, the selection or the theme changes.
    void [model.arcs, model.origins, model.countryActivity, model.routeCountries, model.country, model.selectedMoas, model.selectedAsn, model.selectedCountry, model.showCables, model.observedIps, model.observedRoutes, model.asIps, light];
    rebuild();
    apply();
  });

  let shownProjection = model.projection;
  $effect(() => {
    // Crossfade between projections: fade out, swap the view, fade back in.
    const next = model.projection;
    if (next === shownProjection || deck === null) return;
    fading = true;
    setTimeout(() => {
      shownProjection = next;
      rebuild();
      viewState = { ...viewState, zoom: next === 'globe' ? Math.min(Number(viewState.zoom), 2.5) : Math.max(Number(viewState.zoom), 1.2), pitch: 0, bearing: 0 };
      deck?.setProps({ views: view(), viewState: viewState as never });
      apply();
      fading = false;
    }, 260);
  });

  $effect(() => {
    // Fly to a network or an address's origin when asked.
    const f = model.focus;
    if (f === null || deck === null) return;
    lastInteraction = performance.now();
    viewState = { ...viewState, longitude: f.lon, latitude: f.lat, zoom: model.projection === 'globe' ? Math.min(f.zoom, 2.1) : f.zoom, transitionDuration: 1400, transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }) };
    deck.setProps({ viewState: viewState as never });
    setTimeout(() => {
      viewState = { ...viewState, transitionDuration: 0 };
    }, 1500);
  });
</script>

<div class="globe" class:fading bind:this={host}></div>

<style>
  .globe {
    position: absolute;
    inset: 0;
    transition: opacity 0.26s ease;
  }
  .fading {
    opacity: 0;
  }
</style>
