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
  let light = $state(false);
  let panelsOpen = $state(true);

  function toggleTheme(): void {
    // Purpose: switch the whole page between the dark and light palettes.
    light = !light;
    document.documentElement.classList.toggle('light', light);
  }

  function togglePanels(): void {
    // Purpose: dock the panels or slide them away for a clean view of the globe.
    panelsOpen = !panelsOpen;
  }

  function onKeydown(event: KeyboardEvent): void {
    // Purpose: keyboard shortcuts, except while the user is typing in a field.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (event.key.toLowerCase() === 'd') toggleTheme();
    if (event.key.toLowerCase() === 'f') togglePanels();
    if (event.key === 'Escape' && !panelsOpen) panelsOpen = true;
  }

  onMount(() => {
    // Exposed for the browser checks in tests/browser.ts and for poking around in the console.
    (globalThis as { zamdaGlobe?: Model }).zamdaGlobe = model;
    void model.start();
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if model.phase === 'ready'}
  <Globe {model} {light} />
{/if}

<div class="corner-controls" class:shifted={panelsOpen}>
  <button class="icon-btn" onclick={toggleTheme} aria-label={light ? 'Switch to dark mode' : 'Switch to light mode'} title={light ? 'Dark mode' : 'Light mode'}>
    {#if light}
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><circle cx="10" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
    {:else}
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M16.5 12.2A7 7 0 0 1 7.8 3.5 7 7 0 1 0 16.5 12.2Z" fill="currentColor" /></svg>
    {/if}
  </button>
  <button class="icon-btn" onclick={togglePanels} aria-label={panelsOpen ? 'Hide panels' : 'Show panels'} title={panelsOpen ? 'Hide panels (F)' : 'Show panels (F)'}>
    {#if panelsOpen}
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M13 3.5v13" stroke="currentColor" stroke-width="1.5" /><rect x="13.6" y="4.1" width="3.4" height="11.8" fill="currentColor" /></svg>
    {:else}
      <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
    {/if}
  </button>
</div>

{#if model.phase === 'ready'}
  <div class="hud" class:hidden={!panelsOpen} aria-hidden={!panelsOpen} inert={!panelsOpen}>
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
      {#if model.routes}
        <p class="source muted">
          {compact(model.routeTotals.routes)} routes from {model.routes.collector} (RIPE RIS) at {utc(model.routes.time)} ·
          {compact(model.updates?.rows ?? 0)} updates recorded over the next {model.updates?.minutes} minutes
        </p>
      {/if}
    </header>

    <aside class="drawer glass" aria-label="Data panels">
      <EnginePanel {model} />
      <SidePanel {model} />
    </aside>

    <Timeline {model} />
    <Learn {model} />
  </div>
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
  .hud { transition: opacity 0.22s ease; }
  .hud.hidden { opacity: 0; pointer-events: none; }

  .drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(var(--drawer-width), 100vw);
    display: flex;
    flex-direction: column;
    border-radius: 0;
    border-top: 0;
    border-right: 0;
    border-bottom: 0;
    z-index: 6;
    transition: transform 0.26s ease;
  }
  .hidden .drawer { transform: translateX(100%); }

  .corner-controls { position: absolute; top: 12px; right: 12px; display: flex; gap: 4px; z-index: 20; transition: right 0.26s ease; }
  .corner-controls.shifted { right: calc(min(var(--drawer-width), 100vw) + 12px); }
  .icon-btn {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: 0;
    color: var(--text);
    cursor: pointer;
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }
  .icon-btn:hover { background: var(--wash-3); }

  .brand { position: absolute; top: 16px; left: 16px; padding: 14px 16px; width: min(440px, calc(100vw - 32px)); z-index: 5; }
  .title { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; font-weight: 700; }
  .title p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .source { margin: 10px 0 0; font-size: 11.5px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--faint); margin-right: 6px; vertical-align: 1px; }
  .dot.live { background: var(--withdraw); box-shadow: 0 0 0 0 var(--withdraw-pulse); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--withdraw-pulse); } 70% { box-shadow: 0 0 0 8px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .loading { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 14px; z-index: 4; }
  .loading p { margin: 0; }
  .err { color: var(--withdraw); font-weight: 600; }
  .bar { width: 320px; height: 4px; background: var(--wash-3); border-radius: 0; overflow: hidden; }
  .bar div { height: 100%; background: linear-gradient(90deg, var(--announce), var(--wasm)); transition: width 0.2s; }
  .spinner { width: 46px; height: 46px; border-radius: 50%; border: 2px solid var(--wash-3); border-top-color: var(--announce); animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
