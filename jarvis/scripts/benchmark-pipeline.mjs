import { pathToFileURL } from 'node:url';
import { summarize } from './benchmark-summary.mjs';

async function settle() { for (let index = 0; index < 80; index++) await Promise.resolve(); }

/** Virtual monotonic clock for production scheduling with an explicitly modelled remote peer. */
class Clock {
  now = 0;
  timers = new Set();
  install() {
    const saved = { performance: Object.getOwnPropertyDescriptor(globalThis, 'performance'),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, dateNow: Date.now };
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => this.now } });
    Date.now = () => 1_800_000_000_000 + this.now;
    globalThis.setTimeout = (callback, milliseconds = 0, ...args) => {
      const timer = { at: this.now + milliseconds, callback: () => callback(...args), unref() { return this; } };
      this.timers.add(timer);
      return timer;
    };
    globalThis.clearTimeout = timer => { this.timers.delete(timer); };
    return () => {
      Object.defineProperty(globalThis, 'performance', saved.performance);
      globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout;
      Date.now = saved.dateNow;
    };
  }
  sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
  async advance(milliseconds) {
    const until = this.now + milliseconds;
    await settle();
    for (;;) {
      let next;
      for (const timer of this.timers) if (timer.at <= until && (!next || timer.at < next.at)) next = timer;
      if (!next) break;
      this.now = next.at; this.timers.delete(next); next.callback(); await settle();
    }
    this.now = until; await settle();
  }
}

function harness(clock, mode, SessionManager) {
  const counters = {};
  const durations = {};
  let sttCalls = 0;
  let sessions = 0;
  let confirmed = 0;
  let unconfirmed = 0;
  let eventId = 0;
  let requestCount = 0;
  let responses = 0;
  let rejected = 0;
  const firstPlayback = [];
  const submittedAt = [];
  let manager;
  const streams = [];
  const schedule = (milliseconds, callback) => { setTimeout(callback, milliseconds); };
  const metric = (name, value = 1) => {
    counters[name] = (counters[name] ?? 0) + value;
    if (name.endsWith('_ms')) (durations[name] ??= []).push(value);
  };
  const playback = {
    get isPlaying() { return streams.some(stream => !stream.finished); },
    startStream(userId, _rate, _owner, options) {
      let resolve;
      const done = new Promise(yes => { resolve = yes; });
      let first = true;
      let ended = false;
      let drained = false;
      let latest = 0;
      const stream = {
        userId, finished: false, done,
        async write() {
          if (first) {
            first = false;
            schedule(20, () => { firstPlayback.push(clock.now - submittedAt.shift()); options?.onProgress?.('first_packet', 20); });
          }
          const version = ++latest;
          schedule(120, () => {
            if (version !== latest || stream.finished) return;
            drained = true; options?.onProgress?.('drained', 120);
            if (ended) { stream.finished = true; resolve(); }
          });
        },
        end() { ended = true; if (drained) { stream.finished = true; resolve(); } },
        cancel() { stream.finished = true; resolve(); },
      };
      streams.push(stream);
      return stream;
    },
    stopUser(userId) { for (const stream of streams) if (stream.userId === userId) stream.cancel(); },
    stop() { for (const stream of streams) stream.cancel(); },
  };
  const speaker = id => ({ discordUserId: id, displayName: 'generated fixture', guildId: 'fixture', channelId: 'fixture',
    consented: true, consentVersion: 1, isOwner: id === 'creator' });
  manager = new SessionManager({
    allowed: () => true, playback,
    detectWake: async () => {
      sttCalls++; await clock.sleep(560);
      if (mode === 'stt_failure') throw new Error('synthetic_provider_failure');
      return true;
    },
    connect: async (_speaker, callbacks) => {
      sessions++; await clock.sleep(486);
      let audioVersion = 0;
      let closed = false;
      const respond = voice => {
        if (closed) return;
        const omitCompletion = mode === 'missing_completion' && responses++ === 0;
        if (voice) {
          if (mode === 'recognition_timeout') return;
          callbacks.onUserTranscript?.({ eventId: ++eventId });
          callbacks.onConversationText?.({ kind: 'user_final', text: 'generated fixture', truncated: false, eventId });
        }
        const toolWait = mode === 'search_success' ? 150 : mode === 'search_timeout' ? 5_000 : 0;
        if (toolWait) {
          callbacks.onToolActivity?.(1);
          schedule(toolWait, () => callbacks.onToolActivity?.(0));
        }
        schedule(toolWait + 1_020, () => {
          if (closed) return;
          callbacks.onTextResponse?.({ eventId: ++eventId });
          callbacks.onConversationText?.({ kind: 'agent_final', text: 'generated fixture', truncated: false, eventId });
          for (let chunk = 0; chunk < 5; chunk++) {
            schedule(chunk * 100, () => { if (!closed) void callbacks.onAudio(Buffer.alloc(480, 1), ++eventId); });
          }
          if (!omitCompletion) schedule(450, () => { if (!closed) void callbacks.onResponseComplete(++eventId); });
        });
      };
      return {
        inputSampleRate: 16_000, outputSampleRate: 24_000,
        sendText() { respond(false); }, sendContext() {},
        sendAudio() {
          const version = ++audioVersion;
          // Remote fixture recognizes 200ms after the final paced input packet.
          schedule(200, () => { if (version === audioVersion) respond(true); });
        },
        close() { if (!closed) { closed = true; callbacks.onClose(); } },
      };
    },
    pace: () => clock.sleep(20), metric,
    maxSessions: 2, maxTurnSeconds: 12, maxSessionSeconds: 300,
    idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 100,
    onTurnDelivered: (_speaker, turn) => {
      if (turn.generation === 'confirmed') confirmed++;
      else unconfirmed++;
    },
  });
  async function submit(kind, user = 'creator', spokenMs = 1_000) {
    requestCount++;
    if (kind === 'text') {
      submittedAt.push(clock.now);
      void manager.ask(speaker(user), 'generated fixture').catch(() => { rejected++; });
      return;
    }
    const start = clock.now;
    await clock.advance(spokenMs + 600);
    const pcm = Buffer.alloc((spokenMs + 600) * 192);
    for (let offset = 0; offset < spokenMs * 192; offset += 2) pcm.writeInt16LE(1_000, offset);
    submittedAt.push(start);
    void manager.voiceTurn(speaker(user), pcm, { captureMs: spokenMs + 600, endDetectionMs: 600,
      captureId: `fixture-${requestCount}`, captureStartedAtMs: start, captureEndedAtMs: clock.now })
      .catch(() => { rejected++; });
  }
  return { submit, manager, counters, durations, firstPlayback,
    summary: () => ({ interactions: requestCount, success: confirmed,
      local_deliveries: confirmed + unconfirmed, unconfirmed_deliveries: unconfirmed, rejected, stt_calls: sttCalls,
      sessions_started: sessions, sessions_reused: counters.agent_session_reused ?? 0,
      timeouts: (counters.agent_user_turn_missing ?? 0) + (counters.agent_response_timeouts ?? 0),
      lost_questions: Math.max(0, requestCount - confirmed - unconfirmed - rejected - (counters.questions_failed ?? 0)),
    }),
  };
}

