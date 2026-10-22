import { randomBytes } from 'node:crypto';

export class Metrics {
  private readonly counters = new Map<string, number>();
  add = (name: string, value = 1): void => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !Number.isFinite(value)) return;
    if (!this.counters.has(name) && this.counters.size >= 128) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  };
  snapshot(): Record<string, number> { return Object.fromEntries(this.counters); }
}

export type LogLevel = 'info' | 'warn' | 'error';

export const diagnosticStages = [
  'authorize', 'interaction_ack', 'channel_lookup', 'channel_restriction', 'member_fetch',
  'permissions', 'channel_capacity', 'previous_room_cleanup', 'voice_connect', 'voice_ready_wait',
  'voice_reconnect', 'playback_setup', 'session_setup', 'receiver_setup', 'join_reply',
  'join_complete', 'runtime_probe', 'voice_state', 'voice_network', 'voice_websocket', 'voice_dave',
  'agent_connect', 'agent_response_wait', 'agent_audio_wait', 'playback',
] as const;
export type DiagnosticStage = typeof diagnosticStages[number];

export const errorCategories = [
  'authorization', 'permissions', 'channel', 'timeout', 'cancelled', 'dave', 'dependency',
  'network', 'discord', 'voice', 'runtime', 'unknown', 'agent', 'playback',
] as const;
export type ErrorCategory = typeof errorCategories[number];

export const errorCodes = [
  'UNKNOWN', 'ACCESS_DENIED', 'CHANNEL_NOT_FOUND', 'CHANNEL_RESTRICTED', 'CHANNEL_FULL',
  'JOIN_IN_PROGRESS', 'JOIN_CANCELLED', 'JOIN_TIMEOUT', 'RECONNECT_TIMEOUT',
  'VOICE_DESTROYED', 'VOICE_DISCONNECTED', 'VOICE_ADAPTER_UNAVAILABLE', 'VOICE_NOT_READY',
  'PLAYBACK_SUBSCRIBE_FAILED', 'VOICE_ENCRYPTION_UNAVAILABLE', 'DAVE_REQUIRED', 'DAVE_UNAVAILABLE', 'DAVE_NEGOTIATION_FAILED',
  'DAVE_TRANSITION_FAILED', 'DAVE_UNSUPPORTED_PROTOCOL', 'DEPENDENCY_MISSING',
  'NATIVE_BINDING_UNAVAILABLE', 'NODE_UNSUPPORTED', 'ENVIRONMENT_UNSUPPORTED',
  'INTERACTION_EXPIRED', 'INTERACTION_ACKNOWLEDGED', 'DISCORD_MISSING_ACCESS',
  'DISCORD_MISSING_PERMISSIONS', 'DISCORD_UNKNOWN_CHANNEL', 'DISCORD_UNKNOWN_GUILD',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EACCES', 'EPERM', 'ABORT_ERR',
  'WS_CLOSE_4001', 'WS_CLOSE_4002', 'WS_CLOSE_4003', 'WS_CLOSE_4004', 'WS_CLOSE_4005',
  'WS_CLOSE_4006', 'WS_CLOSE_4009', 'WS_CLOSE_4011', 'WS_CLOSE_4012', 'WS_CLOSE_4014',
  'WS_CLOSE_4015', 'WS_CLOSE_4016', 'WS_CLOSE_4017', 'WS_CLOSE_4018', 'WS_CLOSE_4020',
  'WS_CLOSE_4021', 'WS_CLOSE_4022',
  'AGENT_RESPONSE_TIMEOUT', 'AGENT_COMPLETION_MISSING', 'AGENT_TEXT_WITHOUT_AUDIO',
  'AGENT_EMPTY_RESPONSE', 'AGENT_PREMATURE_CLOSE', 'AGENT_PROVIDER_ERROR',
  'AGENT_AUDIO_OVERFLOW', 'AGENT_SESSION_EXPIRED', 'AGENT_TRANSPORT_ERROR', 'AGENT_HEARTBEAT_TIMEOUT',
  'AGENT_INVALID_EVENT', 'AGENT_AUDIO_FORMAT_UNSUPPORTED', 'AGENT_METADATA_TIMEOUT',
  'AGENT_CREDIT_LIMIT', 'AGENT_RATE_LIMITED', 'AGENT_AUTHENTICATION_FAILED',
  'AGENT_CALLBACK_ERROR', 'AGENT_BACKPRESSURE', 'PLAYBACK_FAILED',
] as const;
export type ErrorCode = typeof errorCodes[number];

const voiceStatuses = ['signalling', 'connecting', 'ready', 'disconnected', 'destroyed'] as const;
type VoiceStatus = typeof voiceStatuses[number];

