<script lang="ts">
  // The explainer, kept out of the way until the info control in the drawer is hovered or focused.
  import type { Model } from '../lib/model.svelte';
  import { compact } from '../lib/format';

  let { model }: { model: Model } = $props();
  let index = $state(0);
  let open = $state(false);

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
      body: `The table holds ${compact(model.routeTotals.routes)} IPv4 prefixes covering ${compact(model.routeTotals.addresses)} addresses. A /24 is 256 addresses, a /16 is 65,536. A router picks the most specific prefix that covers an address: try the lookup below.`,
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

<span
  class="info-wrap"
  role="group"
  aria-label="What you are looking at"
  onpointerenter={() => (open = true)}
  onpointerleave={() => (open = false)}
  onfocusin={() => (open = true)}
  onfocusout={() => (open = false)}
>
  <button class="info" aria-label="What you are looking at" aria-expanded={open} title="What you are looking at">ⓘ</button>
  {#if open}
    <div class="tip" role="tooltip">
      <div class="tip-head"><b>{cards[index]!.title}</b><span>{index + 1}/{cards.length}</span></div>
      <p>{cards[index]!.body}</p>
      <div class="tip-nav">
        <button aria-label="Previous" onclick={() => (index = (index + cards.length - 1) % cards.length)}>‹</button>
        <button aria-label="Next" onclick={() => (index = (index + 1) % cards.length)}>›</button>
      </div>
    </div>
  {/if}
</span>

<style>
  .info-wrap { position: relative; display: inline-flex; }
  .info { width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 0; background: var(--wash-1); color: var(--muted); cursor: pointer; font-size: 14px; }
  .info:hover, .info:focus-visible { color: var(--text); border-color: var(--line-strong); outline: none; }
  .tip { position: absolute; left: 0; top: calc(100% + 6px); width: 300px; padding: 10px 12px; z-index: 30; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 0; color: var(--text); }
  .tip-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; }
  .tip-head span { color: var(--faint); font-family: var(--mono); }
  .tip p { margin: 6px 0 8px; font-size: 12px; line-height: 1.5; color: var(--learn-text); }
  .tip-nav { display: flex; justify-content: flex-end; gap: 6px; }
  .tip-nav button { width: 22px; height: 20px; padding: 0; border: 1px solid var(--line); border-radius: 0; background: var(--wash-1); color: var(--muted); cursor: pointer; line-height: 1; }
  .tip-nav button:hover { color: var(--text); border-color: var(--line-strong); }
</style>
