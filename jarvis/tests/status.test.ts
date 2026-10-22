import { expect, test } from 'vitest';
import { Metrics } from '../src/observability/metrics.js';
import { operationalStatus } from '../src/observability/status.js';

test('status separates unmeasured latency from zero and never truncates required stages', () => {
  const pages = operationalStatus({});
  expect(pages.every(page => page.length <= 1500)).toBe(true);
  const content = pages.join('\n');
  expect(content).toContain('Captura Discord + VAD: sem amostras');
  expect(content).toContain('Captura antes do VAD final: sem amostras');
  expect(content).toContain('Fim da fala (VAD): sem amostras');
  expect(content).toContain('Fila do STT: sem amostras');
  expect(content).toContain('STT remoto: sem amostras');
  expect(content).toContain('Abertura ElevenAgents: sem amostras');
  expect(content).toContain('Início do envio → reconhecimento ElevenAgents: sem amostras');
  expect(content).toContain('Fim do envio → reconhecimento ElevenAgents: sem amostras');
  expect(content).toContain('Primeiro pacote local → drain: sem amostras');
  expect(content).toContain('Upload PCM + silêncio: sem amostras');
  expect(content).toContain('Drain → próxima disponibilidade: sem amostras');
  expect(content).toContain('search_missing_key=0');
  expect(content).toContain('voice_capture_duplicates=0');
  for (const name of ['voice_turns_captured', 'voice_wake_activations', 'agent_input_audio_chunks',
    'agent_initial_audio_discarded', 'agent_user_turn_missing', 'audio_stream_started',
    'agent_response_received', 'agent_response_complete_received', 'audio_bytes_received',
    'voice_capture_silent_rejected', 'voice_capture_too_short_rejected', 'voice_capture_limit_rejected',
    'voice_wake_busy', 'voice_turn_rejected', 'wake_checks', 'wake_queued', 'wake_rate_limited',
    'wake_queue_full', 'wake_queue_timeout', 'wake_provider_errors',
    'agent_guardrail_rejections', 'agent_concurrency_rejections',
    'search_timeout', 'search_invalid_reply', 'search_no_sources', 'search_cancelled']) {
    expect(content).toContain(`${name}=0`);
  }
});

test('latencies distinguish recent measured median/p95 from lifetime aggregates in milliseconds', () => {
  const metrics = new Metrics();
  metrics.record('agent_audio_upload_ms', 2000); metrics.record('agent_audio_upload_ms', 3000);
  metrics.record('opus_encode_ms', 0.25);
  const content = operationalStatus(metrics.snapshot()).join('\n');
  expect(content).toContain('Upload PCM + silêncio: 3000.0 / 2500.0 / 2000.0 / 3000.0; n=2; mediana=2500.0; p95=3000.0; janela n=2');
  expect(content).toContain('Opus por frame: 0.250 / 0.250 / 0.250 / 0.250; n=1; mediana=0.250; p95=0.250; janela n=1');
  expect(content).toContain('até 256 amostras recentes por etapa');
});

test('legacy aggregate snapshots cannot invent a median or p95', () => {
  const content = operationalStatus({ agent_audio_upload_ms: 5000, agent_audio_upload_ms_samples: 2,
    agent_audio_upload_ms_last: 3000, agent_audio_upload_ms_min: 2000, agent_audio_upload_ms_max: 3000 }).join('\n');
  expect(content).toContain('Upload PCM + silêncio: 3000.0 / 2500.0 / 2000.0 / 3000.0; n=2; mediana/p95: sem amostras');
});

test('status only exposes reviewed operational names and rejects malformed numeric durations', () => {
  const content = operationalStatus({ PRIVATE_token: 1, 'https://signed?key=secret': 2,
    agent_audio_upload_ms: NaN, agent_audio_upload_ms_samples: 1,
    agent_audio_upload_ms_last: Infinity, search_calls: 5 }).join('\n');
  expect(content).not.toMatch(/PRIVATE|signed|secret|Infinity|NaN/);
  expect(content).toContain('search_calls=5');
  expect(content).toContain('Upload PCM + silêncio: sem amostras');
});
