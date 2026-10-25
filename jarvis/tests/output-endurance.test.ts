import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import {
  AudioPlayerError, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus, createAudioPlayer,
  type AudioPlayer, type AudioResource, type PlayerSubscription, type VoiceConnection,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { expect, test, vi } from 'vitest';
import { createAgentConnector, type AgentDependencies } from '../src/agents/elevenlabs-client.js';
import { RecentConversation } from '../src/agents/recent-conversation.js';
import { SessionManager, type DeliveredTurn, type TurnNotification, type TurnReceipt } from '../src/agents/session-manager.js';
import { OpusDecoder } from '../src/audio/opus-decoder.js';
import { PlaybackQueue } from '../src/audio/playback.js';
import { Logger } from '../src/observability/metrics.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

// The pinned AudioPlayer, resource reader, PCM converter, Opus encoder, adapter
// and turn scheduler run here. Only provider websocket and Discord transport are
// controlled. Prepared/dispatched packets do not prove remote audibility/DAVE.
class OutputSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  send(value: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(value) as Record<string, unknown>); callback?.();
  }
  open(): void {
    this.readyState = 1; this.emit('open');
    this.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
      conversation_id: 'private_output_fixture', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000',
    } });
  }
  message(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  pause(): void { /* The bounded output fixture never reaches TCP high water. */ }
  resume(): void { /* No microphone or receiver is created by this harness. */ }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000); }
  terminate(): void { this.close(); }
}

function sine(rate: number, seconds: number, amplitude = 8_000): Buffer {
  const pcm = Buffer.alloc(Math.round(rate * seconds) * 2);
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * sample / rate)), sample * 2);
  }
  return pcm;
}

