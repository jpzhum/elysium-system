import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import {
  AudioPlayerError, AudioPlayerStatus, VoiceConnection, VoiceConnectionStatus,
  type AudioPlayer, type AudioResource, type Networking, type VoiceConnectionState,
} from '@discordjs/voice';
import { DAVESession, DAVE_PROTOCOL_VERSION } from '@snazzah/davey';
import { ChannelType, Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type GuildMember } from 'discord.js';
import OpusScript from 'opusscript';
import { expect, test, vi } from 'vitest';
import { createAgentConnector, type AgentDependencies, type ConnectAgentOptions } from '../src/agents/elevenlabs-client.js';
import type { RecentConversation } from '../src/agents/recent-conversation.js';
import type { SessionManager, SessionOptions } from '../src/agents/session-manager.js';
import type { ElevenWakeDetector } from '../src/agents/wake-detector.js';
import { OpusDecoder } from '../src/audio/opus-decoder.js';
import type { PlaybackQueue } from '../src/audio/playback.js';
import { loadConfig } from '../src/config.js';
import { JarvisBot } from '../src/discord/bot.js';
import type { VoiceConnectionManager } from '../src/discord/voice-connection.js';
import type { VoiceReceiver, VoiceReceiverOptions } from '../src/discord/voice-receiver.js';
import { Logger, type Metrics } from '../src/observability/metrics.js';
import type { ConsentStore } from '../src/policy/consent.js';

const hooks = vi.hoisted(() => ({ connection: undefined as VoiceConnection | undefined,
  connect: vi.fn<(options: ConnectAgentOptions) => ReturnType<ReturnType<typeof createAgentConnector>>>() }));
vi.mock('@discordjs/voice', async original => ({ ...await original<typeof import('@discordjs/voice')>(),
  joinVoiceChannel: () => hooks.connection! }));
vi.mock('../src/agents/elevenlabs-client.js', async original => ({
  ...await original<typeof import('../src/agents/elevenlabs-client.js')>(), connectAgent: hooks.connect,
}));

const OWNER = '100000000000000001';
const BOT = '100000000000000002';
const GUILD = '100000000000000003';
const CHANNEL = '100000000000000004';
const VOICE = '100000000000000005';
interface Room {
  sessions: SessionManager; playback: PlaybackQueue; receiver: VoiceReceiver;
  consent: ConsentStore; recent: RecentConversation;
}
interface Access {
  client: Client; voice: VoiceConnectionManager; wake: ElevenWakeDetector; metrics: Metrics; room?: Room;
  handle(interaction: ChatInputCommandInteraction): Promise<void>;
}
class Socket extends EventEmitter {
  constructor(readonly userId: string) { super(); }
  readyState = 0;
  bufferedAmount = 0;
  audioChunks = 0;
  send(value: string, done?: (error?: Error) => void): void {
    const event = JSON.parse(value) as { user_audio_chunk?: string };
    if (event.user_audio_chunk) this.audioChunks++;
    done?.();
  }
  open(): void {
    this.readyState = 1; this.emit('open');
    this.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
      conversation_id: 'PRIVATE_fixture_session', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000',
    } });
  }
  message(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  pause(): void { /* Bounded synthetic PCM. */ }
  resume(): void { /* No external network. */ }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000); }
  terminate(): void { this.close(); }
}
function sine(rate: number, channels: number, seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(rate * seconds) * channels * 2);
  for (let sample = 0; sample < pcm.length / (channels * 2); sample++) {
    const value = Math.round(8_000 * Math.sin(2 * Math.PI * 440 * sample / rate));
    for (let channel = 0; channel < channels; channel++) pcm.writeInt16LE(value, (sample * channels + channel) * 2);
  }
  return pcm;
}

