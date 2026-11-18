// Browser side of the runtime comparison (T-223). Loads the routes file, runs
// the same measurements as `bun run bench:compare`, shows a markdown report and
// exposes the result as window.__benchResult for scripted runs.

import { decodeRoutes } from '../../../scripts/bgp/file';
import { comparisonMarkdown, runComparison } from '../compare';
import type { Comparison } from '../compare';

declare global {
  interface Window {
    __benchResult?: Comparison;
    __benchError?: string;
  }
}

function byId(id: string): HTMLElement {
  // Purpose: an element the page is known to contain
  return document.getElementById(id)!;
}

async function main(): Promise<void> {
  // Purpose: load data, run the comparison, show and publish the result
  const params = new URLSearchParams(location.search);
  const rows = Number(params.get('rows') ?? 1_000_000);
  const runs = Number(params.get('runs') ?? 7);
  const response = await fetch('/data/routes.bin');
  if (!response.ok) throw new Error(await response.text());
  const { arrays } = decodeRoutes(new Uint8Array(await response.arrayBuffer()));
  byId('status').textContent = `Running at ${Math.min(rows, arrays.rowCount).toLocaleString()} rows…`;
  const log = (line: string): void => {
    // Purpose: show progress
    byId('log').textContent += `${line}\n`;
  };
  const result = await runComparison(arrays, rows, runs, `${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? 'browser'}`, log);
  byId('status').textContent = 'Done.';
  byId('report').textContent = comparisonMarkdown(result);
  window.__benchResult = result;
}

main().catch((error: unknown) => {
  // Purpose: show a failure on the page and for scripted runs
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  byId('status').textContent = `Failed: ${message}`;
  window.__benchError = message;
});
