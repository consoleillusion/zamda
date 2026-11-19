import { describe, expect, test } from 'bun:test';
import {
  formatMs,
  formatSpeedup,
  phasePercentages,
  raceWidth,
  speedup,
  sparkline,
} from '../demo/performance';
import type { RaceSample } from '../demo/performance';

describe('demo engine race', () => {
  const sample = (jsMs: number, wasmMs: number | null): RaceSample => ({
    label: 'brush',
    jsMs,
    wasmMs,
    fallbacks: 0,
    cacheHits: 0,
  });

  test('a speedup needs two positive timings', () => {
    expect(speedup(sample(80, 20))).toBe(4);
    expect(speedup(sample(20, 80))).toBe(0.25);
    expect(speedup(sample(80, 0))).toBeNull();
    expect(speedup(sample(80, null))).toBeNull();
    expect(formatSpeedup(4)).toBe('4.0×');
    expect(formatSpeedup(12.6)).toBe('13×');
    expect(formatSpeedup(0.25)).toBe('0.25×');
    expect(formatSpeedup(null)).toBe('—');
  });

  test('timings and track widths stay readable', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(7.24)).toBe('7.2 ms');
    expect(formatMs(107.6)).toBe('108 ms');
    expect(raceWidth(50, 100)).toBe(50);
    expect(raceWidth(150, 100)).toBe(100);
    expect(raceWidth(4, 0)).toBe(0);
  });

  test('sparklines skip missing WASM samples', () => {
    const samples = [sample(80, 40), sample(90, null), sample(100, 20)];
    expect(sparkline(samples, 'jsMs', 100, 30)).toBe('M0,8 L50,5 L100,3');
    expect(sparkline(samples, 'wasmMs', 100, 30)).toBe('M0,3 L100,15');
    expect(sparkline([sample(1, 1)], 'jsMs', 100, 30)).toBe('');
  });

  test('phase shares always add to one hundred', () => {
    expect(phasePercentages({ prepare: 10, tables: 20, start: 5, steps: 60, read: 5 })).toEqual([10, 20, 5, 60, 5]);
    expect(phasePercentages({ prepare: 0, tables: 0, start: 0, steps: 0, read: 0 })).toEqual([0, 0, 0, 0, 0]);
  });
});
