import { expect, test } from 'vitest';
import { summarize } from '../scripts/benchmark-summary.mjs';
import { runPipelineBenchmark } from '../scripts/benchmark-pipeline.mjs';
import { SessionManager } from '../src/agents/session-manager.js';

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

test('virtual pipeline separates confirmed success, unconfirmed local delivery and lost requests', async () => {
  const report = await runPipelineBenchmark(SessionManager);
  expect(report.scenarios.missing_completion).toMatchObject({
    interactions: 10, success: 5, success_rate: 0.5,
    local_deliveries: 10, unconfirmed_deliveries: 5, unconfirmed_delivery_rate: 0.5,
    lost_questions: 0, rejected: 0,
  });
  expect(report.scenarios.text).toMatchObject({
    interactions: 5, success: 5, success_rate: 1, local_deliveries: 5, unconfirmed_deliveries: 0, lost_questions: 0,
  });
  expect(report.scenarios.recognition_timeout).toMatchObject({
    interactions: 5, success: 0, local_deliveries: 0, unconfirmed_deliveries: 0, timeouts: 5, lost_questions: 0,
  });
  expect(report.scenarios.stt_failure).toMatchObject({
    interactions: 5, success: 0, local_deliveries: 0, unconfirmed_deliveries: 0, rejected: 5, lost_questions: 0,
  });
});
