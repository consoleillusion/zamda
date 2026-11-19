// The dashboard's engine-race readout. It records only measured runs: the JS
// reference time, the WASM time from the worker, their ratio, and the engine's
// own counters. A missing or failed engine stays visible instead of being hidden.

import { PHASES, formatMs, formatSpeedup, phasePercentages, raceWidth, sparkline, speedup } from './performance';
import type { PhaseTimes, RaceSample } from './performance';

export interface RaceView {
  readonly label: string;
  readonly jsMs: number | null;
  readonly wasmMs: number | null;
  readonly engine: number;
  readonly fallbacks: number;
  readonly cacheHits: number;
  readonly phases: PhaseTimes;
  readonly match: boolean | null;
  readonly error: string | null;
}

export interface RaceProbe {
  readonly label: string;
  readonly jsMs: number | null;
  readonly wasmMs: number | null;
  readonly speedup: string;
  readonly engine: number;
  readonly fallbacks: number;
  readonly cacheHits: number;
  readonly match: boolean | null;
  readonly status: string;
  readonly error: string | null;
  readonly phases: PhaseTimes;
  readonly samples: readonly RaceSample[];
}

declare global {
  interface Window {
    __zamdaRace?: RaceProbe;
  }
}

export interface RacePanel {
  setStatus(message: string, state: 'loading' | 'ready' | 'error'): void;
  record(view: RaceView): void;
  fail(message: string): void;
}

function byId<T extends Element>(id: string): T {
  // Purpose: an element that the race panel is known to contain
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as unknown as T;
}

function text(id: string, value: string): void {
  // Purpose: write one measured value into the panel
  byId<HTMLElement>(id).textContent = value;
}

export function createRacePanel(): RacePanel {
  // Purpose: bind the race panel's DOM once and update it from measured interactions
  const samples: RaceSample[] = [];
  let state: 'loading' | 'ready' | 'error' = 'loading';
  let status = 'waiting for engine';
  let latest: RaceProbe = {
    label: '—',
    jsMs: null,
    wasmMs: null,
    speedup: '—',
    engine: 0,
    fallbacks: 0,
    cacheHits: 0,
    match: null,
    status,
    error: null,
    phases: { prepare: 0, tables: 0, start: 0, steps: 0, read: 0 },
    samples,
  };

  const publish = function (): void {
    // Purpose: expose the last measured state to scripted browser checks
    window.__zamdaRace = { ...latest, samples: [...samples] };
  };

  const setStatus = function (message: string, next: 'loading' | 'ready' | 'error'): void {
    // Purpose: show the engine's current state, including when there is no engine
    state = next;
    status = message;
    text('race-state', message);
    byId<HTMLElement>('race-state-pill').dataset.state = state;
    latest = { ...latest, status, error: state === 'error' ? message : latest.error };
    publish();
  };

  const record = function (view: RaceView): void {
    // Purpose: draw one complete JS-versus-WASM interaction from its measurements
    state = view.error === null && view.wasmMs !== null ? 'ready' : state;
    status = view.error ?? status;
    const sample: RaceSample = {
      label: view.label,
      jsMs: view.jsMs ?? 0,
      wasmMs: view.wasmMs,
      fallbacks: view.fallbacks,
      cacheHits: view.cacheHits,
    };
    samples.push(sample);
    if (samples.length > 24) samples.shift();
    const ratio = view.jsMs === null || view.wasmMs === null ? null : speedup(sample);
    const scale = Math.max(sample.jsMs, sample.wasmMs ?? 0, 1);
    text('race-label', view.label);
    text('race-js-time', view.jsMs === null ? '—' : formatMs(view.jsMs));
    text('race-wasm-time', view.wasmMs === null ? '—' : formatMs(view.wasmMs));
    text('race-speed', formatSpeedup(ratio));
    text('race-state', view.error ?? status);
    byId<HTMLElement>('race-state-pill').dataset.state = state;
    byId<HTMLElement>('race-js-bar').style.width = `${raceWidth(sample.jsMs, scale)}%`;
    byId<HTMLElement>('race-wasm-bar').style.width = `${raceWidth(sample.wasmMs ?? 0, scale)}%`;
    byId<HTMLElement>('race-spark-js').setAttribute('d', sparkline(samples, 'jsMs', 220, 28));
    byId<HTMLElement>('race-spark-wasm').setAttribute('d', sparkline(samples, 'wasmMs', 220, 28));
    text('race-runs', String(view.engine));
    text('race-fallbacks', String(view.fallbacks));
    text('race-cache', String(view.cacheHits));
    const match = byId<HTMLElement>('race-match');
    match.textContent = view.match === null ? 'not checked' : view.match ? 'answers match' : 'ANSWERS DIFFER';
    match.dataset.match = view.match === null ? 'unknown' : view.match ? 'yes' : 'no';
    const shares = phasePercentages(view.phases);
    PHASES.forEach(function (phase, i) {
      // Purpose: one engine phase's share of the measured WASM wall time
      const bar = byId<HTMLElement>(`race-phase-${phase}`);
      bar.style.width = `${shares[i] ?? 0}%`;
      bar.title = `${phase}: ${shares[i] ?? 0}% of engine time`;
    });
    text('race-detail', view.error ?? `${view.engine} plans in the engine · ${view.cacheHits} shared filter hits`);
    latest = {
      label: view.label,
      jsMs: view.jsMs,
      wasmMs: view.wasmMs,
      speedup: formatSpeedup(ratio),
      engine: view.engine,
      fallbacks: view.fallbacks,
      cacheHits: view.cacheHits,
      match: view.match,
      status,
      error: view.error,
      phases: view.phases,
      samples,
    };
    publish();
  };

  const fail = function (message: string): void {
    // Purpose: leave a typed engine failure on screen without claiming a speedup
    setStatus(message, 'error');
    text('race-label', 'engine unavailable');
    text('race-js-time', '—');
    text('race-wasm-time', '—');
    text('race-speed', '—');
    text('race-detail', 'The charts still run on the JS reference engine.');
  };

  setStatus(status, state);
  return { setStatus, record, fail };
}
