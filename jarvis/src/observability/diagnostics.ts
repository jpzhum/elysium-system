import { performance } from 'node:perf_hooks';
import {
  diagnosticValue, errorCategories, errorCodes, Logger, newIncident, sanitizeDiagnosticFields,
  type DiagnosticFields, type DiagnosticStage, type ErrorCategory, type ErrorCode, type LogLevel,
} from './metrics.js';

export type { DiagnosticFields, DiagnosticStage, ErrorCategory, ErrorCode, LogLevel } from './metrics.js';

/** Carries a reviewed operational classification, never an upstream exception message. */
export class DiagnosticError extends Error {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  constructor(category: ErrorCategory, code: ErrorCode) {
    const safeCategory = errorCategories.includes(category) ? category : 'unknown';
    const safeCode = errorCodes.includes(code) ? code : 'UNKNOWN';
    super(safeCode);
    this.name = 'DiagnosticError';
    this.category = safeCategory;
    this.code = safeCode;
  }
}

interface SafeError { category: ErrorCategory; code: ErrorCode }

const nodeCodes: Readonly<Record<string, ErrorCategory>> = {
  ECONNRESET: 'network', ECONNREFUSED: 'network', ETIMEDOUT: 'timeout',
  ENOTFOUND: 'network', EAI_AGAIN: 'network', EHOSTUNREACH: 'network', ENETUNREACH: 'network',
  EACCES: 'permissions', EPERM: 'permissions', ABORT_ERR: 'cancelled',
};
const discordCodes: Readonly<Record<number, SafeError>> = {
  50001: { category: 'permissions', code: 'DISCORD_MISSING_ACCESS' },
  50013: { category: 'permissions', code: 'DISCORD_MISSING_PERMISSIONS' },
  10003: { category: 'channel', code: 'DISCORD_UNKNOWN_CHANNEL' },
  10004: { category: 'discord', code: 'DISCORD_UNKNOWN_GUILD' },
  10062: { category: 'discord', code: 'INTERACTION_EXPIRED' },
  40060: { category: 'discord', code: 'INTERACTION_ACKNOWLEDGED' },
};

/** Never returns arbitrary error names, messages, stack, causes, URLs or code values. */
export function sanitizeError(error: unknown): SafeError {
  const category = diagnosticValue(error, 'category');
  const code = diagnosticValue(error, 'code');
  if (diagnosticValue(error, 'name') === 'DiagnosticError' && typeof category === 'string' && typeof code === 'string' &&
      errorCategories.includes(category as ErrorCategory) && errorCodes.includes(code as ErrorCode)) {
    return { category: category as ErrorCategory, code: code as ErrorCode };
  }
  if (typeof code === 'string' && Object.hasOwn(nodeCodes, code)) {
    return { category: nodeCodes[code]!, code: code as ErrorCode };
  }
  if (code === 'busy') return { category: 'voice', code: 'JOIN_IN_PROGRESS' };
  if (code === 'closed') return { category: 'cancelled', code: 'JOIN_CANCELLED' };
  if (typeof code === 'number' && Object.hasOwn(discordCodes, code)) return { ...discordCodes[code]! };
  const closeCode = diagnosticValue(error, 'closeCode');
  if (typeof closeCode === 'number' && Number.isSafeInteger(closeCode)) {
    const fixedCode = `WS_CLOSE_${closeCode}` as ErrorCode;
    if (errorCodes.includes(fixedCode)) return { category: closeCode === 4017 ? 'dave' : 'voice', code: fixedCode };
  }
  const message = diagnosticValue(error, 'message');
  if (typeof message === 'string') {
    // Fixed patterns classify known dependency failures; matching text is never emitted.
    if (/failed to load native binding|cannot find native binding/i.test(message)) {
      return { category: 'dependency', code: 'NATIVE_BINDING_UNAVAILABLE' };
    }
    if (/(?:cannot find module|cannot find package)\s+['"]?@snazzah\/davey/i.test(message)) {
      return { category: 'dave', code: 'DAVE_UNAVAILABLE' };
    }
    if (/no compatible encryption modes|unsupported encryption method/i.test(message)) {
      return { category: 'voice', code: 'VOICE_ENCRYPTION_UNAVAILABLE' };
    }
    if (message.startsWith('Cannot play audio as no valid encryption package is installed.')) {
      return { category: 'voice', code: 'VOICE_ENCRYPTION_UNAVAILABLE' };
    }
    if (message === 'Conexão de voz indisponível para reprodução.') {
      return { category: 'voice', code: 'PLAYBACK_SUBSCRIBE_FAILED' };
    }
    if (/unsupported dave protocol|dave protocol.*not supported/i.test(message)) {
      return { category: 'dave', code: 'DAVE_UNSUPPORTED_PROTOCOL' };
    }
    if (message === 'Ação reservada ao criador autenticado do Jarvis.') {
      return { category: 'authorization', code: 'ACCESS_DENIED' };
    }
  }
  return { category: 'unknown', code: 'UNKNOWN' };
}

/** One join attempt, one incident ID and one terminal failure across async boundaries. */
export class JoinDiagnostics {
  readonly incident = newIncident();
  private readonly started = performance.now();
  private stageStarted = this.started;
  private current: DiagnosticStage = 'authorize';
  private failed: SafeError | undefined;
  private snapshot: DiagnosticFields = {};

  constructor(private readonly logger: Logger) {}

  private get duration(): number { return Math.min(86_400_000, Math.max(0, Math.round(performance.now() - this.started))); }

  stage(stage: DiagnosticStage): void {
    this.current = stage;
    this.stageStarted = performance.now();
    this.event('jarvis_join_step', 'info');
  }

  /** Retain operational context even when info events are filtered by LOG_LEVEL. */
  remember(fields: DiagnosticFields): void {
    const clean = sanitizeDiagnosticFields(fields);
    // Event-specific classifications and stages must never overwrite the join's failed stage.
    delete clean.command;
    delete clean.stage;
    delete clean.category;
    delete clean.code;
    delete clean.duration_ms;
    delete clean.stage_duration_ms;
    this.snapshot = { ...this.snapshot, ...clean };
  }

  event(name: string, level: LogLevel = 'info', fields: DiagnosticFields = {}): void {
    const clean = sanitizeDiagnosticFields(fields);
    this.remember(clean);
    // Both merged objects are sanitized copies. Never spread caller-provided objects.
    this.logger.event(name, level, {
      ...this.snapshot, ...clean, incident: this.incident, command: 'join', stage: clean.stage ?? this.current,
      duration_ms: clean.duration_ms ?? this.duration,
    });
  }

  failure(error: unknown): SafeError {
    if (!this.failed) {
      this.failed = sanitizeError(error);
      this.event('jarvis_command_failed', 'error', {
        ...this.failed,
        stage_duration_ms: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - this.stageStarted))),
      });
    }
    return this.failed;
  }

  success(): void {
    this.current = 'join_complete';
    this.event('jarvis_join_succeeded', 'info');
  }
}
