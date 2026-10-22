/** Capture metadata contains no PCM, transcript, question, or provider identity. */
export interface CaptureTiming {
  readonly captureMs: number;
  readonly endDetectionMs: number;
  readonly captureId?: string;
  readonly captureStartedAtMs?: number;
  readonly captureEndedAtMs?: number;
}

interface Window {
  id?: string;
  start?: number;
  end?: number;
  expires: number;
}
interface SpeakerWindows {
  consentVersion: number;
  channelId: string;
  windows: Window[];
}

/**
 * Bounded, ephemeral replay protection for the same Discord capture, rather than
 * speech content. Consecutive, non-overlapping questions may be identical.
 * performance.now() is shared by the receiver and manager in this process.
 */
export class CaptureWindows {
  private readonly speakers = new Map<string, SpeakerWindows>();
  constructor(private readonly ttlMs = 120_000, private readonly maxSpeakers = 16,
    private readonly maxWindows = 16) {}

  duplicate(userId: string, consentVersion: number, channelId: string,
    timing: CaptureTiming | undefined, now = performance.now()): boolean {
    if (!timing) return false; // Compatibility with trusted callers without capture metadata.
    const id = typeof timing.captureId === 'string' && timing.captureId.length > 0 &&
      timing.captureId.length <= 96 ? timing.captureId : undefined;
    const start = timing.captureStartedAtMs;
    const end = timing.captureEndedAtMs;
    const validWindow = typeof start === 'number' && typeof end === 'number' &&
      Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && end - start <= 120_000;
    if (!id && !validWindow) return false;
    for (const [speaker, value] of this.speakers) {
      value.windows = value.windows.filter(window => window.expires > now);
      if (!value.windows.length) this.speakers.delete(speaker);
    }
    let current = this.speakers.get(userId);
    if (current && (current.consentVersion !== consentVersion || current.channelId !== channelId)) {
      this.speakers.delete(userId); current = undefined;
    }
    if (current?.windows.some(window => (id !== undefined && window.id === id) ||
      (validWindow && window.start !== undefined && window.end !== undefined &&
        start! < window.end && end! > window.start))) return true;
    if (!current) {
      if (this.speakers.size >= this.maxSpeakers) {
        const oldest = this.speakers.keys().next().value;
        if (oldest !== undefined) this.speakers.delete(oldest);
      }
      current = { consentVersion, channelId, windows: [] };
      this.speakers.set(userId, current);
    }
    if (current.windows.length >= this.maxWindows) current.windows.shift();
    current.windows.push({ id, ...(validWindow ? { start, end } : {}), expires: now + this.ttlMs });
    return false;
  }

  forget(userId: string): void { this.speakers.delete(userId); }
  clear(): void { this.speakers.clear(); }
}
