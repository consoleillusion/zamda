<script lang="ts">
  // The map: a WebGL globe or a Mercator map (deck.gl), drawing what the model's queries returned.
  import { onMount } from 'svelte';
  import { Deck, FlyToInterpolator, MapView, _GlobeView as GlobeView } from '@deck.gl/core';
  import { ArcLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
  import type { Model } from '../lib/model.svelte';
  import { compact, flag } from '../lib/format';
  import { NONE } from '../lib/schemas';

  let { model }: { model: Model } = $props();

  let host: HTMLDivElement;
  let deck: Deck<GlobeView | MapView> | null = null;
  let countriesGeo: { type: string; features: { properties: { iso: string; name: string } }[] } | null = null;
  let viewState: Record<string, unknown> = { longitude: 10, latitude: 25, zoom: 1.55, pitch: 0, bearing: 0 };
  let lastInteraction = 0;
  let fading = $state(false);
  let now = $state(0);

  // Colours: one palette for the whole page (see style.css).
  const ANNOUNCE: [number, number, number] = [56, 224, 214];
  const WITHDRAW: [number, number, number] = [255, 92, 138];
  const STOPS: [number, [number, number, number]][] = [
    [0, [17, 30, 52]],
    [0.35, [20, 88, 120]],
    [0.65, [38, 170, 170]],
    [0.85, [180, 220, 120]],
    [1, [255, 214, 102]],
  ];

  function ramp(x: number): [number, number, number] {
    // Purpose: a colour from the sequential palette for x in [0, 1]
    const v = Math.max(0, Math.min(1, x));
    for (let i = 1; i < STOPS.length; i++) {
      const [b, cb] = STOPS[i]!;
      const [a, ca] = STOPS[i - 1]!;
      if (v <= b) {
        const f = (v - a) / (b - a);
        return [0, 1, 2].map(k => Math.round(ca[k]! + (cb[k]! - ca[k]!) * f)) as [number, number, number];
      }
    }
    return STOPS[STOPS.length - 1]![1];
  }

  function mix(w: number): [number, number, number] {
    // Purpose: announce colour to withdraw colour by the share of withdrawals
    return [0, 1, 2].map(k => Math.round(ANNOUNCE[k]! + (WITHDRAW[k]! - ANNOUNCE[k]!) * Math.min(1, w))) as [number, number, number];
  }

  function position(asn: number): [number, number] | null {
    // Purpose: where a network is drawn
    const n = model.networks;
    const i = n?.index.get(asn);
    if (n === null || i === undefined) return null;
    return [n.lon[i]!, n.lat[i]!];
  }

  function arcPath(from: [number, number], to: [number, number], lift: number): [number, number, number][] {
    // Purpose: a great-circle arc raised off the sphere (the globe draws arcs as 3D paths)
    const rad = Math.PI / 180;
    const v = ([lon, lat]: [number, number]) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
    const a = v(from);
    const b = v(to);
    const dot = Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
    const omega = Math.acos(dot);
    const steps = Math.max(4, Math.ceil(omega * 24));
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
  } = { arcs: [], maxArc: 1, origins: [], maxOrigin: 1, maxCountry: 1, routeMax: 1, moasArcs: [], paths: [] };

  function rebuild(): void {
    // Purpose: positions and scales for the latest results
    const arcs = model.arcs.map(a => ({ ...a, from: position(a.peer), to: position(a.origin) })).filter(a => a.from !== null && a.to !== null);
    const origins = model.origins.filter(o => position(o.asn) !== null);
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
    // The globe gets the strongest 700 arcs, kept low, so the land stays readable underneath.
    const paths = model.projection === 'globe' ? arcs.slice(0, 700).map(arc => ({ path: arcPath(arc.from!, arc.to!, 0.07), arc })) : [];
    drawn = { arcs, maxArc, origins, maxOrigin, maxCountry, routeMax, moasArcs, paths };
  }

  function layers(): unknown[] {
    // Purpose: every layer, from the model's latest results
    const globe = model.projection === 'globe';
    const { arcs, maxArc, origins, maxOrigin, maxCountry, routeMax, moasArcs, paths } = drawn;
    const selected = model.country;
    const t = now;
    return [
      new SolidPolygonLayer({
        id: 'ocean',
        data: [[[-180, 90], [0, 90], [180, 90], [180, -90], [0, -90], [-180, -90]]],
        getPolygon: (d: unknown) => d as [number, number][],
        getFillColor: [7, 13, 26],
      }),
      new PathLayer({ id: 'graticule', data: graticule, getPath: (d: unknown) => d as [number, number][], getColor: [80, 120, 170, 40], widthMinPixels: 1, parameters: { depthTest: false } }),
      countriesGeo &&
        new GeoJsonLayer({
          id: 'countries',
          data: countriesGeo as never,
          pickable: true,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 0.6,
          getLineColor: (f: { properties: { iso: string } }) => (selected !== null && model.countryIndex.get(f.properties.iso) === selected ? [255, 255, 255, 220] : [90, 130, 180, 90]),
          getFillColor: (f: { properties: { iso: string } }) => {
            const v = countryValue(f.properties.iso);
            if (v !== null) {
              const [r, g, b] = ramp(Math.log1p(v.value) / Math.log1p(maxCountry));
              return [r, g, b, 210];
            }
            const code = model.countryIndex.get(f.properties.iso);
            const routes = code === undefined ? 0 : (model.routeCountries.get(code)?.routes ?? 0);
            const [r, g, b] = ramp(0.25 * (Math.log1p(routes) / Math.log1p(routeMax)));
            return [r, g, b, 200];
          },
          updateTriggers: { getFillColor: [model.countryActivity, model.routeCountries], getLineColor: [selected] },
          transitions: { getFillColor: 350 },
          parameters: { depthTest: !globe ? false : true },
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
          capRounded: true,
          wrapLongitude: false,
          updateTriggers: { getColor: [paths], getWidth: [maxArc] },
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
        updateTriggers: { getSourceColor: [arcs], getWidth: [maxArc] },
      }),
      new ScatterplotLayer({
        id: 'origins',
        data: origins,
        pickable: true,
        radiusUnits: 'pixels',
        getPosition: (d: OriginLike) => position(d.asn)!,
        getRadius: (d: OriginLike) => 1.5 + 16 * Math.sqrt(d.updates / maxOrigin),
        getFillColor: (d: OriginLike) => [...mix(d.withdraws / Math.max(1, d.updates)), 150] as [number, number, number, number],
        getLineColor: [255, 255, 255, 120],
        lineWidthMinPixels: 0.5,
        stroked: true,
        updateTriggers: { getRadius: [maxOrigin], getFillColor: [origins] },
        transitions: { getRadius: 250 },
        parameters: { depthTest: false },
      }),
      new ScatterplotLayer({
        id: 'pulses',
        data: model.pulses,
        radiusUnits: 'pixels',
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getRadius: (d: { born: number }) => 2 + Math.min(12, Math.max(0, t - d.born) / 400),
        getFillColor: (d: { born: number; kind: number }) => {
          const age = Math.max(0, t - d.born) / 6000;
          return [...(d.kind === 1 ? WITHDRAW : ANNOUNCE), Math.round(200 * Math.max(0, 1 - age))] as [number, number, number, number];
        },
        stroked: false,
        updateTriggers: { getRadius: [t], getFillColor: [t] },
        parameters: { depthTest: false },
      }),
      globe &&
        new PathLayer({
          id: 'moas',
          data: moasArcs.map(m => arcPath(m.from, m.to, 0.12)),
          getPath: (d: [number, number, number][]) => d,
          wrapLongitude: false,
          getColor: [255, 170, 60, 255],
          getWidth: 3,
          widthUnits: 'pixels',
        }),
      !globe && new ArcLayer({
        id: 'moas',
        data: moasArcs,
        greatCircle: true,
        getSourcePosition: (d: { from: [number, number] }) => d.from,
        getTargetPosition: (d: { to: [number, number] }) => d.to,
        getSourceColor: [255, 200, 60, 255],
        getTargetColor: [255, 70, 70, 255],
        getWidth: 3,
        getHeight: 0.6,
      }),
    ].filter(Boolean);
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
    void fetch('/countries.geojson')
      .then(r => r.json())
      .then(geo => {
        countriesGeo = geo;
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
        } else if (info.layer?.id === 'origins' && info.object) model.flyToNetwork((info.object as OriginLike).asn);
      },
      layers: [],
      parameters: { clearColor: [0, 0, 0, 0] } as never,
    });
    // Slow rotation while nobody touches the globe; it stops for 8 s after any interaction.
    let raf = 0;
    const spin = (time: number) => {
      now = performance.now();
      if (model.projection === 'globe' && time - lastInteraction > 8000 && !(viewState as { transitionDuration?: number }).transitionDuration) {
        viewState = { ...viewState, longitude: ((Number(viewState.longitude) + 0.025 + 180) % 360) - 180 };
        deck?.setProps({ viewState: viewState as never });
      }
      if (model.pulses.length > 0) apply();
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
    // Redraw whenever a result, a filter or the selection changes.
    void [model.arcs, model.origins, model.countryActivity, model.routeCountries, model.country, model.selectedMoas];
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
