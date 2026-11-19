// Pure helpers behind the dashboard's engine-race panel: timing summaries,
// bounded bar widths, a small sparkline and the engine phase breakdown. No DOM
// here, so the arithmetic that turns measurements into marks is tested directly.

export interface RaceSample {
  readonly label: string;
  readonly jsMs: number;
  readonly wasmMs: number | null;
  readonly fallbacks: number;
  readonly cacheHits: number;
}

export const PHASES = ['prepare', 'tables', 'start', 'steps', 'read'] as const;
export type PhaseName = (typeof PHASES)[number];
export type PhaseTimes = Readonly<Record<PhaseName, number>>;

export function speedup(sample: RaceSample): number | null {
  // Purpose: how many times faster WASM was than JS on the same interaction
  if (sample.wasmMs === null || sample.jsMs <= 0 || sample.wasmMs <= 0) return null;
  return sample.jsMs / sample.wasmMs;
}

export function formatSpeedup(value: number | null): string {
  // Purpose: a compact, honest speedup label, including "—" when there is no comparison
  if (value === null || !Number.isFinite(value)) return '—';
  if (value >= 10) return `${Math.round(value)}×`;
  if (value >= 1) return `${value.toFixed(1)}×`;
  return `${value.toFixed(2)}×`;
}

export function formatMs(ms: number): string {
  // Purpose: sub-ten measurements keep one decimal, larger ones read as whole milliseconds
  if (ms <= 0) return '0 ms';
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function raceWidth(ms: number, max: number): number {
  // Purpose: a 0–100 track width clamped to the current scale
  if (!Number.isFinite(ms) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (ms / max) * 100));
}

export function sparkline(
  samples: readonly RaceSample[],
  field: 'jsMs' | 'wasmMs',
  width: number,
  height: number,
): string {
  // Purpose: one SVG path through the available samples, keeping gaps in their original time positions
  const points: string[] = [];
  const values = samples
    .map(sample => sample[field])
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < 2) return '';
  const max = Math.max(...values);
  const pad = 3;
  const usable = Math.max(1, height - 2 * pad);
  samples.forEach(function (sample, i) {
    // Purpose: place each sample on the shared x axis, skipping engines that did not run
    const value = sample[field];
    if (value === null || !Number.isFinite(value)) return;
    const x = samples.length === 1 ? width / 2 : (i / (samples.length - 1)) * width;
    const y = pad + (1 - value / max) * usable;
    points.push(`${points.length === 0 ? 'M' : 'L'}${x.toFixed(0)},${y.toFixed(0)}`);
  });
  return points.join(' ');
}

export function phasePercentages(times: PhaseTimes): readonly number[] {
  // Purpose: the five engine phases as whole percentages that always sum to 100
  const values = PHASES.map(phase => Math.max(0, times[phase]));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return PHASES.map(() => 0);
  const rounded = values.map(value => Math.round((value / total) * 100));
  const extra = 100 - rounded.reduce((sum, value) => sum + value, 0);
  rounded[rounded.length - 1] = (rounded[rounded.length - 1] ?? 0) + extra;
  return rounded;
}
