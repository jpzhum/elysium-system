import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const snowflake = z.string().refine((v) => /^[1-9]\d{16,19}$/.test(v) && BigInt(v) < 2n ** 64n);
const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  JARVIS_DISCORD_TOKEN: z.string().trim().min(20),
  JARVIS_OWNER_USER_ID: snowflake,
  JARVIS_GUILD_ID: snowflake,
  JARVIS_DEFAULT_VOICE_CHANNEL_ID: snowflake.optional(),
  ELEVENLABS_AGENT_ID: z.string().trim().min(1).max(200).optional(),
  ELEVENLABS_API_KEY: z.string().trim().min(1).optional(),
  JARVIS_SUPPRESS_FIRST_MESSAGE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  JARVIS_VOICE_INPUT: z.enum(['disabled', 'elevenlabs-stt']).default('disabled'),
  JARVIS_BARGE_IN_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  JARVIS_WAKE_WORD: z.string().trim().min(2).max(30).default('Jarvis'),
  JARVIS_FOLLOWUP_SECONDS: integer(18, 0, 30),
  JARVIS_MAX_ACTIVE_SESSIONS: integer(2, 1, 8),
  JARVIS_MAX_QUEUED_TURNS: integer(8, 1, 16),
  JARVIS_MAX_QUEUED_PER_USER: integer(2, 1, 4),
  JARVIS_QUESTION_QUEUE_TTL_SECONDS: integer(60, 10, 120),
  JARVIS_SESSION_IDLE_SECONDS: integer(45, 20, 180),
  JARVIS_MAX_AUDIO_SECONDS_PER_TURN: integer(12, 1, 30),
  JARVIS_MAX_SESSION_SECONDS: integer(300, 30, 900),
  JARVIS_MAX_TURNS_PER_HOUR: integer(120, 1, 600),
  JARVIS_MAX_WAKE_CHECKS_PER_MINUTE: integer(6, 1, 30),
  JARVIS_SEARCH_API_KEY: z.string().trim().min(1).optional(),
  JARVIS_LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema> & { readonly daveSmoke: boolean };
export class ConfigError extends Error {
  constructor(readonly missingOrInvalid: readonly string[]) {
    super(`Configuração ausente/inválida: ${missingOrInvalid.join(', ')}`);
  }
}

/** All environment access for this independent worker belongs here. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env, daveSmoke = false): Config {
  const cleaned = Object.fromEntries(Object.entries(environment).filter(([, v]) => v?.trim()));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const config = parsed.data;
  if (!daveSmoke && (!config.ELEVENLABS_AGENT_ID || !config.ELEVENLABS_API_KEY)) {
    throw new ConfigError(['ELEVENLABS_AGENT_ID', 'ELEVENLABS_API_KEY'].filter((key) => !cleaned[key]));
  }
  if (cleaned.JARVIS_CONSENT_STORAGE_URL) {
    throw new ConfigError(['JARVIS_CONSENT_STORAGE_URL (persistência ainda não implementada)']);
  }
  if (config.JARVIS_BARGE_IN_ENABLED && (daveSmoke || config.JARVIS_VOICE_INPUT !== 'elevenlabs-stt')) {
    throw new ConfigError(['JARVIS_BARGE_IN_ENABLED (requer JARVIS_VOICE_INPUT=elevenlabs-stt)']);
  }
  return Object.freeze({ ...config, daveSmoke });
}

export function loadEnvironment(): void {
  // Run from jarvis/. Never fall back to the Elysium .env in the parent directory.
  dotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
}
