import type { DiagnosticFields } from './metrics.js';

export const voiceAdmissionEvents = [
  'capture', 'wake_requested', 'wake_accepted', 'wake_cooldown_rejected',
  'wake_global_rejected', 'wake_fair_share_rejected', 'wake_valid', 'followup',
  'question_accepted', 'duplicate', 'queue_rejected', 'turn_responded',
  'turn_unconfirmed', 'turn_partial', 'playback_failed', 'first_audio', 'turn_released',
] as const;
export type VoiceAdmissionEvent = typeof voiceAdmissionEvents[number];
export interface VoiceAdmissionDetails {
  readonly durationMs?: number;
  /** Technical incident only. Used for recent event deduplication, never rendered. */
  readonly turnId?: string;
}
type Counts = Record<VoiceAdmissionEvent, number>;
type DisconnectReason = NonNullable<DiagnosticFields['voice_lifecycle_reason']>;
interface Participant { readonly label: string; lastSeen: number; }
interface Sample {
  readonly at: number;
  readonly event: VoiceAdmissionEvent;
  participant?: Participant;
  readonly turnId?: string;
  readonly durationMs?: number;
}
export interface VoiceDurationSummary {
  readonly n: number;
  readonly p50_ms: number | null;
  readonly p90_ms: number | null;
  readonly p95_ms: number | null;
  readonly max_ms: number | null;
}
interface ParticipantSummary {
  readonly participant: string;
  readonly counts: Readonly<Counts>;
  readonly first_audio_ms: VoiceDurationSummary;
  readonly busy_ms: VoiceDurationSummary;
}
export interface VoiceAdmissionSnapshot {
  readonly scope: 'current_process';
  readonly deployed_revision: string | null;
  readonly window_ms: number;
  readonly elapsed_ms: number;
  readonly retained_events: number;
  readonly window_complete: boolean;
  readonly participants_complete: boolean;
  readonly recent: Readonly<Counts>;
  readonly process: Readonly<Counts>;
  /** Actual admitted STT starts observed in the rolling window, not billed credits. */
  readonly paid_starts_in_window: number;
  readonly participants: readonly ParticipantSummary[];
  readonly last_disconnect: Readonly<{ reason: DisconnectReason; ago_ms: number }> | null;
}

const WINDOW_MS = 60_000;
const MAX_EVENTS = 256;
const MAX_PARTICIPANTS = 16;
const acceptedEvents = new Set<string>(voiceAdmissionEvents);
const disconnectReasons = new Set<string>([
  'explicit_leave', 'channel_changed', 'channel_empty', 'shutdown', 'connection_destroyed', 'room_replaced',
]);
const counts = (): Counts => Object.fromEntries(voiceAdmissionEvents.map(event => [event, 0])) as Counts;
const validDuration = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 3_600_000;

function durationSummary(samples: readonly Sample[], event: VoiceAdmissionEvent): VoiceDurationSummary {
  const values = samples.filter(sample => sample.event === event && sample.durationMs !== undefined)
    .map(sample => sample.durationMs!).sort((left, right) => left - right);
  const n = values.length;
  if (!n) return { n: 0, p50_ms: null, p90_ms: null, p95_ms: null, max_ms: null };
  const middle = Math.floor(n / 2);
  return { n, p50_ms: n % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2,
    p90_ms: values[Math.ceil(n * 0.9) - 1]!, p95_ms: values[Math.ceil(n * 0.95) - 1]!, max_ms: values[n - 1]! };
}

/**
 * RAM-only evidence fed exclusively by authenticated backend decisions. User IDs
 * are map keys for correlation; output contains process-local numbered labels.
 * No audio, conversational text, display names, timers or external calls.
 */
export class VoiceAdmissionEvidence {
  private readonly participants = new Map<string, Participant>();
  private readonly samples: Sample[] = [];
  // Paid starts must survive a burst of local capture/rejection events. This
  // separate bound exceeds the validated maximum of 30 wake starts/minute.
  private readonly paidStarts: Sample[] = [];
  private readonly processCounts = counts();
  private readonly started: number;
  private readonly revision: string | null;
  private nextLabel = 0;
  private droppedEventAt = -Infinity;
  private droppedParticipantAt = -Infinity;
  private lastDisconnect?: { reason: DisconnectReason; at: number };

  constructor(revision?: string, private readonly now: () => number = () => performance.now()) {
    this.started = now();
    this.revision = typeof revision === 'string' && /^[a-f0-9]{7,40}$/i.test(revision)
      ? revision.toLowerCase() : null;
  }

  record(userId: string, event: VoiceAdmissionEvent, details: VoiceAdmissionDetails = {}): void {
    if (typeof userId !== 'string' || !userId.length || userId.length > 128 || !acceptedEvents.has(event)) return;
    const now = this.now();
    this.expire(now);
    let participant = this.participants.get(userId);
    if (!participant) {
      if (this.participants.size >= MAX_PARTICIPANTS) {
        const oldest = [...this.participants].sort((left, right) => left[1].lastSeen - right[1].lastSeen)[0]!;
        this.forget(oldest[0]);
        this.droppedParticipantAt = now;
      }
      participant = { label: `falante_${++this.nextLabel}`, lastSeen: now };
      this.participants.set(userId, participant);
    }
    participant.lastSeen = now;
    const turnId = typeof details.turnId === 'string' && /^[A-F0-9]{8}$/.test(details.turnId) ? details.turnId : undefined;
    if (turnId && [...this.samples, ...this.paidStarts].some(sample => sample.participant === participant && sample.event === event && sample.turnId === turnId)) return;
    if (this.samples.length >= MAX_EVENTS) {
      this.samples.shift();
      this.droppedEventAt = now;
    }
    const sample = { at: now, event, participant, turnId,
      ...(validDuration(details.durationMs) ? { durationMs: details.durationMs } : {}) };
    this.samples.push(sample);
    if (event === 'wake_accepted') {
      if (this.paidStarts.length >= MAX_EVENTS) { this.paidStarts.shift(); this.droppedEventAt = now; }
      this.paidStarts.push(sample);
    }
    this.processCounts[event]++;
  }

