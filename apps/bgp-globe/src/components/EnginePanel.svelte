<script lang="ts">
  // The engine switch and what it costs: every frame's queries timed on the engine that ran them.
  import type { Model } from '../lib/model.svelte';
  import { compact, ms } from '../lib/format';

  let { model }: { model: Model } = $props();

  function median(values: readonly number[]): number | null {
    // Purpose: the middle value of the recent frames, which ignores the odd slow one
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  function spark(values: readonly number[], max: number): string {
    // Purpose: an SVG polyline of recent frame times
    if (values.length < 2) return '';
    return values.map((v, i) => `${((i / (values.length - 1)) * 200).toFixed(1)},${(44 - Math.min(1, v / max) * 40).toFixed(1)}`).join(' ');
  }

  const js = $derived(median(model.history.js));
  const wasm = $derived(median(model.history.wasm));
  const max = $derived(Math.max(16, ...model.history.js, ...model.history.wasm));
  const speedup = $derived(js !== null && wasm !== null && wasm > 0 ? js / wasm : null);
  const budget = $derived(model.frameMs <= 16.7 ? 'smooth' : model.frameMs <= 50 ? 'interactive' : 'sluggish');
</script>

<section class="engine" aria-label="Engine">
  <div class="head">
    <h2>Query engine</h2>
    <div class="seg">
      <button class:on={model.engine === 'js'} onclick={() => model.setEngine('js')}><span class="sw js"></span>JS</button>
      <button class:on={model.engine === 'wasm'} disabled={!model.wasmReady} title={model.wasmReady ? 'Rust compiled to WebAssembly, in a Web Worker' : model.wasmStatus} onclick={() => model.setEngine('wasm')}><span class="sw wasm"></span>WASM</button>
    </div>
  </div>
  <div class="big">
    <span class="num value" class:slow={budget === 'sluggish'}>{ms(model.frameMs)}</span>
    <span class="muted">per frame · {budget}</span>
  </div>
  <p class="what muted">
    {model.engine === 'wasm' ? 'Rust → WebAssembly in a Web Worker: the page never waits for it.' : 'The JS reference executor, on this page’s own thread.'}
    Each frame runs 5 compiled zamda plans (filter, group, count, distinct, sort) over
    <b class="num">{compact(model.rowsPerFrame / 5)}</b> rows: <b class="num">{compact(model.rowsPerFrame)}</b> rows scanned,
    {model.framesPerSecond.toFixed(1)} frames/s.
  </p>
  <svg viewBox="0 0 200 46" class="spark" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="200" y1={44 - (16.7 / max) * 40} y2={44 - (16.7 / max) * 40} class="budget" />
    <polyline points={spark(model.history.js, max)} class="js" />
    <polyline points={spark(model.history.wasm, max)} class="wasm" />
  </svg>
  <div class="legend">
    <span><span class="sw js"></span>JS {js === null ? '—' : ms(js)}</span>
    <span><span class="sw wasm"></span>WASM {wasm === null ? (model.wasmReady ? '—' : model.wasmStatus) : ms(wasm)}</span>
    {#if speedup !== null}<span class="speed">WASM {speedup.toFixed(1)}× faster</span>{:else}<span class="muted">switch engines to compare</span>{/if}
  </div>
</section>

<style>
  .engine { padding: 14px 16px; flex: none; }
  .head { display: flex; justify-content: space-between; align-items: center; }
  .head h2 { margin: 0; }
  .big { display: flex; align-items: baseline; gap: 10px; margin: 10px 0 4px; }
  .value { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
  .value.slow { color: var(--withdraw); }
  .what { margin: 0 0 8px; font-size: 12px; line-height: 1.5; }
  .what b { color: var(--text); font-weight: 600; }
  .spark { width: 100%; height: 46px; display: block; }
  .spark polyline { fill: none; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
  .spark .js { stroke: var(--js); }
  .spark .wasm { stroke: var(--wasm); }
  .budget { stroke: var(--wash-4); stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .legend { display: flex; gap: 12px; font-size: 12px; margin-top: 6px; flex-wrap: wrap; font-family: var(--mono); }
  .speed { color: var(--wasm); font-weight: 600; margin-left: auto; }
  .sw { display: inline-block; width: 8px; height: 8px; border-radius: 0; margin-right: 6px; }
  .sw.js { background: var(--js); }
  .sw.wasm { background: var(--wasm); }
</style>
