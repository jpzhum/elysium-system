/** Observed samples only. Median averages the middle pair; percentiles use nearest rank. */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('Benchmark samples must be finite, non-negative numbers.');
  }
  const values = [...samples].sort((left, right) => left - right);
  const n = values.length;
  if (!n) return { n: 0, p50_ms: null, p90_ms: null, p95_ms: null, max_ms: null };
  const middle = Math.floor(n / 2);
  return {
    n,
    p50_ms: n % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    p90_ms: values[Math.ceil(n * 0.9) - 1],
    p95_ms: values[Math.ceil(n * 0.95) - 1],
    max_ms: values[n - 1],
  };
}
