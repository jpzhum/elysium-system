import { expect, test } from 'vitest';
import { Metrics } from '../src/observability/metrics.js';
import { operationalStatus } from '../src/observability/status.js';

test('status separates unmeasured latency from zero and never truncates required stages', () => {
  const pages = operationalStatus({});
  expect(pages.every(page => page.length <= 1500)).toBe(true);
  const content = pages.join('\n');
  expect(content).toContain('Captura Discord + VAD: sem amostras');
  expect(content).toContain('Upload PCM + silêncio: sem amostras');
  expect(content).toContain('Drain → próxima disponibilidade: sem amostras');
  expect(content).toContain('search_missing_key=0');
  expect(content).toContain('voice_capture_duplicates=0');
  for (const name of ['voice_turns_captured', 'voice_wake_activations', 'agent_input_audio_chunks',
    'agent_initial_audio_discarded', 'agent_user_turn_missing', 'audio_stream_started',
    'agent_response_received', 'agent_response_complete_received', 'audio_bytes_received',
    'search_timeout', 'search_invalid_reply', 'search_no_sources', 'search_cancelled']) {
    expect(content).toContain(`${name}=0`);
  }
});

test('latencies report local samples and arithmetic aggregates in milliseconds', () => {
  const metrics = new Metrics();
  metrics.record('agent_audio_upload_ms', 2000); metrics.record('agent_audio_upload_ms', 3000);
  metrics.record('opus_encode_ms', 0.25);
  const content = operationalStatus(metrics.snapshot()).join('\n');
  expect(content).toContain('Upload PCM + silêncio: 3000.0 / 2500.0 / 2000.0 / 3000.0; n=2');
  expect(content).toContain('Opus por frame: 0.250 / 0.250 / 0.250 / 0.250; n=1');
  expect(content).not.toContain('p95');
});

test('status only exposes reviewed operational names and rejects malformed numeric durations', () => {
  const content = operationalStatus({ PRIVATE_token: 1, 'https://signed?key=secret': 2,
    agent_audio_upload_ms: NaN, agent_audio_upload_ms_samples: 1,
    agent_audio_upload_ms_last: Infinity, search_calls: 5 }).join('\n');
  expect(content).not.toMatch(/PRIVATE|signed|secret|Infinity|NaN/);
  expect(content).toContain('search_calls=5');
  expect(content).toContain('Upload PCM + silêncio: sem amostras');
});
