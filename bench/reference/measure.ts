// Timing helpers shared by the Bun runner and the browser page: nothing here
// touches Node, so it bundles for a browser unchanged.

export interface Timing {
  readonly median: number;
  readonly min: number;
  readonly runs: number;
}

export function summarise(times: number[]): Timing {
  // Purpose: median and best of a list of timings in ms
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[sorted.length >> 1]!, min: sorted[0]!, runs: times.length };
}

export async function measure(run: () => unknown, runs: number): Promise<Timing> {
  // Purpose: time a function: two warm-up runs, then `runs` timed runs (3 if one run takes over half a second)
  await run();
  await run();
  const first = performance.now();
  await run();
  const slow = performance.now() - first > 500;
  const times: number[] = [];
  const n = slow ? Math.min(3, runs) : runs;
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return summarise(times);
}

export async function once(run: () => unknown, runs: number): Promise<Timing> {
  // Purpose: time a one-off cost such as loading, repeated a few times with fresh work each time
  const times: number[] = [];
  for (let i = 0; i < Math.min(runs, 5); i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return summarise(times);
}
