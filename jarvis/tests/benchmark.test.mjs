import { expect, test } from 'vitest';
import { summarize } from '../scripts/benchmark-summary.mjs';

test('benchmark percentiles use measured nearest-rank values and median averages the middle pair', () => {
  const samples = Array.from({ length: 20 }, (_, index) => 20 - index);
  expect(summarize(samples)).toEqual({ n: 20, p50_ms: 10.5, p90_ms: 18, p95_ms: 19, max_ms: 20 });
  expect(samples[0]).toBe(20);
  expect(summarize([0.5])).toEqual({ n: 1, p50_ms: 0.5, p90_ms: 0.5, p95_ms: 0.5, max_ms: 0.5 });
});

test('missing benchmark samples cannot become fabricated zero latency; malformed measurements fail', () => {
  expect(summarize([])).toEqual({ n: 0, p50_ms: null, p90_ms: null, p95_ms: null, max_ms: null });
  for (const value of [NaN, Infinity, -1]) expect(() => summarize([value])).toThrow(TypeError);
});
