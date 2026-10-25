import { convertPcm } from '../audio/pcm-conversion.js';
import { limitedJson } from '../network/limited-json.js';
import { containsWakeWord } from '../audio/wakeword.js';

export { containsWakeWord } from '../audio/wakeword.js';

export interface WakeInspection {
  readonly activated: boolean;
  readonly interrupt: boolean;
}

/** Classifies an entire utterance, never a declaration of identity or authority. */
export function isExplicitStopCommand(text: string, wakeWord = 'Jarvis'): boolean {
  const words = text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length === 2 && containsWakeWord(words[0]!, wakeWord) &&
    (words[1] === 'parar' || words[1] === 'cancela');
}

const NOT_ACTIVATED: WakeInspection = Object.freeze({ activated: false, interrupt: false });
const MAX_CAPTURE_BYTES = 4 * 48_000 * 4;
const MAX_WAITING = 2;
const MAX_WAIT_MS = 8_000;
const BUDGET_WINDOW_MS = 60_000;
const MAX_ADMISSION_SPEAKERS = 16;
const NEGATIVE_WAKE_BASE_MS = 10_000;

/** Only authenticated backend context may be supplied; never inferred from STT. */
export interface WakeAdmissionContext {
  readonly discordUserId: string;
  readonly consentVersion: number;
  readonly channelId: string;
}

interface AdmissionRecord {
  readonly speaker: WakeAdmissionContext;
  misses: number;
  retryAt: number;
  expiresAt: number;
}

export type WakeRateLimitSource = 'global_budget' | 'speaker_backoff' | 'speaker_budget';
export type WakeObservationEvent = 'wake_requested' | 'wake_accepted' | 'wake_cooldown_rejected'
  | 'wake_global_rejected' | 'wake_fair_share_rejected' | 'wake_valid';

export class WakeError extends Error {
  readonly retryAfterMs?: number;
  readonly rateLimitSource?: WakeRateLimitSource;
  constructor(readonly code: 'wake_queue_full' | 'wake_queue_timeout' | 'wake_rate_limited' | 'wake_provider_failed',
    retryAfterMs?: number, rateLimitSource: WakeRateLimitSource = 'global_budget') {
    super(code);
    if (code === 'wake_rate_limited') this.rateLimitSource = rateLimitSource;
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= BUDGET_WINDOW_MS) {
      this.retryAfterMs = Math.ceil(retryAfterMs);
    }
  }
}

interface InspectionRequest {
  pcm: Buffer;
  admission?: AdmissionRecord;
  signal?: AbortSignal;
  interrupt: boolean;
  enqueuedAt: number;
  resolve: (value: WakeInspection) => void;
  reject: (error: WakeError) => void;
  wait?: NodeJS.Timeout;
  onAbort?: () => void;
}

/** Experimental, paid, external wake detection. Audio consent MUST disclose pre-wake upload. */
export class ElevenWakeDetector {
  private readonly checkStarts: { at: number; userId?: string }[] = [];
  private readonly admissions = new Map<string, AdmissionRecord>();
  private participants?: Map<string, WakeAdmissionContext>;
  private observer?: (speaker: WakeAdmissionContext, event: WakeObservationEvent) => void;
  private checking = false;
  private readonly waiting: InspectionRequest[] = [];
  constructor(private readonly apiKey: string, private readonly wakeWord: string,
    private readonly perMinute: number, private readonly metric: (name: string, value?: number) => void,
    private readonly request: typeof fetch = fetch) {}

  /** Shared paid-call capacity in a rolling minute; no identity or transcript is exposed. */
  get operationalState(): Readonly<{ remaining: number; queued: number; active: boolean; retryAfterMs: number }> {
    const now = performance.now();
    while (this.checkStarts[0] !== undefined && this.checkStarts[0].at <= now - BUDGET_WINDOW_MS) this.checkStarts.shift();
    const remaining = Math.max(0, this.perMinute - this.checkStarts.length);
    return Object.freeze({ remaining, queued: this.waiting.length, active: this.checking,
      retryAfterMs: remaining > 0 ? 0 : Math.max(0, Math.ceil(this.checkStarts[0]!.at + BUDGET_WINDOW_MS - now)) });
  }

