import { describe, expect, test, vi } from 'vitest';
import {
  Logger, Metrics, type DiagnosticFields, type ErrorCategory, type ErrorCode,
} from '../src/observability/metrics.js';
import { DiagnosticError, JoinDiagnostics, sanitizeError } from '../src/observability/diagnostics.js';

function capture(level: 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  return {
    lines,
    logger: new Logger(level, (line) => { lines.push(line); }),
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('bounded structured operational logging', () => {
  test('legacy events retain generated eight-character uppercase incidents', () => {
    const state = capture();
    const incident = state.logger.event('jarvis_ready');
    expect(incident).toMatch(/^[A-F0-9]{8}$/);
    expect(state.records()[0]).toMatchObject({ event: 'jarvis_ready', level: 'info', incident });
    expect(Object.keys(state.records()[0]!)).toEqual(['time', 'level', 'event', 'incident']);
  });

  test('accepts only reviewed metadata and reuses a validated incident', () => {
    const state = capture();
    const incident = state.logger.event('jarvis_command_failed', 'error', {
      incident: '07090582', command: 'join', stage: 'voice_ready_wait', category: 'timeout',
      code: 'JOIN_TIMEOUT', duration_ms: 20_010, timeout_ms: 20_000,
      voice_status: 'connecting', network_status: 2, websocket_close_code: 4017,
      disconnect_reason: 0, dave_enabled: true, dave_protocol_version: 1,
      node_version: '22.22.0', voice_version: '0.19.2', platform: 'linux', arch: 'x64',
      permission_connect: true, diagnostics_version: 1,
    });
    expect(incident).toBe('07090582');
    expect(state.records()[0]).toMatchObject({ incident, stage: 'voice_ready_wait', code: 'JOIN_TIMEOUT',
      duration_ms: 20_010, network_status: 2, dave_enabled: true, node_version: '22.22.0' });
  });

  test('drops credentials, URLs, IDs, messages, transcripts and arbitrary nested values', () => {
    const state = capture();
    const secret = 'PRIVATE_TOKEN https://host/audio?signature=private <@123456789012345678>';
    const fields = {
      incident: secret, command: secret, stage: secret, category: secret, code: secret,
      operation: secret, audio_chunks: secret, audio_bytes: secret,
      text_received: secret, completion_received: secret, input_kind: secret, capture_bytes: secret,
      capture_ms: secret, capture_wait_ms: secret, end_detection_ms: secret, first_message_override_requested: secret,
      wake_detected: secret, followup: secret, user_turn_recognized: secret, input_audio_chunks: secret,
      input_audio_bytes: secret, input_audio_finished: secret, input_sample_rate: secret, output_sample_rate: secret, silence_tail_ms: secret,
      session_reused: secret, speaker_verified: secret, consent_current: secret,
      identity_injected: secret, identity_is_creator: secret, active_game_known: secret,
      room_context_injected: secret, identity_source: secret, search_key_configured: secret, search_status: secret,
      source_count: secret, tool_name: secret, tool_stage: secret, wait_for_response: secret,
      participants_available: secret, participants_complete: secret, input_source_chunks: secret,
      input_silence_chunks: secret, upload_ms: secret,
      context_injected: secret, context_items: secret, context_chars: secret,
      recovery_attempt: secret, retry_delay_ms: secret, receiver_state: secret,
      capture_rejection: secret, rejection_reason: secret, voice_lifecycle_reason: secret,
      voice_status: secret, previous_voice_status: secret, network_status: secret,
      duration_ms: secret, stage_duration_ms: secret, timeout_ms: secret, disconnect_reason: secret,
      websocket_close_code: secret, dave_protocol_version: secret, diagnostics_version: secret,
      node_version: secret, voice_version: secret, discord_version: secret, davey_version: secret,
      platform: secret, arch: secret, permission_view: secret, permission_connect: secret,
      permission_speak: secret, permission_full: secret, dave_enabled: secret,
      dave_available: secret, dave_ready: secret, transport_aes_gcm: secret,
      token: secret, signed_url: secret, transcript: secret, audio: Buffer.from(secret),
      user_id: secret, channel_id: secret, message: secret, stack: secret,
      cause: { secret }, error: new Error(secret),
    } as unknown as DiagnosticFields;
    state.logger.event('jarvis_command_failed', 'error', fields);
    expect(state.lines.join('')).not.toMatch(/PRIVATE_TOKEN|signature|123456789012345678|https|secret/);
    const record = state.records()[0]!;
    expect(Object.keys(record)).toEqual(['time', 'level', 'event', 'incident']);
    expect(record.incident).toMatch(/^[A-F0-9]{8}$/);
  });

  test('speaker backoff remains distinguishable from the shared wake quota without speaker identifiers', () => {
    const state = capture();
    state.logger.event('jarvis_wake_failed', 'warn', {
      stage: 'wake_detection', rejection_reason: 'wake_speaker_backoff', retry_after_ms: 10_000,
    });
    expect(state.records()[0]).toMatchObject({
      rejection_reason: 'wake_speaker_backoff', retry_after_ms: 10_000, stage: 'wake_detection',
    });
    expect(Object.keys(state.records()[0]!)).toEqual([
      'time', 'level', 'event', 'incident', 'stage', 'rejection_reason', 'retry_after_ms',
    ]);
  });

  test('rejects unknown event names even when a leaked string fits a name-shaped regex', () => {
    const state = capture();
    state.logger.event('private_token');
    state.logger.event('https://host/?token=private');
    state.logger.event('jarvis_ready\nprivate');
    expect(state.lines).toEqual([]);
  });

  test('does not invoke payload getters, inherited fields or toJSON methods', () => {
    const state = capture();
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    const serialize = vi.fn(() => 'PRIVATE');
    const fields = Object.create({ stage: 'permissions' }) as DiagnosticFields;
    Object.defineProperty(fields, 'code', { get: getter, enumerable: true });
    Object.defineProperty(fields, 'toJSON', { value: serialize, enumerable: true });
    state.logger.event('jarvis_ready', 'info', fields);
    expect(getter).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(state.records()[0]).not.toHaveProperty('stage');
    expect(state.records()[0]).not.toHaveProperty('code');
  });

  test.each([null, undefined, [], 1, 'PRIVATE', new Proxy({}, {
    getOwnPropertyDescriptor: () => { throw new Error('PRIVATE'); },
  })])('unexpected fields input never reaches JSON', (input) => {
    const state = capture();
    expect(() => state.logger.event('jarvis_ready', 'info', input as DiagnosticFields)).not.toThrow();
    expect(Object.keys(state.records()[0]!)).toEqual(['time', 'level', 'event', 'incident']);
  });

  test('rejects non-finite, fractional, oversized and negative numeric fields', () => {
    const state = capture();
    state.logger.event('jarvis_ready', 'info', {
      duration_ms: NaN, stage_duration_ms: -1, timeout_ms: Infinity, network_status: -1, previous_network_status: 7,
      websocket_close_code: 5_000, disconnect_reason: 1.5, dave_protocol_version: 65_536,
      diagnostics_version: 8, pending_tools: 129, context_items: 11, context_chars: 2401,
    });
    expect(Object.keys(state.records()[0]!)).toEqual(['time', 'level', 'event', 'incident']);
  });

  test.each(['v22.22.0', '22.22.0-private_token', '22.22.0+signed_url', '22.22.0\nPRIVATE', '022.22.0'])('rejects untrusted version %s', (node_version) => {
    const state = capture();
    state.logger.event('jarvis_ready', 'info', { node_version });
    expect(state.records()[0]).not.toHaveProperty('node_version');
  });

  test('rejects lowercase and malformed supplied incidents', () => {
    const state = capture();
    for (const incident of ['aabbccdd', 'ABCDEFGH', '07090582\nTOKEN', '070905820']) {
      expect(state.logger.event('jarvis_ready', 'info', { incident })).toMatch(/^[A-F0-9]{8}$/);
      expect(state.records().at(-1)?.incident).not.toBe(incident);
    }
  });
});

describe('safe error classification', () => {
  test.each([
    [50001, 'permissions', 'DISCORD_MISSING_ACCESS'],
    [50013, 'permissions', 'DISCORD_MISSING_PERMISSIONS'],
    [10003, 'channel', 'DISCORD_UNKNOWN_CHANNEL'],
    [10004, 'discord', 'DISCORD_UNKNOWN_GUILD'],
    [10062, 'discord', 'INTERACTION_EXPIRED'],
    [40060, 'discord', 'INTERACTION_ACKNOWLEDGED'],
    ['ECONNRESET', 'network', 'ECONNRESET'],
    ['ETIMEDOUT', 'timeout', 'ETIMEDOUT'],
    ['ABORT_ERR', 'cancelled', 'ABORT_ERR'],
    ['busy', 'voice', 'JOIN_IN_PROGRESS'],
    ['closed', 'cancelled', 'JOIN_CANCELLED'],
  ])('classifies reviewed upstream code %s without its message', (code, category, expected) => {
    const error = Object.assign(new Error('PRIVATE https://signed?secret=1'), { code });
    expect(sanitizeError(error)).toEqual({ category, code: expected });
  });

  test('classifies Discord voice close 4017 separately from generic voice close', () => {
    expect(sanitizeError({ closeCode: 4017, message: 'PRIVATE' })).toEqual({ category: 'dave', code: 'WS_CLOSE_4017' });
    expect(sanitizeError({ closeCode: 4014 })).toEqual({ category: 'voice', code: 'WS_CLOSE_4014' });
    expect(sanitizeError({ closeCode: 123456789 })).toEqual({ category: 'unknown', code: 'UNKNOWN' });
  });

  test.each([
    ['Failed to load native binding: PRIVATE', 'dependency', 'NATIVE_BINDING_UNAVAILABLE'],
    ["Cannot find module '@snazzah/davey' from PRIVATE", 'dave', 'DAVE_UNAVAILABLE'],
    ['No compatible encryption modes. Available include: PRIVATE', 'voice', 'VOICE_ENCRYPTION_UNAVAILABLE'],
    ['Unsupported DAVE protocol PRIVATE', 'dave', 'DAVE_UNSUPPORTED_PROTOCOL'],
    ['Cannot play audio as no valid encryption package is installed.\nPRIVATE_DIAGNOSTIC_REPORT', 'voice', 'VOICE_ENCRYPTION_UNAVAILABLE'],
    ['Conexão de voz indisponível para reprodução.', 'voice', 'PLAYBACK_SUBSCRIBE_FAILED'],
  ])('maps known dependency failures to a fixed classification', (message, category, code) => {
    expect(sanitizeError(new Error(message))).toEqual({ category, code });
  });

  test.each([undefined, null, 'PRIVATE', new Error('PRIVATE token'), { code: 'PRIVATE', stack: 'PRIVATE', cause: new Error('PRIVATE') }, { code: '__proto__' }])('unknown failures produce only a fixed unknown classification', (error) => {
    expect(sanitizeError(error)).toEqual({ category: 'unknown', code: 'UNKNOWN' });
  });

  test('typed failures remain sanitized even when called from untyped code', () => {
    expect(sanitizeError(new DiagnosticError('permissions', 'DISCORD_MISSING_PERMISSIONS')))
      .toEqual({ category: 'permissions', code: 'DISCORD_MISSING_PERMISSIONS' });
    const failure = new DiagnosticError('PRIVATE' as ErrorCategory, 'PRIVATE' as ErrorCode);
    expect(failure.message).toBe('UNKNOWN');
    expect(sanitizeError(failure)).toEqual({ category: 'unknown', code: 'UNKNOWN' });
  });

  test('hostile exception accessors and revoked proxies do not interrupt diagnostics', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    const error = Object.defineProperty({}, 'message', { get: getter });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(sanitizeError(error)).toEqual({ category: 'unknown', code: 'UNKNOWN' });
    expect(sanitizeError(proxy)).toEqual({ category: 'unknown', code: 'UNKNOWN' });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('correlated join diagnostics', () => {
  test('records one incident across stages and logs one failure with the failed stage', () => {
    const state = capture();
    const join = new JoinDiagnostics(state.logger);
    join.stage('interaction_ack');
    join.stage('permissions');
    join.failure(Object.assign(new Error('PRIVATE_TOKEN'), { code: 50013 }));
    join.failure(new Error('SECOND_PRIVATE'));
    const failures = state.records().filter((record) => record.event === 'jarvis_command_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ command: 'join', stage: 'permissions', category: 'permissions',
      code: 'DISCORD_MISSING_PERMISSIONS', level: 'error' });
    expect(new Set(state.records().map(({ incident }) => incident))).toEqual(new Set([join.incident]));
    expect(state.lines.join('')).not.toMatch(/PRIVATE/);
    expect(failures[0]?.duration_ms).toEqual(expect.any(Number));
    expect(failures[0]?.stage_duration_ms).toEqual(expect.any(Number));
  });

  test('retains latest runtime and network snapshot in error-only logs without losing the join stage', () => {
    const state = capture('error');
    const join = new JoinDiagnostics(state.logger);
    join.stage('runtime_probe');
    join.event('jarvis_voice_runtime', 'info', { node_version: '22.22.0', dave_available: true });
    join.stage('voice_ready_wait');
    join.event('voice_network_state', 'info', { stage: 'voice_network', network_status: 2, dave_enabled: true });
    join.remember({ voice_status: 'connecting', timeout_ms: 20_000 });
    join.failure(new DiagnosticError('timeout', 'JOIN_TIMEOUT'));
    expect(state.records()).toHaveLength(1);
    expect(state.records()[0]).toMatchObject({ stage: 'voice_ready_wait', voice_status: 'connecting',
      network_status: 2, timeout_ms: 20_000, node_version: '22.22.0', dave_available: true,
      category: 'timeout', code: 'JOIN_TIMEOUT' });
  });

  test('caller fields cannot replace incident and command or invoke getters during merge', () => {
    const state = capture();
    const join = new JoinDiagnostics(state.logger);
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    const fields = { incident: 'FFFFFFFF', command: 'PRIVATE' } as unknown as DiagnosticFields;
    Object.defineProperty(fields, 'duration_ms', { enumerable: true, get: getter });
    join.event('jarvis_join_step', 'info', fields);
    expect(getter).not.toHaveBeenCalled();
    expect(state.records()[0]).toMatchObject({ incident: join.incident, command: 'join' });
    join.success();
    join.event('voice_connection_state', 'info', { voice_status: 'ready' });
    expect(state.records().at(-1)).toMatchObject({ stage: 'join_complete', incident: join.incident });
  });

  test('preserves bounded operation durations while main failures use total attempt duration', () => {
    const state = capture();
    const join = new JoinDiagnostics(state.logger);
    join.event('voice_recovery_ready', 'info', { duration_ms: 5_123 });
    expect(state.records()[0]).toHaveProperty('duration_ms', 5_123);
    join.stage('voice_ready_wait');
    join.failure(new DiagnosticError('timeout', 'JOIN_TIMEOUT'));
    expect(state.records().at(-1)?.duration_ms).toEqual(expect.any(Number));
    expect(state.records().at(-1)?.duration_ms).not.toBe(5_123);
  });
});

test('metrics counters preserve existing names, bounds and snapshots', () => {
  const metrics = new Metrics();
  metrics.add('voice_turns');
  metrics.add('voice_turns', 2);
  metrics.add('invalid metric');
  metrics.add('invalid_value', Infinity);
  expect(metrics.snapshot()).toEqual({ voice_turns: 3 });
});

test('turn latency logs accept bounded fractional encoder time and never malformed values', () => {
  const state = capture();
  state.logger.event('jarvis_playback_state', 'info', { opus_encode_ms: 1.25 });
  expect(state.records()[0]).toMatchObject({ opus_encode_ms: 1.25 });
  for (const opus_encode_ms of [NaN, Infinity, -1, 3_600_001]) {
    state.logger.event('jarvis_playback_state', 'info', { opus_encode_ms });
    expect(state.records().at(-1)).not.toHaveProperty('opus_encode_ms');
  }
});

test('stream diagnostics keep completion, drain, recovery and tool state separate without content', () => {
  const state = capture();
  state.logger.event('jarvis_agent_turn_recovering', 'warn', {
    operation: 'agent_turn', code: 'AGENT_COMPLETION_MISSING', completion_received: false,
    ingress_ended: true, playback_drained: false, recovery: true, pending_tools: 2, diagnostics_version: 3,
  });
  expect(state.records()[0]).toMatchObject({ completion_received: false, ingress_ended: true,
    playback_drained: false, recovery: true, pending_tools: 2, diagnostics_version: 3 });
});

test('stream gauges return to zero and fixed metric cardinality is bounded', () => {
  const metrics = new Metrics();
  metrics.add('audio_stream_buffer_bytes', 384);
  metrics.add('audio_stream_buffer_bytes', -384);
  for (let i = 0; i < 600; i++) metrics.add(`counter_${i}`);
  expect(metrics.snapshot().audio_stream_buffer_bytes).toBe(0);
  expect(Object.keys(metrics.snapshot())).toHaveLength(512);
});

test('latency samples retain aggregates and measured window median/p95 in milliseconds', () => {
  const metrics = new Metrics();
  metrics.record('opus_encode_ms', 0.25); metrics.record('opus_encode_ms', 0.75);
  metrics.record('opus_encode_ms', -1); metrics.record('opus_encode_ms', NaN);
  metrics.record('opus_encode_ms', Infinity); metrics.record('opus_encode_ms', 3_600_001);
  metrics.record('turn_queue_depth', 2); metrics.record('turn_queue_depth', -2);
  expect(metrics.snapshot()).toEqual({ opus_encode_ms: 1, opus_encode_ms_samples: 2,
    opus_encode_ms_last: 0.75, opus_encode_ms_min: 0.25, opus_encode_ms_max: 0.75,
    opus_encode_ms_median: 0.5, opus_encode_ms_p90: 0.75, opus_encode_ms_p95: 0.75, opus_encode_ms_window_samples: 2,
    turn_queue_depth: 0 });
});

test('latency distribution keeps only the latest 256 samples and preserves lifetime aggregates', () => {
  const metrics = new Metrics();
  for (let value = 1; value <= 300; value++) metrics.record('stage_ms', value);
  expect(metrics.snapshot()).toEqual({ stage_ms: 45_150, stage_ms_samples: 300,
    stage_ms_last: 300, stage_ms_min: 1, stage_ms_max: 300,
    stage_ms_median: 172.5, stage_ms_p90: 275, stage_ms_p95: 288, stage_ms_window_samples: 256 });
  // Sorting a snapshot must not alter the ring, including when values arrive out of order.
  metrics.record('stage_ms', 0);
  expect(metrics.snapshot()).toMatchObject({ stage_ms_samples: 301, stage_ms_window_samples: 256,
    stage_ms_median: 172.5, stage_ms_p95: 288, stage_ms_min: 0, stage_ms_last: 0 });
});

test('skewed stages keep independent windows and distinguish median from nearest-rank p95', () => {
  const metrics = new Metrics();
  for (const value of [1, 2, 3, 4, 100]) metrics.record('recognition_ms', value);
  for (const value of [0, 0, 0, 1000]) metrics.record('playback_ms', value);
  expect(metrics.snapshot()).toMatchObject({ recognition_ms_median: 3,
    recognition_ms_p95: 100, recognition_ms_window_samples: 5,
    playback_ms_median: 0, playback_ms_p95: 1000, playback_ms_window_samples: 4 });
});

test('duration aggregate admission is atomic at the counter limit and existing series keep updating', () => {
  const full = new Metrics();
  for (let index = 0; index < 508; index++) full.add(`counter_${index}`);
  full.record('stage_ms', 10);
  expect(full.snapshot()).not.toHaveProperty('stage_ms');
  expect(Object.keys(full.snapshot())).toHaveLength(508);

  const admitted = new Metrics();
  for (let index = 0; index < 507; index++) admitted.add(`counter_${index}`);
  admitted.record('stage_ms', 10);
  admitted.record('stage_ms', 20);
  expect(admitted.snapshot()).toMatchObject({ stage_ms: 30, stage_ms_samples: 2,
    stage_ms_median: 15, stage_ms_p95: 20, stage_ms_window_samples: 2 });
});

test('duration windows have bounded series cardinality', () => {
  const metrics = new Metrics();
  for (let index = 0; index < 100; index++) metrics.record(`stage_${index}_ms`, index);
  expect(Object.keys(metrics.snapshot())).toHaveLength(48 * 9);
  expect(metrics.snapshot()).not.toHaveProperty('stage_48_ms');
});

test('queue and local drain diagnostics accept only bounded, reviewed state', () => {
  const state = capture();
  state.logger.event('jarvis_agent_turn_superseded', 'info', { queue_depth: 2, queue_position: 1,
    local_playback_drained: true, playback_drained: false, turn_outcome: 'superseded',
    first_audio_ms: 100, first_playback_ms: 140, last_audio_ms: 900, drain_ms: 950, next_question_ready_ms: 80 });
  expect(state.records()[0]).toMatchObject({ local_playback_drained: true, playback_drained: false,
    turn_outcome: 'superseded', queue_depth: 2, first_audio_ms: 100 });
  state.logger.event('jarvis_turn_queue_changed', 'info', { queue_depth: 100, queue_position: -1,
    turn_outcome: 'PRIVATE' as 'completed', first_audio_ms: NaN, question_wait_ms: -1 });
  expect(Object.keys(state.records()[1]!)).toEqual(['time', 'level', 'event', 'incident']);
});
