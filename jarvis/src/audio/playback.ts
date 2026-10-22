import { Readable } from 'node:stream';
import {
  AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource,
  type AudioPlayer, type AudioResource, type PlayerSubscription, type VoiceConnection,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { StreamingPcm } from './streaming-pcm.js';

export interface PlaybackStream {
  readonly done: Promise<void>;
  write(pcmMono: Buffer): Promise<void>;
  /** Ends ingress; neither generation nor conversation completion is inferred here. */
  end(): void;
  cancel(): void;
}

export interface PlaybackOptions {
  maxQueue?: number;
  maxSeconds?: number;
  maxBufferBytes?: number;
  /** Absolute resource lifetime, including queue and generation gaps. */
  maxWallMs?: number;
  onMetric?: (name: string, value: number) => void;
  player?: AudioPlayer;
}

interface Playback {
  userId: string;
  isOwner: boolean;
  source: StreamingPcm;
  allowed: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  resource?: AudioResource;
  stream?: Readable;
  deadline?: NodeJS.Timeout;
  finished: boolean;
  settled: boolean;
  consumedChunks: number;
  packetChunks: WeakMap<Buffer, number>;
}

class PlaybackCancelledError extends Error {
  constructor() { super('Reprodução cancelada.'); }
}

/** A final guard also fences packets prefetched before consent was revoked. */
class GuardedStream extends Readable {
  private pulling = false;
  constructor(
    private readonly packets: AsyncGenerator<Buffer>,
    private readonly allowed: () => boolean,
    private readonly denied: () => void,
    private readonly consumed: (packet: Buffer) => void,
  ) { super({ objectMode: true, highWaterMark: 2 }); }

  override read(size?: number): Buffer | null {
    if (!this.allowed()) { this.denied(); return null; }
    const packet = super.read(size) as Buffer | null;
    if (packet) this.consumed(packet);
    return packet;
  }

  override _read(): void {
    if (this.pulling) return;
    if (!this.allowed()) { this.denied(); return; }
    this.pulling = true;
    void this.packets.next().then((result) => {
      this.pulling = false;
      if (this.destroyed) return;
      if (!this.allowed()) { this.denied(); return; }
      this.push(result.done ? null : result.value);
    }, () => this.destroy(new Error('Falha ao codificar reprodução.')));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.packets.return(undefined).catch(() => undefined);
    callback(error);
  }
}

/** One stream per response, with owner priority only between queued streams. */
export class PlaybackQueue {
  private readonly player: AudioPlayer;
  private readonly subscription: PlayerSubscription;
  private readonly waiting: Playback[] = [];
  private active: Playback | undefined;
  private stopped = false;
  private disconnected = false;
  private readonly maxQueue: number;
  private readonly maxSeconds: number;
  private readonly maxBufferBytes: number;
  private readonly maxWallMs: number;
  private readonly onConnectionState = (_before: unknown, next: { status: string }): void => {
    if (next.status === VoiceConnectionStatus.Destroyed) this.stop();
    else if (next.status === VoiceConnectionStatus.Disconnected) {
      this.disconnected = true;
      this.cancelAll();
    } else if (next.status === VoiceConnectionStatus.Ready) this.disconnected = false;
  };

  constructor(private readonly connection: VoiceConnection, private readonly options: PlaybackOptions = {}) {
    this.maxQueue = options.maxQueue ?? 4;
    this.maxSeconds = options.maxSeconds ?? 120;
    this.maxBufferBytes = options.maxBufferBytes ?? 384 * 1024;
    this.maxWallMs = options.maxWallMs ?? this.maxSeconds * 1_000 + 60_000;
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1 || this.maxQueue > 32 ||
      !Number.isFinite(this.maxSeconds) || this.maxSeconds < 1 || this.maxSeconds > 120 ||
      !Number.isInteger(this.maxBufferBytes) || this.maxBufferBytes % 2 !== 0 || this.maxBufferBytes < 512 || this.maxBufferBytes > 4 * 1024 * 1024 ||
      !Number.isFinite(this.maxWallMs) || this.maxWallMs < 1 || this.maxWallMs > 300_000) {
      throw new RangeError('Limites da fila de áudio inválidos.');
    }
    // The voice default ends a resource after five missing frames. Generation gaps
    // remain open instead; the separate absolute deadline bounds resource lifetime.
    this.player = options.player ?? createAudioPlayer({ behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: Number.MAX_SAFE_INTEGER,
    } });
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.active) this.complete(this.active, this.active.finished
        ? undefined : new Error('Reprodução encerrada antes de esvaziar o fluxo.'));
    });
    this.player.on('error', (error) => {
      if (this.active && error.resource === this.active.resource) {
        this.options.onMetric?.('playback_errors', 1);
        this.complete(this.active, new Error('Falha ao reproduzir áudio.'));
      }
    });
    const subscription = connection.subscribe(this.player);
    if (!subscription) throw new Error('Conexão de voz indisponível para reprodução.');
    this.subscription = subscription;
    connection.on('stateChange', this.onConnectionState);
  }

  get isPlaying(): boolean { return this.active !== undefined || this.waiting.length > 0; }

  startStream(userId: string, sampleRate: number, isOwner: boolean,
    options: { isAllowed?: () => boolean } = {}): PlaybackStream {
    if (this.stopped) this.rejectStart('Fila de áudio encerrada.', true);
    if (this.disconnected) this.rejectStart('Conexão de voz indisponível para reprodução.', true);
    if (this.waiting.length + Number(this.active !== undefined) >= this.maxQueue) this.rejectStart('Fila de áudio cheia.');
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) this.rejectStart('Formato PCM de reprodução inválido.');
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => undefined);
    const item: Playback = {
      userId, isOwner, resolve, reject, finished: false, settled: false,
      consumedChunks: 0, packetChunks: new WeakMap(),
      allowed: () => !this.stopped && !this.disconnected && !item.settled && (options.isAllowed?.() ?? true),
      source: new StreamingPcm(sampleRate, {
        maxBufferBytes: this.maxBufferBytes, maxSeconds: this.maxSeconds,
        onBufferDelta: (delta) => this.options.onMetric?.('audio_stream_buffer_bytes', delta),
        onChunkPlayed: () => { item.consumedChunks++; },
      }),
    };
    const guestIndex = this.waiting.findIndex((queued) => !queued.isOwner);
    if (isOwner && guestIndex >= 0) this.waiting.splice(guestIndex, 0, item);
    else this.waiting.push(item);
    item.deadline = setTimeout(() => this.complete(item, new Error('Reprodução excedeu o prazo.')), this.maxWallMs);
    item.deadline.unref();
    return {
      done,
      write: async (pcm) => {
        try {
          if (!item.allowed()) throw new PlaybackCancelledError();
          const writing = item.source.write(pcm, item.allowed);
          this.pump();
          await writing;
          if (!item.allowed()) throw new PlaybackCancelledError();
          this.pump();
        } catch (error) {
          const safe = !item.allowed() ? new PlaybackCancelledError()
            : error instanceof Error ? error : new Error('Falha ao receber áudio.');
          this.complete(item, safe);
          throw safe;
        }
      },
      end: () => { if (!item.settled) { item.source.end(); this.pump(); } },
      cancel: () => this.complete(item, new PlaybackCancelledError()),
    };
  }

  async play(userId: string, pcmMono: Buffer, sampleRate: number, isOwner: boolean): Promise<void> {
    if (!pcmMono.length || pcmMono.length % 2 !== 0) this.rejectStart('Formato PCM de reprodução inválido.');
    if (pcmMono.length / (sampleRate * 2) > this.maxSeconds) this.rejectStart('Resposta de áudio excedeu o limite de duração.');
    const stream = this.startStream(userId, sampleRate, isOwner);
    try {
      for (let offset = 0; offset < pcmMono.length; offset += this.maxBufferBytes) {
        await stream.write(pcmMono.subarray(offset, offset + this.maxBufferBytes));
      }
      stream.end();
      await stream.done;
    } catch (error) { stream.cancel(); throw error; }
  }

  stopUser(userId: string): void {
    for (const item of [...this.waiting, ...(this.active ? [this.active] : [])]) {
      if (item.userId === userId) this.complete(item, new PlaybackCancelledError());
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.connection.off('stateChange', this.onConnectionState);
    this.cancelAll();
    this.player.stop(true);
    this.subscription.unsubscribe();
  }

  private pump(): void {
    if (this.stopped || this.disconnected || this.active) return;
    const item = this.waiting[0];
    if (!item || !item.source.hasInput) return;
    this.waiting.shift();
    this.active = item;
    if (!item.allowed()) { this.complete(item, new PlaybackCancelledError()); return; }
    try {
      item.stream = new GuardedStream(this.encode(item), item.allowed,
        () => this.complete(item, new PlaybackCancelledError()), (packet) => {
          const count = item.packetChunks.get(packet) ?? 0;
          if (count) this.options.onMetric?.('audio_chunks_played', count);
          item.packetChunks.delete(packet);
        });
      item.stream.on('error', () => this.complete(item, new Error('Falha ao preparar reprodução.')));
      item.resource = createAudioResource(item.stream, { inputType: StreamType.Opus });
      this.player.play(item.resource);
      this.options.onMetric?.('audio_stream_started', 1);
      this.options.onMetric?.('playback_started', 1);
    } catch { this.complete(item, new Error('Falha ao preparar reprodução.')); }
  }

  private async *encode(item: Playback): AsyncGenerator<Buffer> {
    const codec = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    try {
      for await (const frame of item.source.frames()) {
        try {
          if (!item.allowed()) throw new PlaybackCancelledError();
          const packet = codec.encode(frame, 960);
          item.packetChunks.set(packet, item.consumedChunks);
          item.consumedChunks = 0;
          yield packet;
        } finally { frame.fill(0); }
      }
      item.finished = true;
    } finally { codec.delete(); }
  }

  private complete(item: Playback, error?: Error): void {
    if (item.settled) return;
    item.settled = true;
    if (item.deadline) clearTimeout(item.deadline);
    const wasActive = this.active === item;
    if (wasActive) this.active = undefined;
    const index = this.waiting.indexOf(item);
    if (index >= 0) this.waiting.splice(index, 1);
    item.source.cancel();
    item.stream?.destroy();
    if (wasActive && error) this.player.stop(true);
    if (error) {
      this.options.onMetric?.(error instanceof PlaybackCancelledError ? 'playback_cancelled' : 'playback_failed', 1);
      item.reject(error);
    }
    else {
      this.options.onMetric?.('playback_seconds', (item.resource?.playbackDuration ?? 0) / 1_000);
      this.options.onMetric?.('playback_completed', 1);
      item.resolve();
    }
    this.pump();
  }

  private cancelAll(): void {
    for (const item of [...this.waiting, ...(this.active ? [this.active] : [])]) {
      this.complete(item, new PlaybackCancelledError());
    }
  }

  private rejectStart(message: string, cancelled = false): never {
    this.options.onMetric?.(cancelled ? 'playback_cancelled' : 'playback_failed', 1);
    throw new Error(message);
  }
}
