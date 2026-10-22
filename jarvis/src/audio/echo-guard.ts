const FRAME_BYTES = 960 * 4;
const FINGERPRINT_SAMPLES = 160;
const MAX_FRAMES = 150;
const MAX_AGE_MS = 3_000;
const MAX_INPUT_BYTES = 4 * 48_000 * 4;
const MIN_RMS = 0.004;

/**
 * Bounded, local echo heuristic, not acoustic echo cancellation. No raw PCM is retained.
 * It recognizes a coherent run of recently played frames despite amplitude changes.
 * Room acoustics and frame alignment can reduce recall; owner/consent gates remain mandatory.
 */
export class PlaybackEchoGuard {
  private readonly frames: { at: number; fingerprint?: Float32Array }[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  remember(frame48kStereo: Buffer): void {
    if (frame48kStereo.length !== FRAME_BYTES) return;
    this.prune();
    this.frames.push({ at: this.now(), fingerprint: this.fingerprint(frame48kStereo) });
    while (this.frames.length > MAX_FRAMES) this.frames.shift()?.fingerprint?.fill(0);
  }

  isLikelyEcho(pcm48kStereo: Buffer): boolean {
    this.prune();
    if (pcm48kStereo.length < FRAME_BYTES * 5 || this.frames.length < 5) return false;
    const limit = Math.min(pcm48kStereo.length, MAX_INPUT_BYTES);
    const incoming: (Float32Array | undefined)[] = [];
    for (let offset = 0; offset + FRAME_BYTES <= limit; offset += FRAME_BYTES) {
      incoming.push(this.fingerprint(pcm48kStereo.subarray(offset, offset + FRAME_BYTES)));
    }
    const voiced = incoming.reduce((count, frame) => count + (frame ? 1 : 0), 0);
    if (voiced < 5) return false;
    let likely = false;
    // A single alignment must explain the entire utterance; isolated matching sounds do not suffice.
    for (let lag = -incoming.length + 5; lag <= this.frames.length - 5 && !likely; lag += 1) {
      let matched = 0;
      let consecutive = 0;
      let longest = 0;
      for (let index = 0; index < incoming.length; index += 1) {
        const input = incoming[index];
        if (!input) { consecutive = 0; continue; }
        const played = this.frames[index + lag]?.fingerprint;
        if (played && this.similarity(input, played) >= 0.92) {
          matched += 1;
          longest = Math.max(longest, ++consecutive);
        } else consecutive = 0;
      }
      likely = longest >= 5 && matched / voiced >= 0.8;
    }
    for (const fingerprint of incoming) fingerprint?.fill(0);
    return likely;
  }

  clear(): void {
    for (const frame of this.frames) frame.fingerprint?.fill(0);
    this.frames.length = 0;
  }

  private prune(): void {
    const cutoff = this.now() - MAX_AGE_MS;
    while (this.frames[0] && this.frames[0].at <= cutoff) this.frames.shift()?.fingerprint?.fill(0);
  }

  private fingerprint(pcm: Buffer): Float32Array | undefined {
    const values = new Float32Array(FINGERPRINT_SAMPLES);
    let mean = 0;
    for (let sample = 0; sample < FINGERPRINT_SAMPLES; sample += 1) {
      const offset = sample * 6 * 4;
      const value = (pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2)) / 65_536;
      values[sample] = value;
      mean += value;
    }
    mean /= FINGERPRINT_SAMPLES;
    let energy = 0;
    for (let sample = 0; sample < values.length; sample += 1) {
      const centered = values[sample]! - mean;
      values[sample] = centered;
      energy += centered * centered;
    }
    if (Math.sqrt(energy / values.length) < MIN_RMS) { values.fill(0); return undefined; }
    const norm = Math.sqrt(energy);
    for (let sample = 0; sample < values.length; sample += 1) values[sample] = values[sample]! / norm;
    return values;
  }

  private similarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let sample = 0; sample < a.length; sample += 1) dot += a[sample]! * b[sample]!;
    return Math.abs(dot);
  }
}
