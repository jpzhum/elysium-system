import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentConnector, type AgentDependencies } from '../src/agents/elevenlabs-client.js';
import { SessionManager, type Playback } from '../src/agents/session-manager.js';
import { Logger, Metrics } from '../src/observability/metrics.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

const secret = 'PRIVATE-text-and-credentials-that-must-not-appear';
class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  send(_data: string, callback?: (error?: Error) => void): void { callback?.(); }
  open(): void { this.readyState = 1; this.emit('open'); }
  event(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close(): void { this.readyState = 3; this.emit('close', 1000, Buffer.from(secret)); }
  terminate(): void { this.close(); }
}
const active: SessionManager[] = [];
function setup(pendingPlayback = false) {
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
  const grant = consent.grant('guest', false);
  const speaker = speakerContext({ discordUserId: 'guest', displayName: secret, guildId: 'guild', channelId: 'room',
    consented: true, consentVersion: grant.version }, 'owner');
  let finishPlayback = () => {};
  const playbackGate = new Promise<void>((resolve) => { finishPlayback = resolve; });
  const copies: Buffer[] = [];
  const playback: Playback = { isPlaying: false, stopUser: vi.fn(), stop: vi.fn(),
    play: vi.fn(async (_id, pcm) => { copies.push(Buffer.from(pcm)); if (pendingPlayback) await playbackGate; }),
  };
  const manager = new SessionManager({
    connect: (_speaker, callbacks, signal) => connector({ apiKey: secret, agentId: 'agent_test',
      dynamicVariables: {}, callbacks, signal }),
    allowed: (context, audio) => consent.isCurrent(context.discordUserId, context.consentVersion, audio),
    detectWake: async () => false, playback, maxSessions: 2, maxTurnSeconds: 12,
    maxSessionSeconds: 300, idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 100,
    metric: metrics.add, logger: new Logger('info', (line) => logs.push(JSON.parse(line))),
  });
  active.push(manager);
  const audio = () => socket.event({ type: 'audio', audio_event: { audio_base_64: 'AQACAA==', event_id: 1 } });
  const text = () => socket.event({ type: 'agent_response', agent_response_event: { agent_response: secret, event_id: 2 } });
  const complete = (id = 3) => socket.event({ type: 'agent_response_complete', agent_response_complete_event: { event_id: id } });
  const failed = (code: string) => {
    const failures = logs.filter((line) => line.event === 'jarvis_agent_turn_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code, operation: 'agent_turn', incident: expect.stringMatching(/^[0-9A-F]{8}$/),
      duration_ms: expect.any(Number) });
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain('fixture-private-id');
    return failures[0]!;
  };
  return { manager, speaker, socket, metrics, logs, audio, text, complete, playback, copies, consent, finishPlayback, failed };
}

afterEach(() => {
  for (const manager of active.splice(0)) manager.close();
  vi.useRealTimers();
});