  get fairnessState(): Readonly<{ participants: number; perSpeaker: number }> {
    const participants = this.participants?.size ?? 0;
    return Object.freeze({ participants, perSpeaker: Math.max(1, Math.ceil(this.perMinute / Math.max(1, participants))) });
  }

  /** The caller supplies current audio-consented members; this never grants consent. */
  setParticipants(speakers: readonly WakeAdmissionContext[]): void {
    const participants = new Map<string, WakeAdmissionContext>();
    for (const speaker of speakers) {
      participants.set(speaker.discordUserId, { discordUserId: speaker.discordUserId,
        consentVersion: speaker.consentVersion, channelId: speaker.channelId });
    }
    this.participants = participants;
    for (const [id, record] of this.admissions) {
      if (!this.registered(record.speaker)) this.admissions.delete(id);
    }
  }

  /** Technical events remain in process; consumers must mask identities before rendering. */
  setObserver(observer?: (speaker: WakeAdmissionContext, event: WakeObservationEvent) => void): void {
    this.observer = observer;
  }

  get admissionState(): Readonly<{ tracked: number; backingOff: number }> {
    this.expireAdmission();
    const now = performance.now();
    return Object.freeze({ tracked: this.admissions.size,
      backingOff: [...this.admissions.values()].filter(record => record.retryAt > now).length });
  }

  /** Clear consent-scoped admission only; never reset the worker's paid-call ceiling. */
  forget(userId: string): void { this.admissions.delete(userId); this.participants?.delete(userId); }
  clearAdmission(): void { this.admissions.clear(); this.participants = undefined; }

  async detect(pcm48kStereo: Buffer, signal?: AbortSignal, speaker?: WakeAdmissionContext): Promise<boolean> {
    return (await this.inspect(pcm48kStereo, signal, { speaker })).activated;
  }

  /** One bounded STT call for wake and stop intent; callers must authorize the Discord ID separately. */
  inspect(pcm48kStereo: Buffer, signal?: AbortSignal,
    options: { allowInterruption?: boolean; speaker?: WakeAdmissionContext } = {}): Promise<WakeInspection> {
    if (signal?.aborted || pcm48kStereo.length < 19_200 || pcm48kStereo.length % 4 !== 0) {
      return Promise.resolve(NOT_ACTIVATED);
    }
    this.observe(options.speaker, 'wake_requested');
    if (options.speaker && !this.registered(options.speaker)) return Promise.resolve(NOT_ACTIVATED);
    const admission = options.speaker ? this.admission(options.speaker) : undefined;
    const backoff = admission ? this.backoff(admission) : undefined;
    if (backoff) return Promise.reject(backoff);
    const budget = this.operationalState;
    if (!budget.remaining) {
      this.observe(options.speaker, 'wake_global_rejected');
      this.metric('wake_rate_limited'); return Promise.reject(new WakeError('wake_rate_limited', budget.retryAfterMs));
    }
    const fairShare = options.speaker ? this.fairShare(options.speaker) : undefined;
    if (fairShare) return Promise.reject(fairShare);
    if (this.checking && this.waiting.length >= MAX_WAITING) {
      this.metric('wake_queue_full'); return Promise.reject(new WakeError('wake_queue_full'));
    }
    return new Promise<WakeInspection>((resolve, reject) => {
      // Own only a bounded copy. Neither cancellation nor another speaker can mutate caller audio.
      const entry: InspectionRequest = { pcm: Buffer.from(pcm48kStereo.subarray(0, MAX_CAPTURE_BYTES)), admission,
        signal, interrupt: options.allowInterruption === true, enqueuedAt: performance.now(), resolve, reject };
      if (!this.checking) { this.start(entry); return; }
      const priority = entry.interrupt ? this.waiting.findIndex((other) => !other.interrupt) : -1;
      if (priority >= 0) this.waiting.splice(priority, 0, entry);
      else this.waiting.push(entry);
      entry.onAbort = () => this.drop(entry, false);
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      entry.wait = setTimeout(() => this.drop(entry, true), MAX_WAIT_MS);
      entry.wait.unref();
      this.metric('wake_queued');
      if (signal?.aborted) this.drop(entry, false);
    });
  }

