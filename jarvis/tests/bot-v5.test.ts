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
import type { SessionManager, SessionOptions } from '../src/agents/session-manager.js';
import type { AgentSession, ConnectAgentOptions } from '../src/agents/elevenlabs-client.js';
import type { ElevenWakeDetector } from '../src/agents/wake-detector.js';
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
vi.mock('../src/audio/playback.js', () => ({ PlaybackQueue: class {
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
    send: vi.fn(async () => undefined), permissionsFor: () => ({ has: (permission: bigint) =>
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
  await settle(); vi.restoreAllMocks(); vi.unstubAllGlobals();
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
