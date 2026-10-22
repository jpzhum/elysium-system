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

export class WakeError extends Error {
  constructor(readonly code: 'wake_queue_full' | 'wake_queue_timeout' | 'wake_rate_limited' | 'wake_provider_failed') { super(code); }
}

interface InspectionRequest {
  pcm: Buffer;
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
  private window = Date.now();
  private checks = 0;
  private checking = false;
  private readonly waiting: InspectionRequest[] = [];
  constructor(private readonly apiKey: string, private readonly wakeWord: string,
    private readonly perMinute: number, private readonly metric: (name: string, value?: number) => void,
    private readonly request: typeof fetch = fetch) {}

  async detect(pcm48kStereo: Buffer, signal?: AbortSignal): Promise<boolean> {
    return (await this.inspect(pcm48kStereo, signal)).activated;
  }

  /** One bounded STT call for wake and stop intent; callers must authorize the Discord ID separately. */
  inspect(pcm48kStereo: Buffer, signal?: AbortSignal,
    options: { allowInterruption?: boolean } = {}): Promise<WakeInspection> {
    if (signal?.aborted || pcm48kStereo.length < 19_200 || pcm48kStereo.length % 4 !== 0) {
      return Promise.resolve(NOT_ACTIVATED);
    }
    if (this.checking && this.waiting.length >= MAX_WAITING) {
      this.metric('wake_queue_full'); return Promise.reject(new WakeError('wake_queue_full'));
    }
    return new Promise<WakeInspection>((resolve, reject) => {
      // Own only a bounded copy. Neither cancellation nor another speaker can mutate caller audio.
      const entry: InspectionRequest = { pcm: Buffer.from(pcm48kStereo.subarray(0, MAX_CAPTURE_BYTES)),
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
    if (entry.signal?.aborted) return NOT_ACTIVATED;
    if (Date.now() - this.window >= 60_000) { this.window = Date.now(); this.checks = 0; }
    if (this.checks >= this.perMinute) { this.metric('wake_rate_limited'); throw new WakeError('wake_rate_limited'); }
    this.checks += 1;
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
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 8_000);
    timer.unref();
    const combined = entry.signal ? AbortSignal.any([entry.signal, timeout.signal]) : timeout.signal;
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
      const activated = containsWakeWord(text, this.wakeWord);
      if (activated) this.metric('wake_activations');
      return { activated, interrupt: entry.interrupt && typeof text === 'string' &&
        isExplicitStopCommand(text, this.wakeWord) };
    } catch {
      if (entry.signal?.aborted) { this.metric('wake_cancelled'); return NOT_ACTIVATED; }
      this.metric('wake_provider_errors');
      throw new WakeError('wake_provider_failed');
    } finally {
      clearTimeout(timer);
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
