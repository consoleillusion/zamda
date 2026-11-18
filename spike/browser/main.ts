// Browser side of S-301: the WASM module against zamda's JS executor in this
// browser's own engine (V8 or SpiderMonkey), loading included.

import { decodeRoutes } from '../../scripts/bgp/file';
import { compareSize, sample, spikeMarkdown } from '../compare';
import type { SpikeSize } from '../compare';
import { loadWasm } from '../engine';

declare global {
  interface Window {
    __spikeResult?: SpikeSize[];
    __spikeError?: string;
  }
}

function byId(id: string): HTMLElement {
  // Purpose: an element the page is known to contain
  return document.getElementById(id)!;
}

async function main(): Promise<void> {
  // Purpose: load data and the module, run the comparison at each size, show and publish the result
  const params = new URLSearchParams(location.search);
  const sizes = (params.get('rows') ?? '100000,1000000').split(',').map(Number);
  const runs = Number(params.get('runs') ?? 7);
  const routes = await fetch('/data/routes.bin');
  if (!routes.ok) throw new Error(await routes.text());
  const { arrays } = decodeRoutes(new Uint8Array(await routes.arrayBuffer()));
  const wasm = await fetch('/spike.wasm');
  if (!wasm.ok) throw new Error('no /spike.wasm: run `bun run spike:build` first');
  const bytes = await wasm.arrayBuffer();
  const kernels = await loadWasm(bytes);
  const results: SpikeSize[] = [];
  for (const rows of sizes) {
    if (rows > arrays.rowCount) continue;
    byId('status').textContent = `Running at ${rows.toLocaleString()} rows…`;
    byId('log').textContent += `${rows.toLocaleString()} rows\n`;
    results.push(await compareSize(sample(arrays, rows), [{ name: 'wasm', kernels }], runs));
  }
  const browser = navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? 'browser';
  byId('status').textContent = 'Done.';
  byId('report').textContent = `${spikeMarkdown({ runtime: browser, 'wasm size (bytes, uncompressed)': bytes.byteLength, date: new Date().toISOString().slice(0, 10) }, results)}`;
  window.__spikeResult = results;
}

main().catch((error: unknown) => {
  // Purpose: show a failure on the page and for scripted runs
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  byId('status').textContent = `Failed: ${message}`;
  window.__spikeError = message;
});
