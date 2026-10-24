import { expect, test } from 'vitest';
import { createLatencyAnalysis } from '../scripts/analyze-latency.mjs';

function add(analysis, incident, event, fields = {}) { analysis.addLine(JSON.stringify({ incident, event, ...fields })); }

test('latency analysis correlates stages by incident, not line order or unrelated population averages', () => {
  const analysis = createLatencyAnalysis();
  for (const [incident, queue, upload, audio, playback] of [
    ['AAAAAAAA', 10, 100, 200, 220], ['BBBBBBBB', 1000, 200, 1500, 1550],
  ]) {
    add(analysis, incident, 'jarvis_agent_turn_started', { input_kind: 'voice', question_wait_ms: queue });
    add(analysis, incident, 'jarvis_agent_playback_completed', { first_audio_ms: audio, first_playback_ms: playback });
    add(analysis, incident, 'jarvis_agent_input_sent', { input_audio_finished: true, duration_ms: queue + upload,
      upload_ms: upload });
    add(analysis, incident, 'jarvis_agent_turn_finished', { turn_outcome: 'completed' });
  }
  add(analysis, 'CCCCCCCC', 'jarvis_agent_turn_started', { question_wait_ms: 90_000 });
  const report = analysis.snapshot();
  expect(report.stages.question_wait_ms).toMatchObject({ n: 3, p50_ms: 1000 });
  expect(report.paired_queue_upload_audio_playback.n).toBe(2);
  expect(report.paired_queue_upload_audio_playback.stages.question_wait_ms).toMatchObject({ n: 2, p50_ms: 505 });
  expect(report.paired_queue_upload_audio_playback.stages.post_upload_first_audio_ms).toMatchObject({ n: 2, p50_ms: 195 });
  expect(report.turns.map(row => row.incident)).toEqual(['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']);
  expect(report.terminal_turns).toBe(2);
  expect(report.outcomes).toMatchObject({ completed: 2, unknown: 1, failed: 0 });
  expect(report.finished_upload_observed).toBe(2);
});

test('latency analysis cannot invent zero latency from absent or malformed measurements or early audio', () => {
  const analysis = createLatencyAnalysis();
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_started', { upload_ms: -1, question_wait_ms: 'private' });
  add(analysis, 'AAAAAAAA', 'jarvis_agent_input_sent', { duration_ms: 200, input_audio_finished: true });
  add(analysis, 'AAAAAAAA', 'jarvis_agent_first_audio', { first_audio_ms: 100 });
  add(analysis, 'AAAAAAAA', 'jarvis_voice_captured', { capture_ms: 999 });
  const report = analysis.snapshot();
  expect(report.audio_before_upload_finished).toBe(1);
  expect(report.stages.post_upload_first_audio_ms.n).toBe(0);
  expect(report.stages.capture_ms.p50_ms).toBeNull();
  expect(report.stages.upload_ms.p95_ms).toBeNull();
  expect(report.paired_queue_upload_audio_playback.n).toBe(0);
});

test('latency analysis includes observed failed and unfinished turns without calling them completed', () => {
  const analysis = createLatencyAnalysis();
  for (const incident of ['AAAAAAAA', 'BBBBBBBB']) {
    add(analysis, incident, 'jarvis_agent_turn_started', { input_kind: 'voice', question_wait_ms: 10 });
    add(analysis, incident, 'jarvis_agent_input_sent', { duration_ms: 100, upload_ms: 80, input_audio_finished: true });
    add(analysis, incident, 'jarvis_agent_first_audio', { first_audio_ms: 110, first_playback_ms: 120 });
  }
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_failed', { turn_outcome: 'failed' });
  const report = analysis.snapshot();
  expect(report.paired_queue_upload_audio_playback.n).toBe(2);
  expect(report.paired_queue_upload_audio_playback.outcomes).toMatchObject({ failed: 1, unknown: 1, completed: 0 });
  expect(report.terminal_turns).toBe(1);
  expect(report.turns.find(row => row.incident === 'BBBBBBBB')).toMatchObject({ outcome: 'unknown', terminal: false });
});