function output() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const scheduled = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const clearedIntervals = vi.spyOn(globalThis, 'clearInterval');
  const unexpectedNetwork = vi.fn<typeof fetch>(async () => { throw new Error('unexpected_network_request'); });
  vi.stubGlobal('fetch', unexpectedNetwork);
  const metrics: Record<string, number> = {};
  const metric = (name: string, value = 1): void => { metrics[name] = (metrics[name] ?? 0) + value; };
  const player = createAudioPlayer({ behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: Number.MAX_SAFE_INTEGER,
  } });
  const decoder = new OpusDecoder();
  const state = { status: VoiceConnectionStatus.Ready, subscription: undefined as PlayerSubscription | undefined };
  let preparedPackets = 0;
  let dispatchedPackets = 0;
  let prepared: Buffer | undefined;
  const connection = Object.assign(new EventEmitter(), {
    state,
    setSpeaking: (speaking: boolean) => { if (!speaking) prepared = undefined; },
    onSubscriptionRemoved: (subscription: PlayerSubscription) => {
      if (state.subscription === subscription) state.subscription = undefined;
    },
    prepareAudioPacket: (packet: Buffer) => {
      expect(decoder.decode(packet)).toHaveLength(960 * 4);
      prepared = Buffer.from(packet);
      if (packet.length > 3) preparedPackets++;
    },
    dispatchAudio: () => { if (prepared && prepared.length > 3) dispatchedPackets++; prepared = undefined; },
    subscribe: (actual: AudioPlayer) => {
      state.subscription = Reflect.get(actual, 'subscribe').call(actual, connection) as PlayerSubscription;
      return state.subscription;
    },
  });
  // An accidental microphone dependency is an immediate test failure.
  Object.defineProperty(connection, 'receiver', { get: () => { throw new Error('output_only_test_must_not_initialize_receiver'); } });
  const queue = new PlaybackQueue(connection as unknown as VoiceConnection, { player, onMetric: metric });
  const play = vi.spyOn(player, 'play');
  const codecs = vi.spyOn(OpusScript.prototype, 'delete');
  const listenerCounts = (): [string | symbol, number][] => player.eventNames().map(name => [name, player.listenerCount(name)]);
  const initialListeners = listenerCounts();
  const transition = (status: VoiceConnectionStatus): void => {
    const before = { ...state }; state.status = status; connection.emit('stateChange', before, state);
  };
  const step = async (): Promise<void> => {
    // Drive the real pinned scheduler methods deterministically; neither the
    // resource nor its transitions/Opus packets are supplied by a fake player.
    if (Reflect.get(player, 'checkPlayable').call(player)) {
      Reflect.get(player, '_stepDispatch').call(player);
      Reflect.get(player, '_stepPrepare').call(player);
    }
    await tick();
  };
  const released = async (turn: number): Promise<void> => {
    await tick(); await vi.advanceTimersByTimeAsync(20); await tick();
    expect(queue.isPlaying, `turn ${turn} must release playback`).toBe(false);
    expect(player.state.status).toBe(AudioPlayerStatus.Idle);
    expect(queue.diagnosticState, `turn ${turn} has its own current subscription`).toMatchObject({ available: true, subscribed: true });
    expect(state.subscription?.player).toBe(player);
    expect(state.subscription?.connection).toBe(connection);
    expect(metrics.audio_stream_buffer_bytes).toBe(0);
    expect(codecs).toHaveBeenCalledTimes(turn);
    expect(listenerCounts()).toEqual(initialListeners);
    expect(connection.listenerCount('stateChange')).toBe(1);
    const cancelled = new Set(cleared.mock.calls.map(([timer]) => timer));
    for (const [index, call] of scheduled.mock.calls.entries()) {
      if (call[1] === 180_000 || call[1] === 250) expect(cancelled.has(scheduled.mock.results[index]!.value)).toBe(true);
    }
  };
  const close = async (): Promise<void> => {
    try {
      queue.stop(); await tick(); await vi.advanceTimersByTimeAsync(20); await tick();
      expect(connection.listenerCount('stateChange')).toBe(0);
      expect(state.subscription).toBeUndefined();
      expect(metrics.audio_stream_buffer_bytes).toBe(0);
      expect(unexpectedNetwork).not.toHaveBeenCalled();
      // The real player owns a process-wide short scheduler; every application
      // resource/session/RAM deadline and provider heartbeat must be cancelled.
      const cancelled = new Set(cleared.mock.calls.map(([timer]) => timer));
      for (const [index, call] of scheduled.mock.calls.entries()) {
        if (Number(call[1]) >= 250) expect(cancelled.has(scheduled.mock.results[index]!.value)).toBe(true);
      }
      const cancelledHeartbeats = new Set(clearedIntervals.mock.calls.map(([timer]) => timer));
      for (const result of intervals.mock.results) expect(cancelledHeartbeats.has(result.value)).toBe(true);
    } finally { decoder.delete(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  };
  return { queue, player, connection, metrics, metric, play, codecs, transition, step, released, close,
    get preparedPackets() { return preparedPackets; }, get dispatchedPackets() { return dispatchedPackets; } };
}

test('twenty text asks cross the real output chain, recover from turns three/four and repair a lost rejoin subscription', async () => {
  const h = output();
  const sockets: OutputSocket[] = [];
  const logs: Record<string, unknown>[] = [];
  const notices: TurnNotification[] = [];
  const delivered: DeliveredTurn[] = [];
  const consent = new ConsentStore();
  // Text consent is sufficient. No audio consent, receiver or paid STT exists.
  const grant = consent.grant('owner', false);
  const speaker = speakerContext({ discordUserId: 'owner', displayName: 'Private output fixture',
    guildId: 'guild', channelId: 'voice', consented: true, consentVersion: grant.version }, 'owner');
  const memory = new RecentConversation('guild', 'voice', 600);
  const detectWake = vi.fn(async () => { throw new Error('text_question_must_not_request_STT'); });
  const manager = new SessionManager({
    connect: (_speaker, callbacks, signal) => {
      const socket = new OutputSocket(); sockets.push(socket);
      return createAgentConnector({
        fetch: async () => Response.json({ signed_url:
          'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture&token=PRIVATE_OUTPUT_TOKEN' }),
        createSocket: () => { queueMicrotask(() => socket.open());
          return socket as unknown as ReturnType<AgentDependencies['createSocket']>; },
        random: () => 0.5, sleep: async () => undefined,
      })({ apiKey: 'PRIVATE_OUTPUT_KEY', agentId: 'fixture', callbacks, signal,
        dynamicVariables: { speaker_name: speaker.displayName, speaker_is_creator: speaker.isOwner }, suppressFirstMessage: true });
    },
    playback: h.queue, allowed: (context, audio) => consent.isCurrent(context.discordUserId, context.consentVersion, audio),
    detectWake, maxSessions: 2, maxTurnSeconds: 12, maxSessionSeconds: 300,
    idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 120,
    metric: h.metric, logger: new Logger('info', line => { logs.push(JSON.parse(line) as Record<string, unknown>); }),
    notify: (_speaker, event) => { notices.push(event); },
    onTurnDelivered: (_speaker, turn) => { delivered.push(turn); memory.add(speaker, turn); },
  });
  const terminal = (receipt: TurnReceipt) => logs.filter(log => log.incident === receipt.turnId
    && ['jarvis_agent_turn_finished', 'jarvis_agent_turn_failed', 'jarvis_agent_turn_cancelled'].includes(String(log.event)));
  const pcm = sine(16_000, 0.2);
  let encoderFailureResource: AudioResource | undefined;
  let interruptedSocket: OutputSocket | undefined;
  try {
    for (let turn = 1; turn <= 20; turn++) {
      const receipt = await manager.ask(speaker, `Private written question ${turn}.`);
      await tick();
      expect(receipt.turnId).toMatch(/^[0-9A-F]{8}$/);
      expect(logs.filter(log => log.incident === receipt.turnId && log.event === 'jarvis_agent_turn_started')).toHaveLength(1);
      const socket = sockets.at(-1)!;
      const beforePrepared = h.preparedPackets;
      const beforeDispatch = h.dispatchedPackets;
      if (turn === 3) vi.spyOn(OpusScript.prototype, 'encode').mockImplementationOnce(() => { throw new Error('Encode error: Internal error'); });
      socket.message({ type: 'agent_response', agent_response_event: {
        agent_response: `Private generated answer ${turn}.`, event_id: turn, response_id: `output_${turn}`,
      } });
      socket.message({ type: 'audio', audio_event: {
        audio_base_64: pcm.toString('base64'), event_id: turn, response_id: `output_${turn}`,
      } });
      if (turn !== 4) socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: turn } });
      await tick();
      let injected = false;
      for (let frame = 0; frame < 150 && (manager.queueStatus.active || h.queue.isPlaying); frame++) {
        await h.step();
        if (turn === 4 && !injected && h.dispatchedPackets > beforeDispatch + 1) {
          interruptedSocket = socket;
          socket.emit('error', new Error('PRIVATE_OUTPUT_TOKEN signed-url transcript'));
          injected = true;
        }
        if (turn === 5 && !injected && h.dispatchedPackets > beforeDispatch) {
          expect(encoderFailureResource).toBeDefined();
          encoderFailureResource!.playStream.emit('error', new Error('PRIVATE stale resource'));
          h.player.emit('error', new AudioPlayerError(new Error('PRIVATE stale player'), encoderFailureResource!));
          interruptedSocket!.message({ type: 'audio', audio_event: { audio_base_64: pcm.toString('base64'), event_id: 999 } });
          injected = true;
        }
      }
      if (turn === 3) encoderFailureResource = h.play.mock.calls.at(-1)?.[0];
      expect(terminal(receipt), `turn ${turn}: ${JSON.stringify(logs.slice(-4))}`).toHaveLength(1);
      const outcome = turn === 3 ? 'failed' : turn === 4 ? 'partial' : 'completed';
      expect(terminal(receipt)[0]).toMatchObject({ input_kind: 'text', turn_outcome: outcome,
        turn_delivery: turn === 3 ? 'not_started' : turn === 4 ? 'partial' : 'confirmed' });
      expect(logs.filter(log => log.incident === receipt.turnId && log.event === 'jarvis_agent_turn_released')).toHaveLength(1);
      expect(notices.filter(event => event.turnId === receipt.turnId && ['failed', 'cancelled'].includes(event.type)))
        .toHaveLength(turn === 3 || turn === 4 ? 1 : 0);
      expect(delivered.filter(value => value.turnId === receipt.turnId)).toHaveLength(turn === 3 || turn === 4 ? 0 : 1);
      expect(manager.queueStatus).toEqual({ waiting: 0, active: false });
      const playbackEvents = logs.filter(log => log.incident === receipt.turnId && log.event === 'jarvis_playback_state');
      for (const event of ['stream_accepted', 'resource_created', 'play_called', 'settled']) {
        expect(playbackEvents.filter(log => log.playback_event === event), `turn ${turn}: ${event}`).toHaveLength(1);
      }
      expect(playbackEvents.every(log => log.playback_token === turn)).toBe(true);
      expect(playbackEvents.some(log => log.player_status === AudioPlayerStatus.Buffering)).toBe(true);
      const settlement = playbackEvents.find(log => log.playback_event === 'settled')!;
      expect(settlement).toMatchObject({ consumed_packets: turn === 3 ? 0 : 10, encoded_packets: turn === 3 ? 0 : 10 });
      expect(playbackEvents.filter(log => log.playback_event === 'packet_read')).toHaveLength(turn === 3 ? 0 : 1);
      if (turn === 3) {
        expect(h.preparedPackets).toBe(beforePrepared);
        expect(h.dispatchedPackets).toBe(beforeDispatch);
        expect(terminal(receipt)[0]).toMatchObject({ code: 'PLAYBACK_FAILED', cause_code: 'PLAYBACK_ENCODER_FAILED',
          playback_stage: 'opus_encode', opus_error_code: -3 });
      } else {
        expect(playbackEvents.some(log => log.player_status === AudioPlayerStatus.Playing)).toBe(true);
        expect(playbackEvents.some(log => log.previous_player_status === AudioPlayerStatus.Playing
          && log.player_status === AudioPlayerStatus.Idle)).toBe(true);
        expect(h.preparedPackets).toBeGreaterThan(beforePrepared);
        expect(h.dispatchedPackets).toBeGreaterThan(beforeDispatch);
      }
      if (turn === 4) {
        expect(injected).toBe(true);
        expect(terminal(receipt)[0]).toMatchObject({ code: 'AGENT_TRANSPORT_ERROR' });
        h.transition(VoiceConnectionStatus.Signalling);
        const previousSubscription = h.connection.state.subscription!;
        previousSubscription.unsubscribe();
        h.transition(VoiceConnectionStatus.Connecting);
        expect(h.queue.diagnosticState.available).toBe(false);
        h.transition(VoiceConnectionStatus.Ready);
        expect(h.connection.state.subscription).toBeDefined();
        expect(h.connection.state.subscription).not.toBe(previousSubscription);
      }
      await h.released(turn);
      expect(h.play.mock.calls.every(([resource]) => resource.playStream.destroyed)).toBe(true);
      expect(memory.context(speaker).text).not.toMatch(/written question [34]\./);
      for (const current of sockets) for (const event of current.eventNames()) expect(current.listenerCount(event)).toBeLessThanOrEqual(1);
    }
    expect(detectWake).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(3);
    expect(h.metrics.playback_started).toBe(20);
    expect(h.metrics.playback_completed).toBe(19); // Transport-failed generation still drains local PCM.
    expect(h.metrics.playback_failed).toBe(1);
    expect(h.metrics.agent_turns_completed).toBe(18);
    expect(delivered).toHaveLength(18);
    expect(notices.filter(event => event.type === 'failed')).toHaveLength(2);
    expect(memory.count(speaker)).toBe(10);
    expect(JSON.stringify(logs)).not.toMatch(/Private|PRIVATE|written question|generated answer|private_output_fixture|signed-url|transcript/);
  } finally {
    pcm.fill(0); manager.close(); memory.close(); consent.clear();
    for (const socket of sockets) socket.close();
    await h.close();
  }
});

