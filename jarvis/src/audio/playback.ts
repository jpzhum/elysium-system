import { Readable } from "node:stream";
import {
  AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource,
  type AudioPlayer, type AudioResource, type PlayerSubscription, type VoiceConnection,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { convertPcm } from "./pcm-conversion.js";

export interface PlaybackOptions {
  maxQueue?: number;
  maxSeconds?: number;
  onMetric?: (name: string, value: number) => void;
  /** Optional injected player for isolated scheduling tests. */
  player?: AudioPlayer;
}

interface Playback {
  userId: string;
  isOwner: boolean;
  pcm: Buffer;
  seconds: number;
  resolve: () => void;
  reject: (error: Error) => void;
  resource?: AudioResource;
  stream?: Readable;
  deadline?: NodeJS.Timeout;
}

/** Encodes bounded PCM lazily, one 20 ms packet at a time. No FFmpeg is needed. */
function* encode(pcm: Buffer): Generator<Buffer> {
  const codec = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const frame = Buffer.alloc(960 * 2 * 2);
  try {
    for (let offset = 0; offset < pcm.length; offset += frame.length) {
      frame.fill(0);
      pcm.copy(frame, 0, offset, Math.min(pcm.length, offset + frame.length));
      yield codec.encode(frame, 960);
    }
  } finally {
    frame.fill(0);
    codec.delete();
  }
}

/** One complete response per item. Owner items move ahead of waiting guests. */
export class PlaybackQueue {
  private readonly player: AudioPlayer;
  private readonly subscription: PlayerSubscription;
  private readonly waiting: Playback[] = [];
  private active: Playback | undefined;
  private stopped = false;
  private readonly maxQueue: number;
  private readonly maxSeconds: number;
  private readonly onConnectionState = (_before: unknown, next: { status: string }): void => {
    if (next.status === VoiceConnectionStatus.Destroyed) this.stop();
  };

  constructor(private readonly connection: VoiceConnection, private readonly options: PlaybackOptions = {}) {
    this.maxQueue = options.maxQueue ?? 8;
    this.maxSeconds = options.maxSeconds ?? 30;
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1 || this.maxQueue > 32 ||
      !Number.isFinite(this.maxSeconds) || this.maxSeconds < 1 || this.maxSeconds > 120) {
      throw new RangeError("Limites da fila de áudio inválidos.");
    }
    this.player = options.player ?? createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on(AudioPlayerStatus.Idle, () => this.complete());
    this.player.on("error", (error) => {
      if (this.active && error.resource === this.active.resource) {
        this.options.onMetric?.("playback_errors", 1);
        this.complete(new Error("Falha ao reproduzir áudio."));
      }
    });
    const subscription = connection.subscribe(this.player);
    if (!subscription) throw new Error("Conexão de voz indisponível para reprodução.");
    this.subscription = subscription;
    connection.on("stateChange", this.onConnectionState);
  }

  get isPlaying(): boolean { return this.active !== undefined; }

  async play(userId: string, pcmMono: Buffer, sampleRate: number, isOwner: boolean): Promise<void> {
    if (this.stopped) throw new Error("Fila de áudio encerrada.");
    if (this.waiting.length + Number(this.active !== undefined) >= this.maxQueue) {
      throw new Error("Fila de áudio cheia.");
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
      pcmMono.length % 2 !== 0 || pcmMono.length === 0) {
      throw new Error("Formato PCM de reprodução inválido.");
    }
    const seconds = pcmMono.length / (sampleRate * 2);
    if (seconds > this.maxSeconds) throw new Error("Resposta de áudio excedeu o limite de duração.");
    const pcm = convertPcm(pcmMono, sampleRate, 1, 48_000, 2);
    return new Promise<void>((resolve, reject) => {
      const item: Playback = { userId, isOwner, pcm, seconds, resolve, reject };
      const guestIndex = this.waiting.findIndex((queued) => !queued.isOwner);
      if (isOwner && guestIndex >= 0) this.waiting.splice(guestIndex, 0, item);
      else this.waiting.push(item);
      this.pump();
    });
  }

  stopUser(userId: string): void {
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      const item = this.waiting[index];
      if (item?.userId !== userId) continue;
      this.waiting.splice(index, 1);
      this.dispose(item);
      item.reject(new Error("Reprodução cancelada."));
    }
    if (this.active?.userId === userId) this.complete(new Error("Reprodução cancelada."));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.connection.off("stateChange", this.onConnectionState);
    for (const item of this.waiting.splice(0)) {
      this.dispose(item);
      item.reject(new Error("Reprodução cancelada."));
    }
    this.complete(new Error("Reprodução cancelada."));
    this.player.stop(true);
    this.subscription.unsubscribe();
  }

  private pump(): void {
    if (this.stopped || this.active) return;
    const item = this.waiting.shift();
    if (!item) return;
    this.active = item;
    try {
      item.stream = Readable.from(encode(item.pcm), { objectMode: true, highWaterMark: 2 });
      // AudioPlayer reports resource errors while active; consume late stream errors too.
      item.stream.on("error", () => undefined);
      item.resource = createAudioResource(item.stream, { inputType: StreamType.Opus });
      item.deadline = setTimeout(() => {
        if (this.active === item) this.complete(new Error("Reprodução excedeu o prazo."));
      }, item.seconds * 1_000 + 15_000);
      item.deadline.unref();
      this.player.play(item.resource);
      this.options.onMetric?.("playback_seconds", item.seconds);
    } catch {
      this.complete(new Error("Falha ao preparar reprodução."));
    }
  }

  private complete(error?: Error): void {
    const item = this.active;
    if (!item) return;
    this.active = undefined;
    // stop() can emit Idle synchronously. Clear active first, then start the next item.
    if (error) this.player.stop(true);
    this.dispose(item);
    if (error) item.reject(error);
    else item.resolve();
    this.pump();
  }

  private dispose(item: Playback): void {
    if (item.deadline) clearTimeout(item.deadline);
    item.stream?.destroy();
    item.pcm.fill(0);
  }
}
