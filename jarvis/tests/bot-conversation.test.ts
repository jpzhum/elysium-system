import { Collection, type ChatInputCommandInteraction, type Client, type GuildMember } from 'discord.js';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { JarvisBot } from '../src/discord/bot.js';
import type { VoiceConnectionManager } from '../src/discord/voice-connection.js';
import type { ElevenWakeDetector, WakeInspection } from '../src/agents/wake-detector.js';
import type { TurnNotification, TurnReceipt } from '../src/agents/session-manager.js';
import type { SpeakerContext } from '../src/policy/identity.js';
import { ConsentStore } from '../src/policy/consent.js';
import { Logger } from '../src/observability/metrics.js';

const OWNER = '100000000000000001';
const GUEST = '100000000000000002';
const GUILD = '100000000000000003';
const CHANNEL = '100000000000000004';
const active: JarvisBot[] = [];

interface Access {
  readonly client: Client;
  readonly voice: VoiceConnectionManager;
  readonly wake: ElevenWakeDetector;
  room?: unknown;
  handle(interaction: ChatInputCommandInteraction): Promise<void>;
  reset(): void;
  revoke(room: unknown, userId: string): void;
  voiceInterruption(room: unknown, member: GuildMember, pcm: Buffer, playbackToken?: number): Promise<void>;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(bargeIn = true) {
  const config = loadConfig({
    JARVIS_DISCORD_TOKEN: 'fictional-discord-token-without-network-access',
    JARVIS_OWNER_USER_ID: OWNER, JARVIS_GUILD_ID: GUILD,
    ELEVENLABS_API_KEY: 'fictional-elevenlabs-key', ELEVENLABS_AGENT_ID: 'fictional-agent',
    JARVIS_VOICE_INPUT: 'elevenlabs-stt', JARVIS_BARGE_IN_ENABLED: String(bargeIn),
  });
  const logs: string[] = [];
  const bot = new JarvisBot(config, new Logger('info', line => logs.push(line)));
  active.push(bot);
  const access = bot as unknown as Access;
  Object.assign(access.client, { user: { id: '100000000000000005' } });
  vi.spyOn(access.client, 'destroy').mockResolvedValue(undefined);
  vi.spyOn(access.voice, 'leave').mockImplementation(() => undefined);
  vi.spyOn(access.voice, 'connection', 'get').mockReturnValue({
    state: { status: VoiceConnectionStatus.Ready },
  } as VoiceConnection);
  const members = new Collection<string, GuildMember>();
  for (const id of [OWNER, GUEST]) members.set(id, {
    id, displayName: 'Participante de teste', user: { bot: false }, guild: { id: GUILD },
    voice: { channelId: CHANNEL },
  } as GuildMember);
  const consent = new ConsentStore();
  consent.grant(OWNER, true); consent.grant(GUEST, true);
  let notify: ((event: TurnNotification) => void | Promise<void>) | undefined;
  const ask = vi.fn(async (_speaker: SpeakerContext, _text: string,
    callback?: (event: TurnNotification) => void | Promise<void>): Promise<TurnReceipt> => {
    notify = callback;
    return { queued: true, position: 1, turnId: 'AABBCCDD' };
  });
  const room = {
    channel: { id: CHANNEL, members, send: vi.fn(async () => undefined) },
    consent,
    receiver: { stop: vi.fn(), stopUser: vi.fn() },
    playback: { stop: vi.fn(), stopUser: vi.fn(), currentStreamToken: 1, isAudible: true },
    sessions: {
      ask, activeCount: 1, queuedCount: 1,
      cancelUser: vi.fn(), revoke: vi.fn(), interruptOwner: vi.fn(),
      close: vi.fn(() => { void notify?.({ type: 'cancelled', reason: 'closed', turnId: 'AABBCCDD' }); }),
    },
    probe: new Map(), interruptions: new Map<string, AbortController>(),
    echo: { isLikelyEcho: vi.fn(() => false), clear: vi.fn() },
  };
  access.room = room;
  function interaction(command: string, userId = OWNER) {
    let deferred = false;
    const reply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
    const followUp = vi.fn(async () => undefined);
    const input = {
      inCachedGuild: () => true, guildId: GUILD, user: { id: userId }, member: members.get(userId),
      options: { getSubcommand: () => command, getString: () => 'conteúdo privado que não pode virar log',
        getBoolean: () => false },
      get deferred() { return deferred; }, replied: false, reply, editReply, followUp,
      deferReply: vi.fn(async () => { deferred = true; }),
    };
    return { input: input as unknown as ChatInputCommandInteraction, reply, editReply, followUp,
      run: () => access.handle(input as unknown as ChatInputCommandInteraction) };
  }
  return { bot, access, config, room, members, logs, interaction,
    emit: async (event: TurnNotification) => { await notify?.(event); await settle(); } };
}

afterEach(async () => {
  for (const bot of active.splice(0)) await bot.stop();
  await settle();
  vi.restoreAllMocks();
});

test('privacy handler discloses pre-wake and owner audio during playback when barge-in is enabled', async () => {
  const h = setup();
  const privacy = h.interaction('privacy');
  await privacy.run();
  expect(privacy.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('Durante respostas, somente o proprietário'),
    allowedMentions: { parse: [] },
  }));
  expect(JSON.stringify(privacy.reply.mock.calls)).toContain('inclusive antes da ativação');
});