test('full documented audio + completion traverses the real adapter and finishes local playback', async () => {
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.text(); h.audio(); h.complete();
  await Promise.resolve();
  expect(h.copies).toEqual([Buffer.from([1, 0, 2, 0])]);
  expect(h.metrics.snapshot()).toMatchObject({ agent_sessions_started: 1, agent_turns: 1,
    audio_chunks_received: 1, audio_bytes_received: 4, agent_responses_completed: 1, playback_completed: 1,
    agent_response_complete_events_received: 1, agent_text_events_received: 1 });
  expect(h.logs.filter((line) => line.event === 'jarvis_agent_turn_failed')).toHaveLength(0);
  expect(JSON.stringify(h.logs)).not.toContain(secret);
});
test('buffered audio without completion is discarded at deadline; cleanup is not a provider error', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.audio();
  await vi.advanceTimersByTimeAsync(44_000);
  expect(h.playback.play).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(h.playback.play).not.toHaveBeenCalled();
  expect(h.metrics.snapshot()).toMatchObject({ audio_chunks_received: 1, audio_bytes_received: 4,
    agent_response_timeouts: 1, agent_completion_missing: 1 });
  expect(h.metrics.snapshot().agent_errors ?? 0).toBe(0);
  expect(h.failed('AGENT_COMPLETION_MISSING')).toMatchObject({ audio_bytes: 4, completion_received: false });
  expect(h.manager.activeCount).toBe(0);
});
test('silence without any provider output identifies a response timeout without a fabricated second error', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  await vi.advanceTimersByTimeAsync(45_001);
  expect(h.failed('AGENT_RESPONSE_TIMEOUT')).toMatchObject({ text_received: false, audio_chunks: 0 });
  expect(h.metrics.snapshot().agent_errors ?? 0).toBe(0);
  expect(h.playback.play).not.toHaveBeenCalled();
});
test.each([true, false])('detects text without audio, with completion=%s', async (completed) => {
  vi.useFakeTimers();
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.text();
  if (completed) h.complete();
  else await vi.advanceTimersByTimeAsync(45_001);
  expect(h.failed('AGENT_TEXT_WITHOUT_AUDIO')).toMatchObject({ text_received: true, audio_bytes: 0, completion_received: completed });
  expect(h.metrics.snapshot().agent_text_without_audio).toBe(1);
  expect(h.playback.play).not.toHaveBeenCalled();
});
test('explicit completion with no text and no audio is an empty response', async () => {
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.complete();
  expect(h.failed('AGENT_EMPTY_RESPONSE')).toMatchObject({ completion_received: true });
  expect(h.metrics.snapshot().agent_responses_completed).toBe(1);
  expect(h.playback.play).not.toHaveBeenCalled();
});
test('malformed completion is counted as received but never accepted as safe for playback', async () => {
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.audio();
  h.socket.event({ type: 'agent_response_complete', agent_response_complete_event: { event_id: secret } });
  expect(h.metrics.snapshot()).toMatchObject({ agent_response_complete_events_received: 1, agent_errors: 1 });
  expect(h.metrics.snapshot().agent_responses_completed ?? 0).toBe(0);
  h.failed('AGENT_INVALID_EVENT');
  expect(h.playback.play).not.toHaveBeenCalled();
});
test('premature socket close never flushes partial audio and cancels the pending timeout', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.audio(); h.socket.close();
  await vi.advanceTimersByTimeAsync(46_000);
  h.failed('AGENT_PREMATURE_CLOSE');
  expect(h.metrics.snapshot()).toMatchObject({ agent_premature_closes: 1, agent_errors: 1 });
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
  expect(h.playback.play).not.toHaveBeenCalled();
});
test('a primary provider error stays singular even when teardown emits close', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.socket.event({ type: 'client_error', error_event: { code: 401, message: secret } });
  await vi.advanceTimersByTimeAsync(46_000);
  h.failed('AGENT_AUTHENTICATION_FAILED');
  expect(h.metrics.snapshot().agent_errors).toBe(1);
  expect(h.metrics.snapshot().agent_response_timeouts ?? 0).toBe(0);
});
test('socket closure after explicit completion preserves an already validated full response', async () => {
  const h = setup(true);
  await h.manager.ask(h.speaker, secret);
  h.audio(); h.complete(); h.socket.close();
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
  h.finishPlayback();
  await Promise.resolve(); await Promise.resolve();
  expect(h.metrics.snapshot().playback_completed).toBe(1);
  expect(h.metrics.snapshot().agent_errors ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});
test('revocation still cancels completed, queued playback and suppresses late events', async () => {
  const h = setup(true);
  await h.manager.ask(h.speaker, secret);
  h.audio(); h.complete();
  h.consent.revoke(h.speaker.discordUserId);
  h.manager.revoke(h.speaker.discordUserId);
  h.finishPlayback();
  h.audio(); h.complete();
  await Promise.resolve(); await Promise.resolve();
  expect(h.playback.stopUser).toHaveBeenCalledWith(h.speaker.discordUserId);
  expect(h.metrics.snapshot().playback_completed ?? 0).toBe(0);
  expect(h.manager.activeCount).toBe(0);
});
test('an old duplicate completion cannot prematurely flush the next question', async () => {
  const h = setup();
  await h.manager.ask(h.speaker, secret);
  h.audio(); h.complete(3);
  await Promise.resolve();
  await h.manager.ask(h.speaker, secret);
  h.audio(); h.complete(3);
  expect(h.playback.play).toHaveBeenCalledTimes(1);
  h.complete(4);
  await Promise.resolve();
  expect(h.playback.play).toHaveBeenCalledTimes(2);
  expect(h.metrics.snapshot().agent_duplicate_completions).toBe(1);
});
