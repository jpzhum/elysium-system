import { randomBytes } from 'node:crypto';

const MAX_METRICS = 256;
const MAX_DURATION_SERIES = 32;
const DURATION_WINDOW_SAMPLES = 256;

interface DurationWindow {
  readonly values: number[];
  next: number;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, DurationWindow>();
  add = (name: string, value = 1): void => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !Number.isFinite(value)) return;
    if (!this.counters.has(name) && this.counters.size >= MAX_METRICS) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  };
  snapshot(): Record<string, number> {
    const result = Object.fromEntries(this.counters);
    for (const [name, window] of this.durations) {
      const sorted = [...window.values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      result[`${name}_median`] = sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
      // Nearest-rank p95 is an observed value; the median averages the two middle values.
      result[`${name}_p95`] = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      result[`${name}_window_samples`] = sorted.length;
    }
    return result;
  }
  /** Lifetime aggregates plus a bounded, recent window; no audio, content or identities. */
  record = (name: string, value = 1): void => {
    if (!name.endsWith('_ms')) { this.add(name, value); return; }
    if (!/^[a-z][a-z0-9_]{0,51}$/.test(name) || !Number.isFinite(value) || value < 0 || value > 3_600_000) return;
    if (!this.durations.has(name) && this.durations.size >= MAX_DURATION_SERIES) return;
    const keys = [name, `${name}_samples`, `${name}_last`, `${name}_min`, `${name}_max`];
    // Reserve the entire aggregate before changing it, even when counter capacity is exhausted.
    if (this.counters.size + keys.filter(key => !this.counters.has(key)).length > MAX_METRICS) return;
    this.add(name, value);
    this.add(`${name}_samples`);
    this.set(`${name}_last`, value);
    this.set(`${name}_min`, Math.min(this.counters.get(`${name}_min`) ?? value, value));
    this.set(`${name}_max`, Math.max(this.counters.get(`${name}_max`) ?? value, value));
    let window = this.durations.get(name);
    if (!window) {
      window = { values: [], next: 0 };
      this.durations.set(name, window);
    }
    if (window.values.length < DURATION_WINDOW_SAMPLES) window.values.push(value);
    else window.values[window.next] = value;
    window.next = (window.next + 1) % DURATION_WINDOW_SAMPLES;
  };
  private set(name: string, value: number): void {
    if (this.counters.has(name) || this.counters.size < MAX_METRICS) this.counters.set(name, value);
  }
}

export type LogLevel = 'info' | 'warn' | 'error';

export const diagnosticStages = [
  'authorize', 'interaction_ack', 'channel_lookup', 'channel_restriction', 'member_fetch',
  'permissions', 'channel_capacity', 'previous_room_cleanup', 'voice_connect', 'voice_ready_wait',
  'voice_reconnect', 'playback_setup', 'session_setup', 'receiver_setup', 'join_reply',
  'join_complete', 'runtime_probe', 'voice_state', 'voice_network', 'voice_websocket', 'voice_dave',
  'agent_connect', 'agent_response_wait', 'agent_audio_wait', 'playback',
  'voice_capture', 'wake_detection', 'agent_audio_upload', 'agent_user_recognition',
  'identity_injection', 'tool_dispatch', 'voice_participants', 'search_request',
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
  'AGENT_GUARDRAIL_REJECTED', 'AGENT_CONCURRENCY_LIMIT',
  'AGENT_CALLBACK_ERROR', 'AGENT_BACKPRESSURE', 'PLAYBACK_FAILED', 'AGENT_USER_TURN_MISSING', 'AGENT_INITIATION_REJECTED',
  'AGENT_INPUT_INCOMPLETE', 'AGENT_INPUT_INVALID',
  'TOOL_UNAVAILABLE', 'TOOL_FAILED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED',
] as const;
export type ErrorCode = typeof errorCodes[number];

const voiceStatuses = ['signalling', 'connecting', 'ready', 'disconnected', 'destroyed'] as const;
type VoiceStatus = typeof voiceStatuses[number];

