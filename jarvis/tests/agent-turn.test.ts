import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentConnector, type AgentDependencies } from '../src/agents/elevenlabs-client.js';
import { SessionManager, type Playback, type SessionOptions } from '../src/agents/session-manager.js';
import { WakeError } from '../src/agents/wake-detector.js';
import type { PlaybackStream } from '../src/audio/playback.js';
import { DiagnosticError } from '../src/observability/diagnostics.js';
import { Logger, Metrics } from '../src/observability/metrics.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

const secret = 'PRIVATE-text-and-credentials-that-must-not-appear';
class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  pause = vi.fn();
  resume = vi.fn();
  send(_data: string, callback?: (error?: Error) => void): void { callback?.(); }
  open(): void { this.readyState = 1; this.emit('open'); }
  event(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close(): void { this.readyState = 3; this.emit('close', 1000, Buffer.from(secret)); }
  terminate(): void { this.close(); }
}
const active: SessionManager[] = [];
async function settle(): Promise<void> { for (let step = 0; step < 30; step++) await Promise.resolve(); }

function setup(pendingPlayback = false, pace?: SessionOptions['pace'], options: Partial<SessionOptions> = {}) {
  const socket = new Socket();
  const metrics = new Metrics();
  const logs: Record<string, unknown>[] = [];
  const connector = createAgentConnector({
    fetch: vi.fn<typeof fetch>(async () => Response.json({
      signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test&token=${secret}`,
    })),
    createSocket: () => {
      queueMicrotask(() => {
        socket.open();
        socket.event({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
          conversation_id: 'fixture-private-id', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
        } });
      });
      return socket as unknown as ReturnType<AgentDependencies['createSocket']>;
    }, random: () => 0.5, sleep: async () => undefined,
  });
  const consent = new ConsentStore();
  const grant = consent.grant('guest', true);
  const speaker = speakerContext({ discordUserId: 'guest', displayName: secret, guildId: 'guild', channelId: 'room',
    consented: true, consentVersion: grant.version }, 'owner');
  interface LocalStream extends PlaybackStream { userId: string; ended: boolean; settled: boolean; finish(): void; }
  const streams: LocalStream[] = [];
  const copies: Buffer[] = [];
  let allowFinish = !pendingPlayback;
  const playback: Playback = {
    get isPlaying() { return streams.some(stream => !stream.settled); },
    startStream: vi.fn((userId, _rate, _owner, options) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void done.catch(() => undefined);
      let started = false;
      const stream: LocalStream = {
        userId, done, ended: false, settled: false,
        write: vi.fn(async (pcm) => {
          if (stream.settled || stream.ended || options?.isAllowed?.() === false) throw new Error('cancelled');
          // Synthetic consumer accepts bounded chunks and records copies before
          // adapter ownership ends; no actual Discord audibility is asserted.
          if (pcm.length > 65_536) throw new Error('bounded playback ingress');
          copies.push(Buffer.from(pcm));
          if (!started) {
            started = true;
            metrics.add('audio_stream_started'); metrics.add('playback_started');
          }
          metrics.add('audio_chunks_played');
        }),
        end: vi.fn(() => { stream.ended = true; stream.finish(); }),
        finish: () => {
          if (!allowFinish || !stream.ended || stream.settled) return;
          stream.settled = true;
          metrics.add('playback_completed'); resolve();
        },
        cancel: vi.fn(() => {
          if (stream.settled) return;
          stream.settled = true;
          metrics.add('playback_cancelled'); reject(new Error('cancelled'));
        }),
      };
      streams.push(stream);
      return stream;
    }),
    stopUser: vi.fn(userId => { for (const stream of streams) if (stream.userId === userId) stream.cancel(); }),
    stop: vi.fn(() => { for (const stream of streams) stream.cancel(); }),
  };
  const detectWake = vi.fn(async () => false);
  const manager = new SessionManager({
    connect: (_speaker, callbacks, signal) => connector({ apiKey: secret, agentId: 'agent_test',
      dynamicVariables: {}, callbacks, signal }),
    allowed: (context, audio) => consent.isCurrent(context.discordUserId, context.consentVersion, audio),
    detectWake, playback, maxSessions: 2, maxTurnSeconds: 12,
    maxSessionSeconds: 300, idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 100,
    metric: metrics.add, logger: new Logger('info', (line) => logs.push(JSON.parse(line))), pace, ...options,
  });
  active.push(manager);
  const audio = (id = 1, value = 1) => socket.event({ type: 'audio', audio_event: {
    audio_base_64: Buffer.from([value, 0, value + 1, 0]).toString('base64'), event_id: id,
  } });
  const text = () => socket.event({ type: 'agent_response', agent_response_event: { agent_response: secret, event_id: 2 } });
  const complete = (id = 3) => socket.event({ type: 'agent_response_complete', agent_response_complete_event: { event_id: id } });
  const ping = () => socket.event({ type: 'ping', ping_event: { event_id: 50 } });
  const tool = (pending: boolean) => socket.event(pending
    ? { type: 'agent_tool_request', agent_tool_request: { tool_call_id: 'tool_private' } }
    : { type: 'agent_tool_response', agent_tool_response: { tool_call_id: 'tool_private' } });
  const failed = (code: string) => {
    const failures = logs.filter((line) => line.event === 'jarvis_agent_turn_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code, operation: 'agent_turn', incident: expect.stringMatching(/^[0-9A-F]{8}$/),
      duration_ms: expect.any(Number) });
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain('fixture-private-id');
    return failures[0]!;
  };
  const finishPlayback = () => { allowFinish = true; for (const stream of streams) stream.finish(); };
  return { manager, speaker, socket, metrics, logs, audio, text, complete, ping, tool,
    playback, copies, streams, consent, finishPlayback, failed, detectWake,
    ask: async () => { const receipt = await manager.ask(speaker, secret); await settle(); return receipt; } };
}

afterEach(() => {
  for (const manager of active.splice(0)) manager.close();
  vi.useRealTimers();
});

test('invalid capture rejection logs only its category before wake detection or provider connection', async () => {
  const h = setup();
  await h.manager.voiceTurn(h.speaker, Buffer.alloc(3_836, 1));
  await h.manager.voiceTurn(h.speaker, Buffer.alloc(19_200));
  expect(h.detectWake).not.toHaveBeenCalled();
  expect(h.manager.activeCount).toBe(0);
  expect(h.logs).toMatchObject([
    { event: 'jarvis_voice_capture_rejected', code: 'AGENT_INPUT_INVALID', capture_rejection: 'too_short',
      incident: expect.stringMatching(/^[0-9A-F]{8}$/), capture_ms: 20 },
    { event: 'jarvis_voice_capture_rejected', code: 'AGENT_INPUT_INVALID', capture_rejection: 'silent', capture_ms: 100 },
  ]);
  expect(JSON.stringify(h.logs)).not.toContain(secret);
});

test('missing ASR has its own sanitized ten-second diagnostic without being counted as generation or search timeout', async () => {
  vi.useFakeTimers();
  const h = setup(false, async () => undefined); h.detectWake.mockResolvedValue(true);
  await h.manager.voiceTurn(h.speaker, Buffer.alloc(3_840, 1)); await settle();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(h.logs.filter(line => line.event === 'jarvis_agent_turn_failed')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2); await settle();
  expect(h.failed('AGENT_USER_TURN_MISSING')).toMatchObject({
    stage: 'agent_user_recognition', timeout_ms: 10_000, user_turn_recognized: false,
    input_audio_finished: true, input_source_chunks: 1, input_silence_chunks: 40,
  });
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  expect(h.metrics.snapshot().agent_completion_missing ?? 0).toBe(0);
  expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
});

test('failed wake STT retains the capture incident without becoming a missed wake word', async () => {
  const h = setup();
  h.detectWake.mockRejectedValue(new WakeError('wake_provider_failed'));
  await expect(h.manager.voiceTurn(h.speaker, Buffer.alloc(19_200, 1)))
    .rejects.toMatchObject({ code: 'wake_provider_failed' });
  const capture = h.logs.find(line => line.event === 'jarvis_voice_captured');
  expect(h.logs.find(line => line.event === 'jarvis_wake_failed')).toMatchObject({
    incident: capture?.incident, stage: 'wake_detection', rejection_reason: 'wake_provider_failed',
    duration_ms: expect.any(Number),
  });
  expect(h.metrics.snapshot().wake_rejections ?? 0).toBe(0);
  expect(JSON.stringify(h.logs)).not.toContain(secret);
});

test.each([
  { event: { type: 'guardrail_triggered', private_details: secret }, code: 'AGENT_GUARDRAIL_REJECTED',
    counter: 'agent_guardrail_rejections' },
  { event: { type: 'queue_status', queue_status_event: { status: 'waiting' } }, code: 'AGENT_CONCURRENCY_LIMIT',
    counter: 'agent_concurrency_rejections' },
])('known provider rejection is distinguishable from an absent response: $code', async ({ event, code, counter }) => {
  const h = setup();
  await h.ask();
  h.socket.event(event); await settle();
  h.failed(code);
  expect(h.metrics.snapshot()[counter]).toBe(1);
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  expect(h.metrics.snapshot().agent_user_turn_missing ?? 0).toBe(0);
  expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
});

test('real final text enters RAM only after successful local playback and remains absent from diagnostics', async () => {
  const onTurnDelivered = vi.fn();
  const h = setup(true, undefined, { onTurnDelivered });
  const receipt = await h.ask();
  h.text(); h.audio(); h.complete(); await settle();
  expect(onTurnDelivered).not.toHaveBeenCalled();
  h.finishPlayback(); await settle();
  expect(onTurnDelivered).toHaveBeenCalledExactlyOnceWith(h.speaker, {
    turnId: receipt.turnId, inputKind: 'text', question: secret, response: secret, generation: 'confirmed',
  });
  expect(JSON.stringify(h.logs)).not.toContain(secret);
});

test('real audio without completion preserves observed final text separately from a confirmed delivered answer', async () => {
  vi.useFakeTimers();
  const onTurnDelivered = vi.fn();
  const h = setup(false, undefined, { onTurnDelivered });
  const receipt = await h.ask();
  h.text(); h.audio(); await settle();
  await vi.advanceTimersByTimeAsync(45_001); await settle();
  expect(onTurnDelivered).toHaveBeenCalledExactlyOnceWith(h.speaker, {
    turnId: receipt.turnId, inputKind: 'text', question: secret, observedResponse: secret, generation: 'unconfirmed',
  });
  expect(onTurnDelivered.mock.calls[0]![1]).not.toHaveProperty('response');
  expect(h.metrics.snapshot().agent_turns_completed ?? 0).toBe(0);
});

test('wire final ASR, rather than a tentative transcript or startup greeting, is the remembered voice question', async () => {
  const onTurnDelivered = vi.fn();
  const h = setup(false, async () => undefined, { onTurnDelivered }); h.detectWake.mockResolvedValue(true);
  const receipt = await h.manager.voiceTurn(h.speaker, Buffer.alloc(3_840, 1)); await settle();
  h.text(); h.audio();
  h.socket.event({ type: 'tentative_user_transcript', user_transcription_event: { user_transcript: 'tentative-private' } });
  await settle();
  h.socket.event({ type: 'user_transcript', user_transcription_event: { user_transcript: 'Jarvis, onde encontro a arma?', event_id: 10 } });
  h.socket.event({ type: 'agent_response', agent_response_event: { agent_response: 'Na torre.', event_id: 11 } });
  h.audio(11); h.complete(11); await settle();
  expect(onTurnDelivered).toHaveBeenCalledExactlyOnceWith(h.speaker, {
    turnId: receipt!.turnId, inputKind: 'voice', question: 'Jarvis, onde encontro a arma?', response: 'Na torre.', generation: 'confirmed',
  });
  expect(JSON.stringify(h.logs)).not.toContain('arma');
  expect(JSON.stringify(h.logs)).not.toContain('torre');
  expect(JSON.stringify(h.logs)).not.toContain('tentative-private');
});

test('documented audio starts before completion and repeated event IDs preserve all PCM in arrival order', async () => {
  const h = setup();
  await h.ask();
  h.text(); h.audio(1, 1); h.audio(1, 3);
  await settle();
  expect(h.copies).toEqual([Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])]);
  expect(h.playback.startStream).toHaveBeenCalledOnce();
  expect(h.metrics.snapshot()).toMatchObject({ playback_started: 1, audio_chunks_received: 2, audio_bytes_received: 8 });
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
  h.complete(); await settle();
  expect(h.metrics.snapshot()).toMatchObject({ agent_sessions_started: 1, agent_turns: 1,
    agent_responses_completed: 1, playback_completed: 1, agent_turns_completed: 1,
    agent_response_complete_received: 1, agent_response_received: 1,
    agent_response_complete_events_received: 1, agent_text_events_received: 1 });
  expect(h.logs.filter(line => line.event === 'jarvis_agent_turn_failed')).toHaveLength(0);
  expect(JSON.stringify(h.logs)).not.toContain(secret);
});

test('real wire recognition gates a microphone response and keeps capture-to-response diagnostics correlated', async () => {
  vi.useFakeTimers();
  const h = setup(false, async () => undefined); h.detectWake.mockResolvedValue(true);
  const receipt = await h.manager.voiceTurn(h.speaker, Buffer.alloc(19_200, 1), { captureMs: 700, endDetectionMs: 600 });
  await settle();
  h.text(); h.audio(1, 90); h.complete(1); await settle();
  expect(h.copies).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1_500);
  h.socket.event({ type: 'tentative_user_transcript', user_transcription_event: { user_transcript: secret } });
  await settle();
  expect(h.metrics.snapshot().agent_user_turns_recognized ?? 0).toBe(0);
  h.socket.event({ type: 'user_transcript', user_transcription_event: { user_transcript: secret, event_id: 10 } });
  h.socket.event({ type: 'agent_response', agent_response_event: { agent_response: secret, event_id: 11 } });
  h.audio(11, 4); h.complete(11); await settle();
  expect(h.copies).toEqual([Buffer.from([4, 0, 5, 0])]);
  expect(h.metrics.snapshot()).toMatchObject({ agent_user_turns_recognized: 1, agent_responses_after_recognition: 1,
    agent_initial_audio_discarded: 1, agent_turns_completed: 1, voice_wake_activations: 1 });
  const stages = ['jarvis_voice_captured', 'jarvis_wake_detected', 'jarvis_agent_input_started',
    'jarvis_agent_input_sent', 'jarvis_agent_user_turn_recognized', 'jarvis_agent_response_observed'];
  for (const event of stages) {
    expect(h.logs.filter(line => line.event === event), event).toMatchObject([{ incident: receipt!.turnId, input_kind: 'voice' }]);
  }
  expect(h.logs.find(line => line.event === 'jarvis_agent_input_sent')).toMatchObject({
    input_audio_finished: true, input_sample_rate: 16000, silence_tail_ms: 800, input_audio_chunks: 45,
    input_audio_bytes: 28_800, user_turn_recognized: false, speaker_verified: true, consent_current: true,
  });
  expect(JSON.stringify(h.logs)).not.toContain(secret);
  expect(JSON.stringify(h.logs)).not.toContain('fixture-private-id');
});

test('missing completion recovers after inactivity, drains valid audio and never claims a successful conversation turn', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  h.audio(); await settle();
  expect(h.copies).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(44_000);
  expect(h.streams[0]!.ended).toBe(false);
  await vi.advanceTimersByTimeAsync(1_001); await settle();
  expect(h.metrics.snapshot()).toMatchObject({ audio_chunks_received: 1, audio_bytes_received: 4,
    agent_completion_recovery_timeouts: 1, agent_completion_missing: 1, turn_completion_missing: 1,
    playback_started: 1, playback_completed: 1 });
  expect(h.metrics.snapshot().agent_turns_completed ?? 0).toBe(0);
  expect(h.metrics.snapshot().agent_errors ?? 0).toBe(0);
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  expect(h.logs.filter(line => line.event === 'jarvis_agent_turn_failed')).toHaveLength(0);
  expect(h.logs.find(line => line.event === 'jarvis_agent_turn_recovering')).toMatchObject({
    code: 'AGENT_COMPLETION_MISSING', audio_bytes: 4, completion_received: false,
  });
  expect(h.manager.activeCount).toBe(0);
  await h.manager.voiceTurn(h.speaker, Buffer.alloc(3_840, 1));
  expect(h.detectWake).toHaveBeenCalledOnce();
  expect(h.playback.startStream).toHaveBeenCalledOnce();
});

test('generation completion and playback drain are independent; new asks are queued until local drain', async () => {
  const h = setup(true);
  await h.ask();
  h.audio(); h.complete(); await settle();
  expect(h.streams[0]!.ended).toBe(true);
  expect(h.metrics.snapshot().agent_responses_completed).toBe(1);
  expect(h.metrics.snapshot().agent_turns_completed ?? 0).toBe(0);
  await expect(h.manager.ask(h.speaker, secret)).resolves.toMatchObject({ queued: true, position: 1 });
  h.finishPlayback(); await settle();
  expect(h.metrics.snapshot()).toMatchObject({ playback_completed: 1, agent_turns_completed: 1 });
});

test('no provider output identifies the primary timeout without cleanup creating a second provider error', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  await vi.advanceTimersByTimeAsync(45_001); await settle();
  expect(h.failed('AGENT_RESPONSE_TIMEOUT')).toMatchObject({ text_received: false, audio_chunks: 0 });
  expect(h.metrics.snapshot().agent_errors ?? 0).toBe(0);
  expect(h.playback.startStream).not.toHaveBeenCalled();
});

test.each([true, false])('detects text without audio, with completion=%s', async completed => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  h.text();
  if (completed) h.complete();
  else await vi.advanceTimersByTimeAsync(45_001);
  await settle();
  expect(h.failed('AGENT_TEXT_WITHOUT_AUDIO')).toMatchObject({ text_received: true, audio_bytes: 0, completion_received: completed });
  expect(h.metrics.snapshot().agent_text_without_audio).toBe(1);
  expect(h.playback.startStream).not.toHaveBeenCalled();
});

test('explicit completion with no text and no audio is an empty response', async () => {
  const h = setup();
  await h.ask();
  h.complete(); await settle();
  expect(h.failed('AGENT_EMPTY_RESPONSE')).toMatchObject({ completion_received: true });
  expect(h.metrics.snapshot().agent_responses_completed).toBe(1);
  expect(h.playback.startStream).not.toHaveBeenCalled();
});

test('malformed completion cancels progressive output without accepting a fabricated generation end', async () => {
  const h = setup();
  await h.ask();
  h.audio(); await settle();
  h.socket.event({ type: 'agent_response_complete', agent_response_complete_event: { event_id: secret } });
  await settle();
  expect(h.metrics.snapshot()).toMatchObject({ agent_response_complete_events_received: 1, agent_errors: 1 });
  expect(h.metrics.snapshot().agent_responses_completed ?? 0).toBe(0);
  h.failed('AGENT_INVALID_EVENT');
  expect(h.streams[0]!.cancel).toHaveBeenCalled();
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
});

test.each(['close', 'error'])('premature WebSocket %s drains validated queued audio and records one primary error', async kind => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  h.audio(1, 1); h.audio(1, 3);
  if (kind === 'close') h.socket.close();
  else h.socket.emit('error', new Error(secret));
  await settle();
  await vi.advanceTimersByTimeAsync(46_000);
  h.failed(kind === 'close' ? 'AGENT_PREMATURE_CLOSE' : 'AGENT_TRANSPORT_ERROR');
  expect(h.copies).toEqual([Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])]);
  expect(h.metrics.snapshot()).toMatchObject({ agent_errors: 1, playback_completed: 1, turn_completion_missing: 1 });
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  expect(h.metrics.snapshot().agent_turns_completed ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});

test('a primary provider error stays singular even when teardown emits close', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  h.socket.event({ type: 'client_error', error_event: { code: 401, message: secret } });
  await vi.advanceTimersByTimeAsync(46_000); await settle();
  h.failed('AGENT_AUTHENTICATION_FAILED');
  expect(h.metrics.snapshot().agent_errors).toBe(1);
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
});

test('socket closure after explicit completion preserves queued full output', async () => {
  const h = setup(true);
  await h.ask();
  h.audio(); h.complete(); await settle();
  h.socket.close(); await settle();
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
  h.finishPlayback(); await settle();
  expect(h.metrics.snapshot().playback_completed).toBe(1);
  expect(h.metrics.snapshot().agent_errors ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});

test('revocation cancels progressive and queued output immediately and fences late provider events', async () => {
  const h = setup(true);
  await h.ask();
  h.audio(); await settle();
  h.consent.revoke(h.speaker.discordUserId);
  h.manager.revoke(h.speaker.discordUserId);
  h.finishPlayback(); h.audio(); h.complete(); await settle();
  expect(h.playback.stopUser).toHaveBeenCalledWith(h.speaker.discordUserId);
  expect(h.streams[0]!.cancel).toHaveBeenCalled();
  expect(h.copies).toHaveLength(1);
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});

test('an old duplicate completion cannot seal the next question but does not block progressive audio', async () => {
  const h = setup();
  await h.ask();
  h.audio(); h.complete(3); await settle();
  await h.ask();
  h.audio(); h.complete(3); await settle();
  expect(h.playback.startStream).toHaveBeenCalledTimes(2);
  expect(h.streams[1]!.ended).toBe(false);
  h.complete(4); await settle();
  expect(h.metrics.snapshot().playback_completed).toBe(2);
  expect(h.metrics.snapshot().agent_duplicate_completions).toBe(1);
});

test('pending tools suspend response inactivity recovery and multiple messages remain on one ordered stream', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  h.text(); h.audio(); h.tool(true); await settle();
  for (let interval = 0; interval < 3; interval++) { await vi.advanceTimersByTimeAsync(35_000); h.ping(); }
  expect(h.manager.activeCount).toBe(1);
  expect(h.metrics.snapshot().turn_completion_missing ?? 0).toBe(0);
  h.text(); h.audio(1, 3); h.tool(false); await settle();
  expect(h.playback.startStream).toHaveBeenCalledOnce();
  expect(h.copies).toHaveLength(2);
  h.complete(); await settle();
  expect(h.metrics.snapshot()).toMatchObject({ agent_response_received: 2, agent_turns_completed: 1 });
});

test('completion received while a tool is pending waits for its response before ending ingress', async () => {
  const h = setup();
  await h.ask();
  h.audio(); h.tool(true); h.complete(); await settle();
  expect(h.streams[0]!.ended).toBe(false);
  expect(h.metrics.snapshot().agent_responses_completed).toBe(1);
  h.tool(false); await settle();
  expect(h.streams[0]!.ended).toBe(true);
  expect(h.metrics.snapshot().agent_turns_completed).toBe(1);
});

test('hard session TTL bounds pending tools and cancels output even when pings keep the provider alive', async () => {
  vi.useFakeTimers();
  const h = setup(true);
  await h.ask();
  h.audio(); h.tool(true); await settle();
  for (let interval = 0; interval < 8; interval++) { await vi.advanceTimersByTimeAsync(35_000); h.ping(); }
  await vi.advanceTimersByTimeAsync(20_001); await settle();
  h.failed('AGENT_SESSION_EXPIRED');
  expect(h.streams[0]!.cancel).toHaveBeenCalled();
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});

test('audio progress supports long generation while transport pings alone do not reset response inactivity', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.ask();
  h.audio(); await settle();
  await vi.advanceTimersByTimeAsync(30_000); h.audio(1, 3); await settle();
  await vi.advanceTimersByTimeAsync(30_000); h.audio(1, 5); h.complete(); await settle();
  expect(h.copies).toHaveLength(3);
  expect(h.metrics.snapshot()).toMatchObject({ playback_completed: 1, agent_turns_completed: 1 });
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  await h.ask();
  await vi.advanceTimersByTimeAsync(40_000); h.ping();
  await vi.advanceTimersByTimeAsync(5_001); await settle();
  h.failed('AGENT_RESPONSE_TIMEOUT');
});

test('local playback backpressure is not mistaken for provider inactivity', async () => {
  vi.useFakeTimers();
  const h = setup(); await h.ask();
  h.audio(); await settle();
  let release!: () => void;
  const capacity = new Promise<void>((resolve) => { release = resolve; });
  const write = h.streams[0]!.write;
  vi.spyOn(h.streams[0]!, 'write').mockImplementationOnce(async (pcm) => { await capacity; await write(pcm); });
  h.audio(1, 3); await settle();
  for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(35_000); h.ping(); }
  expect(h.manager.activeCount).toBe(1);
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  h.complete(); release(); await settle();
  expect(h.copies).toHaveLength(2);
  expect(h.metrics.snapshot()).toMatchObject({ playback_completed: 1, agent_turns_completed: 1 });
});

test('provider heartbeat failure drains valid audio and keeps one specific primary diagnostic', async () => {
  vi.useFakeTimers();
  const h = setup(); await h.ask();
  h.audio(); h.tool(true); await settle();
  await vi.advanceTimersByTimeAsync(100_001); await settle();
  h.failed('AGENT_HEARTBEAT_TIMEOUT');
  expect(h.copies).toHaveLength(1);
  expect(h.metrics.snapshot()).toMatchObject({ agent_errors: 1, playback_completed: 1, turn_completion_missing: 1 });
  expect(h.metrics.snapshot().agent_turns_completed ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});

test.each(['start', 'write', 'done'] as const)('playback %s failures preserve their safe original code and request incident', async (phase) => {
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((_resolve, reject) => { rejectDone = reject; });
  void done.catch(() => undefined);
  const failure = new DiagnosticError('network', 'ECONNRESET');
  failure.message = secret;
  const playback: Playback = {
    isPlaying: false, stopUser: vi.fn(), stop: vi.fn(),
    startStream: vi.fn(() => {
      if (phase === 'start') throw failure;
      return { done, end: vi.fn(), cancel: vi.fn(), write: vi.fn(async () => {
        if (phase === 'write') throw failure;
      }) };
    }),
  };
  const h = setup(false, undefined, { playback });
  const receipt = await h.ask();
  h.text(); h.audio(); await settle();
  if (phase === 'done') { rejectDone(failure); await settle(); }
  const summary = h.failed('PLAYBACK_FAILED');
  expect(summary).toMatchObject({ incident: receipt.turnId, category: 'playback', cause_code: 'ECONNRESET',
    playback_stage: phase === 'start' ? 'player_start' : phase === 'write' ? 'pcm_input' : 'player' });
  const originals = h.logs.filter(line => line.event === 'jarvis_playback_failed');
  expect(originals).toHaveLength(1);
  expect(originals[0]).toMatchObject({ incident: receipt.turnId, category: 'network', code: 'ECONNRESET', stage: 'playback' });
  expect(h.manager.activeCount).toBe(0);
});

test('real playback diagnostics survive a later generic stream rejection without losing encoder and player state', async () => {
  const playback: Playback = {
    isPlaying: false, stopUser: vi.fn(), stop: vi.fn(),
    startStream: vi.fn((_id, _rate, _owner, options) => ({
      done: new Promise<void>(() => undefined), end: vi.fn(), cancel: vi.fn(),
      write: vi.fn(async () => {
        options?.onDiagnostic?.({ playback_stage: 'player', player_status: 'buffering', previous_player_status: 'idle' });
        options?.onDiagnostic?.({ category: 'playback', code: 'PLAYBACK_ENCODER_FAILED', cause_code: 'UNKNOWN',
          playback_stage: 'opus_encode', opus_error_code: -2, player_status: 'buffering', voice_status: 'ready', dave_ready: true });
        throw new Error(secret);
      }),
    })),
  };
  const h = setup(false, undefined, { playback });
  const receipt = await h.ask();
  h.text(); h.audio(); await settle();
  const summary = h.failed('PLAYBACK_FAILED');
  expect(summary).toMatchObject({ incident: receipt.turnId, cause_code: 'PLAYBACK_ENCODER_FAILED', playback_stage: 'opus_encode',
    opus_error_code: -2, player_status: 'buffering', voice_status: 'ready', dave_ready: true });
  expect(h.logs.filter(line => line.event === 'jarvis_playback_failed')).toEqual([
    expect.objectContaining({ incident: receipt.turnId, code: 'PLAYBACK_ENCODER_FAILED', playback_stage: 'opus_encode', opus_error_code: -2 }),
  ]);
  expect(h.logs).toContainEqual(expect.objectContaining({ event: 'jarvis_playback_state', incident: receipt.turnId,
    player_status: 'buffering', previous_player_status: 'idle' }));
});
