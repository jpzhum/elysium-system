import { EndBehaviorType, VoiceConnectionStatus, type AudioReceiveStream, type VoiceConnection } from "@discordjs/voice";
import { OpusDecoder } from "../audio/opus-decoder.js";
import { rms } from "../audio/voice-activity.js";

export interface VoiceReceiverOptions {
  ownUserId: string;
  canReceive: (userId: string) => boolean;
  isPlaying: () => boolean;
  /** Backend identity + individual audio consent gate, disabled when omitted. */
  canBargeIn?: (userId: string) => boolean;
  /** Opaque local stream generation; never logged or treated as speaker identity. */
  playbackToken?: () => number | undefined;
  maxTurnSeconds: number;
  onTurn: (userId: string, pcm48kStereo: Buffer, timing: VoiceTurnTiming) => void | Promise<void>;
  onMetric?: (name: string, value: number) => void;
}

export interface VoiceTurnTiming {
  readonly duringPlayback: boolean;
  readonly captureMs: number;
  readonly endDetectionMs: number;
  readonly playbackToken?: number;
}

interface IncomingTurn {
  stream: AudioReceiveStream;
  decoder: OpusDecoder;
  chunks: Buffer[];
  bytes: number;
  voiced: boolean;
  silentBytes: number;
  timeout: NodeJS.Timeout;
  duringPlayback: boolean;
  startedAt: number;
  lastVoicedAt: number;
  maxBytes: number;
  playbackToken?: number;
}

const BYTES_PER_SECOND = 48_000 * 2 * 2;
const SILENCE_MS = 600;
const MIN_VOICE_RMS = 0.008;
const BARGE_IN_SECONDS = 4;
const BARGE_IN_COOLDOWN_MS = 2_000;

/** Receives individual Discord IDs only after the caller's consent/identity gate. */
export class VoiceReceiver {
  private readonly turns = new Map<string, IncomingTurn>();
  private started = false;
  private nextBargeInAt = 0;
  private readonly maxBytes: number;
  private readonly onStart = (userId: string): void => this.subscribe(userId);
  private readonly onConnectionState = (_before: unknown, next: { status: string }): void => {
    if (next.status === VoiceConnectionStatus.Destroyed) this.stop();
    else if (next.status === VoiceConnectionStatus.Disconnected) {
      for (const userId of [...this.turns.keys()]) this.stopUser(userId);
    }
  };

  constructor(private readonly connection: VoiceConnection, private readonly options: VoiceReceiverOptions) {
    if (!Number.isFinite(options.maxTurnSeconds) || options.maxTurnSeconds < 1 || options.maxTurnSeconds > 120) {
      throw new RangeError("Duração máxima do turno inválida.");
    }
    this.maxBytes = Math.floor(options.maxTurnSeconds * BYTES_PER_SECOND / 4) * 4;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connection.on("stateChange", this.onConnectionState);
    this.connection.receiver.speaking.on("start", this.onStart);
  }

  stopUser(userId: string): void {
    this.finish(userId, false);
  }

  stop(): void {
    this.started = false;
    this.connection.off("stateChange", this.onConnectionState);
    this.connection.receiver.speaking.off("start", this.onStart);
    for (const userId of [...this.turns.keys()]) this.stopUser(userId);
    this.nextBargeInAt = 0;
  }

  private allowed(userId: string): boolean {
    return this.started && this.connection.state.status === VoiceConnectionStatus.Ready &&
      userId !== this.options.ownUserId &&
      this.options.canReceive(userId) &&
      (!this.options.isPlaying() || this.options.canBargeIn?.(userId) === true);
  }

  private metric(name: string, value = 1): void {
    this.options.onMetric?.(name, value);
  }

