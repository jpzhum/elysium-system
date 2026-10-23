import { VoiceConnectionStatus } from '@discordjs/voice';
import type { ChatInputCommandInteraction } from 'discord.js';
import { afterEach, expect, test, vi } from 'vitest';
import { JarvisBot } from '../src/discord/bot.js';
import { loadConfig } from '../src/config.js';
import { DiagnosticError } from '../src/observability/diagnostics.js';
import { Logger, type DiagnosticFields } from '../src/observability/metrics.js';
import { SessionError } from '../src/agents/session-manager.js';
import { ConsentStore } from '../src/policy/consent.js';
import type { PlaybackStreamOptions } from '../src/audio/playback.js';

const provider = vi.hoisted(() => vi.fn());
vi.mock('../src/agents/elevenlabs-client.js', async (original) => ({
  ...await original<typeof import('../src/agents/elevenlabs-client.js')>(), connectAgent: provider,
}));
const OWNER = '100000000000000001';
const GUILD = '100000000000000002';
const CHANNEL = '100000000000000003';
const PRIVATE = 'PRIVATE https://signed.invalid/?token=SECRET';
const cleanup: (() => Promise<void>)[] = [];

function setup(command = 'tone', smoke = true) {
  // The supported DAVE probe starts with no ElevenLabs keys at all.
  const config = loadConfig({ JARVIS_DISCORD_TOKEN: 'fictional-discord-token-for-command-tests', JARVIS_OWNER_USER_ID: OWNER, JARVIS_GUILD_ID: GUILD,
    ...(!smoke ? { ELEVENLABS_API_KEY: 'fictional-key', ELEVENLABS_AGENT_ID: 'fictional-agent' } : {}) }, smoke);
  const logs: Record<string, unknown>[] = [];
  const bot = new JarvisBot(config, new Logger('info', line => logs.push(JSON.parse(line))));
  const play = vi.fn(async (_id: string, _pcm: Buffer, _rate: number, _owner: boolean, _options?: PlaybackStreamOptions) => undefined);
  const ask = vi.fn(async () => { throw new SessionError('limit', 'queue_full'); });
  const consent = new ConsentStore();
  consent.grant(OWNER, false);
  const channel = { id: CHANNEL };
  const room = { channel, playback: { play }, consent, sessions: { ask } };
  Reflect.set(bot, 'room', room);
  const client = Reflect.get(bot, 'client') as { destroy(): Promise<void> };
  vi.spyOn(client, 'destroy').mockResolvedValue(undefined);
  const voice = Reflect.get(bot, 'voice') as { readonly connection: unknown };
  vi.spyOn(voice, 'connection', 'get').mockReturnValue({ state: { status: VoiceConnectionStatus.Ready } });
  cleanup.push(async () => { Reflect.set(bot, 'room', undefined); await bot.stop(); });
  let deferred = false;
  const input = {
    inCachedGuild: () => true, guildId: GUILD, user: { id: OWNER },
    member: { id: OWNER, displayName: PRIVATE, guild: { id: GUILD }, voice: { channelId: CHANNEL } },
    options: { getSubcommand: () => command, getString: () => PRIVATE },
    get deferred() { return deferred; }, replied: false,
    deferReply: vi.fn(async () => { deferred = true; }),
    reply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined),
  };
  const run = () => (Reflect.get(bot, 'handle') as (i: ChatInputCommandInteraction) => Promise<void>)
    .call(bot, input as unknown as ChatInputCommandInteraction);
  return { config, logs, play, ask, input, run };
}

afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  provider.mockClear();
  vi.restoreAllMocks();
});

test('tone plays one second of synthetic PCM without ElevenLabs or consent audio', async () => {
  const h = setup();
  expect(h.config.ELEVENLABS_API_KEY).toBeUndefined();
  let energy = 0;
  h.play.mockImplementationOnce(async (_id, pcm, rate, owner) => {
    expect(rate).toBe(48_000); expect(owner).toBe(true); expect(pcm.length).toBe(96_000);
    energy = pcm.reduce((sum, value) => sum + value, 0);
  });
  await h.run();
  expect(energy).toBeGreaterThan(0);
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.play.mock.calls[0]![1].every(value => value === 0)).toBe(true);
  expect(provider).not.toHaveBeenCalled();
  expect(h.input.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Tom reproduzido') }));
});

test.each([
  ['playback', 'PLAYBACK_RESOURCE_ENDED'], ['playback', 'PLAYBACK_ENCODER_FAILED'],
  ['playback', 'PLAYBACK_PLAYER_ERROR'], ['voice', 'VOICE_DISCONNECTED'],
] as const)('tone preserves %s/%s and correlates playback, command and user incident', async (category, code) => {
  const h = setup();
  h.play.mockImplementationOnce(async (_id, _pcm, _rate, _owner, options) => {
    options?.onDiagnostic?.({ category, code, playback_stage: 'player', player_status: 'buffering',
      voice_status: 'ready', subscribed: true, dave_ready: true, cause_code: 'ECONNRESET' });
    throw new DiagnosticError(category, code);
  });
  await h.run();
  const failures = h.logs.filter(line => line.event === 'jarvis_command_failed');
  expect(failures).toHaveLength(1);
  const failure = failures[0]!;
  expect(failure).toMatchObject({ command: 'tone', stage: 'playback', category, code,
    playback_stage: 'player', player_status: 'buffering', subscribed: true, dave_ready: true, cause_code: 'ECONNRESET' });
  expect(h.logs.find(line => line.event === 'jarvis_playback_failed')?.incident).toBe(failure.incident);
  expect(JSON.stringify(h.input.editReply.mock.calls)).toContain(failure.incident);
  expect(h.play.mock.calls[0]![1].every(value => value === 0)).toBe(true);
  expect(provider).not.toHaveBeenCalled();
});

