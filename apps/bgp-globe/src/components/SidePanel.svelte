<script lang="ts">
  // Numbers and lists for the current window, the filters, possible hijacks and an address lookup.
  import type { Model } from '../lib/model.svelte';
  import { compact, flag, parseIp, prefixText } from '../lib/format';
  import { NONE } from '../lib/schemas';

  let { model }: { model: Model } = $props();
  let ipText = $state('8.8.8.8');
  let ipError = $state(false);
  let asQuery = $state('');

  const asResults = $derived(model.searchNetworks(asQuery));
  const selectedIps = $derived(model.hasSelection ? model.observedIps.filter(ip => model.matchesSelection(ip.asn)).length : 0);
  const selectedPaths = $derived(model.hasSelection ? model.routesForSelection().length : 0);
  const selectedGeoPoints = $derived(model.hasSelection ? model.asIps.filter(point => model.matchesSelection(point.asn)).length : 0);
  const countryOptions = $derived.by(() => {
    if (model.networks === null) return [];
    const networks = model.networks;
    type Row = { code: number; name: string; lon: number; lat: number; count: number; asCount: number };
    const byCode = new Map<number, Row>();
    networks.countries.forEach((iso, code) => byCode.set(code, { code, name: model.countryNames.get(iso) ?? iso, lon: 0, lat: 0, count: 0, asCount: 0 }));
    for (let i = 0; i < networks.count; i++) {
      const code = networks.cc[i]!;
      if (code === NONE) continue;
      const row = byCode.get(code)!;
      row.lon += networks.lon[i]!;
      row.lat += networks.lat[i]!;
      row.asCount++;
    }
    const withData = new Set<number>();
    const add = (asn: number) => {
      const i = networks.index.get(asn);
      if (i === undefined || networks.cc[i] === NONE) return;
      const code = networks.cc[i]!;
      const row = byCode.get(code)!;
      if (withData.has(asn)) return;
      withData.add(asn);
      row.count++;
    };
    for (const ip of model.observedIps) add(ip.asn);
    for (const point of model.asIps) add(point.asn);
    return [...byCode.values()].map(row => ({ code: row.code, name: row.name, lon: row.lon / Math.max(1, row.asCount), lat: row.lat / Math.max(1, row.asCount), count: row.count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });

  function chooseCountry(code: number | null): void {
    // Purpose: focus every observed IP and originated route for ASes registered in one country
    const at = code === null ? null : countryOptions.find(option => option.code === code);
    model.selectCountry(code);
    if (at !== undefined && at !== null) model.flyTo(at.lon, at.lat, 1.5);
  }

  function name(asn: number): string {
    // Purpose: a network's registered name
    const n = model.networks!;
    const i = n.index.get(asn);
    return i === undefined ? 'unknown' : n.names[n.nameCode[i]!] || 'unnamed';
  }

  function cc(asn: number): string {
    // Purpose: a network's country as a flag and code
    const n = model.networks!;
    const i = n.index.get(asn);
    if (i === undefined || n.cc[i] === NONE) return '';
    const iso = n.countries[n.cc[i]!]!;
    return `${flag(iso)} ${iso}`;
  }

  const top = $derived([...model.origins].sort((a, b) => b.updates - a.updates || a.asn - b.asn).slice(0, 8));
  const topMax = $derived(Math.max(1, ...top.map(t => t.updates)));
  const withdrawShare = $derived(model.totals.updates === 0 ? 0 : model.totals.withdraws / model.totals.updates);
  const countryLabel = $derived.by(() => {
    if (model.country === null || model.networks === null) return null;
    const iso = model.networks.countries[model.country] ?? '??';
    return `${flag(iso)} ${model.countryNames.get(iso) ?? iso}`;
  });

  function lookup(event: SubmitEvent): void {
    // Purpose: run the longest-prefix match for the typed address
    event.preventDefault();
    const ip = parseIp(ipText);
    ipError = ip === null;
    if (ip !== null) void model.lookupIp(ip);
  }

  function toggleKind(kind: number): void {
    // Purpose: show announcements, withdrawals or both
    const has = model.kinds.includes(kind);
    const next = has ? model.kinds.filter(k => k !== kind) : [...model.kinds, kind];
    model.setFilter({ kinds: next });
  }

  function chooseAsn(asn: number): void {
    // Purpose: focus the globe on one AS's observed IPs and originated paths
    model.selectAsn(asn);
    model.flyToNetwork(asn);
    asQuery = '';
  }

  function searchAsn(event: SubmitEvent): void {
    // Purpose: focus the first search result, or clear when there is no query
    event.preventDefault();
    if (model.selectedAsn !== null && asQuery.trim() === '') {
      model.selectAsn(null);
      return;
    }
    if (asResults[0]) chooseAsn(asResults[0].asn);
  }
</script>

<aside class="side">
  <section>
    <h2>Physical route layers</h2>
    <div class="legend">
      <div><i class="sw solid"></i><span><b>BGP next hop</b> — observed UPDATE hop, or a RIB prefix with its AS's RIS peer address as next hop. Thin lines run through every AS on the path, not straight to the peer.</span></div>
      <div><i class="sw dashed"></i><span><b>Inferred physical route</b> — every distinct candidate cable path between the same consecutive ASes, merged into one line per candidate. BGP did not observe the cable path.</span></div>
      <div><i class="sw cable"></i><span><b>Submarine cables</b> — background geometry only, never a claim that traffic uses that cable.</span></div>
    </div>
    <p class="muted hint">IP locations: <a href="https://db-ip.com" target="_blank" rel="noreferrer">DB-IP</a> (CC BY 4.0) and operator geofeeds.</p>
    <label class="tick"><input type="checkbox" bind:checked={model.showCables} /> Show cable geometry</label>
    <label class="detail-level">
      Path detail
      <select bind:value={model.pathDetail}>
        <option value="as-paths">AS numbers only</option>
        <option value="ips-geoip">Router IPs plus GeoIP</option>
      </select>
    </label>
  </section>

  <section>
    <h2>{model.mode === 'live' ? 'Last two minutes' : 'In the window'}</h2>
    <div class="cards">
      <div><span class="num">{compact(model.totals.updates)}</span><small>updates</small></div>
      <div><span class="num">{compact(model.totals.prefixes)}</span><small>prefixes</small></div>
      <div><span class="num">{compact(model.totals.networks)}</span><small>origin networks</small></div>
      <div><span class="num">{model.totals.peers}</span><small>RIS peers</small></div>
    </div>
    <div class="split" title="announcements vs withdrawals">
      <div class="a" style="flex: {1 - withdrawShare}"></div>
      <div class="w" style="flex: {withdrawShare}"></div>
    </div>
    <div class="splitlabels"><span class="ann">{compact(model.totals.updates - model.totals.withdraws)} announced</span><span class="wd">{compact(model.totals.withdraws)} withdrawn</span></div>
  </section>

  <section>
    <h2>Network focus</h2>
    <label class="detail-level">
      Country
      <select value={model.selectedCountry ?? ''} onchange={e => chooseCountry(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}>
        <option value="">All countries</option>
        {#each countryOptions as option (option.code)}
          <option value={option.code}>{option.name} ({option.count})</option>
        {/each}
      </select>
    </label>
    <form onsubmit={searchAsn}>
      <input class="mono" bind:value={asQuery} placeholder="AS1564, name or country" spellcheck="false" />
      <button type="submit">Focus</button>
    </form>
    {#if model.selectedAsn !== null || model.selectedCountry !== null}
      <div class="focus-chip">
        <span>
          {#if model.selectedAsn !== null}
            <b>AS{model.selectedAsn}</b> {name(model.selectedAsn)} {cc(model.selectedAsn)}
          {:else}
            <b>{countryOptions.find(option => option.code === model.selectedCountry)?.name ?? 'Country'}</b> · all BGP ASes
          {/if}
        </span>
        <button aria-label="clear network focus" onclick={() => { model.selectAsn(null); model.selectCountry(null); }}>✕</button>
      </div>
      <p class="muted hint">{selectedIps} observed IPs · {selectedGeoPoints} geolocated blocks · {selectedPaths} advertised paths</p>
    {/if}
    {#if asQuery.trim().length > 0}
      <ol class="list">
        {#each asResults as result (result.asn)}
          <li>
            <button onclick={() => chooseAsn(result.asn)}>
              <span class="who"><b>AS{result.asn}</b> {result.name}</span>
              <span class="cc">{result.country}</span>
            </button>
          </li>
        {:else}
          <li class="muted">no matching network</li>
        {/each}
      </ol>
    {/if}
  </section>

  <section>
    <h2>Filter</h2>
    <div class="filters">
      <div class="seg">
        <button class:on={model.kinds.includes(0)} onclick={() => toggleKind(0)}><span class="sw ann"></span>Announce</button>
        <button class:on={model.kinds.includes(1)} onclick={() => toggleKind(1)}><span class="sw wd"></span>Withdraw</button>
      </div>
      <label class="len">
        prefixes /{model.lenRange[0]} to /{model.lenRange[1]}
        <span class="ranges">
          <input type="range" min="0" max="32" value={model.lenRange[0]} oninput={e => model.setFilter({ lenRange: [Math.min(Number(e.currentTarget.value), model.lenRange[1]), model.lenRange[1]] })} />
          <input type="range" min="0" max="32" value={model.lenRange[1]} oninput={e => model.setFilter({ lenRange: [model.lenRange[0], Math.max(Number(e.currentTarget.value), model.lenRange[0])] })} />
        </span>
      </label>
      {#if countryLabel}<span class="chip">{countryLabel}<button aria-label="clear country" onclick={() => model.setFilter({ country: null })}>✕</button></span>{:else}<span class="muted hint">click a country to filter</span>{/if}
    </div>
  </section>

  <section>
    <h2>Busiest networks</h2>
    <ol class="list">
      {#each top as row (row.asn)}
        <li>
          <button onclick={() => model.flyToNetwork(row.asn)}>
            <span class="bar" style="width: {(row.updates / topMax) * 100}%; background: linear-gradient(90deg, var(--announce), {row.withdraws / row.updates > 0.3 ? 'var(--withdraw)' : 'var(--announce)'})"></span>
            <span class="who"><b>AS{row.asn}</b> {name(row.asn)}</span>
            <span class="num n">{compact(row.updates)}</span>
            <span class="cc">{cc(row.asn)}</span>
          </button>
        </li>
      {:else}
        <li class="muted">no updates in the window</li>
      {/each}
    </ol>
  </section>

  <section>
    <h2>Possible hijacks <span class="muted" title="Multiple Origin AS: one prefix announced by more than one network. Often legitimate (anycast, migrations), sometimes a hijack or leak.">(MOAS) ⓘ</span></h2>
    <ol class="list moas">
      {#each model.moas.slice(0, 6) as row (row.addr * 64 + row.len)}
        <li>
          <button class:on={model.selectedMoas?.row.addr === row.addr && model.selectedMoas?.row.len === row.len} onclick={() => void model.selectMoas(row)}>
            <span class="who mono">{prefixText(row.addr, row.len)}</span>
            <span class="num n">{row.origins} origins</span>
          </button>
        </li>
      {:else}
        <li class="muted">no prefix had two origins in the window</li>
      {/each}
    </ol>
    {#if model.selectedMoas}
      <div class="detail">
        <b class="mono">{prefixText(model.selectedMoas.row.addr, model.selectedMoas.row.len)}</b> was announced by:
        {#each model.selectedMoas.origins as o (o.asn)}
          <button class="link" onclick={() => model.flyToNetwork(o.asn)}>AS{o.asn} {name(o.asn)} {cc(o.asn)} <span class="muted">×{o.updates}</span></button>
        {/each}
        <button class="close" onclick={() => void model.selectMoas(null)}>close</button>
      </div>
    {/if}
  </section>

  <section>
    <h2>Who routes an address?</h2>
    <form onsubmit={lookup}>
      <input class="mono" class:bad={ipError} bind:value={ipText} placeholder="e.g. 1.1.1.1" spellcheck="false" />
      <button type="submit">Look up</button>
    </form>
    {#if model.lookup}
      {#if model.lookup.matches.length === 0}
        <p class="muted">No route covers this address: it is unreachable from the Internet.</p>
      {:else}
        <ol class="matches">
          {#each model.lookup.matches as m, i (m.addr * 64 + m.len)}
            <li class:best={i === 0}>
              <span class="mono">{prefixText(m.addr, m.len)}</span>
              <button class="link" onclick={() => model.flyToNetwork(m.origin)}>AS{m.origin} {name(m.origin)} {cc(m.origin)}</button>
              <span class="muted">{i === 0 ? `chosen: most specific · path ${m.pathLen} hops` : 'less specific'}</span>
            </li>
          {/each}
        </ol>
      {/if}
    {/if}
  </section>
</aside>

<style>
  .side { flex: none; padding: 14px 16px; display: flex; flex-direction: column; gap: 16px; border-top: 1px solid var(--line); }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .cards div { background: var(--wash-1); border: 1px solid var(--line); border-radius: 0; padding: 8px 10px; display: flex; flex-direction: column; }
  .cards .num { font-size: 18px; font-weight: 600; }
  .cards small { color: var(--muted); font-size: 11px; }
  .split { display: flex; height: 6px; border-radius: 0; overflow: hidden; margin-top: 10px; background: var(--wash-2); }
  .split .a { background: var(--announce); transition: flex 0.3s; }
  .split .w { background: var(--withdraw); transition: flex 0.3s; }
  .splitlabels { display: flex; justify-content: space-between; font-size: 11.5px; margin-top: 4px; font-family: var(--mono); }
  .ann { color: var(--announce); }
  .wd { color: var(--withdraw); }
  .sw { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .sw.ann { background: var(--announce); }
  .sw.wd { background: var(--withdraw); }
  .legend .sw { flex: none; width: 20px; height: 0; margin: 7px 0 0; border-radius: 0; border-top-width: 2px; }
  .filters { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .len { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; width: 100%; }
  .ranges { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  input[type='range'] { accent-color: var(--announce); width: 100%; }
  .hint { font-size: 12px; }
  .focus-chip { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding: 7px 9px; border: 1px solid var(--accent-border); background: var(--accent-wash-soft); font-size: 12px; }
  .focus-chip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .focus-chip button { flex: none; background: none; border: 0; color: var(--muted); cursor: pointer; padding: 0 2px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .list button { position: relative; display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; width: 100%; text-align: left; background: var(--wash-1); border: 1px solid transparent; border-radius: 0; padding: 6px 8px; cursor: pointer; overflow: hidden; }
  .list button:hover, .list button.on { border-color: var(--line-strong); }
  .list .bar { position: absolute; left: 0; bottom: 0; height: 2px; opacity: 0.85; }
  .who { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .n { font-size: 12px; color: var(--muted); }
  .cc { grid-column: 1 / -1; font-size: 11px; color: var(--faint); }
  .moas .who { color: var(--amber); }
  .detail { margin-top: 8px; font-size: 12px; line-height: 1.6; padding: 8px 10px; border-radius: 0; border: 1px solid var(--amber-border); background: var(--amber-wash); }
  .link { display: block; background: none; border: 0; padding: 0; color: var(--text); cursor: pointer; text-align: left; font-size: 12px; }
  .link:hover { color: var(--announce); }
  .close { margin-top: 4px; background: none; border: 0; color: var(--muted); cursor: pointer; padding: 0; font-size: 11px; }
  form { display: flex; gap: 6px; }
  form input { flex: 1; background: var(--wash-input); border: 1px solid var(--line-strong); border-radius: 0; padding: 7px 10px; color: var(--text); outline: none; }
  form input:focus { border-color: var(--announce); }
  form input.bad { border-color: var(--withdraw); }
  form button { background: var(--accent-wash); border: 1px solid var(--accent-border); border-radius: 0; padding: 0 12px; cursor: pointer; }
  .matches { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .matches li { padding: 6px 8px; border-radius: 0; border: 1px solid var(--line); opacity: 0.7; }
  .matches li.best { opacity: 1; border-color: var(--accent-border); background: var(--accent-wash-soft); }
  .matches .muted { font-size: 11px; }
  .legend { display: flex; flex-direction: column; gap: 7px; font-size: 11.5px; line-height: 1.45; color: var(--muted); }
  .legend div { display: flex; gap: 8px; align-items: flex-start; }
  .legend b { color: var(--text); font-weight: 600; }
  .sw.solid { border-top-style: solid; border-color: var(--announce); }
  .sw.dashed { border-top-style: dashed; border-color: var(--amber); }
  .sw.cable { border-top-style: solid; border-color: var(--faint); opacity: 0.7; }
  .tick { display: inline-flex; align-items: center; gap: 7px; margin-top: 10px; font-size: 12px; cursor: pointer; }
  .tick input { accent-color: var(--announce); }
  .detail-level { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 12px; color: var(--muted); }
  .detail-level select { background: var(--wash-input); color: var(--text); border: 1px solid var(--line-strong); border-radius: 0; padding: 5px 7px; font: inherit; font-size: 12px; }
</style>
