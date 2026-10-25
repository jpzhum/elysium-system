import { expect, test, vi } from 'vitest';
import {
  VoiceAdmissionEvidence, voiceAdmissionEvents, type VoiceAdmissionEvent,
} from '../src/observability/voice-admission-evidence.js';

const OWNER = '100000000000000001';
const KEL = '100000000000000002';

test('recent multiuser evidence separates consented capture, paid starts, admission and delivery by anonymous participant', () => {
  const evidence = new VoiceAdmissionEvidence('DAA1BBD');
  for (const event of ['capture', 'wake_requested', 'wake_accepted', 'wake_valid', 'question_accepted', 'turn_responded'] as const) {
    evidence.record(OWNER, event);
  }
  evidence.record(KEL, 'capture'); evidence.record(KEL, 'wake_requested');
  evidence.record(KEL, 'wake_cooldown_rejected'); evidence.record(KEL, 'wake_global_rejected');
  evidence.record(KEL, 'wake_fair_share_rejected'); evidence.record(KEL, 'duplicate');
  evidence.record(KEL, 'queue_rejected'); evidence.record(KEL, 'turn_partial'); evidence.record(KEL, 'playback_failed');
  const snapshot = evidence.snapshot();
  expect(snapshot).toMatchObject({ scope: 'current_process', deployed_revision: 'daa1bbd', window_ms: 60_000,
    paid_starts_in_window: 1, window_complete: true, participants_complete: true });
  expect(snapshot.recent).toMatchObject({ capture: 2, wake_requested: 2, wake_accepted: 1, wake_valid: 1,
    question_accepted: 1, turn_responded: 1, turn_partial: 1, playback_failed: 1 });
  expect(snapshot.participants.map(value => value.participant)).toEqual(['falante_1', 'falante_2']);
  expect(snapshot.participants[0]!.counts).toMatchObject({ wake_accepted: 1, turn_responded: 1, turn_partial: 0 });
  expect(snapshot.participants[1]!.counts).toMatchObject({ wake_accepted: 0, turn_responded: 0, turn_partial: 1 });
  expect(JSON.stringify(snapshot)).not.toContain(OWNER); expect(JSON.stringify(snapshot)).not.toContain(KEL);
  expect(evidence.pages().join('\n')).not.toContain(OWNER); expect(evidence.pages().join('\n')).not.toContain(KEL);
});

