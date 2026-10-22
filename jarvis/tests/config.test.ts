import { expect, test } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const base = { JARVIS_DISCORD_TOKEN: 'fictional-discord-token-for-tests', JARVIS_OWNER_USER_ID: '100000000000000001',
  JARVIS_GUILD_ID: '100000000000000002', ELEVENLABS_AGENT_ID: 'agent_test', ELEVENLABS_API_KEY: 'fictional-api-key' };
test('default is no voice capture; Elysium variables are unrelated', () => {
  expect(loadConfig(base).JARVIS_SUPPRESS_FIRST_MESSAGE).toBe(true);
  expect(loadConfig(base).JARVIS_VOICE_INPUT).toBe('disabled');
  expect(loadConfig(base).JARVIS_BARGE_IN_ENABLED).toBe(false);
  expect(loadConfig(base).JARVIS_MAX_QUEUED_TURNS).toBe(8);
  expect(loadConfig(base).JARVIS_MAX_QUEUED_PER_USER).toBe(2);
  expect(loadConfig(base).JARVIS_QUESTION_QUEUE_TTL_SECONDS).toBe(60);
});

test('first-message policy is explicit and never enables unrelated overrides', () => {
  expect(loadConfig({ ...base, JARVIS_SUPPRESS_FIRST_MESSAGE: 'true' }).JARVIS_SUPPRESS_FIRST_MESSAGE).toBe(true);
  expect(loadConfig({ ...base, JARVIS_SUPPRESS_FIRST_MESSAGE: 'false' }).JARVIS_SUPPRESS_FIRST_MESSAGE).toBe(false);
  expect(() => loadConfig({ ...base, JARVIS_SUPPRESS_FIRST_MESSAGE: 'yes' })).toThrow(ConfigError);
});

test('barge-in is an explicit opt-in requiring experimental external voice input', () => {
  expect(loadConfig({ ...base, JARVIS_VOICE_INPUT: 'elevenlabs-stt', JARVIS_BARGE_IN_ENABLED: 'false' })
    .JARVIS_BARGE_IN_ENABLED).toBe(false);
  expect(loadConfig({ ...base, JARVIS_VOICE_INPUT: 'elevenlabs-stt', JARVIS_BARGE_IN_ENABLED: 'true' })
    .JARVIS_BARGE_IN_ENABLED).toBe(true);
  expect(() => loadConfig({ ...base, JARVIS_BARGE_IN_ENABLED: 'true' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, JARVIS_BARGE_IN_ENABLED: 'yes' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, JARVIS_VOICE_INPUT: 'elevenlabs-stt', JARVIS_BARGE_IN_ENABLED: 'true' }, true))
    .toThrow(ConfigError);
});

test.each([
  ['JARVIS_MAX_QUEUED_TURNS', '17'], ['JARVIS_MAX_QUEUED_TURNS', '0'],
  ['JARVIS_MAX_QUEUED_PER_USER', '5'], ['JARVIS_MAX_QUEUED_PER_USER', '0'],
  ['JARVIS_QUESTION_QUEUE_TTL_SECONDS', '9'], ['JARVIS_QUESTION_QUEUE_TTL_SECONDS', '121'],
])('rejects unbounded or ineffective question queues: %s', (key, value) => {
  expect(() => loadConfig({ ...base, [key]: value })).toThrow(ConfigError);
});
test.each(['not-a-discord-id', '18446744073709551616', '1', '-100000000000000001'])('invalid snowflake cannot leak value: %s', (id) => {
  try { loadConfig({ ...base, JARVIS_OWNER_USER_ID: id }); throw new Error('unexpected'); }
  catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('JARVIS_OWNER_USER_ID');
    expect((error as Error).message).not.toContain(id);
  }
});
test('probe requires only separate Discord identity; regular worker requires ElevenLabs', () => {
  const discord = { JARVIS_DISCORD_TOKEN: base.JARVIS_DISCORD_TOKEN,
    JARVIS_GUILD_ID: base.JARVIS_GUILD_ID, JARVIS_OWNER_USER_ID: base.JARVIS_OWNER_USER_ID };
  expect(loadConfig(discord, true).daveSmoke).toBe(true);
  expect(() => loadConfig(discord)).toThrow(ConfigError);
});
test('rejects invalid limits and unsupported persistence', () => {
  expect(() => loadConfig({ ...base, JARVIS_MAX_ACTIVE_SESSIONS: '99' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, JARVIS_CONSENT_STORAGE_URL: 'fictional' })).toThrow(ConfigError);
});