/** Only scalar, bounded operational metadata is accepted, including at runtime. */
export interface DiagnosticFields {
  incident?: string;
  command?: 'join';
  operation?: 'agent_turn' | 'identity' | 'tool' | 'search';
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
  local_playback_drained?: boolean;
  recovery?: boolean;
  pending_tools?: number;
  queue_position?: number;
  queue_depth?: number;
  turn_outcome?: 'completed' | 'superseded' | 'unconfirmed' | 'cancelled' | 'failed';
  question_wait_ms?: number;
  first_audio_ms?: number;
  last_audio_ms?: number;
  first_playback_ms?: number;
  drain_ms?: number;
  next_question_ready_ms?: number;
  first_message_override_requested?: boolean;
  input_kind?: 'voice' | 'text';
  capture_bytes?: number;
  capture_ms?: number;
  capture_wait_ms?: number;
  end_detection_ms?: number;
  wake_detected?: boolean;
  followup?: boolean;
  user_turn_recognized?: boolean;
  input_audio_chunks?: number;
  input_audio_bytes?: number;
  input_audio_finished?: boolean;
  silence_tail_ms?: number;
  input_sample_rate?: number;
  output_sample_rate?: number;
  session_reused?: boolean;
  speaker_verified?: boolean;
  consent_current?: boolean;
  identity_injected?: boolean;
  identity_is_creator?: boolean;
  active_game_known?: boolean;
  room_context_injected?: boolean;
  identity_source?: 'discord';
  search_key_configured?: boolean;
  search_status?: 'success' | 'missing_key' | 'invalid_input' | 'cancelled' | 'rate_limited' | 'unavailable' | 'timeout' | 'invalid_reply' | 'no_sources';
  source_count?: number;
  tool_name?: 'search_game_info' | 'get_voice_participants' | 'unknown';
  tool_stage?: 'received' | 'started' | 'completed' | 'failed';
  wait_for_response?: boolean;
  participants_available?: boolean;
  participants_complete?: boolean;
  input_source_chunks?: number;
  input_silence_chunks?: number;
  upload_ms?: number;
  context_injected?: boolean;
  context_items?: number;
  context_chars?: number;
  recovery_attempt?: number;
  retry_delay_ms?: number;
  receiver_state?: 'ready' | 'suspended' | 'stopped';
  capture_rejection?: 'too_short' | 'silent';
  rejection_reason?: 'consent' | 'busy' | 'limit' | 'closed' | 'unexpected'
    | 'queue_full' | 'user_queue_full' | 'voice_memory_limit' | 'turn_budget'
    | 'wake_check_busy' | 'wake_capacity' | 'voice_unavailable' | 'consent_invalid'
    | 'wake_queue_full' | 'wake_queue_timeout' | 'wake_rate_limited' | 'wake_provider_failed';
  voice_lifecycle_reason?: 'explicit_leave' | 'channel_changed' | 'channel_empty' | 'shutdown' | 'connection_destroyed' | 'room_replaced';
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
  'jarvis_turn_queue_changed', 'jarvis_agent_turn_superseded', 'jarvis_agent_turn_finished', 'jarvis_agent_audio_progress',
  'jarvis_voice_captured', 'jarvis_wake_detected', 'jarvis_agent_input_started', 'jarvis_agent_input_sent',
  'jarvis_wake_failed',
  'jarvis_agent_user_turn_recognized', 'jarvis_agent_initial_output_discarded', 'jarvis_agent_response_observed',
  'jarvis_agent_session_ready',
  'jarvis_identity_injected', 'jarvis_tool_event', 'jarvis_search_result', 'jarvis_voice_participants_result',
  'jarvis_short_context', 'jarvis_agent_turn_recovered',
  'jarvis_voice_receiver_state', 'jarvis_voice_turn_rejected', 'jarvis_voice_capture_rejected',
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
    ['command', ['join']], ['operation', ['agent_turn', 'identity', 'tool', 'search']], ['stage', diagnosticStages], ['category', errorCategories],
    ['code', errorCodes], ['voice_status', voiceStatuses], ['previous_voice_status', voiceStatuses],
    ['turn_outcome', ['completed', 'superseded', 'unconfirmed', 'cancelled', 'failed']],
    ['input_kind', ['voice', 'text']],
    ['identity_source', ['discord']],
    ['search_status', ['success', 'missing_key', 'invalid_input', 'cancelled', 'rate_limited', 'unavailable', 'timeout', 'invalid_reply', 'no_sources']],
    ['tool_name', ['search_game_info', 'get_voice_participants', 'unknown']],
    ['tool_stage', ['received', 'started', 'completed', 'failed']],
    ['receiver_state', ['ready', 'suspended', 'stopped']],
    ['capture_rejection', ['too_short', 'silent']],
    ['rejection_reason', ['consent', 'busy', 'limit', 'closed', 'unexpected',
      'queue_full', 'user_queue_full', 'voice_memory_limit', 'turn_budget',
      'wake_check_busy', 'wake_capacity', 'voice_unavailable', 'consent_invalid',
      'wake_queue_full', 'wake_queue_timeout', 'wake_rate_limited', 'wake_provider_failed']],
    ['voice_lifecycle_reason', ['explicit_leave', 'channel_changed', 'channel_empty', 'shutdown', 'connection_destroyed', 'room_replaced']],
    ['platform', ['win32', 'linux', 'darwin']], ['arch', ['x64', 'arm64']],
  ] as const) {
    const value = diagnosticValue(fields, key);
    if (accepted(value, options)) result[key] = value;
  }
  for (const key of [
    'dave_enabled', 'dave_available', 'dave_ready', 'transport_aes_gcm',
    'permission_view', 'permission_connect', 'permission_speak', 'permission_full',
    'text_received', 'completion_received', 'ingress_ended', 'playback_drained', 'local_playback_drained', 'recovery',
    'first_message_override_requested', 'wake_detected', 'followup', 'user_turn_recognized',
    'input_audio_finished', 'session_reused', 'speaker_verified', 'consent_current',
    'identity_injected', 'identity_is_creator', 'active_game_known', 'room_context_injected',
    'search_key_configured', 'wait_for_response', 'participants_available', 'participants_complete',
    'context_injected',
  ]) {
    const value = diagnosticValue(fields, key);
    if (typeof value === 'boolean') result[key] = value;
  }
  for (const [key, minimum, maximum] of [
    ['duration_ms', 0, 86_400_000], ['stage_duration_ms', 0, 86_400_000], ['timeout_ms', 0, 300_000],
    ['network_status', 0, 6], ['previous_network_status', 0, 6],
    ['websocket_close_code', 1_000, 4_999], ['disconnect_reason', 0, 4],
    ['dave_protocol_version', 0, 65_535], ['diagnostics_version', 1, 7], ['pending_tools', 0, 128],
    ['audio_chunks', 0, 1_000_000], ['audio_bytes', 0, 128_000_000],
    ['queue_position', 0, 32], ['queue_depth', 0, 32],
    ['question_wait_ms', 0, 3_600_000], ['first_audio_ms', 0, 3_600_000], ['last_audio_ms', 0, 3_600_000],
    ['first_playback_ms', 0, 3_600_000], ['drain_ms', 0, 3_600_000], ['next_question_ready_ms', 0, 3_600_000],
    ['capture_bytes', 0, 5_760_000], ['capture_ms', 0, 30_000], ['capture_wait_ms', 0, 120_000],
    ['end_detection_ms', 0, 120_000], ['input_audio_chunks', 0, 10_000], ['input_audio_bytes', 0, 4_000_000],
    ['silence_tail_ms', 0, 2_000], ['input_sample_rate', 8_000, 48_000], ['output_sample_rate', 8_000, 48_000],
    ['input_source_chunks', 0, 10_000], ['input_silence_chunks', 0, 10_000], ['upload_ms', 0, 120_000],
    ['source_count', 0, 5],
    ['context_items', 0, 10], ['context_chars', 0, 2400],
    ['recovery_attempt', 1, 3], ['retry_delay_ms', 0, 5_000],
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
