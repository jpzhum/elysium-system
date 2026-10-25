import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AudioPlayerError, AudioPlayerStatus, VoiceConnectionStatus,
  type AudioPlayer, type AudioResource, type PlayerSubscription, type VoiceConnection,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAgentConnector, type AgentDependencies } from '../src/agents/elevenlabs-client.js';
import { RecentConversation } from '../src/agents/recent-conversation.js';
import { SessionManager, type DeliveredTurn, type TurnNotification, type TurnReceipt } from '../src/agents/session-manager.js';
import { ElevenWakeDetector } from '../src/agents/wake-detector.js';
import { PlaybackQueue } from '../src/audio/playback.js';
import { VoiceReceiver, type VoiceTurnTiming } from '../src/discord/voice-receiver.js';
import { Logger } from '../src/observability/metrics.js';
import { VoiceAdmissionEvidence } from '../src/observability/voice-admission-evidence.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext, type SpeakerContext } from '../src/policy/identity.js';
import { createGameSearch } from '../src/tools/game-search.js';

// Only the network, Discord transport and its packet consumer are controlled.
// Adapter, scheduler, receiver, wake adapter, PCM/Opus, playback and RAM are real.
class ControlledSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  paused = false;
  pauses = 0;
  resumes = 0;
  readonly sent: Record<string, unknown>[] = [];
  send(value: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
    callback?.();
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
    this.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
      conversation_id: 'conv_endurance_fixture', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000',
    } });
  }
  message(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  pause(): this { this.paused = true; this.pauses++; return this; }
  resume(): this { this.paused = false; this.resumes++; return this; }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000); }
  terminate(): void { this.close(); }
}

/** Consume the real AudioResource/Opus stream without pretending packets were heard remotely. */
class PacketConsumer extends EventEmitter {
  state: { status: AudioPlayerStatus; resource?: AudioResource } = { status: AudioPlayerStatus.Idle };
  readonly resources: AudioResource[] = [];
  readonly jobs = new Set<Promise<void>>();
  packets = 0;
  failNextStart = false;
  paused = false;
  private release?: () => void;
  private waiting?: Promise<void>;
  play(resource: AudioResource): void {
    if (this.failNextStart) { this.failNextStart = false; throw new Error('fixture_player_start_failure'); }
    const before = this.state;
    this.state = { status: AudioPlayerStatus.Playing, resource };
    this.resources.push(resource);
    this.emit('stateChange', before, this.state);
    const job = this.consume(resource);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }
  stop(): boolean {
    this.resume();
    const before = this.state;
    this.state = { status: AudioPlayerStatus.Idle };
    this.emit('stateChange', before, this.state);
    this.emit(AudioPlayerStatus.Idle, before);
    return true;
  }
  hold(): void {
    this.paused = true;
    this.waiting ??= new Promise<void>(resolve => { this.release = resolve; });
  }
  resume(): void { this.paused = false; this.release?.(); this.release = undefined; this.waiting = undefined; }
  fail(): void {
    const resource = this.state.resource;
    if (!resource) throw new Error('fixture_expected_active_resource');
    this.emit('error', new AudioPlayerError(new Error('fixture_player_failure'), resource));
  }
  private async consume(resource: AudioResource): Promise<void> {
    try {
      for await (const packet of resource.playStream) {
        if (this.paused) await this.waiting;
        if (this.state.resource !== resource) break;
        expect(Buffer.isBuffer(packet)).toBe(true);
        this.packets++;
      }
      if (this.state.resource === resource) this.stop();
    } catch (error) {
      if (this.state.resource === resource) this.emit('error', new AudioPlayerError(
        error instanceof Error ? error : new Error('fixture_stream_failure'), resource));
    }
  }
}

class ControlledVoice extends EventEmitter {
  readonly speaking = new EventEmitter();
  readonly streams: PassThrough[] = [];
  readonly subscriptions: string[] = [];
  readonly state: { status: VoiceConnectionStatus; subscription?: PlayerSubscription } = { status: VoiceConnectionStatus.Ready };
  readonly receiver = { speaking: this.speaking, subscribe: (id: string): PassThrough => {
    this.subscriptions.push(id);
    const stream = new PassThrough({ objectMode: true });
    this.streams.push(stream);
    return stream;
  } };
  subscribe(_player: AudioPlayer): PlayerSubscription {
    const subscription = { unsubscribe: () => { this.state.subscription = undefined; } } as PlayerSubscription;
    this.state.subscription = subscription;
    return subscription;
  }
  transition(status: VoiceConnectionStatus): void {
    const before = { ...this.state };
    this.state.status = status;
    this.emit('stateChange', before, this.state);
  }
}

interface Captured { userId: string; pcm: Buffer; timing: VoiceTurnTiming; zeroCrossings: number; settled?: boolean; receipt?: TurnReceipt; error?: unknown }
interface Request { speaker: SpeakerContext; kind: 'text' | 'voice' }
const cleanups: (() => Promise<void>)[] = [];
async function microtasks(): Promise<void> { for (let index = 0; index < 80; index++) await Promise.resolve(); }
function pcm(seconds: number, rate = 16_000, channels = 1, frequency = 220): Buffer {
  const result = Buffer.alloc(Math.round(seconds * rate) * channels * 2);
  for (let sample = 0; sample < result.length / (channels * 2); sample++) {
    const value = Math.round(9000 * Math.sin(2 * Math.PI * frequency * sample / rate));
    for (let channel = 0; channel < channels; channel++) result.writeInt16LE(value, (sample * channels + channel) * 2);
  }
  return result;
}

