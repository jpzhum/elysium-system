import { EventEmitter } from 'node:events';
import { ChannelType, Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type Client } from 'discord.js';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { JarvisBot } from '../src/discord/bot.js';
import type { VoiceConnectionManager } from '../src/discord/voice-connection.js';
import { loadConfig } from '../src/config.js';
import { DiagnosticError } from '../src/observability/diagnostics.js';
import { Logger } from '../src/observability/metrics.js';
import type { AgentCallbacks, ConnectAgentOptions } from '../src/agents/elevenlabs-client.js';

const hooks = vi.hoisted(() => ({
  runtime: vi.fn(async () => undefined),
  playbackError: undefined as unknown,
  receiverError: undefined as unknown,
  playbackStop: vi.fn(), receiverStop: vi.fn(),
  agentConnect: vi.fn(async (_options: ConnectAgentOptions) => ({ inputSampleRate: 16000, outputSampleRate: 24000,
    sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn() })),
}));
vi.mock('../src/agents/elevenlabs-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agents/elevenlabs-client.js')>(), connectAgent: hooks.agentConnect,
}));
vi.mock('../src/observability/voice-runtime.js', () => ({ inspectVoiceRuntime: hooks.runtime }));
vi.mock('../src/audio/playback.js', async (original) => ({
  ...await original<typeof import('../src/audio/playback.js')>(), PlaybackQueue: class {
  isPlaying = false;
  constructor() { if (hooks.playbackError) throw hooks.playbackError; }
  play = vi.fn(async () => undefined);
  stopUser = vi.fn();
  stop = hooks.playbackStop;
} }));
vi.mock('../src/discord/voice-receiver.js', () => ({ VoiceReceiver: class {
  start() { if (hooks.receiverError) throw hooks.receiverError; }
  stopUser = vi.fn();
  stop = hooks.receiverStop;
} }));

interface Access {
  client: Client;
  voice: VoiceConnectionManager;
  room?: unknown;
  joining: boolean;
  handle(interaction: ChatInputCommandInteraction): Promise<void>;
}
const active: JarvisBot[] = [];
const privateText = 'PRIVATE_TOKEN=https://private.invalid/signed?token=SECRET';

function setup(environment: Record<string, string> = {}) {
  const config = loadConfig({ JARVIS_DISCORD_TOKEN: 'fictional-discord-token-for-tests',
    JARVIS_OWNER_USER_ID: '100000000000000001', JARVIS_GUILD_ID: '100000000000000002', ...environment }, true);
  const logs: Record<string, unknown>[] = [];
  const bot = new JarvisBot(config, new Logger('info', (line) => logs.push(JSON.parse(line))));
  active.push(bot);
  const access = bot as unknown as Access;
  Object.assign(access.client, { user: { id: '100000000000000003' } });
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready }, destroy: vi.fn(),
  }) as unknown as VoiceConnection;
  const join = vi.spyOn(access.voice, 'join').mockResolvedValue(connection);
  vi.spyOn(access.voice, 'connection', 'get').mockReturnValue(connection);
  const leave = vi.spyOn(access.voice, 'leave').mockImplementation(() => undefined);
  const permissions = new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]);
  const channel = { id: '100000000000000004', type: ChannelType.GuildVoice, full: false,
    name: privateText, guild: { name: privateText }, members: new Collection(),
    permissionsFor: () => ({ has: (flag: bigint) => permissions.has(flag) }),
  };
  const fetchMe = vi.fn(async () => ({ id: '100000000000000003' }));
  let deferred = false;
  const reply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const deferReply = vi.fn(async () => { deferred = true; });
  const input = {
    inCachedGuild: () => true, guildId: config.JARVIS_GUILD_ID,
    options: { getSubcommand: () => 'join' }, user: { id: config.JARVIS_OWNER_USER_ID },
    member: { voice: { channel } }, guild: { members: { me: null, fetchMe } },
    get deferred() { return deferred; }, replied: false, deferReply, reply, editReply, followUp,
  };
  const run = () => access.handle(input as unknown as ChatInputCommandInteraction);
  const failure = () => {
    const failures = logs.filter((line) => line.event === 'jarvis_command_failed');
    expect(failures).toHaveLength(1);
    const entry = failures[0]!;
    expect(entry.incident).toMatch(/^[A-F0-9]{8}$/);
    expect(entry.command).toBe('join');
    expect(entry.level).toBe('error');
    expect(entry.duration_ms).toEqual(expect.any(Number));
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('PRIVATE_TOKEN');
    expect(serialized).not.toContain('private.invalid');
    expect(serialized).not.toContain('100000000000000001');
    const responses = [...reply.mock.calls, ...editReply.mock.calls, ...followUp.mock.calls];
    if (responses.length) expect(JSON.stringify(responses)).toContain(entry.incident);
    return entry;
  };
  return { bot, access, logs, config, connection, join, leave, input, channel, permissions,
    fetchMe, deferReply, reply, editReply, followUp, run, failure };
}

beforeEach(() => {
  hooks.runtime.mockReset().mockResolvedValue(undefined);
  hooks.playbackError = undefined;
  hooks.receiverError = undefined;
  hooks.playbackStop.mockClear();
  hooks.receiverStop.mockClear();
  hooks.agentConnect.mockClear();
});

