import { WindowedSinc } from './windowed-sinc.js';

interface Chunk { pcm: Buffer; start: number; end: number; final: boolean; }
interface Options {
  maxBufferBytes: number;
  maxSeconds: number;
  onBufferDelta?: (delta: number) => void;
  onChunkPlayed?: () => void;
  onConversionMs?: (milliseconds: number) => void;
}

/** Bounded mono PCM ingress and continuous windowed-sinc resampling to 48 kHz stereo. */
export class StreamingPcm {
  private readonly chunks: Chunk[] = [];
  private sampleChunk: Chunk | undefined;
  private bytes = 0;
  private samples = 0;
  private outputFrame = 0;
  private ended = false;
  private cancelled = false;
  private writing = false;
  private waitingInput = false;
  private wake: (() => void) | undefined;
  private capacity: (() => void) | undefined;
  private readonly radius: number;
  private readonly filter: WindowedSinc;
  constructor(private readonly sampleRate: number, private readonly options: Options) {
    this.filter = new WindowedSinc(sampleRate, 48_000);
    this.radius = this.filter.radius;
  }
  get hasInput(): boolean { return this.samples > 0 || this.ended; }
  get bufferedBytes(): number { return this.bytes; }
  /** No further complete frame can be generated without new input; not generation completion. */
  get waitingForInput(): boolean { return this.waitingInput; }

  async write(pcm: Buffer, allowed: () => boolean): Promise<void> {
    if (!pcm.length || pcm.length % 2 !== 0) throw new Error('Formato PCM de reprodução inválido.');
    if (pcm.length > this.options.maxBufferBytes) throw new Error('Bloco de áudio excedeu o limite de memória.');
    if (this.samples + pcm.length / 2 > this.options.maxSeconds * this.sampleRate) throw new Error('Resposta de áudio excedeu o limite de duração.');
    if (this.writing) throw new Error('Envio simultâneo de áudio excedeu o limite.');
    this.writing = true;
    try {
      // Small owned segments let consumed prefixes release capacity while the
      // filter retains its boundary history; a full-size provider chunk cannot
      // deadlock the lookahead needed to accept the following provider chunk.
      const segmentBytes = Math.min(16_384, Math.floor(this.options.maxBufferBytes / 4) * 2);
      for (let offset = 0; offset < pcm.length; offset += segmentBytes) {
        const length = Math.min(segmentBytes, pcm.length - offset);
        while (!this.cancelled && !this.ended && allowed() &&
          (this.bytes + length > this.options.maxBufferBytes || this.chunks.length >= 1_024)) {
          await new Promise<void>((resolve) => { this.capacity = resolve; });
        }
        if (this.cancelled || this.ended || !allowed()) throw new Error('Reprodução cancelada.');
        const copy = Buffer.from(pcm.subarray(offset, offset + segmentBytes));
        const end = this.samples + copy.length / 2;
        this.chunks.push({ pcm: copy, start: this.samples, end, final: offset + copy.length === pcm.length });
        this.samples = end;
        this.bytes += copy.length;
        this.options.onBufferDelta?.(copy.length);
        this.notify();
      }
    } finally { this.writing = false; }
  }

  end(): void { this.ended = true; this.notify(); }
  cancel(): void {
    this.cancelled = true;
    for (const chunk of this.chunks.splice(0)) chunk.pcm.fill(0);
    this.sampleChunk = undefined;
    if (this.bytes) this.options.onBufferDelta?.(-this.bytes);
    this.bytes = 0;
    this.notify();
  }

  async *frames(): AsyncGenerator<Buffer> {
    let frame = Buffer.alloc(960 * 4);
    let frameSamples = 0;
    let computingSince: number | undefined = performance.now();
    const measure = () => {
      if (computingSince !== undefined) this.options.onConversionMs?.(Math.max(0, performance.now() - computingSince));
      computingSince = undefined;
    };
    try {
      while (!this.cancelled) {
        const total = Math.floor(this.samples * 48_000 / this.sampleRate);
        const position = this.outputFrame * this.sampleRate / 48_000;
        if (this.ended && this.outputFrame >= total) break;
        // Lookahead preserves filter state across arbitrary provider chunk boundaries.
        if (!this.ended && Math.floor(position) + this.radius >= this.samples) {
          measure();
          this.waitingInput = true;
          await new Promise<void>((resolve) => { this.wake = resolve; });
          this.waitingInput = false;
          computingSince = performance.now();
          continue;
        }
        const value = this.interpolate(position);
        frame.writeInt16LE(value, frameSamples * 4);
        frame.writeInt16LE(value, frameSamples * 4 + 2);
        frameSamples++;
        this.outputFrame++;
        this.release(Math.floor(this.outputFrame * this.sampleRate / 48_000) - this.radius + 1);
        if (this.ended && this.outputFrame >= total) this.release(Infinity);
        if (frameSamples === 960) {
          measure();
          yield frame;
          computingSince = performance.now();
          frame = Buffer.alloc(960 * 4);
          frameSamples = 0;
        }
      }
      // Only an explicit ingress end pads the final partial frame, never a gap.
      if (!this.cancelled && frameSamples > 0) {
        measure();
        yield frame;
        computingSince = performance.now();
      }
      if (!this.cancelled) this.release(Infinity);
    } finally { this.waitingInput = false; measure(); frame.fill(0); }
  }

  private interpolate(position: number): number {
    const center = Math.floor(position);
    const kernel = this.filter.at(position);
    let value = 0;
    for (let index = 0; index < kernel.weights.length; index++) {
      value += this.sample(center - this.radius + 1 + index) * kernel.weights[index]!;
    }
    return Math.max(-32_768, Math.min(32_767, Math.round(value / kernel.sum)));
  }

  private sample(index: number): number {
    const target = Math.max(0, Math.min(this.samples - 1, index));
    const cached = this.sampleChunk;
    if (cached && target >= cached.start && target < cached.end) return cached.pcm.readInt16LE((target - cached.start) * 2);
    let low = 0;
    let high = this.chunks.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const chunk = this.chunks[middle]!;
      if (target < chunk.start) high = middle - 1;
      else if (target >= chunk.end) low = middle + 1;
      else {
        this.sampleChunk = chunk;
        return chunk.pcm.readInt16LE((target - chunk.start) * 2);
      }
    }
    throw new Error('Sequência PCM indisponível.');
  }

  private release(before: number): void {
    while (this.chunks[0] && this.chunks[0].end <= before) {
      const chunk = this.chunks.shift()!;
      if (this.sampleChunk === chunk) this.sampleChunk = undefined;
      this.bytes -= chunk.pcm.length;
      this.options.onBufferDelta?.(-chunk.pcm.length);
      // This means consumed by the resampler/handed to the player, not heard remotely.
      if (chunk.final) this.options.onChunkPlayed?.();
      chunk.pcm.fill(0);
      this.capacity?.();
      this.capacity = undefined;
    }
  }

  private notify(): void {
    this.wake?.(); this.wake = undefined;
    this.capacity?.(); this.capacity = undefined;
  }
}
