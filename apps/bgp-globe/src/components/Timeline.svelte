<script lang="ts">
  // Replay: the recorded hour as stacked bars (announcements and withdrawals per 20 s), the window as a
  // draggable band, play controls. Live: the feed's status and rate.
  import type { Model } from '../lib/model.svelte';
  import { clock, compact, utc } from '../lib/format';

  let { model }: { model: Model } = $props();
  let svg = $state<SVGSVGElement | null>(null);
  let dragging = false;

  const W = 1000;
  const H = 56;
  const bars = $derived.by(() => {
    const { announce, withdraw } = model.timeline;
    let max = 1;
    for (let i = 0; i < announce.length; i++) max = Math.max(max, announce[i]! + withdraw[i]!);
    const n = announce.length || 1;
    const w = W / n;
    const out: { x: number; w: number; a: number; d: number }[] = [];
    for (let i = 0; i < announce.length; i++) out.push({ x: i * w, w: Math.max(0.5, w - 0.6), a: (announce[i]! / max) * H, d: (withdraw[i]! / max) * H });
    return out;
  });
  const x = (t: number) => (t / model.duration) * W;

  function at(event: PointerEvent): number {
    // Purpose: the recording time under the pointer
    const r = svg!.getBoundingClientRect();
    return ((event.clientX - r.left) / r.width) * model.duration;
  }

  function down(event: PointerEvent): void {
    // Purpose: start scrubbing
    dragging = true;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    model.playing = false;
    model.seek(at(event) + model.span / 2);
  }

  function move(event: PointerEvent): void {
    // Purpose: scrub: every move re-runs the frame's queries for the new window
    if (dragging) model.seek(at(event) + model.span / 2);
  }

  const spans = [15, 60, 300, 900];
  const speeds = [1, 20, 60, 300];
</script>

<footer class="timeline glass">
  {#if model.mode === 'replay'}
    <div class="controls">
      <button class="play" onclick={() => model.togglePlay()} aria-label={model.playing ? 'pause' : 'play'}>
        {#if model.playing}<svg viewBox="0 0 16 16" width="14"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>{:else}<svg viewBox="0 0 16 16" width="14"><path d="M4 2.5v11l9-5.5z" /></svg>{/if}
      </button>
      <div class="when">
        <span class="num t">{clock(model.t)}</span>
        <span class="muted">{model.updates ? utc(model.updates.start + model.t) : ''}</span>
      </div>
      <label>window <span class="seg">{#each spans as s (s)}<button class:on={model.span === s} onclick={() => model.setSpan(s)}>{s < 60 ? `${s}s` : `${s / 60}m`}</button>{/each}</span></label>
      <label>speed <span class="seg">{#each speeds as s (s)}<button class:on={model.speed === s} onclick={() => (model.speed = s)}>{s}×</button>{/each}</span></label>
      <span class="hint muted">drag on the timeline to scrub · every position is a fresh query over all {compact(model.updates?.rows ?? 0)} updates</span>
    </div>
    <svg bind:this={svg} viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="bars" onpointerdown={down} onpointermove={move} onpointerup={() => (dragging = false)} role="slider" aria-valuemin={0} aria-valuemax={model.duration} aria-valuenow={model.t} tabindex="0" aria-label="replay position">
      {#each bars as b, i (i)}
        <rect x={b.x} y={H - b.a - b.d} width={b.w} height={b.a} class="a" />
        <rect x={b.x} y={H - b.d} width={b.w} height={b.d} class="d" />
      {/each}
      <rect x={x(model.t - model.span)} y="0" width={Math.max(2, x(model.span))} height={H} class="window" />
      <line x1={x(model.t)} x2={x(model.t)} y1="0" y2={H} class="head" />
    </svg>
  {:else}
    <div class="live">
      <span class="dot"></span>
      <b>{model.liveSource === 'ris-live' ? 'Live from RIPE RIS' : model.liveSource === 'recorded' ? 'Recorded hour, played back live' : 'Connecting to RIS Live…'}</b>
      <span class="muted">{model.liveMessage}</span>
      <span class="num">{Math.round(model.liveRate).toLocaleString('en')} prefix updates/s</span>
      <span class="num">{compact(model.liveRows)} in the log</span>
      <span class="num">{compact(model.routeChanges)} routing-table changes applied (keyed upsert/delete on both engines)</span>
    </div>
  {/if}
</footer>

<style>
  .timeline { position: absolute; left: 16px; right: calc(min(var(--drawer-width), 100vw) + 12px); bottom: 16px; padding: 12px 16px; z-index: 5; }
  .controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
  .play { width: 36px; height: 36px; border-radius: 0; border: 1px solid var(--line-strong); background: var(--accent-wash); display: grid; place-items: center; cursor: pointer; }
  .play svg { fill: var(--text); }
  .when { display: flex; flex-direction: column; line-height: 1.2; min-width: 120px; }
  .t { font-size: 18px; font-weight: 600; }
  .when .muted { font-size: 11px; }
  label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .seg button { padding: 4px 8px; font-size: 12px; }
  .hint { font-size: 11.5px; margin-left: auto; }
  .bars { width: 100%; height: 64px; display: block; cursor: ew-resize; touch-action: none; }
  .bars .a { fill: var(--accent-bar); }
  .bars .d { fill: var(--withdraw-bar); }
  .bars .window { fill: var(--wash-2); stroke: var(--muted); stroke-opacity: 0.6; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .bars .head { stroke: var(--amber); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .live { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 13px; }
  .live .num { font-size: 12.5px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--withdraw); animation: blink 1.4s infinite; }
  @keyframes blink { 50% { opacity: 0.3; } }
  @media (max-width: 900px) { .timeline { right: 16px; } }
</style>
