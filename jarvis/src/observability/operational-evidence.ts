import { type DiagnosticFields, type ErrorCode, type Logger, type OperationalEvent } from './metrics.js';

type Outcome = 'completed' | 'unconfirmed' | 'failed' | 'partial' | 'cancelled' | 'expired';
const emptyOutcomes = (): Record<Outcome, number> => ({ completed: 0, unconfirmed: 0, failed: 0, partial: 0, cancelled: 0, expired: 0 });
interface Observation { at: number; description: string; }

/** Bounded technical evidence, never a health claim or a record of conversational content. */
export class OperationalEvidence {
  private readonly started: number;
  private readonly dispose: () => void;
  private readonly lifetime = emptyOutcomes();
  private readonly recent = new Map<string, Outcome>();
  private readonly incidents = new Map<string, DiagnosticFields & { failureStage?: DiagnosticFields['stage'] }>();
  private lastSuccessAt?: number;
  private failure?: Observation & { incident: string; code: ErrorCode };
  private recovery?: Observation;
  private agent = 'sem observação';
  private recognition = 'sem observação';
  private playback = 'sem observação';
  private search = 'sem observação';

  constructor(logger: Logger, private readonly now: () => number = () => performance.now()) {
    this.started = now();
    this.dispose = logger.observe(event => this.observe(event));
  }

  close(): void { this.dispose(); }

  private observe(event: OperationalEvent): void {
    const { event: name, code, incident } = event;
    // These records originate in Logger's reviewed scalar allowlist, never user content.
    const previous = this.incidents.get(incident);
    const genericPlaybackSummary = code === 'PLAYBACK_FAILED' && previous?.code !== undefined
      && previous.code !== 'UNKNOWN' && previous.code !== 'PLAYBACK_FAILED'
      && (!event.cause_code || event.cause_code === 'UNKNOWN' || event.cause_code === previous.code);
    const record = { ...previous, ...event };
    // A manager rollup carries the turn result, not a new cause. Keep the
    // specific player/encoder failure even if another incident arrived meanwhile.
    if (genericPlaybackSummary) {
      record.code = previous.code;
      record.cause_code = previous.cause_code;
      record.category = previous.category;
    } else if (code && (previous?.code !== code || !previous.failureStage)) record.failureStage = event.stage;
    this.incidents.delete(incident);
    if (this.incidents.size >= 64) this.incidents.delete(this.incidents.keys().next().value!);
    this.incidents.set(incident, record);
    const terminalRollup = this.failure?.incident === incident && this.failure.code === code
      && (name === 'jarvis_agent_turn_failed' || name === 'jarvis_agent_turn_finished');
    if (code && event.category !== 'cancelled' && name !== 'jarvis_agent_turn_recovering' && !genericPlaybackSummary && !terminalRollup) {
      this.failure = { at: this.now(), incident, code, description: [event.category ?? 'unknown', code,
        event.cause_code && event.cause_code !== code ? `causa=${event.cause_code}` : undefined,
        event.stage, event.playback_stage, `incidente=${incident}`].filter(Boolean).join(' / ') };
    }
    const recovery = {
      voice_recovery_started: 'em andamento', voice_recovery_ready: 'Ready restabelecido',
      voice_recovery_failed: 'falhou', voice_recovery_timeout: 'prazo expirado', voice_recovery_cancelled: 'cancelada',
    }[name];
    if (recovery) this.recovery = { at: this.now(), description: recovery + (code ? ` / ${code}` : '') };

    if (name === 'jarvis_agent_turn_started') this.agent = 'turno iniciado';
    if (name === 'jarvis_agent_session_ready') this.agent = 'sessão aberta';
    if (name === 'jarvis_agent_first_audio') this.agent = 'PCM recebido';
    if (name === 'jarvis_agent_turn_finished') this.agent = 'turno encerrado';
    if (name === 'jarvis_agent_turn_failed') this.agent = 'turno falhou';
    if (name === 'jarvis_agent_input_sent') this.recognition = event.user_turn_recognized
      ? 'fala reconhecida' : 'aguardando transcript final';
    if (name === 'jarvis_agent_user_turn_recognized') this.recognition = 'fala reconhecida';
    if (code === 'AGENT_USER_TURN_MISSING') this.recognition = 'transcript final ausente';
    if (name === 'jarvis_agent_turn_cancelled') {
      this.agent = 'turno cancelado';
      if (event.input_kind === 'voice') this.recognition = 'turno cancelado';
    }
    if (name === 'jarvis_playback_failed') this.playback = 'falhou';
    if (name === 'jarvis_playback_state' && event.player_status === 'playing') this.playback = 'player Playing observado';
    if (name === 'jarvis_agent_audio_progress' && event.first_playback_ms !== undefined) this.playback = 'pacote consumido localmente';
    if (name === 'jarvis_agent_playback_completed') this.playback = 'recurso local concluído';
    if (name === 'jarvis_search_result' && event.search_status) this.search = event.search_status;

    // Only terminal events count. PCM, a recovery attempt or a transcript are not success.
    const outcome: Outcome | undefined = name === 'jarvis_agent_turn_finished'
      ? event.turn_outcome === 'completed' ? 'completed' : event.turn_outcome === 'unconfirmed' ? 'unconfirmed' : undefined
      : name === 'jarvis_agent_turn_failed' ? event.turn_outcome === 'partial' ? 'partial'
        : event.turn_outcome === 'expired' ? 'expired' : 'failed'
        : name === 'jarvis_agent_turn_cancelled' ? event.turn_outcome === 'expired' ? 'expired' : 'cancelled' : undefined;
    if (outcome && !this.recent.has(incident)) {
      if (outcome === 'completed') this.lastSuccessAt = this.now();
      this.lifetime[outcome]++;
      if (this.recent.size >= 256) this.recent.delete(this.recent.keys().next().value!);
      this.recent.set(incident, outcome);
    }
  }