test('unknown command exception logs fixed classification and no private message, stack or cause', async () => {
  const h = setup();
  h.play.mockRejectedValueOnce(Object.assign(new Error(PRIVATE, { cause: new Error(PRIVATE) }), { code: PRIVATE }));
  await h.run();
  expect(h.logs.find(line => line.event === 'jarvis_command_failed')).toMatchObject({ command: 'tone',
    stage: 'playback', category: 'unknown', code: 'UNKNOWN', duration_ms: expect.any(Number) });
  expect(JSON.stringify(h.logs)).not.toMatch(/PRIVATE|SECRET|signed\.invalid|100000000000000001/);
});

test('tone keeps a captured connection failure when subsequent cleanup rejects as cancelled', async () => {
  const h = setup();
  h.play.mockImplementationOnce(async (_id, _pcm, _rate, _owner, options) => {
    options?.onDiagnostic?.({ category: 'voice', code: 'VOICE_DISCONNECTED', voice_status: 'disconnected',
      playback_stage: 'connection', player_status: 'playing' });
    options?.onDiagnostic?.({ player_status: 'idle' });
    throw new Error('Reprodução cancelada.');
  });
  await h.run();
  const failure = h.logs.find(line => line.event === 'jarvis_command_failed')!;
  expect(failure).toMatchObject({ command: 'tone', category: 'voice', code: 'VOICE_DISCONNECTED',
    voice_status: 'disconnected', playback_stage: 'connection' });
  expect(h.logs.find(line => line.event === 'jarvis_playback_failed')?.incident).toBe(failure.incident);
});

test('acknowledgement failure identifies tone and skips playback', async () => {
  const h = setup();
  h.input.deferReply.mockRejectedValueOnce(Object.assign(new Error(PRIVATE), { code: 10062 }));
  await h.run();
  expect(h.logs.find(line => line.event === 'jarvis_command_failed')).toMatchObject({ command: 'tone',
    stage: 'interaction_ack', category: 'discord', code: 'INTERACTION_EXPIRED' });
  expect(h.play).not.toHaveBeenCalled();
});

test('a failed error response keeps the original command incident and reports its own code', async () => {
  const h = setup();
  h.play.mockRejectedValueOnce(new DiagnosticError('playback', 'PLAYBACK_PLAYER_ERROR'));
  h.input.editReply.mockRejectedValueOnce(Object.assign(new Error(PRIVATE), { code: 10062 }));
  await h.run();
  const failure = h.logs.find(line => line.event === 'jarvis_command_failed')!;
  expect(h.logs.find(line => line.event === 'interaction_response_failed')).toMatchObject({
    incident: failure.incident, command: 'tone', stage: 'command_reply', code: 'INTERACTION_EXPIRED',
  });
});

test('same channel failure and authorization denial get safe command metadata', async () => {
  const h = setup();
  h.input.member.voice.channelId = 'another-channel';
  await h.run();
  expect(h.logs.find(line => line.event === 'jarvis_command_failed')).toMatchObject({ command: 'tone',
    stage: 'channel_lookup', category: 'channel', code: 'SAME_CHANNEL_REQUIRED' });
  h.logs.length = 0;
  h.input.member.voice.channelId = CHANNEL;
  h.input.user.id = 'another-user';
  await h.run();
  expect(h.logs.find(line => line.event === 'jarvis_command_failed')).toMatchObject({ command: 'tone',
    stage: 'authorize', category: 'authorization', code: 'ACCESS_DENIED' });
});

test('ask queue rejection has command, category, safe code and exact execution stage', async () => {
  const h = setup('ask', false);
  await h.run();
  expect(h.ask).toHaveBeenCalledOnce();
  expect(h.logs.find(line => line.event === 'jarvis_command_failed')).toMatchObject({ command: 'ask',
    stage: 'turn_enqueue', category: 'runtime', code: 'USAGE_LIMIT' });
  expect(provider).not.toHaveBeenCalled();
});

test('logger accepts reviewed playback metadata and drops unreviewed values', () => {
  const records: Record<string, unknown>[] = [];
  const logger = new Logger('info', line => records.push(JSON.parse(line)));
  logger.event('jarvis_playback_failed', 'error', { command: 'tone', code: 'PLAYBACK_ENCODER_FAILED',
    cause_name: 'Error', opus_error_code: -1, playback_stage: 'opus_encode', resource_ended: false,
    subscribed: true, player_status: 'playing' });
  expect(records[0]).toMatchObject({ command: 'tone', code: 'PLAYBACK_ENCODER_FAILED', opus_error_code: -1 });
  logger.event('jarvis_playback_failed', 'error', { command: PRIVATE, code: PRIVATE,
    cause_code: PRIVATE, cause_name: PRIVATE, playback_stage: PRIVATE, player_status: PRIVATE,
    opus_error_code: -100, subscribed: PRIVATE, message: PRIVATE, stack: PRIVATE } as unknown as DiagnosticFields);
  expect(Object.keys(records[1]!)).toEqual(['time', 'level', 'event', 'incident']);
});
