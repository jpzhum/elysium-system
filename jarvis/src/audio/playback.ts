import { Readable } from 'node:stream';
import {
  AudioPlayerError, AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource,
  type AudioPlayer, type AudioPlayerState, type AudioResource, type PlayerSubscription, type VoiceConnection,
  type VoiceConnectionState,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { StreamingPcm } from './streaming-pcm.js';
import { DiagnosticError, sanitizeError } from '../observability/diagnostics.js';
import { diagnosticValue, sanitizeDiagnosticFields, type DiagnosticFields, type ErrorCode } from '../observability/metrics.js';

export interface PlaybackStream {
  readonly done: Promise<void>;
  write(pcmMono: Buffer): Promise<void>;
  /** Ends ingress; neither generation nor conversation completion is inferred here. */
  end(): void;
  cancel(): void;
}

export interface PlaybackStreamOptions {
  isAllowed?: () => boolean;
  /** Local consumption observations, never confirmation of provider generation. */
  onProgress?: (event: 'first_packet' | 'drained' | 'resumed', elapsedMs: number) => void;
  /** Fixed operational classifications only; the caller supplies the incident ID. */
  onDiagnostic?: (fields: DiagnosticFields) => void;
}

export interface PlaybackOptions {
  maxQueue?: number;
  maxSeconds?: number;
  maxBufferBytes?: number;
  /** Absolute resource lifetime, including queue and generation gaps. */
  maxWallMs?: number;
  onMetric?: (name: string, value: number) => void;
  /** Ephemeral PCM reference; the recipient must finish synchronously or copy it. */
  onPcmFrame?: (stereo48k: Buffer) => void;
  player?: AudioPlayer;
}

interface Playback {
  token: number;
  userId: string;
  isOwner: boolean;
  source: StreamingPcm;
  allowed: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  resource?: AudioResource;
  stream?: Readable;
  deadline?: NodeJS.Timeout;
  drainTimer?: NodeJS.Timeout;
  created: number;
  firstPacket: boolean;
  drained: boolean;
  onProgress?: PlaybackStreamOptions['onProgress'];
  onDiagnostic?: PlaybackStreamOptions['onDiagnostic'];
  failure?: Error;
  finished: boolean;
  settled: boolean;
  consumedChunks: number;
  packetChunks: WeakMap<Buffer, number>;
  encodeAttempts: number;
  encodeMs: number;
}

class PlaybackCancelledError extends Error {
  constructor() { super('Reprodução cancelada.'); }
}

class PlaybackFailure extends DiagnosticError {
  readonly details: DiagnosticFields;
  constructor(message: string, fields: DiagnosticFields) {
    super(fields.category ?? 'playback', fields.code ?? 'PLAYBACK_FAILED');
    this.message = message;
    this.details = Object.freeze(sanitizeDiagnosticFields(fields));
  }
}

/** No exception message, stack, cause object or arbitrary property crosses the log boundary. */
export function playbackFailureFields(error: unknown): DiagnosticFields {
  return error instanceof PlaybackFailure ? { ...error.details } : sanitizeError(error);
}

const opusErrors = [
  'Bad argument', 'Buffer too small', 'Internal error', 'Invalid packet',
  'Unimplemented', 'Invalid state', 'Memory allocation fail',
];

/** A final guard also fences packets prefetched before consent was revoked. */
class GuardedStream extends Readable {
  private pulling = false;
  constructor(
    private readonly packets: AsyncGenerator<Buffer>,
    private readonly allowed: () => boolean,
    private readonly denied: () => void,
    private readonly consumed: (packet: Buffer) => void,
    private readonly starved: () => void,
  ) { super({ objectMode: true, highWaterMark: 2 }); }

  override read(size?: number): Buffer | null {
    if (!this.allowed()) { this.denied(); return null; }
    const packet = super.read(size) as Buffer | null;
    if (packet) this.consumed(packet);
    else this.starved();
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
    }, (error: unknown) => {
      this.pulling = false;
      this.destroy(error instanceof Error ? error : new Error('Falha ao codificar reprodução.'));
    });
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
  private failureCleanupPending = false;
  private streamSequence = 0;
  private readonly maxQueue: number;
  private readonly maxSeconds: number;
  private readonly maxBufferBytes: number;
  private readonly maxWallMs: number;
  private readonly onConnectionState = (_before: VoiceConnectionState, next: VoiceConnectionState): void => {
    if (next.status === VoiceConnectionStatus.Destroyed) {
      this.connectionFailure('VOICE_DESTROYED', next.status);
      this.stop();
    }
    else if (next.status !== VoiceConnectionStatus.Ready) {
      // The pinned voice library can go Ready -> Signalling -> Connecting
      // without emitting Disconnected. Fence that transport replacement too;
      // accepted responses are cancelled once and never replayed after recovery.
      this.disconnected = true;
      this.connectionFailure(next.status === VoiceConnectionStatus.Disconnected ? 'VOICE_DISCONNECTED' : 'VOICE_NOT_READY', next.status);
      this.cancelAll();
    } else if (next.status === VoiceConnectionStatus.Ready) this.disconnected = false;
  };

  constructor(private readonly connection: VoiceConnection, private readonly options: PlaybackOptions = {}) {
    this.maxQueue = options.maxQueue ?? 4;
    this.maxSeconds = options.maxSeconds ?? 120;
    this.maxBufferBytes = options.maxBufferBytes ?? 384 * 1024;
    this.maxWallMs = options.maxWallMs ?? this.maxSeconds * 1_000 + 60_000;
    this.disconnected = connection.state !== undefined && connection.state.status !== VoiceConnectionStatus.Ready;
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
    this.player.on('stateChange', (before: AudioPlayerState, next: AudioPlayerState) => {
      const item = this.active;
      if (item) this.observe(item, { playback_stage: 'player', previous_player_status: before.status,
        player_status: next.status, ...this.snapshot(item) });
    });
    this.player.on(AudioPlayerStatus.Idle, (before?: AudioPlayerState) => {
      const item = this.active;
      if (!item || (before && ('resource' in before ? before.resource !== item.resource : true))) return;
      this.complete(item, item.finished ? undefined : this.failure(item,
        new Error('Reprodução encerrada antes de esvaziar o fluxo.'), 'player', 'PLAYBACK_PREMATURE_IDLE',
        'Reprodução encerrada antes de esvaziar o fluxo.'));
    });
    this.player.on('error', (error) => {
      if (this.active && error.resource === this.active.resource) {
        this.options.onMetric?.('playback_errors', 1);
        this.complete(this.active, this.failure(this.active, error, 'player', 'PLAYBACK_PLAYER_ERROR', 'Falha ao reproduzir áudio.'));
      }
    });
    let subscription: PlayerSubscription | undefined;
    try { subscription = connection.subscribe(this.player); }
    catch (error) { throw this.failure(undefined, error, 'subscribe', 'PLAYBACK_SUBSCRIBE_FAILED',
      'Conexão de voz indisponível para reprodução.'); }
    if (!subscription) throw new PlaybackFailure('Conexão de voz indisponível para reprodução.', {
      category: 'voice', code: 'PLAYBACK_SUBSCRIBE_FAILED', playback_stage: 'subscribe', subscribed: false,
      ...(connection.state ? { voice_status: connection.state.status } : {}),
    });
    this.subscription = subscription;
    connection.on('stateChange', this.onConnectionState);
  }

  get isPlaying(): boolean { return this.active !== undefined || this.waiting.length > 0; }
  /** An open provider stream can be locally drained while still awaiting generation. */
  get isAudible(): boolean { return this.active !== undefined && !this.active.drained; }
  get currentStreamToken(): number | undefined { return this.active?.token; }

  /** Local readiness only: neither a Ready transport nor consumed PCM proves remote audibility. */
  get diagnosticState(): Readonly<DiagnosticFields & { available: boolean; stopped: boolean }> {
    const fields = this.snapshot(this.active);
    return Object.freeze({ ...fields, stopped: this.stopped,
      available: !this.stopped && !this.disconnected && fields.voice_status === VoiceConnectionStatus.Ready &&
        fields.subscribed === true && fields.dave_ready !== false });
  }

  startStream(userId: string, sampleRate: number, isOwner: boolean,
    options: PlaybackStreamOptions = {}): PlaybackStream {
    if (this.stopped) this.rejectStart('Fila de áudio encerrada.', 'PLAYBACK_QUEUE_CLOSED', options, true);
    if (this.disconnected) this.rejectStart('Conexão de voz indisponível para reprodução.',
      this.connection.state?.status === VoiceConnectionStatus.Disconnected ? 'VOICE_DISCONNECTED'
        : this.connection.state?.status === VoiceConnectionStatus.Destroyed ? 'VOICE_DESTROYED' : 'VOICE_NOT_READY', options, true);
    if (this.waiting.length + Number(this.active !== undefined) >= this.maxQueue) {
      this.rejectStart('Fila de áudio cheia.', 'PLAYBACK_QUEUE_FULL', options);
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
      this.rejectStart('Formato PCM de reprodução inválido.', 'PLAYBACK_PCM_INVALID', options);
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => undefined);
    const item: Playback = {
      token: ++this.streamSequence,
      userId, isOwner, resolve, reject, finished: false, settled: false,
      consumedChunks: 0, packetChunks: new WeakMap(), encodeAttempts: 0, encodeMs: 0,
      created: performance.now(), firstPacket: false, drained: false, onProgress: options.onProgress,
      onDiagnostic: options.onDiagnostic,
      allowed: () => !this.stopped && !this.disconnected && !item.settled && (options.isAllowed?.() ?? true),
      source: new StreamingPcm(sampleRate, {
        maxBufferBytes: this.maxBufferBytes, maxSeconds: this.maxSeconds,
        onBufferDelta: (delta) => this.options.onMetric?.('audio_stream_buffer_bytes', delta),
        onChunkPlayed: () => { item.consumedChunks++; },
        onConversionMs: (value) => this.options.onMetric?.('pcm_conversion_ms', value),
      }),
    };
    const guestIndex = this.waiting.findIndex((queued) => !queued.isOwner);
    if (isOwner && guestIndex >= 0) this.waiting.splice(guestIndex, 0, item);
    else this.waiting.push(item);
    item.deadline = setTimeout(() => this.complete(item, this.failure(item,
      new Error('Reprodução excedeu o prazo.'), 'deadline', 'PLAYBACK_DEADLINE', 'Reprodução excedeu o prazo.')), this.maxWallMs);
    item.deadline.unref();
    return {
      done,
      write: async (pcm) => {
        try {
          if (!item.allowed()) throw item.failure ?? new PlaybackCancelledError();
          this.resume(item);
          const writing = item.source.write(pcm, item.allowed);
          this.pump();
          await writing;
          if (!item.allowed()) throw item.failure ?? new PlaybackCancelledError();
          this.pump();
        } catch (error) {
          const safe = item.failure ?? (!item.allowed() ? new PlaybackCancelledError()
            : this.failure(item, error, 'pcm_input', 'PLAYBACK_INPUT_FAILED',
              error instanceof Error && /^(?:Formato PCM de reprodução inválido\.|Bloco de áudio excedeu o limite de memória\.|Resposta de áudio excedeu o limite de duração\.|Envio simultâneo de áudio excedeu o limite\.)$/.test(error.message)
                ? error.message : 'Falha ao receber áudio.'));
          this.complete(item, safe);
          throw safe;
        }
      },
      end: () => { if (!item.settled) { item.source.end(); this.pump(); } },
      cancel: () => this.complete(item, new PlaybackCancelledError()),
    };
  }

  async play(userId: string, pcmMono: Buffer, sampleRate: number, isOwner: boolean,
    options: PlaybackStreamOptions = {}): Promise<void> {
    if (!pcmMono.length || pcmMono.length % 2 !== 0) {
      this.rejectStart('Formato PCM de reprodução inválido.', 'PLAYBACK_PCM_INVALID', options);
    }
    if (pcmMono.length / (sampleRate * 2) > this.maxSeconds) {
      this.rejectStart('Resposta de áudio excedeu o limite de duração.', 'PLAYBACK_DURATION_LIMIT', options);
    }
    const stream = this.startStream(userId, sampleRate, isOwner, options);
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
    if (this.stopped || this.disconnected || this.failureCleanupPending || this.active) return;
    const item = this.waiting[0];
    if (!item || !item.source.hasInput) return;
    this.waiting.shift();
    this.active = item;
    if (!item.allowed()) { this.complete(item, new PlaybackCancelledError()); return; }
    try {
      item.stream = new GuardedStream(this.encode(item), item.allowed,
        () => this.complete(item, new PlaybackCancelledError()), (packet) => {
          this.resume(item);
          if (!item.firstPacket) {
            item.firstPacket = true;
            this.progress(item, 'first_packet');
          }
          const count = item.packetChunks.get(packet) ?? 0;
          if (count) this.options.onMetric?.('audio_chunks_played', count);
          item.packetChunks.delete(packet);
        }, () => this.starved(item));
      item.stream.on('error', (error: Error) => this.complete(item,
        this.failure(item, error, 'stream', 'PLAYBACK_STREAM_FAILED', 'Falha ao preparar reprodução.')));
      item.resource = createAudioResource(item.stream, { inputType: StreamType.Opus });
      this.player.play(item.resource);
      this.options.onMetric?.('audio_stream_started', 1);
      this.options.onMetric?.('playback_started', 1);
    } catch (error) {
      this.complete(item, this.failure(item, error, item.resource ? 'player_start' : 'resource_create',
        'PLAYBACK_STREAM_FAILED', 'Falha ao preparar reprodução.'));
    }
  }

  private async *encode(item: Playback): AsyncGenerator<Buffer> {
    let codec: OpusScript;
    try { codec = new OpusScript(48_000, 2, OpusScript.Application.AUDIO); }
    catch (error) { throw this.failure(item, error, 'opus_init', 'PLAYBACK_ENCODER_FAILED', 'Falha ao iniciar encoder de áudio.'); }
    try {
      for await (const frame of item.source.frames()) {
        try {
          if (!item.allowed()) throw new PlaybackCancelledError();
          this.options.onPcmFrame?.(frame);
          const encodingStarted = performance.now();
          item.encodeAttempts++;
          let packet: Buffer;
          try { packet = codec.encode(frame, 960); }
          catch (error) { throw this.failure(item, error, 'opus_encode', 'PLAYBACK_ENCODER_FAILED', 'Falha ao codificar reprodução.'); }
          finally {
            const encodingMs = Math.max(0, performance.now() - encodingStarted);
            item.encodeMs += encodingMs;
            this.options.onMetric?.('opus_encode_ms', encodingMs);
          }
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
    item.failure = error;
    // CPU spent attempting this resource's frames, including a failed attempt.
    // No sample is invented for resources cancelled before encoding starts.
    if (item.encodeAttempts > 0) this.observe(item, { playback_stage: 'opus_encode', opus_encode_ms: item.encodeMs });
    if (error instanceof PlaybackFailure) this.observe(item, error.details);
    if (item.deadline) clearTimeout(item.deadline);
    if (item.drainTimer) clearTimeout(item.drainTimer);
    const wasActive = this.active === item;
    if (wasActive && error instanceof PlaybackFailure) {
      // @discordjs/voice's stream-error listener is still on the same EventEmitter
      // stack. Keep the player Idle until it finishes: it tags errors using its
      // current resource and would otherwise blame the next queued participant.
      this.failureCleanupPending = true;
      queueMicrotask(() => { this.failureCleanupPending = false; this.pump(); });
    }
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

  private rejectStart(message: string, code: ErrorCode, options: PlaybackStreamOptions, cancelled = false): never {
    this.options.onMetric?.(cancelled ? 'playback_cancelled' : 'playback_failed', 1);
    const error = new PlaybackFailure(message, { ...this.snapshot(), code,
      category: code.startsWith('VOICE_') ? 'voice' : cancelled ? 'cancelled' : 'playback',
      playback_stage: code.startsWith('VOICE_') ? 'connection' : 'pcm_input' });
    try { options.onDiagnostic?.({ ...error.details }); } catch { /* Diagnostics are best effort. */ }
    throw error;
  }

  private snapshot(item?: Playback): DiagnosticFields {
    const state = this.connection.state;
    const network = state && 'networking' in state ? state.networking.state : undefined;
    const dave = network && 'dave' in network ? network.dave : undefined;
    return {
      ...(state ? { voice_status: state.status } : {}),
      subscribed: Boolean(this.subscription && state && 'subscription' in state && state.subscription === this.subscription),
      ...(network ? { network_status: network.code } : {}),
      ...(dave ? { dave_protocol_version: dave.protocolVersion, dave_ready: dave.session?.ready } : {}),
      ...(this.player.state ? { player_status: this.player.state.status } : {}),
      ...(item?.resource ? { resource_ended: item.resource.ended } : {}),
    };
  }

  private observe(item: Playback, fields: DiagnosticFields): void {
    try { item.onDiagnostic?.(sanitizeDiagnosticFields(fields)); }
    catch { /* Observability cannot interrupt playback or cleanup. */ }
  }

  private failure(item: Playback | undefined, error: unknown, stage: DiagnosticFields['playback_stage'],
    fallback: ErrorCode, message: string): PlaybackFailure {
    if (error instanceof PlaybackFailure) return error;
    const original = sanitizeError(error);
    const sourceMessage = diagnosticValue(error, 'message');
    const code = sourceMessage === 'Cannot play a resource that has already ended.' ? 'PLAYBACK_RESOURCE_ENDED'
      : sourceMessage === 'Resource is already being played by another audio player.' ? 'PLAYBACK_RESOURCE_IN_USE'
      : original.code === 'UNKNOWN' ? fallback : original.code;
    const opusIndex = typeof sourceMessage === 'string'
      ? opusErrors.findIndex(value => sourceMessage === `Encode error: ${value}`) : -1;
    const suppliedName = diagnosticValue(error, 'name');
    const causeName = error instanceof AudioPlayerError ? 'AudioPlayerError'
      : error instanceof RangeError ? 'RangeError' : error instanceof TypeError ? 'TypeError'
      : suppliedName === 'DiagnosticError' ? 'DiagnosticError'
      : error instanceof Error ? 'Error' : undefined;
    return new PlaybackFailure(message, {
      category: original.code === 'UNKNOWN' ? 'playback' : original.category, code,
      cause_code: original.code, cause_name: causeName,
      ...(opusIndex >= 0 ? { opus_error_code: -opusIndex - 1 } : {}),
      playback_stage: stage, ...this.snapshot(item),
    });
  }

  private connectionFailure(code: 'VOICE_DESTROYED' | 'VOICE_DISCONNECTED' | 'VOICE_NOT_READY',
    status: DiagnosticFields['voice_status']): void {
    for (const item of [...this.waiting, ...(this.active ? [this.active] : [])]) {
      this.observe(item, { ...this.snapshot(item), voice_status: status,
        category: 'voice', code, playback_stage: 'connection' });
    }
  }

  private progress(item: Playback, event: 'first_packet' | 'drained' | 'resumed'): void {
    if (!item.allowed()) return;
    item.onProgress?.(event, Math.max(0, performance.now() - item.created));
  }

  private resume(item: Playback): void {
    if (item.drainTimer) clearTimeout(item.drainTimer);
    item.drainTimer = undefined;
    if (item.drained) { item.drained = false; this.progress(item, 'resumed'); }
  }

  private starved(item: Playback): void {
    if (!item.firstPacket || item.finished || item.drained || item.drainTimer || !item.source.waitingForInput) return;
    // Debounce brief packet gaps. This observation cannot complete generation.
    // A queued next question, not this timer, authorizes retiring an unknown turn.
    item.drainTimer = setTimeout(() => {
      item.drainTimer = undefined;
      if (!item.allowed() || !item.source.waitingForInput || item.stream?.readableLength || item.finished) return;
      item.drained = true;
      this.progress(item, 'drained');
    }, 250);
    item.drainTimer.unref();
  }
}