  incidentDetails(incident: string): string {
    if (!/^[A-F0-9]{8}$/.test(incident)) return 'Informe um incidente com oito caracteres hexadecimais.';
    const record = this.incidents.get(incident);
    if (!record) return 'Incidente não encontrado nos últimos 64 incidentes deste processo.';
    const keys: (keyof DiagnosticFields)[] = ['stage', 'category', 'code', 'cause_code', 'playback_stage',
      'input_kind', 'turn_outcome', 'turn_delivery', 'cancellation_reason', 'completion_received',
      'local_playback_drained', 'playback_drained', 'first_playback_ms', 'duration_ms', 'queue_depth',
      'voice_status', 'receiver_state', 'rejection_reason', 'capture_rejection', 'retry_after_ms'];
    const values = { ...Object.fromEntries(keys.flatMap(key => record[key] === undefined ? [] : [[key, record[key]]])),
      ...(record.failureStage ? { failure_stage: record.failureStage } : {}) };
    return `Incidente ${incident}, deste processo. Últimos campos técnicos observados:\n${JSON.stringify(values)}`;
  }

  /** Rates use terminated requests as denominator, explicitly including queued cancellations. */
  summary(): string {
    const recent = emptyOutcomes();
    for (const outcome of this.recent.values()) recent[outcome]++;
    const counts = (values: Record<Outcome, number>): string => {
      const total = Object.values(values).reduce((sum, value) => sum + value, 0);
      return `n=${total}; confirmados=${values.completed}; não confirmados=${values.unconfirmed}; `
        + `falhos=${values.failed}; cancelados=${values.cancelled}; parciais=${values.partial}; expirados=${values.expired}; confirmação=`
        + (total ? `${(100 * values.completed / total).toFixed(1)}%` : 'sem amostras');
    };
    const observation = (value: Observation | undefined): string => value
      ? `${value.description} (há ${Math.max(0, Math.floor((this.now() - value.at) / 1000))} s)` : 'sem observação';
    return `Processo ativo há ${Math.max(0, Math.floor((this.now() - this.started) / 1000))} s.\n`
      + `Último turno confirmado e drenado: ${this.lastSuccessAt === undefined ? 'sem observação' : `há ${Math.max(0, Math.floor((this.now() - this.lastSuccessAt) / 1000))} s`}.\n`
      + `Última evidência: ElevenAgents=${this.agent}; ASR=${this.recognition}; playback=${this.playback}; Brave=${this.search}.\n`
      + `Última falha técnica: ${observation(this.failure)}.\nÚltima recuperação de voz: ${observation(this.recovery)}.\n`
      + `Turnos encerrados desde o início: ${counts(this.lifetime)}.\nÚltimos até 256 encerrados: ${counts(recent)}.\n`
      + 'Denominador inclui cancelamentos em fila; confirmação exige geração explícita e drain local. Não comprova audição.';
  }
}

/** Rendering accepts only deployment hashes already validated in config.ts. */
export function deploymentRevision(revision: DiagnosticFields['deployed_revision']): string {
  return typeof revision === 'string' && /^[a-f0-9]{7,40}$/i.test(revision)
    ? revision.toLowerCase() : 'não informada';
}