function endurance(maxTurnSeconds = 12) {
  vi.useFakeTimers();
  const unexpectedRequest = vi.fn<typeof fetch>(async () => { throw new Error('fixture_unexpected_network_request'); });
  vi.stubGlobal('fetch', unexpectedRequest);
  const connection = new ControlledVoice();
  const player = new PacketConsumer();
  const consent = new ConsentStore();
  const memory = new RecentConversation('guild', 'voice', 600);
  const sockets: { speaker: SpeakerContext; socket: ControlledSocket }[] = [];
  const logs: Record<string, unknown>[] = [];
  const metrics: Record<string, number> = {};
  const deliveries: { speaker: SpeakerContext; turn: DeliveredTurn }[] = [];
  const captures: Captured[] = [];
  const requests = new Map<string, Request>();
  const checkpoints: string[] = [];
  const notifications: TurnNotification[] = [];
  const rejectedCaptures: { userId: string; reason: string }[] = [];
  let eventId = 100;
  let wakeText = 'Jarvis, pergunta sintética.';
  const metric = (name: string, value = 1): void => { metrics[name] = (metrics[name] ?? 0) + value; };
  const logger = new Logger('info', line => { logs.push(JSON.parse(line) as Record<string, unknown>); });
  const playback = new PlaybackQueue(connection as unknown as VoiceConnection, {
    player: player as unknown as AudioPlayer, maxBufferBytes: 4096, onMetric: metric,
  });
  const wakeRequests = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: wakeText })));
  const wake = new ElevenWakeDetector('fixture_key', 'Jarvis', 6, metric, wakeRequests);
  const evidence = new VoiceAdmissionEvidence('daa1bbd');
  wake.setObserver((speaker, event) => evidence.record(speaker.discordUserId, event));
  const search = createGameSearch({ apiKey: 'fixture_search_key' });
  const manager = new SessionManager({
    connect: (speaker, callbacks, signal) => {
      const socket = new ControlledSocket();
      sockets.push({ speaker, socket });
      return createAgentConnector({
        fetch: async () => new Response(JSON.stringify({ signed_url:
          'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture&token=fixture' })),
        createSocket: () => { queueMicrotask(() => socket.open());
          return socket as unknown as ReturnType<AgentDependencies['createSocket']>; },
        random: () => 0.5, sleep: async () => undefined,
      })({ apiKey: 'fixture_key', agentId: 'fixture', callbacks, signal, suppressFirstMessage: true,
        dynamicVariables: { speaker_name: speaker.displayName, speaker_is_creator: speaker.isOwner },
        tools: async (name, parameters, toolSignal) => {
          if (name !== 'search_game_info' || signal.aborted || toolSignal.aborted
            || !consent.isCurrent(speaker.discordUserId, speaker.consentVersion)
            || !manager.isTurnActive(speaker)) throw new Error('fixture_tool_not_authorized');
          const values = parameters as { game: string; query: string };
          return search(values.game, values.query, AbortSignal.any([signal, toolSignal]));
        },
      });
    },
    playback, allowed: (speaker, audio) => connection.state.status === VoiceConnectionStatus.Ready
      && consent.isCurrent(speaker.discordUserId, speaker.consentVersion, audio),
    detectWake: (input, signal, speaker) => wake.detect(input, signal, speaker),
    observe: (speaker, event, details) => evidence.record(speaker.discordUserId, event, details),
    maxSessions: 2, maxTurnSeconds, maxSessionSeconds: 300, idleSeconds: 45,
    followupSeconds: 18, maxTurnsPerHour: 120, metric, logger,
    notify: (_speaker, event) => { notifications.push(event); },
    // Keep the production 20 ms upload pacing; fake time advances it explicitly.
    pace: signal => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 20);
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('fixture_upload_aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }),
    sessionContextExpiresAt: speaker => memory.deadline(speaker),
    prepareSession: (speaker, session, reused) => {
      const context = memory.context(speaker);
      if (!reused && context.text) session.sendContext(context.text);
    },
    onTurnDelivered: (speaker, turn) => { deliveries.push({ speaker, turn }); memory.add(speaker, turn); },
  });
  const receiver = new VoiceReceiver(connection as unknown as VoiceConnection, {
    ownUserId: 'bot', canReceive: id => consent.get(id)?.audio === true,
    isPlaying: () => playback.isAudible, maxTurnSeconds, onMetric: metric,
    onCaptureRejected: (userId, reason) => { rejectedCaptures.push({ userId, reason }); },
    onTurn: async (userId, input, timing) => {
      // Synthetic signal provenance is checked before the borrowed PCM is erased.
      let zeroCrossings = 0;
      for (let offset = 4; offset < input.length; offset += 4) {
        if ((input.readInt16LE(offset - 4) >= 0) !== (input.readInt16LE(offset) >= 0)) zeroCrossings++;
      }
      const capture: Captured = { userId, pcm: input, timing, zeroCrossings };
      captures.push(capture);
      try {
        capture.receipt = await manager.voiceTurn(speaker(userId), input, timing);
        if (capture.receipt) requests.set(capture.receipt.turnId, { speaker: speaker(userId), kind: 'voice' });
      } catch (error) { capture.error = error; }
      finally { capture.settled = true; }
    },
  });
  receiver.start();
  const speaker = (id = 'owner', name = id): SpeakerContext => {
    const grant = consent.get(id);
    return speakerContext({ discordUserId: id, displayName: name, guildId: 'guild', channelId: 'voice',
      consented: Boolean(grant), consentVersion: grant?.version ?? -1 }, 'owner');
  };
  const syncWake = (): void => wake.setParticipants(['owner', 'kel', 'visitor'].filter(id => consent.get(id)?.audio).map(id => speaker(id)));
  const grant = (id = 'owner'): SpeakerContext => { consent.grant(id, true); syncWake(); return speaker(id); };
  const advance = async (milliseconds = 20): Promise<void> => { await microtasks(); await vi.advanceTimersByTimeAsync(milliseconds); await microtasks(); };
  const until = async (condition: () => boolean, maximumMs = 40_000): Promise<void> => {
    for (let elapsed = 0; !condition() && elapsed <= maximumMs; elapsed += 20) await advance();
    expect(condition(), `controlled pipeline did not reach its expected state after ${checkpoints.length} turns: ${JSON.stringify(logs.slice(-5))}`).toBe(true);
  };
  const started = async (receipt: TurnReceipt): Promise<void> => until(() => logs.some(log => log.incident === receipt.turnId
    && log.event === 'jarvis_agent_turn_started'));
  const upload = async (receipt: TurnReceipt): Promise<void> => {
    await started(receipt);
    if (requests.get(receipt.turnId)?.kind === 'voice') await until(() => logs.some(log => log.incident === receipt.turnId
      && log.event === 'jarvis_agent_input_sent' && log.input_audio_finished === true));
  };
  const socketFor = (receipt: TurnReceipt): ControlledSocket => {
    const id = requests.get(receipt.turnId)!.speaker.discordUserId;
    const item = sockets.findLast(value => value.speaker.discordUserId === id && value.socket.readyState === 1);
    if (!item) throw new Error('fixture_expected_open_socket');
    return item.socket;
  };
  const ask = async (id = 'owner', text = 'Pergunta sintética.'): Promise<TurnReceipt> => {
    const receipt = await manager.ask(speaker(id), text);
    requests.set(receipt.turnId, { speaker: speaker(id), kind: 'text' });
    await microtasks();
    return receipt;
  };
  const capture = async (id = 'owner', seconds = 0.2, allowRejection = false): Promise<TurnReceipt | undefined> => {
    const before = captures.length;
    const streamCount = connection.streams.length;
    connection.speaking.emit('start', id);
    if (connection.streams.length === streamCount) return undefined;
    const stream = connection.streams.at(-1)!;
    const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    try {
      const frames = Math.round(seconds * 50);
      let sentFrames = 0;
      for (; sentFrames < frames && !stream.destroyed; sentFrames++) {
        stream.write(encoder.encode(pcm(0.02, 48_000, 2), 960));
        await advance();
      }
      // A destroyed subscription receives no further packets. Let the rest of
      // the same utterance elapse to detect a late request or automatic re-entry.
      if (stream.destroyed && sentFrames < frames) await advance((frames - sentFrames) * 20);
      for (let frame = 0; frame < 40 && !stream.destroyed; frame++) {
        stream.write(encoder.encode(Buffer.alloc(3840), 960));
        await advance();
      }
    } finally { encoder.delete(); }
    await advance();
    const result = captures.slice(before).find(value => value.userId === id);
    if (result) { await until(() => result.settled === true); if (!allowRejection) expect(result.error).toBeUndefined(); }
    return result?.receipt;
  };
  const answer = async (receipt: TurnReceipt, options: { complete?: boolean; seconds?: number; recognize?: boolean } = {}): Promise<void> => {
    await upload(receipt);
    const socket = socketFor(receipt);
    const id = ++eventId;
    if (requests.get(receipt.turnId)?.kind === 'voice' && options.recognize !== false) {
      socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'Jarvis, pergunta sintética.', event_id: id } });
    }
    socket.message({ type: 'agent_response', agent_response_event: {
      agent_response: 'Resposta sintética útil.', event_id: id, response_id: `reply_${id}`,
    } });
    const output = pcm(options.seconds ?? 0.1);
    for (let offset = 0; offset < output.length && socket.readyState === 1; offset += 3200) {
      await until(() => !socket.paused || socket.readyState !== 1);
      if (socket.readyState !== 1) break;
      socket.message({ type: 'audio', audio_event: { audio_base_64: output.subarray(offset, offset + 3200).toString('base64'),
        event_id: id, response_id: `reply_${id}` } });
      await microtasks();
    }
    output.fill(0);
    if (options.complete !== false) socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: id } });
    await advance();
  };
  const terminalEvents = (receipt: TurnReceipt) => logs.filter(log => log.incident === receipt.turnId
    && ['jarvis_agent_turn_finished', 'jarvis_agent_turn_failed', 'jarvis_agent_turn_cancelled'].includes(String(log.event)));
  const resources = async (active = false): Promise<void> => {
    await microtasks();
    expect(manager.queueStatus).toEqual({ waiting: 0, active });
    expect(metrics.audio_stream_buffer_bytes ?? 0).toBe(0);
    expect(metrics.turn_queue_depth ?? 0).toBe(0);
    expect(playback.isPlaying).toBe(false);
    expect(player.jobs.size).toBe(0);
    expect(player.resources.every(resource => resource.playStream.destroyed)).toBe(true);
    expect(connection.streams.every(stream => stream.destroyed)).toBe(true);
    expect(captures.every(value => value.pcm.every(byte => byte === 0))).toBe(true);
    const open = sockets.filter(value => value.socket.readyState === 1);
    expect(open.length).toBeLessThanOrEqual(2);
    expect(manager.activeCount).toBe(open.length);
    const memoryTimer = ['owner', 'kel', 'visitor'].some(id => memory.count(speaker(id)) > 0) ? 1 : 0;
    if (active) expect(vi.getTimerCount()).toBeLessThanOrEqual(memoryTimer + 4 * open.length);
    else expect(vi.getTimerCount()).toBe(memoryTimer + 3 * open.length);
    expect(connection.listenerCount('stateChange')).toBe(2);
    expect(connection.speaking.listenerCount('start')).toBe(1);
    for (const { socket } of sockets) for (const event of socket.eventNames()) expect(socket.listenerCount(event)).toBeLessThanOrEqual(1);
    for (const id of ['owner', 'kel', 'visitor']) {
      expect(memory.count(speaker(id))).toBeLessThanOrEqual(10);
      const ownQuestions = deliveries.filter(value => value.speaker.discordUserId === id).map(value => value.turn.question);
      const context = memory.context(speaker(id)).text;
      for (const other of deliveries.filter(value => value.speaker.discordUserId !== id)) {
        if (!ownQuestions.includes(other.turn.question)) expect(context).not.toContain(other.turn.question);
      }
    }
    expect(JSON.stringify(logs)).not.toMatch(/Pergunta sintética|Resposta sintética|fixture_key|Late synthetic response/);
  };
  const checkpoint = async (receipt: TurnReceipt, outcome = 'completed', active = false): Promise<void> => {
    await until(() => terminalEvents(receipt).length > 0 && manager.queueStatus.active === active
      && logs.some(log => log.incident === receipt.turnId && log.event === 'jarvis_agent_turn_released'));
    const terminals = terminalEvents(receipt);
    expect(terminals, `terminal count for ${receipt.turnId}`).toHaveLength(1);
    expect(terminals[0]!.turn_outcome ?? (terminals[0]!.event === 'jarvis_agent_turn_failed' ? 'failed' : undefined)).toBe(outcome);
    expect(logs.filter(log => log.incident === receipt.turnId && log.event === 'jarvis_agent_turn_released')).toHaveLength(1);
    await resources(active);
    expect(deliveries.filter(value => value.turn.turnId === receipt.turnId).length).toBe(outcome === 'completed' || outcome === 'unconfirmed' ? 1 : 0);
    const delivered = deliveries.find(value => value.turn.turnId === receipt.turnId);
    if (delivered) {
      expect(delivered.turn.generation).toBe(outcome === 'completed' ? 'confirmed' : 'unconfirmed');
      expect(memory.context(delivered.speaker).text).toContain(delivered.turn.question);
      expect(memory.context(delivered.speaker).text).toContain(`"generation":"${delivered.turn.generation}"`);
    }
    const notices = notifications.filter(event => event.turnId === receipt.turnId && (event.type === 'failed' || event.type === 'cancelled'));
    expect(notices).toHaveLength(outcome === 'completed' || outcome === 'unconfirmed' ? 0 : 1);
    if (outcome === 'partial') expect(notices[0]!.delivery).toBe('partial');
    checkpoints.push(receipt.turnId);
  };
  const recover = async (): Promise<void> => {
    const receipt = await ask(); await answer(receipt); await checkpoint(receipt);
  };
  const revoke = (id: string): void => { consent.revoke(id); receiver.stopUser(id); manager.revoke(id); memory.forget(id); wake.forget(id); syncWake(); evidence.forget(id); };
  const transition = (status: VoiceConnectionStatus): void => {
    connection.transition(status);
    manager.setAvailable(status === VoiceConnectionStatus.Ready);
  };
  cleanups.push(async () => {
    receiver.stop(); manager.close(); memory.close(); consent.clear(); player.resume();
    for (const { socket } of sockets) socket.close();
    await advance();
    expect(manager.queueStatus).toEqual({ waiting: 0, active: false });
    expect(manager.activeCount).toBe(0);
    expect(playback.isPlaying).toBe(false);
    expect(metrics.audio_stream_buffer_bytes ?? 0).toBe(0);
    expect(player.jobs.size).toBe(0);
    expect(connection.streams.every(stream => stream.destroyed)).toBe(true);
    expect(connection.listenerCount('stateChange')).toBe(0);
    expect(connection.speaking.listenerCount('start')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  });
  return { connection, player, consent, memory, manager, receiver, playback, sockets, logs, metrics, wake, evidence,
    deliveries, captures, requests, checkpoints, notifications, rejectedCaptures, wakeRequests, grant, speaker, ask, capture, answer,
    upload, socketFor, advance, until, checkpoint, resources, recover, revoke, transition,
    setWakeText: (text: string) => { wakeText = text; } };
}

afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});

describe('conversation endurance with real local components and controlled protocol boundaries', () => {
  test.each([['owner', 'kel'], ['kel', 'owner']])('V58 C/D/I/L/T: ten background captures from %s leave wake capacity for %s', async (background, directed) => {
    const h = endurance(); h.grant(); h.grant('kel');
    h.setWakeText('Conversa ambiente sem ativação.');
    for (let utterance = 0; utterance < 10; utterance++) {
      expect(await h.capture(background, 0.2, true)).toBeUndefined();
      expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
      await h.resources();
    }
    expect(h.wakeRequests).toHaveBeenCalledTimes(2);
    h.setWakeText('Jarvis, pergunta dirigida.');
    const receipt = (await h.capture(directed))!;
    await h.answer(receipt); await h.checkpoint(receipt);
    expect(h.wakeRequests).toHaveBeenCalledTimes(3);
    expect(h.evidence.snapshot()).toMatchObject({
      paid_starts_in_window: 3, recent: { capture: 11, question_accepted: 1, wake_cooldown_rejected: 8, turn_responded: 1 },
    });
    expect(JSON.stringify(h.evidence.snapshot())).not.toMatch(/owner|kel|fixture_key|Conversa ambiente/);
  });

  test.each([['owner', 'kel'], ['kel', 'owner']])('V58 E/G/H: long response for %s drains before the queued question from %s', async (firstId, secondId) => {
    const h = endurance(); h.grant(); h.grant('kel');
    const first = (await h.capture(firstId))!;
    const second = (await h.capture(secondId))!;
    expect(second.queued).toBe(true);
    expect(h.notifications.filter(event => event.type === 'queued' && event.turnId === second.turnId)).toHaveLength(1);
    await h.answer(first, { seconds: 20 });
    await h.checkpoint(first, 'completed', true);
    expect(h.deliveries.map(value => value.speaker.discordUserId)).toEqual([firstId]);
    await h.answer(second); await h.checkpoint(second);
    expect(h.deliveries.map(value => value.speaker.discordUserId)).toEqual([firstId, secondId]);
    expect(h.metrics.playback_completed).toBe(2);
  });

  test('V58 A/J/N/P/Q: two speakers alternate twenty voice turns after a fourth-turn playback failure', async () => {
    const h = endurance(); h.grant(); h.grant('kel');
    for (let turn = 1; turn <= 20; turn++) {
      const id = turn % 2 ? 'owner' : 'kel';
      const receipt = (await h.capture(id))!;
      expect(receipt).toBeDefined();
      if (turn === 11) { h.revoke('kel'); expect(h.manager.queueStatus.active).toBe(true); }
      if (turn === 4) h.player.hold();
      await h.answer(receipt, { complete: turn !== 4 });
      if (turn === 4) h.player.fail();
      await h.checkpoint(receipt, turn === 4 ? 'partial' : 'completed');
      if (turn === 11) h.grant('kel');
    }
    expect(h.checkpoints).toHaveLength(20);
    expect(h.metrics.playback_failed).toBe(1);
    expect(h.metrics.playback_completed).toBe(19);
    expect(h.wakeRequests).toHaveBeenCalledTimes(4);
    expect(h.evidence.snapshot().process).toMatchObject({
      question_accepted: 20, turn_responded: 19, turn_partial: 1, playback_failed: 1, wake_accepted: 4,
    });
    expect(h.evidence.snapshot().recent.turn_partial).toBe(1);
    expect(h.notifications.filter(event => event.type === 'failed')).toHaveLength(1);
  });

  test('V58 M: a consumed creator follow-up does not admit more fragments or transfer to Kel', async () => {
    const h = endurance(); h.grant(); h.grant('kel');
    const first = (await h.capture())!; await h.answer(first); await h.checkpoint(first);
    h.setWakeText('Fala paralela sem ativação.');
    expect(await h.capture('kel')).toBeUndefined();
    const calls = h.wakeRequests.mock.calls.length;
    const followup = (await h.capture())!;
    expect(followup).toBeDefined();
    expect(h.wakeRequests).toHaveBeenCalledTimes(calls);
    expect(await h.capture()).toBeUndefined();
    expect(h.manager.queuedCount).toBe(0);
    expect(h.wakeRequests).toHaveBeenCalledTimes(calls + 1);
    await h.answer(followup); await h.checkpoint(followup);
    expect(h.evidence.snapshot().recent.followup).toBe(1);
    expect(h.deliveries.map(value => value.speaker.discordUserId)).toEqual(['owner', 'owner']);
  });

  test('V58 O: STT failure frees the same runtime for another participant and a later retry', async () => {
    const h = endurance(); h.grant(); h.grant('kel');
    h.wakeRequests.mockRejectedValueOnce(new Error('Controlled private STT failure.'));
    expect(await h.capture('owner', 0.2, true)).toBeUndefined();
    expect(h.captures.at(-1)!.error).toMatchObject({ code: 'wake_provider_failed' });
    await h.resources();
    const kel = (await h.capture('kel'))!; await h.answer(kel); await h.checkpoint(kel);
    const owner = (await h.capture('owner'))!; await h.answer(owner); await h.checkpoint(owner);
    expect(h.wakeRequests).toHaveBeenCalledTimes(3);
    expect(h.metrics.wake_provider_errors).toBe(1);
  });

  test('01: twenty text turns share one runtime and release every response exactly once', async () => {
    const h = endurance(); h.grant();
    for (let turn = 0; turn < 20; turn++) {
      const receipt = await h.ask('owner', `Pergunta escrita ${turn}.`);
      await h.answer(receipt); await h.checkpoint(receipt);
    }
    expect(h.checkpoints).toHaveLength(20);
    expect(h.sockets).toHaveLength(1);
    expect(h.metrics.playback_completed).toBe(20);
    expect(h.memory.count(h.speaker())).toBe(10);
  });

  test('02: twenty real Opus captures traverse receiver, wake, paced upload and playback', async () => {
    const h = endurance(); h.grant();
    for (let turn = 0; turn < 20; turn++) {
      const receipt = (await h.capture())!;
      expect(receipt).toBeDefined();
      await h.answer(receipt); await h.checkpoint(receipt);
    }
    expect(h.checkpoints).toHaveLength(20);
    expect(h.captures).toHaveLength(20);
    expect(h.metrics.agent_user_turns_recognized).toBe(20);
    expect(h.wakeRequests).toHaveBeenCalledOnce();
    expect(h.metrics.wake_rate_limited ?? 0).toBe(0);
    expect(h.connection.subscriptions.every(id => id === 'owner')).toBe(true);
    expect(h.memory.count(h.speaker())).toBe(10);
  });

  test('03: short and long questions alternate without losing 15/20 second configured captures', async () => {
    const h = endurance(30); h.grant();
    for (let turn = 0; turn < 20; turn++) {
      const seconds = turn % 2 === 0 ? 0.2 : turn % 4 === 1 ? 15 : 20;
      const receipt = (await h.capture('owner', seconds))!;
      await h.upload(receipt);
      const sent = h.logs.findLast(log => log.incident === receipt.turnId && log.event === 'jarvis_agent_input_sent');
      expect(Number(sent!.input_source_chunks) * 20).toBeGreaterThanOrEqual(seconds * 1000);
      await h.answer(receipt, { seconds: seconds > 1 ? 0.8 : 0.04 }); await h.checkpoint(receipt);
    }
    expect(h.checkpoints).toHaveLength(20);
  }, 30_000);

  test('04: ten missing completion events retire transports without inventing completed replies', async () => {
    const h = endurance(); h.grant();
    let current = await h.ask('owner', 'Pergunta sem complete 0.');
    for (let turn = 0; turn < 10; turn++) {
      await h.answer(current, { complete: false });
      await h.until(() => h.logs.some(log => log.incident === current.turnId && log.local_playback_drained === true));
      const next = await h.ask('owner', `Pergunta sem complete ${turn + 1}.`);
      await h.checkpoint(current, 'unconfirmed', true);
      current = next;
    }
    await h.answer(current); await h.checkpoint(current);
    expect(h.deliveries.filter(value => value.turn.generation === 'unconfirmed')).toHaveLength(10);
    expect(h.metrics.agent_turns_recovered).toBe(10);
  });

  test('05: a fourth-turn playback failure does not prevent sixteen later responses in the same runtime', async () => {
    const h = endurance(); h.grant();
    for (let turn = 1; turn <= 20; turn++) {
      const receipt = await h.ask();
      if (turn === 4) h.player.hold();
      await h.answer(receipt, { complete: turn !== 4 });
      if (turn === 4) h.player.fail();
      await h.checkpoint(receipt, turn === 4 ? 'partial' : 'completed');
    }
    expect(h.checkpoints).toHaveLength(20);
    expect(h.metrics.playback_completed).toBe(19);
    expect(h.metrics.playback_failed).toBe(1);
  });

  test('05b: four distinct playback failures each release the same runtime for a successful next turn', async () => {
    const h = endurance(); h.grant();
    for (const failure of ['start', 'player', 'encoder', 'premature_idle']) {
      const receipt = await h.ask();
      if (failure === 'start') h.player.failNextStart = true;
      else if (failure === 'encoder') vi.spyOn(OpusScript.prototype, 'encode').mockImplementationOnce(() => { throw new Error('Encode error: Internal error'); });
      else h.player.hold();
      await h.answer(receipt, { complete: false });
      if (failure === 'player') h.player.fail();
      if (failure === 'premature_idle') h.player.stop();
      await h.checkpoint(receipt, failure === 'player' || failure === 'premature_idle' ? 'partial' : 'failed');
      vi.restoreAllMocks();
      await h.recover();
    }
    expect(h.checkpoints).toHaveLength(8);
    expect(h.metrics.playback_failed).toBe(4);
  });

  test('06: missing final ASR on the third voice turn fails once and later turns recover', async () => {
    const h = endurance(); h.grant();
    for (let turn = 1; turn <= 8; turn++) {
      const receipt = (await h.capture())!;
      await h.answer(receipt, { complete: turn !== 3, recognize: turn !== 3 });
      if (turn === 3) await h.advance(10_000);
      await h.checkpoint(receipt, turn === 3 ? 'failed' : 'completed');
    }
    expect(h.metrics.agent_user_turn_missing).toBe(1);
    expect(h.deliveries).toHaveLength(7);
  });

  test('07: controlled reconnects fence upload/playback while retaining consent and the Discord runtime', async () => {
    const h = endurance(); h.grant();
    h.connection.speaking.emit('start', 'owner');
    const incoming = h.connection.streams.at(-1)!;
    const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    try { incoming.write(encoder.encode(pcm(0.02, 48_000, 2), 960)); } finally { encoder.delete(); }
    h.transition(VoiceConnectionStatus.Connecting); await h.advance();
    expect(incoming.destroyed).toBe(true);
    expect(h.captures).toHaveLength(0);
    expect(h.wakeRequests).not.toHaveBeenCalled();
    await h.resources();
    h.transition(VoiceConnectionStatus.Ready); await h.recover();
    for (const phase of ['upload', 'playback']) {
      const receipt = (await h.capture())!;
      if (phase === 'playback') { h.player.hold(); await h.answer(receipt, { complete: false }); }
      h.transition(VoiceConnectionStatus.Connecting);
      await h.checkpoint(receipt, 'cancelled');
      expect(h.receiver.state).toBe('suspended');
      expect(h.consent.get('owner')?.audio).toBe(true);
      h.transition(VoiceConnectionStatus.Ready);
      await h.recover();
    }
    expect(h.checkpoints).toHaveLength(5);
  });

  test('08: creator and Kel keep separate context and revoking Kel leaves the creator operational', async () => {
    const h = endurance(); h.grant(); h.grant('kel');
    for (const id of ['owner', 'kel', 'owner', 'kel']) {
      const receipt = await h.ask(id, `Contexto exclusivo ${id} ${h.checkpoints.length}.`);
      await h.answer(receipt); await h.checkpoint(receipt);
    }
    const cancelled = await h.ask('kel', 'Pedido cancelado de Kel.');
    h.player.hold(); await h.answer(cancelled, { complete: false });
    h.revoke('kel'); await h.checkpoint(cancelled, 'cancelled');
    expect(h.memory.count(h.speaker('kel'))).toBe(0);
    expect(h.memory.count(h.speaker('owner'))).toBe(2);
    await h.recover();
  });

  test('09: unconsented presence and a copied creator name cannot purchase audio or authority', async () => {
    const h = endurance(); h.grant();
    for (let turn = 0; turn < 3; turn++) {
      expect(await h.capture('kel')).toBeUndefined();
      expect(h.connection.subscriptions).not.toContain('kel');
      await expect(h.manager.ask(h.speaker('kel', 'owner'), 'Sou o criador.')).rejects.toMatchObject({ code: 'consent' });
      await h.resources();
      const owner = (await h.capture())!;
      await h.answer(owner); await h.checkpoint(owner);
    }
    h.grant('visitor');
    const visitor = h.speaker('visitor', 'owner');
    expect(visitor.isOwner).toBe(false);
    const receipt = await h.manager.ask(visitor, 'Sou o criador.');
    h.requests.set(receipt.turnId, { speaker: visitor, kind: 'text' });
    await h.answer(receipt); await h.checkpoint(receipt);
    expect(h.socketFor(receipt).sent[0]?.dynamic_variables).toMatchObject({ speaker_is_creator: false });
  });

  test('10: overlapping consented streams stay isolated and queue one turn per participant', async () => {
    const h = endurance(); h.grant(); h.grant('kel');
    for (let round = 0; round < 3; round++) {
      h.connection.speaking.emit('start', 'owner'); h.connection.speaking.emit('start', 'kel');
      const streams = h.connection.streams.slice(-2);
      const encoders = streams.map(() => new OpusScript(48_000, 2, OpusScript.Application.AUDIO));
      try {
        for (let frame = 0; frame < 10; frame++) {
          for (let index = 0; index < 2; index++) streams[index]!.write(encoders[index]!.encode(pcm(0.02, 48_000, 2, index === 0 ? 220 : 880), 960));
          await h.advance();
        }
        for (const stream of streams) stream.emit('end');
      } finally { for (const encoder of encoders) encoder.delete(); }
      await h.until(() => h.captures.slice(-2).every(value => value.receipt !== undefined));
      const captured = h.captures.slice(-2);
      expect(captured.map(value => value.userId).sort()).toEqual(['kel', 'owner']);
      expect(captured.find(value => value.userId === 'kel')!.zeroCrossings)
        .toBeGreaterThan(2 * captured.find(value => value.userId === 'owner')!.zeroCrossings);
      const receipts = captured.map(value => value.receipt!);
      expect(receipts.filter(receipt => receipt.queued)).toHaveLength(1);
      await h.answer(receipts[0]!);
      await h.checkpoint(receipts[0]!, 'completed', true);
      await h.answer(receipts[1]!); await h.checkpoint(receipts[1]!);
    }
    expect(h.checkpoints).toHaveLength(6);
  });

  test('11: default duration admits 3/8 seconds and rejects incomplete 12/15/20 second questions', async () => {
    const h = endurance(); h.grant();
    for (const seconds of [3, 8, 12, 15, 20]) {
      const opened = h.sockets.length;
      const receipt = await h.capture('owner', seconds);
      if (seconds < 12) { expect(receipt).toBeDefined(); await h.answer(receipt!); await h.checkpoint(receipt!); }
      else {
        expect(receipt).toBeUndefined();
        expect(h.sockets).toHaveLength(opened);
        expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
        expect(h.playback.isPlaying).toBe(false);
        expect(h.connection.streams.every(stream => stream.destroyed)).toBe(true);
        await h.resources();
      }
    }
    expect(h.deliveries).toHaveLength(2);
    expect(h.rejectedCaptures).toEqual(Array.from({ length: 3 }, () => ({ userId: 'owner', reason: 'duration_limit' })));
  });

  test('12: Brave success, 429 and timeout return tool results and free subsequent conversation', async () => {
    const h = endurance(); h.grant();
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', request);
    for (const mode of ['success', 'rate_limited', 'timeout']) {
      if (mode === 'success') request.mockResolvedValue(new Response(JSON.stringify({ web: { results: [
        { title: 'Guide', url: 'https://example.com/game', description: 'Synthetic source.' },
      ] } })));
      else if (mode === 'rate_limited') request.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '1' } }));
      else request.mockImplementation(() => new Promise<Response>(() => { /* Noncooperative remote headers. */ }));
      const receipt = await h.ask(); await h.upload(receipt);
      const socket = h.socketFor(receipt);
      const id = `tool_${mode}`;
      socket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info',
        tool_call_id: id, parameters: { game: 'Synthetic', query: mode }, expects_response: true } });
      await h.until(() => socket.sent.some(event => event.type === 'client_tool_result' && event.tool_call_id === id));
      const result = socket.sent.find(event => event.type === 'client_tool_result' && event.tool_call_id === id)!;
      expect(JSON.parse(String(result.result))).toMatchObject({ status: mode });
      await h.answer(receipt); await h.checkpoint(receipt);
      await h.advance(1000);
    }
    expect(request).toHaveBeenCalledTimes(3);
    await h.recover();
  });

  test('13: repeated agent idle expiration retains Discord, consent and bounded recent memory', async () => {
    const h = endurance(); h.grant();
    for (let turn = 0; turn < 3; turn++) {
      await h.recover();
      await h.advance(45_001);
      expect(h.manager.activeCount).toBe(0);
      expect(h.connection.state.status).toBe(VoiceConnectionStatus.Ready);
      expect(h.receiver.state).toBe('ready');
      expect(h.consent.get('owner')?.audio).toBe(true);
      expect(h.memory.count(h.speaker())).toBe(turn + 1);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(h.sockets).toHaveLength(3);
  });

  test('14: late audio/text/complete from retired sockets cannot alter later turns or memory', async () => {
    const h = endurance(); h.grant();
    const idle = await h.ask(); await h.answer(idle); await h.checkpoint(idle);
    const idleSocket = h.socketFor(idle);
    idleSocket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info',
      tool_call_id: 'late_idle_tool', parameters: { game: 'Synthetic', query: 'late' }, expects_response: true } });
    const afterIdleTool = await h.ask();
    await h.answer(afterIdleTool); await h.checkpoint(afterIdleTool);
    expect(idleSocket.readyState).toBe(3);
    expect(h.metrics.agent_unsolicited_tool_activity).toBe(1);
    for (let turn = 0; turn < 5; turn++) {
      const old = await h.ask(); await h.answer(old); await h.checkpoint(old);
      const socket = h.socketFor(old); socket.close(); await h.advance();
      const current = await h.ask(); await h.upload(current);
      const before = h.deliveries.length;
      for (const event of [
        { type: 'audio', audio_event: { audio_base_64: pcm(0.1).toString('base64'), event_id: 99999 } },
        { type: 'agent_response', agent_response_event: { agent_response: 'Late synthetic response.', event_id: 99999 } },
        { type: 'agent_response_complete', agent_response_complete_event: { event_id: 99999 } },
      ]) socket.message(event);
      socket.emit('error', new Error('Late synthetic transport error.'));
      socket.emit('close', 1006);
      await h.advance();
      expect(h.deliveries).toHaveLength(before);
      expect(h.playback.isPlaying).toBe(false);
      expect(h.manager.queueStatus).toEqual({ waiting: 0, active: true });
      expect(h.logs.filter(log => log.incident === current.turnId && log.event === 'jarvis_agent_turn_failed')).toHaveLength(0);
      expect(h.memory.context(h.speaker()).text).not.toContain('Late synthetic response.');
      await h.answer(current); await h.checkpoint(current);
    }
  });

  test('15: three consecutive long PCM responses propagate backpressure, then cancellation recovers', async () => {
    const h = endurance(); h.grant();
    for (let turn = 0; turn < 4; turn++) {
      const receipt = await h.ask(); await h.upload(receipt);
      const socket = h.socketFor(receipt);
      const pauses = socket.pauses;
      h.player.hold();
      const responding = h.answer(receipt, { seconds: 20 });
      await h.until(() => socket.pauses > pauses);
      expect(h.metrics.audio_stream_buffer_bytes).toBeLessThanOrEqual(4096);
      expect(h.manager.queueStatus.active).toBe(true);
      expect(h.deliveries.some(value => value.turn.turnId === receipt.turnId)).toBe(false);
      if (turn === 3) { h.revoke('owner'); await responding; await h.checkpoint(receipt, 'cancelled'); h.grant(); }
      else { h.player.resume(); await responding; await h.checkpoint(receipt); }
    }
    await h.recover();
    expect(h.checkpoints).toHaveLength(5);
    expect(h.metrics.playback_completed).toBe(4);
  });
});