test('latency analysis ignores missing starts, reused incident IDs and arbitrary content', () => {
  const analysis = createLatencyAnalysis();
  analysis.addLine('private https://signed?token=secret');
  add(analysis, 'PRIVATE', 'jarvis_agent_turn_started', { message: 'secret' });
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_started', { text: 'private transcript', token: 'secret',
    code: 'SECRET_CODE', first_audio_ms: 30 });
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_started');
  add(analysis, 'BBBBBBBB', 'jarvis_agent_turn_finished', { question_wait_ms: 20 });
  add(analysis, 'CCCCCCCC', 'jarvis_agent_turn_started', { text: 'private transcript', token: 'secret', code: 'SECRET_CODE' });
  const report = analysis.snapshot();
  expect(report.ambiguous_starts).toBe(1);
  expect(report.missing_start).toBe(1);
  expect(report.started_turns).toBe(1);
  expect(report.ignored_lines).toBe(2);
  expect(JSON.stringify(report)).not.toMatch(/secret|private|SECRET|signed|transcript/);
  expect(report.stages.first_audio_ms.n).toBe(0);
  const bounded = createLatencyAnalysis({ maxIncidents: 1 });
  add(bounded, 'AAAAAAAA', 'jarvis_agent_turn_started');
  expect(() => add(bounded, 'BBBBBBBB', 'jarvis_agent_turn_started')).toThrow('incident limit exceeded');
});

test('V5.6 stages retain paired per-turn measurements through playback and release', () => {
  const analysis = createLatencyAnalysis();
  for (const [incident, factor, outcome] of [['AAAAAAAA', 1, 'completed'], ['BBBBBBBB', 2, 'unconfirmed']]) {
    // Release and encoder summaries can precede earlier events in an exported file.
    add(analysis, incident, 'jarvis_agent_turn_released', { turn_outcome: outcome,
      next_question_ready_ms: 30 * factor });
    add(analysis, incident, 'jarvis_playback_state', { playback_stage: 'opus_encode', opus_encode_ms: 4 * factor });
    add(analysis, incident, 'jarvis_playback_state', { playback_stage: 'opus_encode', opus_encode_ms: 4 * factor });
    add(analysis, incident, 'jarvis_agent_turn_started', { input_kind: 'voice', question_wait_ms: 20 * factor });
    add(analysis, incident, 'jarvis_wake_detected', { followup: false, wake_detection_ms: 50 * factor });
    add(analysis, incident, 'jarvis_agent_session_ready', { session_reused: false, agent_connect_ms: 60 * factor });
    add(analysis, incident, 'jarvis_agent_input_sent', { upload_ms: 100 * factor,
      duration_ms: 200 * factor, input_audio_finished: true });
    add(analysis, incident, 'jarvis_agent_audio_progress', { first_audio_ms: 220 * factor,
      first_playback_ms: 230 * factor, speech_end_to_first_packet_ms: 700 * factor,
      remote_first_audio_ms: 20 * factor, playback_start_ms: 10 * factor });
  }
  const report = analysis.snapshot();
  expect(report.schema).toBe(1);
  expect(report.terminal_turns).toBe(2);
  expect(report.stages.speech_end_to_first_packet_ms).toEqual({ n: 2, p50_ms: 1050,
    p90_ms: 1400, p95_ms: 1400, max_ms: 1400 });
  expect(report.stages.opus_encode_ms).toMatchObject({ n: 2, p50_ms: 6 });
  expect(report.paired_voice_pipeline.n).toBe(2);
  expect(report.paired_voice_pipeline.outcomes).toMatchObject({ completed: 1, unconfirmed: 1 });
  for (const field of report.paired_voice_pipeline.required_fields) {
    expect(report.paired_voice_pipeline.stages[field].n, field).toBe(2);
  }
  expect(report.outcome_rates).toMatchObject({ denominator: 2, unit: 'fraction', completed: 0.5, unconfirmed: 0.5 });
});

test('follow-ups, reused sessions and early audio keep missing stages absent instead of synthesizing zeros', () => {
  const analysis = createLatencyAnalysis();
  for (const incident of ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']) {
    add(analysis, incident, 'jarvis_agent_turn_started', { input_kind: 'voice', question_wait_ms: 10 });
    add(analysis, incident, 'jarvis_agent_audio_progress', { speech_end_to_first_packet_ms: 300,
      playback_start_ms: 20 });
  }
  add(analysis, 'AAAAAAAA', 'jarvis_wake_detected', { followup: true, duration_ms: 999 });
  add(analysis, 'AAAAAAAA', 'jarvis_agent_session_ready', { session_reused: true });
  add(analysis, 'BBBBBBBB', 'jarvis_wake_detected', { followup: false, duration_ms: 40 });
  add(analysis, 'BBBBBBBB', 'jarvis_agent_session_ready', { session_reused: false, agent_connect_ms: 50 });
  add(analysis, 'CCCCCCCC', 'jarvis_agent_first_audio', { first_audio_ms: 100 });
  add(analysis, 'CCCCCCCC', 'jarvis_agent_input_sent', { input_audio_finished: true, duration_ms: 200, upload_ms: 80 });
  const report = analysis.snapshot();
  expect(report.stages.wake_detection_ms).toMatchObject({ n: 1, p50_ms: 40 });
  expect(report.stages.agent_connect_ms).toMatchObject({ n: 1, p50_ms: 50 });
  expect(report.stages.remote_first_audio_ms).toMatchObject({ n: 0, p50_ms: null });
  expect(report.stages.opus_encode_ms).toMatchObject({ n: 0, p50_ms: null });
  expect(report.audio_before_upload_finished).toBe(1);
  expect(report.paired_voice_pipeline.n).toBe(0);
  expect(report.turns.find(turn => turn.incident === 'AAAAAAAA')).not.toHaveProperty('wake_detection_ms');
});

