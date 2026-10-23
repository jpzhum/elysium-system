import { EventEmitter } from 'node:events';
import { ChannelType, Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type GuildMember } from 'discord.js';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JarvisBot } from '../src/discord/bot.js';
import { loadConfig } from '../src/config.js';
import { Logger, type Metrics } from '../src/observability/metrics.js';
import { AuthorizationError } from '../src/policy/authorization.js';
import type { ConsentStore } from '../src/policy/consent.js';
import type { SpeakerContext } from '../src/policy/identity.js';
import { SessionError, type SessionManager, type SessionOptions } from '../src/agents/session-manager.js';
import type { AgentSession, ConnectAgentOptions } from '../src/agents/elevenlabs-client.js';
import { WakeError, type ElevenWakeDetector } from '../src/agents/wake-detector.js';
import type { VoiceReceiverOptions } from '../src/discord/voice-receiver.js';
import type { VoiceConnectionManager } from '../src/discord/voice-connection.js';
import type { VoiceParticipantsResult } from '../src/tools/voice-participants.js';

interface Provider { options: ConnectAgentOptions; session: AgentSession; audio: Buffer[]; }
const hooks = vi.hoisted(() => ({
  providers: [] as Provider[],
  receiver: undefined as VoiceReceiverOptions | undefined,
  autoRecognize: true,
  beforeConnect: undefined as ((options: ConnectAgentOptions) => Promise<void>) | undefined,
  streams: [] as { userId: string; pcm: Buffer[] }[],
  runtime: vi.fn(async () => undefined),
  connect: vi.fn(async (options: ConnectAgentOptions): Promise<AgentSession> => {
    const audio: Buffer[] = [];
    const session: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendContext: vi.fn(), close: vi.fn(),
      sendAudio: vi.fn((pcm) => {
        audio.push(Buffer.from(pcm));
        if (hooks.autoRecognize && audio.length === 1) options.callbacks.onUserTranscript?.({ eventId: 123 });
      }),
    };
    hooks.providers.push({ options, session, audio });
    await hooks.beforeConnect?.(options);
    return session;
  }),
}));

vi.mock('../src/agents/elevenlabs-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agents/elevenlabs-client.js')>(), connectAgent: hooks.connect,
}));
vi.mock('../src/observability/voice-runtime.js', () => ({ inspectVoiceRuntime: hooks.runtime }));
vi.mock('../src/discord/voice-receiver.js', () => ({ VoiceReceiver: class {
  constructor(_connection: unknown, options: VoiceReceiverOptions) { hooks.receiver = options; }
  start = vi.fn(); stop = vi.fn(); stopUser = vi.fn();
} }));
vi.mock('../src/audio/playback.js', async (original) => ({
  ...await original<typeof import('../src/audio/playback.js')>(), PlaybackQueue: class {
  isPlaying = false; isAudible = false; currentStreamToken = undefined;
  play = vi.fn(async () => undefined);
  stop = vi.fn(); stopUser = vi.fn();
  startStream(userId: string, _rate: number, _owner: boolean, options?: {
    isAllowed?: () => boolean; onProgress?: (event: 'first_packet' | 'drained', ms: number) => void;
  }) {
    let resolve!: () => void;
    const done = new Promise<void>((complete) => { resolve = complete; });
    const record = { userId, pcm: [] as Buffer[] };
    hooks.streams.push(record);
    this.isPlaying = true;
    return { done, write: async (pcm: Buffer) => {
      if (options?.isAllowed && !options.isAllowed()) throw new Error('cancelled');
      record.pcm.push(Buffer.from(pcm)); options?.onProgress?.('first_packet', 0);
    }, end: () => { this.isPlaying = false; options?.onProgress?.('drained', 0); resolve(); },
    cancel: () => { this.isPlaying = false; resolve(); } };
  }
} }));