export async function runPipelineBenchmark(sessionManagerClass) {
  // The optional constructor lets tests exercise source on a clean checkout;
  // normal benchmark execution always uses the production build.
  const SessionManager = sessionManagerClass ?? (await import('../dist/agents/session-manager.js')).SessionManager;
  const scenarios = {};
  const repetitions = 5;
  for (const mode of ['short_voice', 'long_voice', 'text', 'consecutive', 'followup', 'two_speakers',
    'missing_completion', 'recognition_timeout', 'stt_failure', 'search_success', 'search_timeout']) {
    const totals = { interactions: 0, success: 0, local_deliveries: 0, unconfirmed_deliveries: 0,
      rejected: 0, stt_calls: 0, sessions_started: 0,
      sessions_reused: 0, timeouts: 0, lost_questions: 0 };
    const stageSamples = {};
    const clock = new Clock();
    const restore = clock.install();
    try {
      for (let repeat = 0; repeat < repetitions; repeat++) {
        const h = harness(clock, mode, SessionManager);
        try {
          const voice = ['short_voice', 'long_voice', 'followup', 'recognition_timeout', 'stt_failure'].includes(mode);
          await h.submit(voice ? 'voice' : 'text', 'creator', mode === 'long_voice' ? 4_000 : 1_000);
          if (['consecutive', 'two_speakers'].includes(mode)) {
            await clock.advance(200);
            await h.submit('text', mode === 'two_speakers' ? 'guest' : 'creator');
          } else if (['followup', 'missing_completion'].includes(mode)) {
            await clock.advance(6_000);
            await h.submit(mode === 'followup' ? 'voice' : 'text');
          }
          await clock.advance(20_000);
          const result = h.summary();
          for (const key of Object.keys(totals)) totals[key] += result[key];
          for (const [name, values] of Object.entries(h.durations)) (stageSamples[name] ??= []).push(...values);
          (stageSamples.capture_to_first_local_packet_ms ??= []).push(...h.firstPlayback);
        } finally { h.manager.close(); await settle(); }
      }
    } finally { restore(); }
    scenarios[mode] = { ...totals, success_rate: totals.success / totals.interactions,
      unconfirmed_delivery_rate: totals.unconfirmed_deliveries / totals.interactions,
      timeout_rate: totals.timeouts / totals.interactions, stt_calls_per_interaction: totals.stt_calls / totals.interactions,
      stages: Object.fromEntries(Object.entries(stageSamples).map(([name, values]) => [name, summarize(values)])) };
  }
  return { kind: 'synthetic_virtual_pipeline', repetitions,
    description: 'Production SessionManager with virtual monotonic timers, generated audio, mocked consent/provider/player. Success counts confirmed generation with local playback done; unconfirmed deliveries remain separate. No live STT, network, Brave, recognition quality, or Discord audibility assertions.',
    assumptions_ms: { vad_silence: 600, wake_stt: 560, connection: 486, upload_chunk_pacing: 20,
      recognition_after_last_input: 200, agent_after_recognition: 1_020, first_playback: 20,
      search_success: 150, search_timeout: 5_000 }, scenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await runPipelineBenchmark(), null, 2)}\n`);
}
