import { rms } from '../dist/audio/voice-activity.js';
import { summarize } from './benchmark-summary.mjs';

const FRAME_MS = 20;
const MIN_VOICE_RMS = 0.008;

function frame(amplitude) {
  const pcm = Buffer.alloc(960 * 4);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(amplitude, offset);
  return pcm;
}

// Amplitude envelopes only: these fixtures contain no words and cannot prove ASR quality.
const levels = { voice: rms(frame(8000)), quiet: rms(frame(0)), noise: rms(frame(150)), loud_noise: rms(frame(3000)) };
const cases = [
  { name: 'short_voice', expected: 1, spans: [['voice', 200], ['quiet', 1000]] },
  { name: 'long_voice', expected: 1, spans: [['voice', 4000], ['quiet', 1000]] },
  { name: 'phrase_with_280ms_pause', expected: 1,
    spans: [['voice', 600], ['quiet', 280], ['voice', 600], ['quiet', 1000]] },
  { name: 'phrase_with_460ms_pause', expected: 1,
    spans: [['voice', 600], ['quiet', 460], ['voice', 600], ['quiet', 1000]] },
  { name: 'phrase_with_540ms_pause', expected: 1,
    spans: [['voice', 600], ['quiet', 540], ['voice', 600], ['quiet', 1000]] },
  { name: 'two_separate_questions', expected: 2,
    spans: [['voice', 400], ['quiet', 1000], ['voice', 400], ['quiet', 1000]] },
  { name: 'silence', expected: 0, spans: [['quiet', 2000]] },
  { name: 'quiet_game_noise', expected: 0, spans: [['noise', 2000], ['quiet', 1000]] },
  { name: 'loud_game_noise', expected: 0, spans: [['loud_noise', 600], ['quiet', 1000]] },
];

function replay(fixture, silenceMs) {
  let active = false;
  let silentMs = 0;
  let captures = 0;
  const endDelays = [];
  for (const [kind, milliseconds] of fixture.spans) {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += FRAME_MS) {
      if (levels[kind] >= MIN_VOICE_RMS) {
        active = true;
        silentMs = 0;
      } else if (active) {
        silentMs += FRAME_MS;
        if (silentMs >= silenceMs) {
          captures++;
          endDelays.push(silentMs);
          active = false;
          silentMs = 0;
        }
      }
    }
  }
  return { name: fixture.name, expected_captures: fixture.expected, captures,
    fragmented: fixture.expected > 0 && captures > fixture.expected,
    false_positive: fixture.expected === 0 && captures > 0,
    lost_capture: captures < fixture.expected, end_delay: summarize(endDelays) };
}

export function runVadExperiment() {
  const variants = [600, 480, 400, 300].map(silenceMs => {
    const fixtures = cases.map(fixture => replay(fixture, silenceMs));
    return { silence_ms: silenceMs, fixtures: fixtures.length,
      fragmented_phrases: fixtures.filter(value => value.fragmented).length,
      false_positive_cases: fixtures.filter(value => value.false_positive).length,
      lost_capture_cases: fixtures.filter(value => value.lost_capture).length,
      results: fixtures };
  });
  return { kind: 'synthetic_vad_envelope_model', frame_ms: FRAME_MS, rms_threshold: MIN_VOICE_RMS,
    description: 'Threshold sweep using production RMS on generated amplitude envelopes. Not real PT-BR, Discord packet timing, wake recognition, overlap cancellation or a quality approval.',
    variants,
    decision: 'Keep production 600 ms. Shorter candidates fragment paused fixtures; no remote recognition or real speech validation permits a change.' };
}
