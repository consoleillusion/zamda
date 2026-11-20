<script lang="ts">
  // Short explanations of what the page shows, one at a time.
  import type { Model } from '../lib/model.svelte';
  import { compact } from '../lib/format';

  let { model }: { model: Model } = $props();
  let index = $state(0);
  let open = $state(true);

  const cards = $derived([
    {
      title: 'What you are looking at',
      body: `The Internet is about ${compact(model.routeTotals.networks)} independent networks (autonomous systems, ASes). They use BGP to tell each other which blocks of addresses (prefixes) they can reach. Each dot is a network; its size is how many routing updates it caused in the window.`,
    },
    {
      title: 'Announce and withdraw',
      body: 'An announcement says “send traffic for this prefix my way, via this path”. A withdrawal takes that back. Teal is announcements, pink is withdrawals. A burst of pink often means an outage or a cable cut somewhere.',
    },
    {
      title: 'The arcs',
      body: 'RIPE RIS collectors listen to BGP from networks around the world (the peers). An arc joins the peer that sent an update to the network that originates the prefix. It shows who learns about whom, not where cables run.',
    },
    {
      title: 'Prefixes and the routing table',
      body: `The table holds ${compact(model.routeTotals.routes)} IPv4 prefixes covering ${compact(model.routeTotals.addresses)} addresses. A /24 is 256 addresses, a /16 is 65,536. A router picks the most specific prefix that covers an address: try the lookup on the right.`,
    },
    {
      title: 'Possible hijacks',
      body: 'When two networks announce the same prefix, traffic may go to the wrong one. That is sometimes deliberate (anycast, a move between providers) and sometimes a hijack or a leak. The list shows prefixes with more than one origin in the window.',
    },
    {
      title: 'Why the engine matters',
      body: 'Every scrub, play step and click re-runs five queries over millions of rows: filter by time, group by network, count distinct prefixes, sort the busiest arcs. Switch between JS and WASM and watch the frame time: the same compiled zamda plans, the same answers, a different engine.',
    },
  ]);
</script>

{#if open}
  <section class="learn glass">
    <div class="head">
      <h2>{index + 1}/{cards.length} · {cards[index]!.title}</h2>
      <button class="x" aria-label="close" onclick={() => (open = false)}>✕</button>
    </div>
    <p>{cards[index]!.body}</p>
    <div class="nav">
      <button onclick={() => (index = (index + cards.length - 1) % cards.length)}>‹ Back</button>
      <div class="dots">{#each cards as _, i (i)}<button class:on={i === index} aria-label="card {i + 1}" onclick={() => (index = i)}></button>{/each}</div>
      <button onclick={() => (index = (index + 1) % cards.length)}>Next ›</button>
    </div>
  </section>
{:else}
  <button class="reopen glass" onclick={() => (open = true)}>ⓘ How to read this</button>
{/if}

<style>
  .learn { position: absolute; left: 16px; bottom: 150px; width: 360px; padding: 14px 16px; z-index: 5; }
  .head { display: flex; justify-content: space-between; align-items: start; }
  .x { background: none; border: 0; color: var(--muted); cursor: pointer; }
  p { margin: 0 0 10px; font-size: 13px; line-height: 1.55; color: #c9d6ee; min-height: 80px; }
  .nav { display: flex; align-items: center; justify-content: space-between; }
  .nav > button { background: none; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; cursor: pointer; color: var(--muted); font-size: 12px; }
  .nav > button:hover { color: var(--text); border-color: var(--line-strong); }
  .dots { display: flex; gap: 5px; }
  .dots button { width: 6px; height: 6px; border-radius: 50%; border: 0; padding: 0; background: rgba(255, 255, 255, 0.2); cursor: pointer; }
  .dots button.on { background: var(--announce); }
  .reopen { position: absolute; left: 16px; bottom: 150px; padding: 8px 12px; cursor: pointer; z-index: 5; font-size: 12.5px; }
  @media (max-width: 900px) { .learn, .reopen { display: none; } }
</style>