test('twenty synthetic tones use the same real output player without ElevenLabs and recover after turns three/four', async () => {
  const h = output();
  // Same rate, length, frequency and amplitude as /jarvis tone.
  const tone = sine(48_000, 1, 1_200);
  let failedResource: AudioResource | undefined;
  try {
    for (let turn = 1; turn <= 20; turn++) {
      const before = h.dispatchedPackets;
      if (turn === 3) vi.spyOn(OpusScript.prototype, 'encode').mockImplementationOnce(() => { throw new Error('Encode error: Internal error'); });
      const done = h.queue.play('owner', tone, 48_000, true);
      let terminals = 0;
      let failure: unknown;
      void done.then(() => { terminals++; }, error => { failure = error; terminals++; });
      await tick();
      let injected = false;
      for (let frame = 0; frame < 150 && h.queue.isPlaying; frame++) {
        await h.step();
        if (turn === 4 && !injected && h.dispatchedPackets > before + 1) {
          failedResource = h.play.mock.calls.at(-1)![0];
          h.player.emit('error', new AudioPlayerError(new Error('PRIVATE output failure'), failedResource));
          injected = true;
        }
        if (turn === 5 && !injected && h.dispatchedPackets > before) {
          h.player.emit('error', new AudioPlayerError(new Error('PRIVATE disposed output'), failedResource!));
          injected = true;
        }
      }
      await tick();
      if (turn === 3 || turn === 4) await expect(done).rejects.toBe(failure);
      else await done;
      expect(terminals).toBe(1);
      if (turn === 3) expect(h.dispatchedPackets).toBe(before);
      else expect(h.dispatchedPackets).toBeGreaterThan(before);
      await h.released(turn);
      expect(h.play.mock.calls.every(([resource]) => resource.playStream.destroyed)).toBe(true);
    }
    expect(h.metrics.playback_started).toBe(20);
    expect(h.metrics.playback_completed).toBe(18);
    expect(h.metrics.playback_failed).toBe(2);
  } finally { tone.fill(0); await h.close(); }
});