const OWNER = '100000000000000001';
const GUEST = '100000000000000002';
const GUILD = '100000000000000003';
const CHANNEL = '100000000000000004';
const BOT = '100000000000000005';
const OBSERVER = '100000000000000006';
const privateText = 'conteúdo privado de teste';
const active: JarvisBot[] = [];

interface Room {
  sessions: SessionManager;
  consent: ConsentStore;
}
interface Access {
  client: Client;
  voice: VoiceConnectionManager;
  wake: ElevenWakeDetector;
  metrics: Metrics;
  room?: Room;
  handle(interaction: ChatInputCommandInteraction): Promise<void>;
  context(room: Room, member: GuildMember): SpeakerContext;
}

async function settle(): Promise<void> { for (let i = 0; i < 120; i++) await Promise.resolve(); }

async function setup() {
  const config = loadConfig({ JARVIS_DISCORD_TOKEN: 'fictional-discord-token-for-v5-tests',
    JARVIS_OWNER_USER_ID: OWNER, JARVIS_GUILD_ID: GUILD,
    ELEVENLABS_API_KEY: 'fictional-elevenlabs-key', ELEVENLABS_AGENT_ID: 'fictional-agent',
    JARVIS_VOICE_INPUT: 'elevenlabs-stt' });
  const logs: Record<string, unknown>[] = [];
  const bot = new JarvisBot(config, new Logger('info', line => logs.push(JSON.parse(line))));
  active.push(bot);
  const access = bot as unknown as Access;
  Object.assign(access.client, { user: { id: BOT } });
  vi.spyOn(access.client, 'destroy').mockResolvedValue(undefined);
  vi.spyOn(access.voice, 'leave').mockImplementation(() => undefined);
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready }, destroy: vi.fn(),
  }) as unknown as VoiceConnection;
  vi.spyOn(access.voice, 'join').mockResolvedValue(connection);
  vi.spyOn(access.voice, 'connection', 'get').mockReturnValue(connection);
  vi.spyOn(access.wake, 'detect').mockResolvedValue(true);
  const members = new Collection<string, GuildMember>();
  const guild = { id: GUILD, name: 'Servidor privado', members: { me: { id: BOT } } };
  const channel = { id: CHANNEL, name: 'Canal privado', guild, type: ChannelType.GuildVoice, full: false, members,
    send: vi.fn(async (_payload: { content: string }) => undefined), permissionsFor: () => ({ has: (permission: bigint) =>
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak].includes(permission) }) };
  const addMember = (id: string, name = 'Mesmo nome', isBot = false): GuildMember => {
    const member = { id, displayName: name, guild, user: { bot: isBot }, voice: { channel, channelId: CHANNEL } } as unknown as GuildMember;
    members.set(id, member); return member;
  };
  addMember(OWNER); addMember(GUEST); addMember(BOT, 'Jarvis', true);
  const interaction = (command: string, userId = OWNER, audio = false, group?: string) => {
    let deferred = false;
    const reply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    const followUp = vi.fn(async () => undefined);
    const input = { inCachedGuild: () => true, guildId: GUILD, guild, user: { id: userId }, member: members.get(userId),
      options: { getSubcommand: () => command, getSubcommandGroup: () => group,
        getString: () => privateText, getBoolean: () => audio },
      get deferred() { return deferred; }, replied: false, reply, editReply, followUp,
      deferReply: vi.fn(async () => { deferred = true; }) };
    return { run: () => access.handle(input as unknown as ChatInputCommandInteraction), reply, editReply, followUp };
  };
  await interaction('join').run();
  expect(access.room).toBeDefined();
  const room = access.room!;
  (Reflect.get(room.sessions, 'options') as SessionOptions).pace = async () => undefined;
  let captureSequence = 0;
  const voice = async (id: string) => {
    await hooks.receiver!.onTurn(id, Buffer.alloc(19_200, 12), { duringPlayback: false, captureMs: 100,
      endDetectionMs: 600, captureId: `window-${id}-${++captureSequence}` });
    await settle();
  };
  const ask = async (id = OWNER) => { const request = interaction('ask', id); await request.run(); await settle(); return request; };
  const complete = async (provider = hooks.providers.at(-1)!) => {
    provider.options.callbacks.onTextResponse?.({ eventId: 200 });
    await provider.options.callbacks.onAudio(Buffer.alloc(960, 3), 201);
    await provider.options.callbacks.onResponseComplete(202);
    await settle();
  };
  const participants = async (provider = hooks.providers.at(-1)!): Promise<VoiceParticipantsResult> =>
    await provider.options.tools!('get_voice_participants', {}, new AbortController().signal) as VoiceParticipantsResult;
  return { bot, access, logs, room, members, channel, connection, addMember, interaction, voice, ask, complete, participants };
}