  private expireAdmission(): void {
    const now = performance.now();
    for (const [id, record] of this.admissions) {
      if (record.expiresAt <= now) this.admissions.delete(id);
    }
  }

  private admission(speaker: WakeAdmissionContext): AdmissionRecord {
    this.expireAdmission();
    const existing = this.admissions.get(speaker.discordUserId);
    if (existing && existing.speaker.consentVersion === speaker.consentVersion &&
      existing.speaker.channelId === speaker.channelId) return existing;
    if (existing) this.admissions.delete(speaker.discordUserId);
    if (this.admissions.size >= MAX_ADMISSION_SPEAKERS) {
      const oldest = this.admissions.keys().next().value;
      if (oldest !== undefined) this.admissions.delete(oldest);
    }
    const record = { speaker: { discordUserId: speaker.discordUserId, consentVersion: speaker.consentVersion,
      channelId: speaker.channelId }, misses: 0, retryAt: 0,
      expiresAt: performance.now() + BUDGET_WINDOW_MS };
    this.admissions.set(speaker.discordUserId, record);
    return record;
  }

  private backoff(record: AdmissionRecord): WakeError | undefined {
    const remaining = record.retryAt - performance.now();
    if (remaining <= 0) return undefined;
    this.observe(record.speaker, 'wake_cooldown_rejected');
    this.metric('wake_speaker_backoff');
    return new WakeError('wake_rate_limited', Math.ceil(remaining), 'speaker_backoff');
  }

  private registered(speaker: WakeAdmissionContext): boolean {
    if (!this.participants) return true; // Trusted standalone callers without a room roster.
    const registered = this.participants.get(speaker.discordUserId);
    return registered?.consentVersion === speaker.consentVersion && registered.channelId === speaker.channelId;
  }

  private fairShare(speaker: WakeAdmissionContext): WakeError | undefined {
    if ((this.participants?.size ?? 0) < 2) return;
    const starts = this.checkStarts.filter(start => start.userId === speaker.discordUserId);
    const limit = this.fairnessState.perSpeaker;
    if (starts.length < limit) return;
    // Cost is charged to the Discord ID, independently of room/consent refresh.
    const retryAfterMs = Math.max(0, Math.ceil(starts[starts.length - limit]!.at + BUDGET_WINDOW_MS - performance.now()));
    this.metric('wake_speaker_rate_limited');
    this.observe(speaker, 'wake_fair_share_rejected');
    return new WakeError('wake_rate_limited', retryAfterMs, 'speaker_budget');
  }

  private observe(speaker: WakeAdmissionContext | undefined, event: WakeObservationEvent): void {
    if (!speaker) return;
    try { this.observer?.(speaker, event); } catch { /* Diagnosis cannot buy, cancel or block a call. */ }
  }

  private currentAdmission(entry: InspectionRequest): boolean {
    return !entry.admission || this.admissions.get(entry.admission.speaker.discordUserId) === entry.admission;
  }

  private recordInspection(entry: InspectionRequest, activated: boolean): void {
    const record = entry.admission;
    if (!record || !this.currentAdmission(entry)) return;
    record.misses = activated ? 0 : Math.min(5, record.misses + 1);
    const delay = record.misses < 2 ? 0
      : Math.min(BUDGET_WINDOW_MS, NEGATIVE_WAKE_BASE_MS * 2 ** (record.misses - 2));
    record.retryAt = activated ? 0 : performance.now() + delay;
    record.expiresAt = performance.now() + BUDGET_WINDOW_MS;
  }

  private drop(entry: InspectionRequest, expired: boolean): void {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    this.cleanupWait(entry);
    entry.pcm.fill(0);
    if (expired) { this.metric('wake_queue_timeout'); entry.reject(new WakeError('wake_queue_timeout')); }
    else { this.metric('wake_cancelled'); entry.resolve(NOT_ACTIVATED); }
  }

  private cleanupWait(entry: InspectionRequest): void {
    if (entry.wait) clearTimeout(entry.wait);
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
  }

  private start(entry: InspectionRequest): void {
    this.cleanupWait(entry);
    this.checking = true;
    void this.execute(entry).then((result) => {
      this.finished(entry);
      entry.resolve(result);
    }, (error: WakeError) => {
      this.finished(entry);
      entry.reject(error);
    });
  }