  private subscribe(userId: string): void {
    if (!this.allowed(userId) || this.turns.has(userId) || this.turns.size >= 16) return;
    const duringPlayback = this.options.isPlaying();
    const playbackToken = duringPlayback ? this.options.playbackToken?.() : undefined;
    if (duringPlayback && Date.now() < this.nextBargeInAt) {
      this.metric('voice_barge_in_rate_limited'); return;
    }
    let stream: AudioReceiveStream | undefined;
    let decoder: OpusDecoder | undefined;
    let state: IncomingTurn | undefined;
    try {
      // Gate is checked before subscribing and before constructing any decoder.
      stream = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
      });
      // Subscribe may synchronously start a stream that later fails DAVE decryption.
      // Always retain an error listener, including after cleanup/destroy.
      stream.on("error", () => {
        this.metric("voice_receive_errors");
        if (state && this.turns.get(userId) === state) this.finish(userId, false);
      });
      if (!this.allowed(userId)) { stream.destroy(); return; }
      decoder = new OpusDecoder();
      const maxSeconds = duringPlayback ? Math.min(BARGE_IN_SECONDS, this.options.maxTurnSeconds)
        : this.options.maxTurnSeconds;
      const timeout = setTimeout(() => this.finish(userId, true), maxSeconds * 1_000);
      timeout.unref();
      const now = performance.now();
      state = { stream, decoder, chunks: [], bytes: 0, voiced: false, silentBytes: 0, timeout,
        duringPlayback, playbackToken, startedAt: now, lastVoicedAt: now,
        maxBytes: Math.min(this.maxBytes, maxSeconds * BYTES_PER_SECOND) };
      if (duringPlayback) this.metric('voice_barge_in_captures');
      const incoming = state;
      this.turns.set(userId, state);
      stream.on("data", (packet: Buffer) => this.receive(userId, incoming, packet));
      stream.once("end", () => { if (this.turns.get(userId) === incoming) this.finish(userId, true); });
      stream.once("close", () => { if (this.turns.get(userId) === incoming) this.finish(userId, false); });
    } catch {
      stream?.destroy();
      decoder?.delete();
      this.metric("voice_receive_errors");
    }
  }

  private receive(userId: string, state: IncomingTurn, packet: Buffer): void {
    if (this.turns.get(userId) !== state) return;
    // Revocation, leaving the channel and playback suppress further decoding immediately.
    if (!this.allowed(userId) ||
      (!state.duringPlayback && this.options.isPlaying()) ||
      (state.duringPlayback && (this.options.canBargeIn?.(userId) !== true ||
        (state.playbackToken !== undefined && this.options.playbackToken?.() !== state.playbackToken)))) {
      this.finish(userId, false); return;
    }
    try {
      const pcm = state.decoder.decode(packet);
      const level = rms(pcm);
      this.metric("voice_decoded_frames");
      this.metric("voice_rms", level);
      if (level >= MIN_VOICE_RMS) {
        state.voiced = true;
        state.silentBytes = 0;
        state.lastVoicedAt = performance.now();
      } else {
        state.silentBytes += pcm.length;
      }
      if (!state.voiced) { pcm.fill(0); return; }
      const available = state.maxBytes - state.bytes;
      const chunk = pcm.length <= available ? pcm : Buffer.from(pcm.subarray(0, available));
      if (chunk !== pcm) pcm.fill(0);
      state.chunks.push(chunk);
      state.bytes += chunk.length;
      if (state.bytes >= state.maxBytes || state.silentBytes >= BYTES_PER_SECOND * SILENCE_MS / 1_000) {
        this.metric("voice_turn_limits", state.bytes >= state.maxBytes ? 1 : 0);
        this.finish(userId, true);
      }
    } catch {
      this.metric("voice_decode_errors");
      this.finish(userId, false);
    }
  }

  private finish(userId: string, deliver: boolean): void {
    const state = this.turns.get(userId);
    if (!state) return;
    this.turns.delete(userId);
    if (state.duringPlayback) this.nextBargeInAt = Date.now() + BARGE_IN_COOLDOWN_MS;
    clearTimeout(state.timeout);
    state.stream.destroy();
    state.decoder.delete();
    const shouldDeliver = deliver && state.voiced && state.bytes > 0 && this.allowed(userId) &&
      (state.duringPlayback ? this.options.canBargeIn?.(userId) === true &&
        (state.playbackToken === undefined || this.options.playbackToken?.() === state.playbackToken)
        : !this.options.isPlaying());
    const result = shouldDeliver ? Buffer.concat(state.chunks, state.bytes) : undefined;
    for (const chunk of state.chunks) chunk.fill(0);
    state.chunks.length = 0;
    if (result) {
      const now = performance.now();
      const timing: VoiceTurnTiming = { duringPlayback: state.duringPlayback,
        captureMs: Math.max(0, Math.round(now - state.startedAt)),
        endDetectionMs: Math.max(0, Math.round(now - state.lastVoicedAt)),
        ...(state.playbackToken !== undefined ? { playbackToken: state.playbackToken } : {}) };
      this.metric("voice_turn_seconds", result.length / BYTES_PER_SECOND);
      this.metric('voice_capture_ms', timing.captureMs);
      this.metric('voice_end_detection_ms', timing.endDetectionMs);
      try {
        Promise.resolve(this.options.onTurn(userId, result, timing))
          .catch(() => this.metric("voice_turn_errors"))
          .finally(() => result.fill(0));
      } catch {
        result.fill(0);
        this.metric("voice_turn_errors");
      }
    }
  }
}
