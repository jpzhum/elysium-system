import { ChannelType, type ChatInputCommandInteraction, type Client, type GuildMember } from 'discord.js';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { JarvisBot } from '../src/discord/bot.js';
import type { VoiceConnectionManager } from '../src/discord/voice-connection.js';
import { Logger } from '../src/observability/metrics.js';

type Interaction = ChatInputCommandInteraction<'cached'>;
interface LifecycleAccess {
  readonly client: Client;
  readonly voice: VoiceConnectionManager;
  readonly joining: boolean;
  join(interaction: Interaction): Promise<void>;
  handle(interaction: Interaction): Promise<void>;
  reset(): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setup() {
  const config = loadConfig({
    JARVIS_DISCORD_TOKEN: 'local-test-token-without-discord-access',
    JARVIS_OWNER_USER_ID: '100000000000000001',
    JARVIS_GUILD_ID: '100000000000000002',
  }, true);
  const bot = new JarvisBot(config, new Logger('error'));
  const access = bot as unknown as LifecycleAccess;
  const gate = deferred<GuildMember>();
  const fetchMe = vi.fn(() => gate.promise);
  const member = { id: '100000000000000003' } as GuildMember;
  const channel = {
    id: '100000000000000004', type: ChannelType.GuildVoice, full: false,
    permissionsFor: vi.fn(() => ({ has: () => true })),
  };
  const interaction = {
    member: { voice: { channel } }, guild: { members: { me: null, fetchMe } },
  } as unknown as Interaction;
  // A real Client is constructed, but no login or network operation is performed.
  return { config, bot, access, gate, fetchMe, member, interaction };
}

afterEach(() => { vi.restoreAllMocks(); });

test.each(['reset', 'leave', 'stop'] as const)(
  'a pending fetchMe cannot connect after %s cancels the join',
  async (cancellation) => {
    const { config, bot, access, gate, fetchMe, member, interaction } = setup();
    const connect = vi.spyOn(access.voice, 'join').mockRejectedValue(new Error('unexpected_voice_join'));
    const pending = access.join(interaction);
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'closed' });
    try {
      expect(fetchMe).toHaveBeenCalledTimes(1);
      expect(access.joining).toBe(true);
      if (cancellation === 'reset') access.reset();
      else if (cancellation === 'stop') await bot.stop();
      else {
        const reply = vi.fn().mockResolvedValue(undefined);
        await access.handle({
          inCachedGuild: () => true, guildId: config.JARVIS_GUILD_ID,
          options: { getSubcommand: () => 'leave' },
          user: { id: config.JARVIS_OWNER_USER_ID },
          deferred: false, replied: false, reply,
        } as unknown as Interaction);
        expect(reply).toHaveBeenCalledWith(expect.objectContaining({
          content: 'Jarvis desconectado; consentimentos e buffers apagados.',
        }));
      }
      gate.resolve(member);
      await cancelled;
      expect(connect).not.toHaveBeenCalled();
      expect(access.joining).toBe(false);
    } finally {
      gate.resolve(member);
      await pending.catch(() => undefined);
      await bot.stop();
    }
  },
);

test('concurrent joins share one preparation and make only one voice connection attempt', async () => {
  const { bot, access, gate, fetchMe, member, interaction } = setup();
  const connectionAttempt = new Error('local_connection_attempt');
  const connect = vi.spyOn(access.voice, 'join').mockRejectedValue(connectionAttempt);
  const pending = access.join(interaction);
  const firstResult = expect(pending).rejects.toBe(connectionAttempt);
  try {
    await expect(access.join(interaction)).rejects.toMatchObject({ code: 'busy' });
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(access.joining).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    gate.resolve(member);
    await firstResult;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(access.joining).toBe(false);
  } finally {
    gate.resolve(member);
    await pending.catch(() => undefined);
    await bot.stop();
  }
});

test.each(['leave', 'stop'] as const)(
  'a pending join acknowledgement cannot reconnect after %s',
  async (cancellation) => {
    const { config, bot, access, gate, fetchMe, member, interaction } = setup();
    const connect = vi.spyOn(access.voice, 'join').mockRejectedValue(new Error('unexpected_voice_join'));
    const acknowledgement = deferred<void>();
    let deferredReply = false;
    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn(async () => {
      await acknowledgement.promise;
      deferredReply = true;
    });
    // Resolve the member lookup too, so a regression fails without a hanging join.
    gate.resolve(member);
    const pending = access.handle({
      ...interaction,
      inCachedGuild: () => true, guildId: config.JARVIS_GUILD_ID,
      options: { getSubcommand: () => 'join' }, user: { id: config.JARVIS_OWNER_USER_ID },
      get deferred() { return deferredReply; },
      replied: false, deferReply, editReply,
    } as unknown as Interaction);
    try {
      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(connect).not.toHaveBeenCalled();
      if (cancellation === 'stop') await bot.stop();
      else {
        await access.handle({
          inCachedGuild: () => true, guildId: config.JARVIS_GUILD_ID,
          options: { getSubcommand: () => 'leave' }, user: { id: config.JARVIS_OWNER_USER_ID },
          deferred: false, replied: false, reply: vi.fn().mockResolvedValue(undefined),
        } as unknown as Interaction);
      }
      acknowledgement.resolve(undefined);
      await pending;
      expect(fetchMe).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: 'A sessão foi encerrada. Tente novamente.',
      }));
    } finally {
      acknowledgement.resolve(undefined);
      await pending.catch(() => undefined);
      await bot.stop();
    }
  },
);