  private finished(entry: InspectionRequest): void {
    entry.pcm.fill(0);
    this.checking = false;
    while (this.waiting[0] && performance.now() - this.waiting[0].enqueuedAt >= MAX_WAIT_MS) {
      this.drop(this.waiting[0], true);
    }
    const next = this.waiting.shift();
    if (next) this.start(next);
  }

  private async execute(entry: InspectionRequest): Promise<WakeInspection> {
    if (entry.signal?.aborted || !this.currentAdmission(entry)) return NOT_ACTIVATED;
    const backoff = entry.admission ? this.backoff(entry.admission) : undefined;
    if (backoff) throw backoff;
    const budget = this.operationalState;
    if (!budget.remaining) {
      this.observe(entry.admission?.speaker, 'wake_global_rejected');
      this.metric('wake_rate_limited'); throw new WakeError('wake_rate_limited', budget.retryAfterMs);
    }
    const fairShare = entry.admission ? this.fairShare(entry.admission.speaker) : undefined;
    if (fairShare) throw fairShare;
    this.checkStarts.push({ at: performance.now(), userId: entry.admission?.speaker.discordUserId });
    this.observe(entry.admission?.speaker, 'wake_accepted');
    if (entry.admission) entry.admission.expiresAt = performance.now() + BUDGET_WINDOW_MS;
    const started = performance.now();
    this.metric('wake_queue_wait_ms', Math.max(0, Math.round(started - entry.enqueuedAt)));
    // Only the leading four seconds are inspected. The complete bounded turn is sent to the agent after activation.
    const pcm = convertPcm(entry.pcm, 48_000, 2, 16_000, 1);
    const form = new FormData();
    form.set('model_id', 'scribe_v2');
    form.set('language_code', 'por');
    form.set('file_format', 'pcm_s16le_16');
    form.set('tag_audio_events', 'false');
    form.set('timestamps_granularity', 'none');
    form.set('file', new Blob([new Uint8Array(pcm)], { type: 'application/octet-stream' }), 'wake.pcm');
    this.metric('wake_checks');
    this.metric('wake_audio_seconds', pcm.length / 32_000);
    pcm.fill(0);
    this.metric('wake_audio_prepare_ms', Math.max(0, performance.now() - started));
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 8_000);
    timer.unref();
    const combined = entry.signal ? AbortSignal.any([entry.signal, timeout.signal]) : timeout.signal;
    const requestStarted = performance.now();
    try {
      const response = await this.requestAudio(form, combined);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new WakeError('wake_provider_failed');
      }
      // Content is transient and never logged or shared with other speakers.
      const data = await limitedJson(response, 65_536, combined);
      if (combined.aborted) throw new WakeError('wake_provider_failed');
      const text = data && typeof data === 'object' && 'text' in data ? data.text : undefined;
      if (typeof text !== 'string') throw new WakeError('wake_provider_failed');
      if (!this.currentAdmission(entry)) return NOT_ACTIVATED;
      const activated = containsWakeWord(text, this.wakeWord);
      this.recordInspection(entry, activated);
      if (activated) { this.metric('wake_activations'); this.observe(entry.admission?.speaker, 'wake_valid'); }
      return { activated, interrupt: entry.interrupt && typeof text === 'string' &&
        isExplicitStopCommand(text, this.wakeWord) };
    } catch {
      if (entry.signal?.aborted) { this.metric('wake_cancelled'); return NOT_ACTIVATED; }
      this.metric('wake_provider_errors');
      throw new WakeError('wake_provider_failed');
    } finally {
      clearTimeout(timer);
      this.metric('wake_stt_request_ms', Math.max(0, performance.now() - requestStarted));
      this.metric('wake_recognition_ms', Math.round(performance.now() - started));
    }
  }

  private async requestAudio(form: FormData, signal: AbortSignal): Promise<Response> {
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = (): void => rejectAbort(new Error('wake_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error('wake_cancelled');
      const pending = this.request('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form, signal, redirect: 'error',
      });
      // Native fetch honors abort. Also fence noncooperative transports and dispose a late body.
      void pending.then((response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => undefined);
      }, () => undefined);
      return await Promise.race([pending, aborted]);
    } finally { signal.removeEventListener('abort', onAbort); }
  }
}
