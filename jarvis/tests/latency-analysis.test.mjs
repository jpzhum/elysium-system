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
