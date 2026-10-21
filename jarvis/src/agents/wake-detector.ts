import { convertPcm } from '../audio/pcm-conversion.js';
import { limitedJson } from '../network/limited-json.js';

export function containsWakeWord(text: string, wakeWord = 'Jarvis'): boolean {
  const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const wake = normalize(wakeWord);
  return words.some((word) => word === wake || (wake === 'jarvis' && word === 'djarvis'));
}

/** Experimental, paid, external wake detection. Audio consent MUST disclose pre-wake upload. */
export class ElevenWakeDetector {
  private window = Date.now();
  private checks = 0;
  constructor(private readonly apiKey: string, private readonly wakeWord: string,
    private readonly perMinute: number, private readonly metric: (name: string, value?: number) => void,
    private readonly request: typeof fetch = fetch) {}

  async detect(pcm48kStereo: Buffer, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (Date.now() - this.window >= 60_000) { this.window = Date.now(); this.checks = 0; }
    if (++this.checks > this.perMinute) { this.metric('wake_rate_limited'); return false; }
    // Only the leading four seconds are inspected. The complete bounded turn is sent to the agent after activation.
    const pcm = convertPcm(pcm48kStereo.subarray(0, 4 * 48_000 * 4), 48_000, 2, 16_000, 1);
    if (pcm.length < 3200) return false;
    const form = new FormData();
    form.set('model_id', 'scribe_v2');
    form.set('language_code', 'por');
    form.set('file_format', 'pcm_s16le_16');
    form.set('tag_audio_events', 'false');
    form.set('timestamps_granularity', 'none');
    form.set('file', new Blob([new Uint8Array(pcm)], { type: 'application/octet-stream' }), 'wake.pcm');
    this.metric('wake_checks');
    this.metric('wake_audio_seconds', pcm.length / 32_000);
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    try {
      const response = await this.request('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form, signal: combined, redirect: 'error',
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        this.metric('wake_provider_errors'); return false;
      }
      // Content is transient and never logged or shared with other speakers.
      const data = await limitedJson(response, 65_536, combined);
      if (combined.aborted) return false;
      const text = data && typeof data === 'object' && 'text' in data ? data.text : undefined;
      const activated = typeof text === 'string' && containsWakeWord(text, this.wakeWord);
      if (activated) this.metric('wake_activations');
      return activated;
    } catch { this.metric('wake_provider_errors'); return false; }
  }
}
