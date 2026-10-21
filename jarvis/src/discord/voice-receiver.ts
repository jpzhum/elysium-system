import { EndBehaviorType, VoiceConnectionStatus, type AudioReceiveStream, type VoiceConnection } from "@discordjs/voice";
import { OpusDecoder } from "../audio/opus-decoder.js";
import { rms } from "../audio/voice-activity.js";

export interface VoiceReceiverOptions {
  ownUserId: string;
  canReceive: (userId: string) => boolean;
  isPlaying: () => boolean;
  maxTurnSeconds: number;
  onTurn: (userId: string, pcm48kStereo: Buffer) => void;
  onMetric?: (name: string, value: number) => void;
}

interface IncomingTurn {
  stream: AudioReceiveStream;
  decoder: OpusDecoder;
  chunks: Buffer[];
  bytes: number;
  voiced: boolean;
  silentBytes: number;
  timeout: NodeJS.Timeout;
}

const BYTES_PER_SECOND = 48_000 * 2 * 2;
const SILENCE_MS = 600;
const MIN_VOICE_RMS = 0.008;

/** Receives individual Discord IDs only after the caller's consent/identity gate. */
export class VoiceReceiver {
  private readonly turns = new Map<string, IncomingTurn>();
  private started = false;
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
  }

  private allowed(userId: string): boolean {
    return this.started && this.connection.state.status === VoiceConnectionStatus.Ready &&
      userId !== this.options.ownUserId &&
      !this.options.isPlaying() && this.options.canReceive(userId);
  }

  private metric(name: string, value = 1): void {
    this.options.onMetric?.(name, value);
  }

  private subscribe(userId: string): void {
    if (!this.allowed(userId) || this.turns.has(userId) || this.turns.size >= 16) return;
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
      const timeout = setTimeout(() => this.finish(userId, true), this.options.maxTurnSeconds * 1_000);
      timeout.unref();
      state = { stream, decoder, chunks: [], bytes: 0, voiced: false, silentBytes: 0, timeout };
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
    if (!this.allowed(userId)) { this.finish(userId, false); return; }
    try {
      const pcm = state.decoder.decode(packet);
      const level = rms(pcm);
      this.metric("voice_decoded_frames");
      this.metric("voice_rms", level);
      if (level >= MIN_VOICE_RMS) {
        state.voiced = true;
        state.silentBytes = 0;
      } else {
        state.silentBytes += pcm.length;
      }
      if (!state.voiced) { pcm.fill(0); return; }
      const available = this.maxBytes - state.bytes;
      const chunk = pcm.length <= available ? pcm : Buffer.from(pcm.subarray(0, available));
      if (chunk !== pcm) pcm.fill(0);
      state.chunks.push(chunk);
      state.bytes += chunk.length;
      if (state.bytes >= this.maxBytes || state.silentBytes >= BYTES_PER_SECOND * SILENCE_MS / 1_000) {
        this.metric("voice_turn_limits", state.bytes >= this.maxBytes ? 1 : 0);
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
    clearTimeout(state.timeout);
    state.stream.destroy();
    state.decoder.delete();
    const shouldDeliver = deliver && state.voiced && state.bytes > 0 && this.allowed(userId);
    const result = shouldDeliver ? Buffer.concat(state.chunks, state.bytes) : undefined;
    for (const chunk of state.chunks) chunk.fill(0);
    state.chunks.length = 0;
    if (result) {
      this.metric("voice_turn_seconds", result.length / BYTES_PER_SECOND);
      try {
        Promise.resolve(this.options.onTurn(userId, result)).catch(() => this.metric("voice_turn_errors"));
      } catch {
        this.metric("voice_turn_errors");
      }
    }
  }
}