/** Only scalar, bounded operational metadata is accepted, including at runtime. */
export interface DiagnosticFields {
  incident?: string;
  command?: 'join';
  operation?: 'agent_turn';
  stage?: DiagnosticStage;
  category?: ErrorCategory;
  code?: ErrorCode;
  duration_ms?: number;
  stage_duration_ms?: number;
  timeout_ms?: number;
  voice_status?: VoiceStatus;
  previous_voice_status?: VoiceStatus;
  network_status?: number;
  previous_network_status?: number;
  websocket_close_code?: number;
  disconnect_reason?: number;
  dave_enabled?: boolean;
  dave_available?: boolean;
  dave_ready?: boolean;
  transport_aes_gcm?: boolean;
  dave_protocol_version?: number;
  diagnostics_version?: number;
  node_version?: string;
  voice_version?: string;
  discord_version?: string;
  davey_version?: string;
  platform?: 'win32' | 'linux' | 'darwin';
  arch?: 'x64' | 'arm64';
  permission_view?: boolean;
  permission_connect?: boolean;
  permission_speak?: boolean;
  permission_full?: boolean;
  audio_chunks?: number;
  audio_bytes?: number;
  text_received?: boolean;
  completion_received?: boolean;
  ingress_ended?: boolean;
  playback_drained?: boolean;
  recovery?: boolean;
  pending_tools?: number;
}

const events = new Set([
  'unhandled_rejection', 'uncaught_exception', 'startup_failed', 'command_registration_failed',
  'discord_client_error', 'discord_gateway_error', 'interaction_response_failed', 'dave_probe_ready',
  'jarvis_ready', 'jarvis_command_failed', 'jarvis_stopped', 'jarvis_join_step', 'jarvis_join_succeeded',
  'jarvis_voice_state', 'jarvis_voice_network', 'jarvis_voice_websocket', 'jarvis_voice_error',
  'jarvis_voice_dave', 'jarvis_voice_runtime', 'jarvis_voice_reconnect', 'jarvis_voice_reconnect_failed',
  'voice_connection_state', 'voice_network_state', 'voice_connection_error', 'voice_join_timeout',
  'voice_join_cancelled', 'voice_join_ready', 'voice_recovery_started', 'voice_recovery_rejoin',
  'voice_recovery_ready', 'voice_recovery_timeout', 'voice_recovery_cancelled', 'voice_recovery_failed',
  'voice_websocket_close', 'voice_connection_disconnected', 'voice_dave_state', 'voice_join_failed',
  'jarvis_agent_turn_started', 'jarvis_agent_turn_failed', 'jarvis_agent_response_complete',
  'jarvis_agent_playback_completed', 'jarvis_agent_turn_recovering',
]);

export function newIncident(): string { return randomBytes(4).toString('hex').toUpperCase(); }

/** Data properties only: ignore getters, prototypes, nested objects and unexpected keys. */
export function diagnosticValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function accepted(value: unknown, options: readonly string[]): value is string {
  return typeof value === 'string' && options.includes(value);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function sanitizeDiagnosticFields(fields: unknown): DiagnosticFields {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, options] of [
    ['command', ['join']], ['operation', ['agent_turn']], ['stage', diagnosticStages], ['category', errorCategories],
    ['code', errorCodes], ['voice_status', voiceStatuses], ['previous_voice_status', voiceStatuses],
    ['platform', ['win32', 'linux', 'darwin']], ['arch', ['x64', 'arm64']],
  ] as const) {
    const value = diagnosticValue(fields, key);
    if (accepted(value, options)) result[key] = value;
  }
  for (const key of [
    'dave_enabled', 'dave_available', 'dave_ready', 'transport_aes_gcm',
    'permission_view', 'permission_connect', 'permission_speak', 'permission_full',
    'text_received', 'completion_received', 'ingress_ended', 'playback_drained', 'recovery',
  ]) {
    const value = diagnosticValue(fields, key);
    if (typeof value === 'boolean') result[key] = value;
  }
  for (const [key, minimum, maximum] of [
    ['duration_ms', 0, 86_400_000], ['stage_duration_ms', 0, 86_400_000], ['timeout_ms', 0, 300_000],
    ['network_status', 0, 6], ['previous_network_status', 0, 6],
    ['websocket_close_code', 1_000, 4_999], ['disconnect_reason', 0, 4],
    ['dave_protocol_version', 0, 65_535], ['diagnostics_version', 1, 3], ['pending_tools', 0, 128],
    ['audio_chunks', 0, 1_000_000], ['audio_bytes', 0, 128_000_000],
  ] as const) {
    const value = diagnosticValue(fields, key);
    if (integer(value, minimum, maximum)) result[key] = value;
  }
  for (const key of ['node_version', 'voice_version', 'discord_version', 'davey_version']) {
    const value = diagnosticValue(fields, key);
    // Installed runtime/package versions are releases, not user supplied build labels.
    if (typeof value === 'string' && value.length <= 32 && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
      result[key] = value;
    }
  }
  return result as DiagnosticFields;
}

export class Logger {
  constructor(
    private readonly minimum: LogLevel = 'info',
    private readonly write: (line: string) => void = (line) => { process.stdout.write(line); },
  ) {}
  event(name: string, level: LogLevel = 'info', fields: DiagnosticFields = {}): string {
    const suppliedIncident = diagnosticValue(fields, 'incident');
    const incident = typeof suppliedIncident === 'string' && /^[A-F0-9]{8}$/.test(suppliedIncident)
      ? suppliedIncident : newIncident();
    if (!events.has(name) || !['info', 'warn', 'error'].includes(level)) return incident;
    if (['info', 'warn', 'error'].indexOf(level) >= ['info', 'warn', 'error'].indexOf(this.minimum)) {
      this.write(`${JSON.stringify({ time: new Date().toISOString(), level, event: name, incident, ...sanitizeDiagnosticFields(fields) })}\n`);
    }
    return incident;
  }
}
