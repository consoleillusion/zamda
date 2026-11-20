<script lang="ts">
  // The page: the map behind everything, controls and panels floating over it.
  import { onMount } from 'svelte';
  import { Model } from '../lib/model.svelte';
  import Globe from './Globe.svelte';
  import EnginePanel from './EnginePanel.svelte';
  import SidePanel from './SidePanel.svelte';
  import Timeline from './Timeline.svelte';
  import Learn from './Learn.svelte';
  import { compact, utc } from '../lib/format';

  const model = new Model();
  onMount(() => {
    // Exposed for the browser checks in tests/browser.ts and for poking around in the console.
    (globalThis as { zamdaGlobe?: Model }).zamdaGlobe = model;
    void model.start();
  });
</script>

{#if model.phase === 'ready'}
  <Globe {model} />
{/if}

<header class="brand glass">
  <div class="title">
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="var(--announce)" stroke-width="2.4" /><path d="M3 16h26M16 3c-6 7-6 19 0 26M16 3c6 7 6 19 0 26" stroke="var(--announce)" stroke-width="1.6" fill="none" /></svg>
    <div>
      <h1>Live Internet</h1>
      <p>How the world's networks tell each other where every IPv4 address lives.</p>
    </div>
  </div>
  <div class="row">
    <div class="seg" role="tablist" aria-label="Mode">
      <button class:on={model.mode === 'replay'} onclick={() => model.setMode('replay')}>Replay an hour</button>
      <button class:on={model.mode === 'live'} onclick={() => model.setMode('live')}><span class="dot" class:live={model.mode === 'live'}></span>Live</button>
    </div>
    <div class="seg" aria-label="Projection">
      <button class:on={model.projection === 'globe'} onclick={() => (model.projection = 'globe')}>Globe</button>
      <button class:on={model.projection === 'mercator'} onclick={() => (model.projection = 'mercator')}>Mercator</button>
    </div>
  </div>
  {#if model.phase === 'ready' && model.routes}
    <p class="source muted">
      {compact(model.routeTotals.routes)} routes from {model.routes.collector} (RIPE RIS) at {utc(model.routes.time)} ·
      {compact(model.updates?.rows ?? 0)} updates recorded over the next {model.updates?.minutes} minutes
    </p>
  {/if}
</header>

{#if model.phase === 'ready'}
  <div class="right">
    <EnginePanel {model} />
    <SidePanel {model} />
  </div>
  <Timeline {model} />
  <Learn {model} />
{:else if model.phase === 'loading'}
  <div class="loading">
    <div class="spinner"></div>
    <p>{model.loadText}</p>
    <div class="bar"><div style="width: {Math.round(model.loadFraction * 100)}%"></div></div>
  </div>
{:else}
  <div class="loading">
    <p class="err">Could not load the data</p>
    <p class="muted">{model.error}</p>
  </div>
{/if}

<style>
  .right { position: absolute; top: 16px; right: 16px; bottom: 150px; width: 340px; display: flex; flex-direction: column; gap: 12px; z-index: 5; pointer-events: none; }
  .right > :global(*) { pointer-events: auto; }
  .brand { position: absolute; top: 16px; left: 16px; padding: 14px 16px; width: min(440px, calc(100vw - 32px)); z-index: 5; }
  .title { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; font-weight: 700; }
  .title p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .source { margin: 10px 0 0; font-size: 11.5px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--faint); margin-right: 6px; vertical-align: 1px; }
  .dot.live { background: var(--withdraw); box-shadow: 0 0 0 0 rgba(255, 92, 138, 0.7); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255, 92, 138, 0.6); } 70% { box-shadow: 0 0 0 8px rgba(255, 92, 138, 0); } 100% { box-shadow: 0 0 0 0 rgba(255, 92, 138, 0); } }
  .loading { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 14px; z-index: 4; }
  .loading p { margin: 0; }
  .err { color: var(--withdraw); font-weight: 600; }
  .bar { width: 320px; height: 4px; background: rgba(255, 255, 255, 0.08); border-radius: 4px; overflow: hidden; }
  .bar div { height: 100%; background: linear-gradient(90deg, var(--announce), var(--wasm)); transition: width 0.2s; }
  .spinner { width: 46px; height: 46px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.08); border-top-color: var(--announce); animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