test('terminal outcome rates separate queue cancellation from started turns and preserve failures across release', () => {
  const analysis = createLatencyAnalysis();
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_cancelled', { turn_outcome: 'cancelled', stage: 'turn_enqueue' });
  add(analysis, 'BBBBBBBB', 'jarvis_agent_turn_started');
  add(analysis, 'BBBBBBBB', 'jarvis_agent_turn_failed');
  add(analysis, 'BBBBBBBB', 'jarvis_agent_turn_released', { turn_outcome: 'completed', next_question_ready_ms: 5 });
  add(analysis, 'CCCCCCCC', 'jarvis_agent_turn_started');
  add(analysis, 'CCCCCCCC', 'jarvis_agent_turn_cancelled', { turn_outcome: 'cancelled' });
  add(analysis, 'DDDDDDDD', 'jarvis_agent_turn_started');
  add(analysis, 'EEEEEEEE', 'jarvis_agent_turn_finished', { turn_outcome: 'completed' });
  const report = analysis.snapshot();
  expect(report.cancelled_before_start).toBe(1);
  expect(report.missing_start).toBe(2);
  expect(report.missing_start_excluding_queue_cancellations).toBe(1);
  expect(report.started_turns).toBe(3);
  expect(report.terminal_turns).toBe(2);
  expect(report.outcome_rates).toMatchObject({ population: 'started_turns', denominator: 3,
    failed: 1 / 3, cancelled: 1 / 3, unknown: 1 / 3, completed: 0 });
  expect(report.terminal_outcome_rates).toMatchObject({ population: 'terminal_started_turns',
    denominator: 2, failed: 0.5, cancelled: 0.5, unknown: 0 });
  const empty = createLatencyAnalysis().snapshot();
  expect(empty.outcome_rates.completed).toBeNull();
  expect(empty.terminal_outcome_rates.failed).toBeNull();
});

test('fractional Opus subtotals remain measured in distributions and paired voice turns', () => {
  const analysis = createLatencyAnalysis();
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_started', { input_kind: 'voice', question_wait_ms: 10 });
  add(analysis, 'AAAAAAAA', 'jarvis_agent_turn_released', { turn_outcome: 'completed',
    speech_end_to_first_packet_ms: 500, wake_detection_ms: 40, agent_connect_ms: 50,
    upload_ms: 200, remote_first_audio_ms: 30, playback_start_ms: 20, next_question_ready_ms: 5 });
  add(analysis, 'AAAAAAAA', 'jarvis_playback_state', { playback_stage: 'opus_encode', opus_encode_ms: 1.25 });
  for (const invalid of [NaN, Infinity, -1, 3_600_000.01, 'private']) {
    add(analysis, 'AAAAAAAA', 'jarvis_playback_state', { playback_stage: 'opus_encode', opus_encode_ms: invalid });
  }
  analysis.addLine('{"incident":"AAAAAAAA","event":"jarvis_playback_state","playback_stage":"opus_encode","opus_encode_ms":1e309}');
  analysis.addLine('{"incident":"AAAAAAAA","event":"jarvis_playback_state","playback_stage":"opus_encode","opus_encode_ms":NaN}');
  add(analysis, 'AAAAAAAA', 'jarvis_agent_audio_progress', { upload_ms: 200.5 });
  const report = analysis.snapshot();
  expect(report.stages.opus_encode_ms).toEqual({ n: 1, p50_ms: 1.25, p90_ms: 1.25,
    p95_ms: 1.25, max_ms: 1.25 });
  expect(report.paired_voice_pipeline.n).toBe(1);
  expect(report.paired_voice_pipeline.stages.opus_encode_ms.n).toBe(1);
  expect(report.turns[0].opus_encode_ms).toBe(1.25);
  expect(report.turns[0].upload_ms).toBe(200);
  expect(report.ignored_lines).toBe(1);
  expect(JSON.stringify(report)).not.toContain('private');
});