  /** Forget identity and participant details while retaining anonymous aggregate evidence. */
  forget(userId: string): void {
    const participant = this.participants.get(userId);
    if (!participant) return;
    this.participants.delete(userId);
    for (const sample of [...this.samples, ...this.paidStarts]) if (sample.participant === participant) sample.participant = undefined;
  }

  clearParticipants(): void {
    this.participants.clear();
    for (const sample of [...this.samples, ...this.paidStarts]) sample.participant = undefined;
  }

  disconnect(reason: DisconnectReason): void {
    if (disconnectReasons.has(reason)) this.lastDisconnect = { reason, at: this.now() };
  }

  snapshot(): VoiceAdmissionSnapshot {
    const now = this.now();
    this.expire(now);
    const recent = counts();
    for (const sample of this.samples) recent[sample.event]++;
    recent.wake_accepted = this.paidStarts.length;
    const participants = [...this.participants.values()].map(participant => {
      const own = this.samples.filter(sample => sample.participant === participant);
      const ownCounts = counts();
      for (const sample of own) ownCounts[sample.event]++;
      ownCounts.wake_accepted = this.paidStarts.filter(sample => sample.participant === participant).length;
      return { participant: participant.label, counts: ownCounts,
        first_audio_ms: durationSummary(own, 'first_audio'), busy_ms: durationSummary(own, 'turn_released') };
    });
    return { scope: 'current_process', deployed_revision: this.revision,
      window_ms: WINDOW_MS, elapsed_ms: Math.max(0, now - this.started), retained_events: this.samples.length,
      window_complete: this.droppedEventAt <= now - WINDOW_MS,
      participants_complete: this.droppedParticipantAt <= now - WINDOW_MS,
      recent, process: { ...this.processCounts }, paid_starts_in_window: recent.wake_accepted, participants,
      last_disconnect: this.lastDisconnect ? { reason: this.lastDisconnect.reason, ago_ms: Math.max(0, now - this.lastDisconnect.at) } : null };
  }

  /** Bounded Discord pages: all labels and enum keys are generated locally. */
  pages(): string[] {
    const snapshot = this.snapshot();
    const nonzero = (values: Readonly<Counts>): string => voiceAdmissionEvents
      .filter(event => values[event] > 0).map(event => `${event}=${values[event]}`).join('; ') || 'sem eventos';
    const timing = (value: VoiceDurationSummary): string => value.n
      ? `n=${value.n}, p50/p90/p95/máx=${[value.p50_ms, value.p90_ms, value.p95_ms, value.max_ms].map(ms => ms!.toFixed(1)).join('/')} ms`
      : 'sem amostras';
    const rows = [
      `Revisão Render: ${snapshot.deployed_revision ?? 'não informada'}; somente este processo. Janela móvel de 60 s, até 256 eventos; completa=${snapshot.window_complete ? 'sim' : 'não'}; participantes completos=${snapshot.participants_complete ? 'sim' : 'não'}.`,
      `Recentes: ${nonzero(snapshot.recent)}.`,
      `Inícios pagos wake observados na janela: ${snapshot.paid_starts_in_window}; não estima créditos faturados.`,
      `Acumulado deste processo: ${nonzero(snapshot.process)}.`,
      `Última desconexão: ${snapshot.last_disconnect ? `${snapshot.last_disconnect.reason}, há ${Math.floor(snapshot.last_disconnect.ago_ms / 1000)} s` : 'sem observação'}.`,
      ...snapshot.participants.flatMap(participant => [
        `${participant.participant}: ${nonzero(participant.counts)}.`,
        `${participant.participant}: primeiro PCM remoto ${timing(participant.first_audio_ms)}; ocupado por turno ${timing(participant.busy_ms)}.`,
      ]),
      'Confirmação, entrega não confirmada e parcial são contagens distintas. Primeiro PCM remoto não comprova audição no Discord.',
    ];
    const pages: string[] = [];
    let page = 'Admissão de voz multiusuário';
    for (const row of rows) {
      if (page.length + row.length + 1 > 1500) { pages.push(page); page = 'Admissão de voz multiusuário'; }
      page += `\n${row}`;
    }
    pages.push(page);
    return pages;
  }

  private expire(now: number): void {
    while (this.samples[0] && this.samples[0].at <= now - WINDOW_MS) this.samples.shift();
    while (this.paidStarts[0] && this.paidStarts[0].at <= now - WINDOW_MS) this.paidStarts.shift();
    for (const [id, participant] of this.participants) if (participant.lastSeen <= now - WINDOW_MS) this.forget(id);
  }
}