test('cancel identifies the interaction user and preserves their consent', async () => {
  const h = setup();
  const prior = h.room.consent.get(GUEST);
  const cancel = h.interaction('cancel', GUEST);
  await cancel.run();
  expect(h.room.sessions.cancelUser).toHaveBeenCalledExactlyOnceWith(GUEST);
  expect(h.room.sessions.cancelUser).not.toHaveBeenCalledWith(OWNER);
  expect(h.room.consent.get(GUEST)).toBe(prior);
  expect(cancel.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('foram canceladas'),
  }));
});

test('queued question receives a terminal cancellation after room reset', async () => {
  const h = setup();
  const ask = h.interaction('ask', GUEST);
  await ask.run();
  expect(ask.editReply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('Pergunta enfileirada'),
  }));
  h.access.reset();
  await settle();
  expect(h.access.room).toBeUndefined();
  expect(ask.followUp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    content: expect.stringContaining('foi cancelada'), allowedMentions: { parse: [] },
  }));
  expect(h.logs.join('')).not.toContain('conteúdo privado');
});

test('queued question receives cancellation after the owner leaves', async () => {
  const h = setup();
  const ask = h.interaction('ask', GUEST);
  await ask.run();
  await h.interaction('leave').run();
  await settle();
  expect(ask.followUp).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('foi cancelada'),
  }));
});

test('a started notification from a discarded room is suppressed', async () => {
  const h = setup();
  const ask = h.interaction('ask');
  await ask.run();
  h.access.reset();
  await settle();
  ask.followUp.mockClear();
  await h.emit({ type: 'started', turnId: 'AABBCCDD' });
  expect(ask.followUp).not.toHaveBeenCalled();
});

test('an authenticated and consenting owner can stop output after an exact voice intent', async () => {
  const h = setup();
  const inspect = vi.spyOn(h.access.wake, 'inspect').mockResolvedValue({ activated: true, interrupt: true });
  await h.access.voiceInterruption(h.room, h.members.get(OWNER)!, Buffer.alloc(19_200), 1);
  expect(inspect).toHaveBeenCalledOnce();
  expect(inspect.mock.calls[0]![2]).toEqual({ allowInterruption: true,
    speaker: expect.objectContaining({ discordUserId: OWNER, isOwner: true,
      channelId: CHANNEL, consentVersion: h.room.consent.get(OWNER)!.version }) });
  expect(h.room.sessions.interruptOwner).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    discordUserId: OWNER, isOwner: true,
  }));
  expect(h.room.interruptions.size).toBe(0);
});

test.each(['guest', 'no_audio_consent', 'disabled', 'echo'] as const)(
  'voice interruption fails closed for %s before invoking paid STT', async (reason) => {
    const h = setup(reason !== 'disabled');
    const inspect = vi.spyOn(h.access.wake, 'inspect').mockResolvedValue({ activated: true, interrupt: true });
    if (reason === 'no_audio_consent') h.room.consent.grant(OWNER, false);
    if (reason === 'echo') h.room.echo.isLikelyEcho.mockReturnValue(true);
    const member = h.members.get(reason === 'guest' ? GUEST : OWNER)!;
    await h.access.voiceInterruption(h.room, member, Buffer.alloc(19_200), 1);
    expect(inspect).not.toHaveBeenCalled();
    expect(h.room.sessions.interruptOwner).not.toHaveBeenCalled();
  });

test('revocation aborts a pending barge-in check and fences its late positive result', async () => {
  const h = setup();
  let resolve!: (value: WakeInspection) => void;
  const inspected = new Promise<WakeInspection>(complete => { resolve = complete; });
  const inspect = vi.spyOn(h.access.wake, 'inspect').mockReturnValue(inspected);
  const pending = h.access.voiceInterruption(h.room, h.members.get(OWNER)!, Buffer.alloc(19_200), 1);
  const signal = inspect.mock.calls[0]![1]!;
  expect(signal.aborted).toBe(false);
  await h.interaction('revoke').run();
  expect(signal.aborted).toBe(true);
  expect(h.room.consent.get(OWNER)).toBeUndefined();
  expect(h.room.receiver.stopUser).toHaveBeenCalledWith(OWNER);
  expect(h.room.sessions.revoke).toHaveBeenCalledWith(OWNER);
  resolve({ activated: true, interrupt: true });
  await pending;
  expect(h.room.sessions.interruptOwner).not.toHaveBeenCalled();
  expect(h.room.interruptions.size).toBe(0);
});

test('a slow stop recognition cannot cancel a newer response', async () => {
  const h = setup();
  let resolve!: (value: WakeInspection) => void;
  const inspected = new Promise<WakeInspection>(complete => { resolve = complete; });
  vi.spyOn(h.access.wake, 'inspect').mockReturnValue(inspected);
  const pending = h.access.voiceInterruption(h.room, h.members.get(OWNER)!, Buffer.alloc(19_200), 1);
  h.room.playback.currentStreamToken = 2;
  resolve({ activated: true, interrupt: true });
  await pending;
  expect(h.room.sessions.interruptOwner).not.toHaveBeenCalled();
});

test.each(['old_token', 'drained'] as const)(
  'a stop command for %s playback is rejected before paid STT', async (reason) => {
    const h = setup();
    const inspect = vi.spyOn(h.access.wake, 'inspect').mockResolvedValue({ activated: true, interrupt: true });
    if (reason === 'old_token') h.room.playback.currentStreamToken = 2;
    if (reason === 'drained') h.room.playback.isAudible = false;
    await h.access.voiceInterruption(h.room, h.members.get(OWNER)!, Buffer.alloc(19_200), 1);
    expect(inspect).not.toHaveBeenCalled();
    expect(h.room.sessions.interruptOwner).not.toHaveBeenCalled();
  });