test('sixty-second window expires without timers while current-process totals remain separate', () => {
  vi.useFakeTimers();
  try {
    let now = 0;
    const evidence = new VoiceAdmissionEvidence(undefined, () => now);
    evidence.record(OWNER, 'wake_accepted');
    now = 59_999; expect(evidence.snapshot().paid_starts_in_window).toBe(1);
    now = 60_000;
    expect(evidence.snapshot()).toMatchObject({ retained_events: 0, paid_starts_in_window: 0, participants: [],
      recent: { wake_accepted: 0 }, process: { wake_accepted: 1 } });
    expect(vi.getTimerCount()).toBe(0);
    const restarted = new VoiceAdmissionEvidence(undefined, () => now);
    expect(restarted.snapshot().process.wake_accepted).toBe(0);
    expect(restarted.snapshot().deployed_revision).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('sample and participant caps are explicit without corrupting process totals or mixing an evicted participant', () => {
  let now = 0;
  const evidence = new VoiceAdmissionEvidence(undefined, () => now);
  for (let sample = 0; sample < 300; sample++) evidence.record(OWNER, 'capture');
  expect(evidence.snapshot()).toMatchObject({ retained_events: 256, window_complete: false,
    recent: { capture: 256 }, process: { capture: 300 } });
  for (let actor = 0; actor < 20; actor++) {
    now++;
    evidence.record(`PRIVATE-${actor}`, 'wake_requested');
  }
  const snapshot = evidence.snapshot();
  expect(snapshot.participants).toHaveLength(16);
  expect(snapshot.participants_complete).toBe(false);
  expect(snapshot.recent.wake_requested).toBe(20);
  expect(snapshot.participants.reduce((sum, actor) => sum + actor.counts.wake_requested, 0)).toBe(16);
  expect(snapshot.participants.some(actor => actor.participant === 'falante_1')).toBe(false);
  expect(snapshot.process.capture).toBe(300);
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  now += 60_000;
  expect(evidence.snapshot()).toMatchObject({ window_complete: true, participants_complete: true,
    retained_events: 0, participants: [] });
});

test('revocation and room cleanup remove identity correlation while preserving anonymous recent aggregates and disconnect reason', () => {
  let now = 0;
  const evidence = new VoiceAdmissionEvidence(undefined, () => now);
  evidence.record(OWNER, 'followup'); evidence.record(KEL, 'question_accepted');
  evidence.forget(KEL);
  expect(evidence.snapshot().participants.map(actor => actor.participant)).toEqual(['falante_1']);
  expect(evidence.snapshot().recent.question_accepted).toBe(1);
  evidence.disconnect('explicit_leave'); evidence.clearParticipants();
  now = 2000;
  expect(evidence.snapshot()).toMatchObject({ participants: [], process: { followup: 1, question_accepted: 1 },
    last_disconnect: { reason: 'explicit_leave', ago_ms: 2000 } });
  evidence.record(KEL, 'capture');
  expect(evidence.snapshot().participants[0]!.participant).toBe('falante_3');
  expect(evidence.pages().join('\n')).toContain('explicit_leave, há 2 s');
});

test('a burst of local captures cannot hide rolling paid starts or erase their cost when consent is cleared', () => {
  const evidence = new VoiceAdmissionEvidence();
  for (let check = 0; check < 6; check++) evidence.record(OWNER, 'wake_accepted', {
    turnId: check.toString(16).padStart(8, '0').toUpperCase(),
  });
  for (let capture = 0; capture < 300; capture++) evidence.record(KEL, 'capture');
  evidence.record(OWNER, 'wake_accepted', { turnId: '00000000' });
  expect(evidence.snapshot()).toMatchObject({ window_complete: false, paid_starts_in_window: 6,
    recent: { wake_accepted: 6 }, process: { wake_accepted: 6 } });
  expect(evidence.snapshot().participants[0]!.counts.wake_accepted).toBe(6);
  evidence.clearParticipants();
  expect(evidence.snapshot()).toMatchObject({ participants: [], paid_starts_in_window: 6, recent: { wake_accepted: 6 } });
});

test('technical turn samples deduplicate repeated callbacks and distinguish confirmed, unconfirmed and partial outcomes', () => {
  const evidence = new VoiceAdmissionEvidence();
  for (let repeat = 0; repeat < 5; repeat++) {
    evidence.record(OWNER, 'question_accepted', { turnId: 'AABBCCDD' });
    evidence.record(OWNER, 'first_audio', { turnId: 'AABBCCDD', durationMs: 1500 });
    evidence.record(OWNER, 'turn_released', { turnId: 'AABBCCDD', durationMs: 3000 });
  }
  evidence.record(OWNER, 'turn_responded', { turnId: 'AABBCCDD' });
  evidence.record(OWNER, 'turn_unconfirmed', { turnId: 'AABBCCDE' });
  evidence.record(OWNER, 'turn_partial', { turnId: 'AABBCCDF' });
  const actor = evidence.snapshot().participants[0]!;
  expect(actor.counts).toMatchObject({ question_accepted: 1, first_audio: 1, turn_released: 1,
    turn_responded: 1, turn_unconfirmed: 1, turn_partial: 1 });
  expect(actor.first_audio_ms).toEqual({ n: 1, p50_ms: 1500, p90_ms: 1500, p95_ms: 1500, max_ms: 1500 });
  expect(actor.busy_ms).toEqual({ n: 1, p50_ms: 3000, p90_ms: 3000, p95_ms: 3000, max_ms: 3000 });
});

test('duration reports preserve measured zero, observed percentiles and missing samples instead of fabricated timings', () => {
  const evidence = new VoiceAdmissionEvidence();
  for (const duration of [0, 100, 200, 300]) evidence.record(OWNER, 'first_audio', { durationMs: duration });
  for (const duration of [NaN, Infinity, -1, 3_600_001]) evidence.record(OWNER, 'turn_released', { durationMs: duration });
  evidence.record(KEL, 'turn_released');
  const [owner, kel] = evidence.snapshot().participants;
  expect(owner!.first_audio_ms).toEqual({ n: 4, p50_ms: 150, p90_ms: 300, p95_ms: 300, max_ms: 300 });
  expect(owner!.busy_ms).toEqual({ n: 0, p50_ms: null, p90_ms: null, p95_ms: null, max_ms: null });
  expect(kel!.first_audio_ms.n).toBe(0);
  expect(evidence.pages().join('\n')).not.toMatch(/NaN|Infinity/);
});

test('only fixed technical fields are retained and pages stay below Discord limits under complete metrics', () => {
  const evidence = new VoiceAdmissionEvidence('PRIVATE_SECRET');
  evidence.record(OWNER, 'PRIVATE_TEXT' as VoiceAdmissionEvent, { durationMs: 12 });
  expect(evidence.snapshot().participants).toHaveLength(0);
  for (let actor = 0; actor < 16; actor++) {
    for (const event of voiceAdmissionEvents) evidence.record(`PRIVATE-ID-${actor}`, event, {
      durationMs: 50, turnId: 'PRIVATE', ...{ transcript: 'PRIVATE', audio: Buffer.alloc(40), signedUrl: 'PRIVATE' },
    });
  }
  evidence.disconnect('PRIVATE' as 'explicit_leave');
  const pages = evidence.pages();
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every(page => page.length <= 1500)).toBe(true);
  expect(pages.join('\n')).not.toMatch(/PRIVATE|transcript|signedUrl|100000000000000/);
  expect(pages.join('\n')).toContain('não informada');
  expect(pages.join('\n')).toContain('não comprova audição');
  expect(evidence.snapshot().last_disconnect).toBeNull();
});
