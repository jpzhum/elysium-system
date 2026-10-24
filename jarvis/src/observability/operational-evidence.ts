import { type DiagnosticFields, type ErrorCode, type Logger, type OperationalEvent } from './metrics.js';

type Outcome = 'completed' | 'unconfirmed' | 'failed' | 'cancelled';
const emptyOutcomes = (): Record<Outcome, number> => ({ completed: 0, unconfirmed: 0, failed: 0, cancelled: 0 });
interface Observation { at: number; description: string; }

/** Bounded technical evidence, never a health claim or a record of conversational content. */
export class OperationalEvidence {
  private readonly started: number;
  private readonly dispose: () => void;
  private readonly lifetime = emptyOutcomes();
  private readonly recent = new Map<string, Outcome>();
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
    const genericPlaybackSummary = code === 'PLAYBACK_FAILED' && this.failure?.incident === incident
      && this.failure.code !== 'UNKNOWN' && this.failure.code !== 'PLAYBACK_FAILED'
      && (!event.cause_code || event.cause_code === 'UNKNOWN');
    if (code && event.category !== 'cancelled' && name !== 'jarvis_agent_turn_recovering' && !genericPlaybackSummary) {
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
    const outcome = name === 'jarvis_agent_turn_finished'
      ? event.turn_outcome === 'completed' ? 'completed' : event.turn_outcome === 'unconfirmed' ? 'unconfirmed' : undefined
      : name === 'jarvis_agent_turn_failed' ? 'failed'
        : name === 'jarvis_agent_turn_cancelled' ? 'cancelled' : undefined;
    if (outcome && !this.recent.has(incident)) {
      this.lifetime[outcome]++;
      if (this.recent.size >= 256) this.recent.delete(this.recent.keys().next().value!);
      this.recent.set(incident, outcome);
    }
  }

  /** Rates use terminated requests as denominator, explicitly including queued cancellations. */
  summary(): string {
    const recent = emptyOutcomes();
    for (const outcome of this.recent.values()) recent[outcome]++;
    const counts = (values: Record<Outcome, number>): string => {
      const total = Object.values(values).reduce((sum, value) => sum + value, 0);
      return `n=${total}; confirmados=${values.completed}; não confirmados=${values.unconfirmed}; `
        + `falhos=${values.failed}; cancelados=${values.cancelled}; confirmação=`
        + (total ? `${(100 * values.completed / total).toFixed(1)}%` : 'sem amostras');
    };
    const observation = (value: Observation | undefined): string => value
      ? `${value.description} (há ${Math.max(0, Math.floor((this.now() - value.at) / 1000))} s)` : 'sem observação';
    return `Processo ativo há ${Math.max(0, Math.floor((this.now() - this.started) / 1000))} s.\n`
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