test('four isolation phases preserve one bot, native connection, player, manager and wake state', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const sockets: Socket[] = [];
  const logs: Record<string, unknown>[] = [];
  let wakeText = 'PRIVATE ambient speech';
  const stt = vi.fn<typeof fetch>(async (url) => {
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    return Response.json({ text: wakeText });
  });
  vi.stubGlobal('fetch', stt);
  hooks.connect.mockReset();
  hooks.connect.mockImplementation(options => createAgentConnector({
    fetch: async () => Response.json({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=PRIVATE_fixture_agent&token=PRIVATE_fixture' }),
    createSocket: () => {
      const socket = new Socket(options.dynamicVariables.speaker_is_creator === true ? OWNER : VOICE);
      sockets.push(socket); queueMicrotask(() => socket.open());
      return socket as unknown as ReturnType<AgentDependencies['createSocket']>;
    }, random: () => 0.5, sleep: async () => undefined,
  })(options));
  const config = loadConfig({ JARVIS_DISCORD_TOKEN: 'PRIVATE_fixture_discord_token',
    JARVIS_OWNER_USER_ID: OWNER, JARVIS_GUILD_ID: GUILD, ELEVENLABS_AGENT_ID: 'PRIVATE_fixture_agent',
    ELEVENLABS_API_KEY: 'PRIVATE_fixture_key', JARVIS_VOICE_INPUT: 'elevenlabs-stt' });
  const bot = new JarvisBot(config, new Logger('info', line => logs.push(JSON.parse(line) as Record<string, unknown>)));
  const access = bot as unknown as Access;
  Object.assign(access.client, { user: { id: BOT } });
  const adapter = { sendPayload: vi.fn(() => true), destroy: vi.fn() };
  let prepared: Buffer | undefined;
  let preparedPackets = 0;
  let dispatchedPackets = 0;
  const network = Object.assign(new EventEmitter(), {
    state: { code: 4 }, destroy: vi.fn(), setSpeaking: () => true,
    prepareAudioPacket: (packet: Buffer) => { prepared = packet; if (packet.length > 3) preparedPackets++; return packet; },
    dispatchAudio: () => { if (prepared && prepared.length > 3) dispatchedPackets++; prepared = undefined; return true; },
  });
  const connection = new VoiceConnection({ guildId: GUILD, channelId: CHANNEL, group: 'isolation', selfDeaf: false, selfMute: false },
    { adapterCreator: () => adapter });
  const ready = (): void => {
    connection.state = { status: VoiceConnectionStatus.Ready, adapter, networking: network as unknown as Networking,
      ...('subscription' in connection.state ? { subscription: connection.state.subscription } : {}) };
  };
  ready(); hooks.connection = connection;
  const subscribe = vi.spyOn(connection.receiver, 'subscribe');
  const members = new Collection<string, GuildMember>();
  const guild = { id: GUILD, name: 'PRIVATE fixture guild', members: { me: { id: BOT } } };
  const channel = { id: CHANNEL, name: 'PRIVATE fixture channel', guild, type: ChannelType.GuildVoice, full: false, members,
    permissionsFor: () => ({ has: (permission: bigint) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak].includes(permission) }),
    send: vi.fn(async () => undefined) };
  const dm = vi.fn(async () => ({ edit: vi.fn(async () => undefined) }));
  for (const id of [OWNER, VOICE, BOT]) members.set(id, { id, displayName: 'PRIVATE fixture speaker', guild,
    user: { bot: id === BOT }, voice: { channelId: CHANNEL, channel }, send: dm } as unknown as GuildMember);
  const command = (name: string, audio = false, userId = OWNER) => {
    let deferred = false; let replied = false;
    const replies: string[] = [];
    const send = async (payload: { content: string }): Promise<void> => { replies.push(payload.content); replied = true; };
    const interaction = { inCachedGuild: () => true, guildId: GUILD, guild, user: { id: userId }, member: members.get(userId),
      options: { getSubcommand: () => name, getSubcommandGroup: () => null,
        getString: (key: string) => key === 'texto' ? 'PRIVATE fixture question' : null,
        getBoolean: (key: string) => key === 'audio' ? audio : false },
      get deferred() { return deferred; }, get replied() { return replied; }, reply: send, editReply: send, followUp: send,
      deferReply: async () => { deferred = true; } };
    return { run: () => access.handle(interaction as unknown as ChatInputCommandInteraction), replies };
  };
  const advance = async (ms = 20): Promise<void> => { await tick(); await vi.advanceTimersByTimeAsync(ms); await tick(); };
  const until = async (condition: () => boolean): Promise<void> => {
    for (let frame = 0; !condition() && frame < 500; frame++) await advance();
    expect(condition(), JSON.stringify(logs.slice(-4))).toBe(true);
  };
  let room: Room | undefined;
  const outputPcm = sine(16_000, 1, 0.1);
  const inputFrame = sine(48_000, 2, 0.02);
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const inputPacket = encoder.encode(inputFrame, 960);
  const silencePacket = encoder.encode(Buffer.alloc(3840), 960);
  try {
    await command('join').run(); room = access.room;
    expect(room).toBeDefined();
    const stable = room!;
    const initialSessions = stable.sessions;
    const initialReceiver = stable.receiver;
    const initialWake = access.wake;
    // Preserve the production 20 ms pacing on the same virtual clock as the
    // other timers. node:timers/promises itself uses the real clock in Vitest.
    (Reflect.get(stable.sessions, 'options') as SessionOptions).pace = signal => new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('fixture_aborted')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 20);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const player = Reflect.get(stable.playback, 'player') as AudioPlayer;
    const play = vi.spyOn(player, 'play');
    const resources: AudioResource[] = [];
    const listeners = (): number[] => [connection.listenerCount('stateChange'), connection.receiver.speaking.listenerCount('start'),
      player.listenerCount('error'), player.listenerCount('stateChange')];
    const initialListeners = listeners();
    const healthy = async (): Promise<void> => {
      await advance();
      expect(access.room).toBe(stable);
      expect(stable.sessions).toBe(initialSessions);
      expect(stable.receiver).toBe(initialReceiver);
      expect(access.wake).toBe(initialWake);
      expect(access.voice.connection).toBe(connection);
      expect(Reflect.get(stable.playback, 'player')).toBe(player);
      expect(stable.sessions.queueStatus).toEqual({ waiting: 0, active: false });
      expect(stable.playback.isPlaying).toBe(false);
      expect(player.state.status).toBe(AudioPlayerStatus.Idle);
      expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
      expect(stable.playback.diagnosticState.subscribed).toBe(true);
      expect(connection.receiver.subscriptions.size).toBe(0);
      expect(Reflect.get(stable.receiver, 'turns').size).toBe(0);
      expect(Reflect.get(stable.sessions, 'checking').size).toBe(0);
      const open = sockets.filter(socket => socket.readyState === 1);
      expect(open.length).toBeLessThanOrEqual(config.JARVIS_MAX_ACTIVE_SESSIONS);
      expect(stable.sessions.activeCount).toBe(open.length);
      // A warm provider session intentionally owns heartbeat/lifetime/idle
      // timers. They must stay bounded rather than grow once per interaction.
      expect(vi.getTimerCount()).toBeLessThanOrEqual(4 + 4 * open.length);
      for (const socket of sockets) for (const event of socket.eventNames()) expect(socket.listenerCount(event)).toBeLessThanOrEqual(1);
      expect(access.metrics.snapshot().audio_stream_buffer_bytes ?? 0).toBe(0);
      expect(access.metrics.snapshot().turn_queue_depth ?? 0).toBe(0);
      expect(access.wake.operationalState).toMatchObject({ queued: 0, active: false });
      expect(resources.every(resource => resource.playStream.destroyed)).toBe(true);
      expect(listeners()).toEqual(initialListeners);
      expect(JSON.stringify(logs)).not.toContain('PRIVATE');
    };
    const terminal = (incident: string) => logs.filter(log => log.incident === incident &&
      ['jarvis_agent_turn_finished', 'jarvis_agent_turn_failed', 'jarvis_agent_turn_cancelled'].includes(String(log.event)));
    let responseId = 0;
    const answer = async (incident: string, voice = false): Promise<void> => {
      const userId = voice ? VOICE : OWNER;
      await until(() => sockets.some(current => current.readyState === 1 && current.userId === userId));
      if (voice) await until(() => logs.some(log => log.incident === incident && log.event === 'jarvis_agent_input_sent' && log.input_audio_finished));
      const socket = sockets.findLast(current => current.readyState === 1 && current.userId === userId)!;
      const id = ++responseId;
      if (voice) socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'PRIVATE fixture speech', event_id: id } });
      socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'PRIVATE fixture answer', event_id: id, response_id: `fixture_${id}` } });
      socket.message({ type: 'audio', audio_event: { audio_base_64: outputPcm.toString('base64'), event_id: id, response_id: `fixture_${id}` } });
      socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: id } });
      await until(() => terminal(incident).length > 0);
      expect(terminal(incident)).toHaveLength(1);
      expect(terminal(incident)[0]).toMatchObject({ turn_outcome: 'completed', turn_delivery: 'confirmed' });
      expect(logs.filter(log => log.incident === incident && log.event === 'jarvis_agent_turn_released')).toHaveLength(1);
      resources.push(play.mock.calls.at(-1)![0]);
      await healthy();
    };
    const text = async (): Promise<string> => {
      const ask = command('ask'); await ask.run(); await tick();
      const incident = ask.replies.join('\n').match(/Incidente ([A-F0-9]{8})/)?.[1];
      expect(incident).toBeDefined(); return incident!;
    };
    // Phase 1: actual /tone handler, no provider or microphone calls.
    for (let turn = 0; turn < 10; turn++) {
      const before = dispatchedPackets;
      const tone = command('tone'); let done = false;
      const running = tone.run().then(() => { done = true; });
      await until(() => done); await running;
      expect(tone.replies.join('\n')).toMatch(/Tom reproduzido.*Incidente [A-F0-9]{8}/);
      resources.push(play.mock.calls.at(-1)![0]);
      expect(dispatchedPackets).toBeGreaterThan(before);
      await healthy();
    }
    expect(hooks.connect).not.toHaveBeenCalled(); expect(stt).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
    // Phase 2: effective capture gate is closed (no audio consent), same worker.
    await command('consent').run();
    for (let turn = 0; turn < 10; turn++) {
      connection.receiver.speaking.emit('start', OWNER);
      await answer(await text());
    }
    expect(subscribe).not.toHaveBeenCalled(); expect(stt).not.toHaveBeenCalled();
    expect(stable.consent.get(OWNER)?.audio).toBe(false);
    expect(preparedPackets).toBeGreaterThan(0); expect(dispatchedPackets).toBeGreaterThan(0);
    // Phase 3: capture/Opus, native DAVE availability, and wake admission are
    // isolated from ElevenAgents without rebuilding any worker component.
    const textConsentVersion = stable.consent.get(OWNER)!.version;
    const textSession = (Reflect.get(stable.sessions, 'entries') as Map<string, unknown>).get(OWNER);
    // Consent a second, previously unconsented speaker. Do not revoke the text
    // participant or clear its session/memory to pass a later phase.
    await command('consent', true, VOICE).run();
    expect((Reflect.get(stable.sessions, 'entries') as Map<string, unknown>).get(OWNER)).toBe(textSession);
    expect(stable.consent.get(OWNER)!.version).toBe(textConsentVersion);
    const receiverOptions = Reflect.get(stable.receiver, 'options') as VoiceReceiverOptions;
    const captured: { bytes: number; duringPlayback: boolean }[] = [];
    const isolatedCapture = vi.spyOn(receiverOptions, 'onTurn').mockImplementation((_id, pcm, timing) => {
      captured.push({ bytes: pcm.length, duringPlayback: timing.duringPlayback });
    });
    const capture = async (failure?: 'decode' | 'dave'): Promise<void> => {
      connection.receiver.speaking.emit('start', VOICE);
      const stream = connection.receiver.subscriptions.get(VOICE);
      expect(stream).toBeDefined();
      if (failure === 'dave') stream!.emit('error', new Error('DecryptionFailed'));
      else if (failure === 'decode') stream!.push(Buffer.alloc(0));
      else {
        for (let frame = 0; frame < 10 && !stream!.destroyed; frame++) stream!.push(inputPacket);
        // The 600 ms VAD tail is decoded by the real receiver; no provider needed.
        for (let frame = 0; frame < 40 && !stream!.destroyed; frame++) stream!.push(silencePacket);
        if (!stream!.destroyed) stream!.push(null);
      }
      await until(() => connection.receiver.subscriptions.size === 0);
    };
    const providerCallsBeforeInput = hooks.connect.mock.calls.length;
    const decoder = new OpusDecoder();
    try {
      expect(decoder.decode(inputPacket)).toHaveLength(3840);
      expect(() => decoder.decode(Buffer.alloc(0))).toThrow(RangeError);
    } finally { decoder.delete(); }
    await capture(); expect(captured).toHaveLength(1); expect(captured[0]!.bytes).toBeGreaterThan(19_200);
    const errorStart = logs.length;
    await capture('dave');
    expect(captured).toHaveLength(1);
    expect(logs.slice(errorStart).filter(log => log.event === 'jarvis_voice_receive_error')).toEqual([
      expect.objectContaining({ code: 'DAVE_DECRYPTION_FAILED', receive_stage: 'stream', capture_has_pcm: false }),
    ]);
    await capture(); expect(captured).toHaveLength(2);
    const decodeStart = logs.length;
    await capture('decode');
    expect(captured).toHaveLength(2);
    expect(logs.slice(decodeStart).filter(log => log.event === 'jarvis_voice_receive_error')).toEqual([
      expect.objectContaining({ code: 'OPUS_DECODE_FAILED', receive_stage: 'decode', capture_has_pcm: false }),
    ]);
    await capture(); expect(captured).toHaveLength(3);
    expect(hooks.connect).toHaveBeenCalledTimes(providerCallsBeforeInput);
    expect(stt).not.toHaveBeenCalled();
    const nativeDave = new DAVESession(DAVE_PROTOCOL_VERSION, OWNER, CHANNEL);
    try {
      expect(nativeDave.protocolVersion).toBe(DAVE_PROTOCOL_VERSION);
      // A synthetic session has no MLS exchange. This is availability, not a
      // claim that real Discord encryption/decryption has passed.
      expect(nativeDave.ready).toBe(false);
    } finally { nativeDave.reset(); }
    const speaker = { discordUserId: VOICE, channelId: CHANNEL, consentVersion: stable.consent.get(VOICE)!.version };
    const wakePcm = Buffer.concat(Array.from({ length: 10 }, () => inputFrame));
    try {
      expect(await access.wake.detect(wakePcm, undefined, speaker)).toBe(false);
      expect(await access.wake.detect(wakePcm, undefined, speaker)).toBe(false);
      for (const delay of [10_000, 20_000, 40_000, 60_000]) {
        const paid = stt.mock.calls.length;
        await expect(access.wake.detect(wakePcm, undefined, speaker)).rejects.toMatchObject({
          rateLimitSource: 'speaker_backoff', retryAfterMs: delay,
        });
        await advance(1000);
        await expect(access.wake.detect(wakePcm, undefined, speaker)).rejects.toMatchObject({
          rateLimitSource: 'speaker_backoff', retryAfterMs: delay - 1000,
        });
        expect(stt).toHaveBeenCalledTimes(paid); // Rejections never extend the pause or buy STT.
        if (delay === 10_000) {
          // A voice-only pause must not block a text turn on the same worker.
          await answer(await text());
          expect(stt).toHaveBeenCalledTimes(paid);
        }
        // Advance to the admission's exact existing retryAt, never reset state.
        const admission = (Reflect.get(access.wake, 'admissions') as Map<string, { retryAt: number }>).get(VOICE)!;
        await advance(Math.max(0, admission.retryAt - performance.now()));
        if (delay === 60_000) wakeText = 'Jarvis, PRIVATE fixture activation';
        expect(await access.wake.detect(wakePcm, undefined, speaker)).toBe(delay === 60_000);
      }
      expect(access.wake.admissionState.backingOff).toBe(0);
    } finally { wakePcm.fill(0); isolatedCapture.mockRestore(); }
    await healthy();
    const afterInputErrors = logs.filter(log => log.event === 'jarvis_voice_receive_error');
    expect(afterInputErrors).toHaveLength(2);
    // Phase 4: 20 integrated turns, preserving the state accumulated above.
    // Old callbacks and real connection transitions are negative controls; no
    // resets, /leave, replacement bot or replacement manager are used.
    const completedBefore = logs.filter(log => log.event === 'jarvis_agent_turn_finished').length;
    const priorConsentVersion = stable.consent.get(OWNER)!.version;
    const voiceConsentVersion = stable.consent.get(VOICE)!.version;
    const staleResource = resources[0]!;
    const staleSocket = sockets[0]!;
    const integrated: string[] = [];
    for (let turn = 1; turn <= 20; turn++) {
      let incident: string;
      if (turn % 2 === 1) incident = await text();
      else {
        // Respect the existing follow-up and rolling STT budget; do not clear
        // the cooldown to make the integrated run artificially pass.
        await advance(18_001);
        const start = logs.length;
        await capture();
        await until(() => logs.slice(start).some(log => log.event === 'jarvis_agent_turn_started'));
        incident = logs.slice(start).find(log => log.event === 'jarvis_agent_turn_started')!.incident as string;
      }
      if (turn === 3) {
        staleSocket.emit('error', new Error('PRIVATE late transport'));
        staleSocket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: -1 } });
        staleResource.playStream.emit('error', new Error('PRIVATE late resource'));
        player.emit('error', new AudioPlayerError(new Error('PRIVATE late player'), staleResource));
      }
      await answer(incident, turn % 2 === 0); integrated.push(incident);
      if (turn === 4) {
        const before = connection.state;
        expect(before.status).toBe(VoiceConnectionStatus.Ready);
        const previousSubscription = 'subscription' in before ? before.subscription : undefined;
        connection.state = { ...before, status: VoiceConnectionStatus.Connecting } as VoiceConnectionState;
        ready();
        expect('subscription' in connection.state && connection.state.subscription).toBe(previousSubscription);
      }
      if (turn === 5) {
        const subscription = 'subscription' in connection.state ? connection.state.subscription : undefined;
        subscription!.unsubscribe();
        // Native connection state change re-enters the same repair callbacks.
        expect(stable.playback.diagnosticState.subscribed).toBe(true);
      }
      expect(stable.consent.get(OWNER)!.version).toBe(priorConsentVersion);
      expect(stable.consent.get(OWNER)!.audio).toBe(false);
      expect(stable.consent.get(VOICE)!.version).toBe(voiceConsentVersion);
      await healthy();
    }
    expect(integrated).toHaveLength(20); expect(new Set(integrated).size).toBe(20);
    expect(logs.filter(log => log.event === 'jarvis_agent_turn_finished')).toHaveLength(completedBefore + 20);
    expect(logs.filter(log => log.event === 'jarvis_agent_turn_failed')).toHaveLength(0);
    expect(logs.filter(log => log.event === 'jarvis_voice_receive_error')).toEqual(afterInputErrors);
    expect(logs.filter(log => log.event === 'jarvis_agent_turn_finished')).toHaveLength(31);
    expect(logs.filter(log => log.event === 'jarvis_agent_turn_released')).toHaveLength(31);
    for (const incident of integrated) {
      const settlement = logs.find(log => log.incident === incident && log.playback_event === 'settled');
      expect(settlement).toBeDefined();
      expect(settlement!.consumed_packets).toBe(settlement!.encoded_packets);
      expect(logs.some(log => log.incident === incident && log.player_status === 'buffering')).toBe(true);
      expect(logs.some(log => log.incident === incident && log.player_status === 'playing')).toBe(true);
    }
    expect(dm).not.toHaveBeenCalled();
  } finally {
    encoder.delete(); inputFrame.fill(0); outputPcm.fill(0);
    await bot.stop();
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    for (const socket of sockets) socket.close();
    await advance();
    expect(connection.receiver.subscriptions.size).toBe(0);
    expect(room?.sessions.activeCount ?? 0).toBe(0);
    const timers = vi.getTimerCount();
    hooks.connection = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    expect(timers).toBe(0);
  }
});