beforeEach(() => {
  hooks.providers.length = 0; hooks.streams.length = 0;
  hooks.receiver = undefined; hooks.autoRecognize = true; hooks.beforeConnect = undefined;
  hooks.connect.mockClear(); hooks.runtime.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected_network_access'); }));
});
afterEach(async () => {
  for (const bot of active.splice(0)) await bot.stop();
  await settle(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('V5 Discord integration with the real per-speaker session manager', () => {
  test('owner text and guest microphone inject all variables without display-name authority or last-writer identity', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER).run();
    await h.interaction('consent', GUEST, true).run();
    await h.ask(OWNER);
    const owner = hooks.providers[0]!;
    expect(owner.options.dynamicVariables).toMatchObject({ speaker_name: 'Mesmo nome', speaker_is_creator: true,
      active_game: 'não informado', room_context: expect.stringContaining('Canal privado') });
    expect((await h.participants(owner)).current_speaker?.is_creator).toBe(true);
    await h.complete(owner);
    await h.voice(GUEST);
    const guest = hooks.providers[1]!;
    expect(guest.options.dynamicVariables).toMatchObject({ speaker_name: 'Mesmo nome', speaker_is_creator: false,
      active_game: 'não informado', room_context: expect.any(String) });
    expect(guest.session.sendAudio).toHaveBeenCalled();
    expect(guest.audio.length).toBe(45); // Five captured 20 ms frames followed by the preserved 800 ms VAD tail.
    expect((await h.participants(guest)).current_speaker).toMatchObject({ display_name: 'Mesmo nome', is_creator: false });
    await h.complete(guest);
    expect(hooks.streams.map(stream => stream.userId)).toEqual([OWNER, GUEST]);
    expect(hooks.streams.every(stream => stream.pcm.length === 1)).toBe(true);
    const identity = h.logs.filter(line => line.event === 'jarvis_identity_injected');
    expect(identity).toMatchObject([
      { input_kind: 'text', identity_is_creator: true, session_reused: false, identity_injected: true },
      { input_kind: 'voice', identity_is_creator: false, session_reused: false, identity_injected: true },
    ]);
    expect(h.access.metrics.snapshot()).toMatchObject({ identity_text_turns: 1, identity_voice_turns: 1,
      identity_creator_turns: 1, identity_guest_turns: 1, agent_user_turns_recognized: 1 });
    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toMatch(/conteúdo privado|Mesmo nome|Canal privado|Servidor privado/);
    expect(serialized).not.toContain(OWNER); expect(serialized).not.toContain(GUEST);
  });

  test('participant tool follows live channel membership, includes bots and requires no other user audio consent', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER).run(); // Guest is present with no consent at all.
    await h.ask();
    const first = await h.participants();
    expect(first.available).toBe(true);
    expect(first.participants).toHaveLength(3);
    expect(first.participants.find(member => member.is_bot)?.display_name).toBe('Jarvis');
    h.addMember(OBSERVER, 'Observador');
    expect((await h.participants()).participants).toHaveLength(4);
    h.members.delete(GUEST);
    const afterLeave = await h.participants();
    expect(afterLeave.participants).toHaveLength(3);
    expect(afterLeave.participants.map(member => member.display_name)).toContain('Observador');
    expect(Object.keys(afterLeave.current_speaker!)).toEqual(['display_name', 'is_creator', 'present', 'is_bot']);
    expect(JSON.stringify(afterLeave)).not.toMatch(/100000000000000|consent|profile|guildId|channelId/);
  });

  test('sender consent is required before text or voice can open a paid session', async () => {
    const h = await setup();
    const denied = await h.ask(GUEST);
    expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('/jarvis consent') }));
    await h.voice(GUEST);
    expect(hooks.connect).not.toHaveBeenCalled();
    expect(h.access.wake.detect).not.toHaveBeenCalled();
  });

  test('joining, consenting, revoking and leaving affect only the authenticated participant', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER, true).run();
    const ownerConsent = h.room.consent.get(OWNER)!;
    h.addMember(OBSERVER);
    h.access.client.emit('voiceStateUpdate', { guild: { id: GUILD }, channelId: null } as never,
      { id: OBSERVER, guild: { id: GUILD }, channelId: CHANNEL } as never);
    expect(h.room.consent.get(OWNER)).toBe(ownerConsent);
    expect(hooks.receiver!.canReceive(OWNER)).toBe(true);
    expect(hooks.receiver!.canReceive(GUEST)).toBe(false);
    expect(hooks.receiver!.canReceive(OBSERVER)).toBe(false);
    await h.voice(GUEST); await h.voice(OWNER);
    expect(hooks.providers).toHaveLength(1);
    expect(hooks.providers[0]!.options.dynamicVariables?.speaker_is_creator).toBe(true);
    await h.complete();
    await h.interaction('consent', GUEST, true).run();
    expect(hooks.receiver!.canReceive(OWNER)).toBe(true);
    expect(hooks.receiver!.canReceive(GUEST)).toBe(true);
    await h.interaction('revoke', GUEST).run();
    expect(hooks.receiver!.canReceive(GUEST)).toBe(false);
    expect(h.room.consent.get(OWNER)).toBe(ownerConsent);
    await h.interaction('consent', GUEST, true).run();
    h.members.delete(GUEST);
    h.access.client.emit('voiceStateUpdate', { guild: { id: GUILD }, channelId: CHANNEL } as never,
      { id: GUEST, guild: { id: GUILD }, channelId: null } as never);
    expect(h.room.consent.get(GUEST)).toBeUndefined();
    expect(h.room.consent.get(OWNER)).toBe(ownerConsent);
    h.addMember(GUEST);
    expect(hooks.receiver!.canReceive(GUEST)).toBe(false);
    await h.ask(OWNER);
    expect(hooks.providers.at(-1)!.session.sendText).toHaveBeenCalledWith(privateText);
  });

  test('transient transport loss keeps individual consent, whereas destruction requires renewed authorization', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER, true).run(); await h.interaction('consent', GUEST, true).run();
    const ownerConsent = h.room.consent.get(OWNER)!;
    const guestConsent = h.room.consent.get(GUEST)!;
    await h.ask(OWNER);
    const original = hooks.providers[0]!;
    const transition = (status: VoiceConnectionStatus) => {
      const before = h.connection.state;
      Object.assign(h.connection, { state: { status } }); h.connection.emit('stateChange', before, h.connection.state);
    };
    transition(VoiceConnectionStatus.Disconnected); await settle();
    expect(original.session.close).toHaveBeenCalled();
    expect(h.access.room).toBe(h.room);
    expect(h.room.consent.get(OWNER)).toBe(ownerConsent);
    expect(h.room.consent.get(GUEST)).toBe(guestConsent);
    transition(VoiceConnectionStatus.Ready);
    await h.ask(GUEST);
    expect(hooks.providers).toHaveLength(2);
    expect(hooks.providers[1]!.options.dynamicVariables?.speaker_is_creator).toBe(false);
    transition(VoiceConnectionStatus.Destroyed); await settle();
    expect(h.access.room).toBeUndefined();
    expect(h.room.consent.get(OWNER)).toBeUndefined(); expect(h.room.consent.get(GUEST)).toBeUndefined();
    expect(h.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringMatching(/\/jarvis join.*\/jarvis consent/), allowedMentions: { parse: [] },
    }));
  });

  test('provider idle expiry leaves Discord and consent available for a fresh question', async () => {
    vi.useFakeTimers();
    const h = await setup();
    await h.interaction('consent', OWNER, true).run();
    const consent = h.room.consent.get(OWNER)!;
    await h.ask(OWNER); await h.complete();
    const original = hooks.providers[0]!;
    await vi.advanceTimersByTimeAsync(46_000); await settle();
    expect(original.session.close).toHaveBeenCalled();
    expect(h.access.room).toBe(h.room);
    expect(h.room.consent.get(OWNER)).toBe(consent);
    expect(h.connection.destroy).not.toHaveBeenCalled();
    expect(hooks.receiver!.canReceive(OWNER)).toBe(true);
    await h.ask(OWNER);
    expect(hooks.providers).toHaveLength(2);
    expect(hooks.providers[1]!.session.sendText).toHaveBeenCalledWith(privateText);
  });

  test('repeated delivery of one capture enqueues and notifies exactly once', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER).run(); await h.interaction('consent', GUEST, true).run();
    await h.ask(OWNER);
    const timing = { duringPlayback: false, captureMs: 100, endDetectionMs: 600, captureId: 'same-local-capture' };
    const pcm = Buffer.alloc(19_200, 12);
    await hooks.receiver!.onTurn(GUEST, pcm, timing); await hooks.receiver!.onTurn(GUEST, pcm, timing); await settle();
    expect(h.room.sessions.queuedCount).toBe(1);
    expect(h.channel.send.mock.calls.filter(([payload]) => String(payload.content).includes('enfileirada'))).toHaveLength(1);
    await h.complete();
    expect(hooks.providers).toHaveLength(2);
  });

  test.each([
    { error: new WakeError('wake_rate_limited'), reason: 'wake_rate_limited' },
    { error: new WakeError('wake_queue_full'), reason: 'wake_queue_full' },
    { error: new WakeError('wake_queue_timeout'), reason: 'wake_queue_timeout' },
    { error: new WakeError('wake_provider_failed'), reason: 'wake_provider_failed' },
    { error: new SessionError('busy', 'wake_check_busy'), reason: 'wake_check_busy' },
    { error: new SessionError('limit', 'wake_capacity'), reason: 'wake_capacity' },
    { error: new SessionError('limit', 'queue_full'), reason: 'queue_full' },
    { error: new SessionError('closed', 'voice_unavailable'), reason: 'voice_unavailable' },
    { error: new SessionError('consent', 'consent_invalid'), reason: 'consent_invalid' },
  ])('voice rejection $reason has a sanitized operational category', async ({ error, reason }) => {
    const h = await setup(); await h.interaction('consent', OWNER, true).run();
    vi.spyOn(h.room.sessions, 'voiceTurn').mockRejectedValueOnce(error);
    await h.voice(OWNER);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'jarvis_voice_turn_rejected',
      rejection_reason: reason, voice_status: 'ready', queue_depth: 0, incident: expect.stringMatching(/^[A-F0-9]{8}$/) }));
    expect(JSON.stringify(h.logs)).not.toMatch(/conteúdo privado|Mesmo nome|100000000000000/);
  });

  test('tools are denied before a turn begins, before final voice ASR, and on idle sockets', async () => {
    const h = await setup();
    await h.interaction('consent', GUEST, true).run();
    const early: unknown[] = [];
    hooks.beforeConnect = async options => {
      try { await options.tools!('get_voice_participants', {}, new AbortController().signal); }
      catch (error) { early.push(error); }
    };
    hooks.autoRecognize = false;
    await h.voice(GUEST);
    const guest = hooks.providers[0]!;
    expect(early).toHaveLength(1);
    expect(early[0]).toBeInstanceOf(AuthorizationError);
    await expect(h.participants(guest)).rejects.toBeInstanceOf(AuthorizationError);
    guest.options.callbacks.onUserTranscript?.({ eventId: 300 });
    expect((await h.participants(guest)).current_speaker?.is_creator).toBe(false);
    await h.complete(guest);
    await expect(h.participants(guest)).rejects.toBeInstanceOf(AuthorizationError);
  });

  test.each(['revoke', 'cancel', 'disconnect', 'destroy', 'move', 'tool_abort'] as const)(
    'old tool closures fail closed after %s', async (reason) => {
      const h = await setup();
      await h.interaction('consent', OWNER, true).run();
      await h.ask();
      const original = hooks.providers[0]!;
      expect((await h.participants(original)).available).toBe(true);
      const toolAbort = new AbortController();
      if (reason === 'revoke' || reason === 'cancel') await h.interaction(reason).run();
      if (reason === 'disconnect' || reason === 'destroy') {
        const previous = h.connection.state;
        Object.assign(h.connection, { state: { status: reason === 'disconnect'
          ? VoiceConnectionStatus.Disconnected : VoiceConnectionStatus.Destroyed } });
        h.connection.emit('stateChange', previous, h.connection.state);
      }
      if (reason === 'move') {
        h.members.delete(OWNER);
        h.access.client.emit('voiceStateUpdate', { guild: { id: GUILD }, channelId: CHANNEL } as never,
          { id: OWNER, guild: { id: GUILD }, channelId: 'other' } as never);
      }
      if (reason === 'tool_abort') toolAbort.abort();
      await expect(original.options.tools!('get_voice_participants', {}, toolAbort.signal)).rejects.toBeInstanceOf(AuthorizationError);
    },
  );

  test('unknown tools cannot grant authority and missing Brave key does not perform or invent a search', async () => {
    const h = await setup();
    await h.interaction('consent', GUEST).run();
    await h.ask(GUEST);
    const tools = hooks.providers[0]!.options.tools!;
    await expect(tools('grant_admin', { user_id: OWNER }, new AbortController().signal)).rejects.toBeInstanceOf(AuthorizationError);
    const search = await tools('search_game_info', { game: 'Game', query: 'Update' }, new AbortController().signal) as {
      sources: unknown[]; uncertainty: string;
    };
    expect(search.sources).toEqual([]);
    expect(search.uncertainty).toMatch(/chave|configurad/i);
    const turn = h.logs.find(event => event.event === 'jarvis_agent_turn_started')!;
    expect(h.logs.filter(event => event.event === 'jarvis_search_result')).toEqual([
      expect.objectContaining({ incident: turn.incident, search_status: 'missing_key', source_count: 0 }),
    ]);
    expect(JSON.stringify(h.logs)).not.toMatch(/fictional-elevenlabs-key|conteúdo privado|"game"|"query"/);
    await expect(tools('search_game_info', { game: 'Game', query: 'Update', user_id: OWNER },
      new AbortController().signal)).rejects.toThrow('tool_parameters');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('reused owner session refreshes current names and context, preserving correlated identity metrics', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER, true).run();
    await h.ask();
    const owner = hooks.providers[0]!;
    await h.complete(owner);
    Object.assign(h.members.get(OWNER)!, { displayName: 'Novo nome' });
    h.channel.name = 'Outra sala nomeada';
    await h.ask();
    expect(hooks.connect).toHaveBeenCalledOnce();
    expect(owner.session.sendContext).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Novo nome'));
    expect(owner.session.sendContext).toHaveBeenCalledWith(expect.stringContaining('Outra sala nomeada'));
    expect((await h.participants(owner)).current_speaker?.display_name).toBe('Novo nome');
    const logs = h.logs.filter(line => line.event === 'jarvis_identity_injected');
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ input_kind: 'text', session_reused: true, identity_injected: true });
    expect(logs[1]!.incident).not.toBe(logs[0]!.incident);
    expect(h.access.metrics.snapshot()).toMatchObject({ identity_text_turns: 2, agent_session_reused: 1 });
  });

  test('late connection stage keeps its opening incident after cancellation and replacement', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER).run();
    let release!: () => void;
    const opening = new Promise<void>(resolve => { release = resolve; });
    hooks.beforeConnect = async options => {
      if (hooks.providers.length !== 1) return;
      await opening;
      options.onConnectionStage?.({ stage: 'signed_url', durationMs: 12 });
    };
    await h.ask();
    const original = h.logs.find(line => line.event === 'jarvis_turn_queue_changed')!.incident;
    await h.interaction('cancel').run();
    await h.ask();
    release(); await settle();
    expect(h.logs.find(line => line.event === 'jarvis_agent_connection_stage')).toMatchObject({
      incident: original, connection_stage: 'signed_url', duration_ms: 12,
    });
    expect(hooks.providers).toHaveLength(2);
  });

  test('new owner socket restores actual delivered context while the guest socket receives none of it', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER).run(); await h.interaction('consent', GUEST).run();
    await h.ask(OWNER);
    const first = hooks.providers[0]!;
    first.options.callbacks.onTextResponse?.({ eventId: 200 });
    first.options.callbacks.onConversationText?.({ kind: 'agent_final', text: 'A arma é a Lua Lunar.', truncated: false, eventId: 200 });
    await h.complete(first);
    first.options.callbacks.onClose(); await settle();
    await h.ask(OWNER);
    const second = hooks.providers[1]!;
    expect(second.session.sendContext).toHaveBeenCalledWith(expect.stringContaining('Lua Lunar'));
    expect(second.session.sendContext).toHaveBeenCalledWith(expect.stringContaining(privateText));
    await h.complete(second);
    await h.ask(GUEST);
    const guest = hooks.providers[2]!;
    expect(guest.session.sendContext).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify(h.logs);
    expect(serializedLogs).not.toMatch(/Lua Lunar|conteúdo privado|Mesmo nome/);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'jarvis_short_context', context_injected: true, context_items: 1 }));
  });

  test('context status and clear are private, scoped to the invoking account and fence late output', async () => {
    const h = await setup();
    await h.interaction('consent', OWNER).run(); await h.interaction('consent', GUEST).run();
    await h.ask(OWNER); await h.complete();
    await h.ask(GUEST); await h.complete();
    const owner = hooks.providers[0]!;
    const status = h.interaction('status', OWNER, false, 'context');
    await status.run();
    expect(status.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: 64,
      content: expect.stringContaining('1 interações suas'), allowedMentions: { parse: [] } }));
    const clear = h.interaction('clear', OWNER, false, 'context'); await clear.run();
    expect(clear.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: 64, content: expect.stringContaining('apagado') }));
    owner.options.callbacks.onConversationText?.({ kind: 'agent_final', text: 'Saída tardia', truncated: false });
    await owner.options.callbacks.onResponseComplete(999); await settle();
    const afterClear = h.interaction('status', OWNER, false, 'context'); await afterClear.run();
    expect(afterClear.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('0 interações suas') }));
    const guestStatus = h.interaction('status', GUEST, false, 'context'); await guestStatus.run();
    expect(guestStatus.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('1 interações suas') }));
    expect(h.room.consent.get(OWNER)).toBeDefined();
    expect(JSON.stringify(h.logs)).not.toContain('Saída tardia');
  });
});