test.each([undefined, 'false'])('Discord sessions pass the configured first-message policy: %s', async (setting) => {
  const h = setup(setting ? { JARVIS_SUPPRESS_FIRST_MESSAGE: setting } : {});
  await h.run();
  const room = h.access.room as { sessions: object };
  const options = Reflect.get(room.sessions, 'options') as {
    connect: (speaker: object, callbacks: AgentCallbacks, signal: AbortSignal) => Promise<unknown>;
  };
  const callbacks: AgentCallbacks = { onAudio: () => {}, onResponseComplete: () => {}, onInterruption: () => {},
    onClose: () => {}, onError: () => {} };
  await options.connect({ discordUserId: 'guest', displayName: 'guest', isOwner: false }, callbacks, new AbortController().signal);
  expect(hooks.agentConnect).toHaveBeenCalledOnce();
  expect(hooks.agentConnect.mock.calls[0]![0]).toMatchObject({ suppressFirstMessage: setting !== 'false', callbacks });
});
afterEach(async () => {
  for (const bot of active.splice(0)) await bot.stop();
  vi.restoreAllMocks();
});

test('owner denial has a correlated authorization diagnostic before acknowledgement', async () => {
  const h = setup();
  h.input.user.id = '100000000000000099';
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'authorize', category: 'authorization', code: 'ACCESS_DENIED' });
  expect(h.deferReply).not.toHaveBeenCalled();
  expect(h.join).not.toHaveBeenCalled();
});
test('failed interaction acknowledgement preserves its sanitized Discord error', async () => {
  const h = setup();
  h.deferReply.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 10062 }));
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'interaction_ack', category: 'discord', code: 'INTERACTION_EXPIRED' });
  expect(h.join).not.toHaveBeenCalled();
});
test('no voice channel identifies channel lookup instead of guessing a DAVE failure', async () => {
  const h = setup();
  Object.assign(h.input.member.voice, { channel: null });
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'channel_lookup', category: 'channel', code: 'CHANNEL_NOT_FOUND' });
  expect(h.join).not.toHaveBeenCalled();
});
test('member REST lookup errors are classified before permission checks', async () => {
  const h = setup();
  h.fetchMe.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 50001 }));
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'member_fetch', category: 'permissions', code: 'DISCORD_MISSING_ACCESS' });
  expect(h.join).not.toHaveBeenCalled();
});
test.each([
  [PermissionFlagsBits.ViewChannel, 'permission_view'],
  [PermissionFlagsBits.Connect, 'permission_connect'],
  [PermissionFlagsBits.Speak, 'permission_speak'],
] as const)('missing permission %s logs boolean preflight and never attempts voice', async (permission, field) => {
  const h = setup();
  h.permissions.delete(permission);
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'permissions', category: 'permissions', code: 'DISCORD_MISSING_PERMISSIONS', [field]: false });
  expect(h.join).not.toHaveBeenCalled();
  expect(hooks.runtime).not.toHaveBeenCalled();
});
test('full voice channel is distinct from missing Connect permission', async () => {
  const h = setup();
  h.channel.full = true;
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'channel_capacity', category: 'channel', code: 'CHANNEL_FULL', permission_full: true });
  expect(h.join).not.toHaveBeenCalled();
});
test('native DAVE probe failure is visible and prevents a doomed network connection', async () => {
  const h = setup();
  hooks.runtime.mockRejectedValueOnce(new DiagnosticError('dependency', 'NATIVE_BINDING_UNAVAILABLE'));
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'runtime_probe', category: 'dependency', code: 'NATIVE_BINDING_UNAVAILABLE' });
  expect(h.join).not.toHaveBeenCalled();
});
test('voice join transport error is reported with original classified cause', async () => {
  const h = setup();
  h.join.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 'ECONNRESET' }));
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'voice_connect', category: 'network', code: 'ECONNRESET' });
  expect(h.access.joining).toBe(false);
});
test('playback setup failure is distinguished from negotiation and closes the owned connection', async () => {
  const h = setup();
  hooks.playbackError = new Error(privateText);
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'playback_setup', category: 'unknown', code: 'UNKNOWN' });
  // One leave clears the previous room; the other releases the failed setup's connection.
  expect(h.leave).toHaveBeenCalledTimes(2);
  expect(h.access.room).toBeUndefined();
});
test('receiver start failure disposes every partially initialized resource', async () => {
  const h = setup();
  hooks.receiverError = new Error(privateText);
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'receiver_setup', category: 'unknown', code: 'UNKNOWN' });
  expect(hooks.receiverStop).toHaveBeenCalled();
  expect(hooks.playbackStop).toHaveBeenCalled();
  expect(h.leave).toHaveBeenCalledTimes(2);
  expect(h.access.room).toBeUndefined();
});
test('failure sending the success notice has its own stage and does not destroy a healthy room', async () => {
  const h = setup();
  h.editReply.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 10062 }));
  await h.run();
  expect(h.failure()).toMatchObject({ stage: 'join_reply', category: 'discord', code: 'INTERACTION_EXPIRED' });
  expect(h.access.room).toBeDefined();
  expect(h.leave).toHaveBeenCalledTimes(1);
});
test('successful join logs its complete stage and all events share one incident', async () => {
  const h = setup();
  await h.run();
  expect(h.logs.some((line) => line.event === 'jarvis_command_failed')).toBe(false);
  const success = h.logs.find((line) => line.event === 'jarvis_join_succeeded');
  expect(success).toMatchObject({ stage: 'join_complete', command: 'join', duration_ms: expect.any(Number) });
  expect(new Set(h.logs.map((line) => line.incident)).size).toBe(1);
  expect(h.access.room).toBeDefined();
});
