import { setTimeout as delay } from 'node:timers/promises';
import { AgentError, type AgentCallbacks, type AgentSession } from './elevenlabs-client.js';
import { convertPcm } from '../audio/pcm-conversion.js';
import type { SpeakerContext } from '../policy/identity.js';
import { Logger, newIncident, type ErrorCode } from '../observability/metrics.js';

export interface Playback {
  readonly isPlaying: boolean;
  play(userId: string, pcm: Buffer, sampleRate: number, owner: boolean): Promise<void>;
  stopUser(userId: string): void;
  stop(): void;
}
export interface SessionOptions {
  connect: (speaker: SpeakerContext, callbacks: AgentCallbacks, signal: AbortSignal) => Promise<AgentSession>;
  allowed: (speaker: SpeakerContext, audio?: boolean) => boolean;
  detectWake: (pcm: Buffer, signal: AbortSignal) => Promise<boolean>;
  playback: Playback;
  maxSessions: number;
  maxTurnSeconds: number;
  maxSessionSeconds: number;
  idleSeconds: number;
  followupSeconds: number;
  maxTurnsPerHour: number;
  metric?: (name: string, value?: number) => void;
  logger?: Logger;
  /** Production uses 20 ms pacing; injection permits cancellation tests without real waits. */
  pace?: (signal: AbortSignal) => Promise<void>;
}
interface Entry {
  speaker: SpeakerContext;
  abort: AbortController;
  session?: AgentSession;
  opening?: Promise<AgentSession>;
  waiting: boolean;
  playing: boolean;
  chunks: Buffer[];
  bytes: number;
  followupUntil: number;
  turnStarted: number;
  incident: string;
  audioChunks: number;
  audioBytes: number;
  textReceived: boolean;
  completionReceived: boolean;
  lastCompletionId?: number;
  providerClosed: boolean;
  failed: boolean;
  idle?: ReturnType<typeof setTimeout>;
  lifetime?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  upload?: AbortController;
}
export class SessionError extends Error {
  constructor(readonly code: 'consent' | 'busy' | 'limit' | 'closed') { super(code); }
}

/** One provider session per authenticated Discord speaker; no mixed audio streams. */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly checking = new Map<string, AbortController>();
  private closed = false;
  private budgetStart = Date.now();
  private turns = 0;
  constructor(private readonly options: SessionOptions) {}
  get activeCount(): number { return this.entries.size; }

  async ask(speaker: SpeakerContext, text: string): Promise<void> {
    if (!text.trim() || text.length > 1800) throw new SessionError('limit');
    this.assertAllowed(speaker);
    this.claimTurn();
    const entry = await this.ensure(speaker);
    this.begin(entry);
    try { entry.session!.sendText(text); }
    catch (error) {
      this.providerError(entry, error instanceof AgentError ? error.code : 'agent_send_failed');
      throw new SessionError('closed');
    }
  }

  async voiceTurn(speaker: SpeakerContext, pcm: Buffer): Promise<void> {
    this.assertAllowed(speaker, true);
    if (this.options.playback.isPlaying || this.checking.has(speaker.discordUserId)) return;
    if (pcm.length > this.options.maxTurnSeconds * 48_000 * 4) throw new SessionError('limit');
    const existing = this.entries.get(speaker.discordUserId);
    if (existing?.waiting || existing?.playing) return;
    const abort = new AbortController();
    this.checking.set(speaker.discordUserId, abort);
    try {
      const followup = existing && existing.speaker.consentVersion === speaker.consentVersion
        && existing.followupUntil > Date.now();
      if (!followup && !await this.options.detectWake(pcm, abort.signal)) return;
      if (abort.signal.aborted || this.options.playback.isPlaying) return;
      this.assertAllowed(speaker, true);
      this.claimTurn();
      const entry = await this.ensure(speaker);
      this.begin(entry);
      entry.upload = abort;
      const rate = entry.session!.inputSampleRate;
      const mono = convertPcm(pcm, 48_000, 2, rate, 1);
      // Real-time pacing and a silence tail let ElevenAgents VAD delimit the turn.
      const frameBytes = Math.round(rate / 50) * 2;
      const tail = Buffer.alloc(Math.round(rate * 0.8) * 2);
      for (const segment of [mono, tail]) {
        for (let offset = 0; offset < segment.length; offset += frameBytes) {
          if (!this.usable(entry) || !this.options.allowed(speaker, true) || abort.signal.aborted) return;
          entry.session!.sendAudio(segment.subarray(offset, offset + frameBytes));
          await (this.options.pace?.(abort.signal) ?? delay(20, undefined, { signal: abort.signal }));
        }
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      const entry = this.entries.get(speaker.discordUserId);
      if (entry?.upload === abort) this.providerError(entry, error instanceof AgentError ? error.code : 'agent_send_failed');
      throw error;
    } finally {
      const entry = this.entries.get(speaker.discordUserId);
      if (entry?.upload === abort) entry.upload = undefined;
      if (this.checking.get(speaker.discordUserId) === abort) this.checking.delete(speaker.discordUserId);
    }
  }

  private assertAllowed(speaker: SpeakerContext, audio = false): void {
    if (this.closed) throw new SessionError('closed');
    if (!speaker.consented || !this.options.allowed(speaker, audio)) throw new SessionError('consent');
  }

  private async ensure(speaker: SpeakerContext): Promise<Entry> {
    let entry = this.entries.get(speaker.discordUserId);
    if (entry && (entry.speaker.consentVersion !== speaker.consentVersion
      || entry.speaker.channelId !== speaker.channelId)) { this.remove(entry); entry = undefined; }
    if (entry) {
      if (entry.opening) await entry.opening;
      this.assertAllowed(speaker);
      if (!this.usable(entry)) throw new SessionError('closed');
      return entry;
    }
    if (this.entries.size >= this.options.maxSessions) throw new SessionError('busy');
    entry = { speaker, abort: new AbortController(), waiting: false, playing: false,
      chunks: [], bytes: 0, followupUntil: 0, turnStarted: performance.now(), incident: newIncident(),
      audioChunks: 0, audioBytes: 0, textReceived: false, completionReceived: false,
      providerClosed: false, failed: false };
    this.entries.set(speaker.discordUserId, entry);
    const current = entry;
    const callbacks: AgentCallbacks = {
      onAudio: (audio) => this.audio(current, audio),
      onResponseComplete: (id) => this.complete(current, id),
      onTextResponse: () => {
        if (this.usable(current) && current.waiting) current.textReceived = true;
      },
      onProtocolEvent: (event) => {
        if (!this.usable(current)) return;
        const names = { audio: 'agent_audio_events_received', agent_response: 'agent_text_events_received',
          agent_response_complete: 'agent_response_complete_events_received', client_error: 'agent_client_errors_received' } as const;
        this.options.metric?.(names[event]);
      },
      onInterruption: () => this.interrupt(current),
      onClose: () => this.providerClose(current),
      onError: (code) => this.providerError(current, code),
    };
    current.lifetime = setTimeout(() => {
      if (current.playing && current.completionReceived) {
        current.providerClosed = true;
        current.session?.close();
      } else if (current.waiting) this.fail(current, 'AGENT_SESSION_EXPIRED');
      else this.remove(current);
    }, this.options.maxSessionSeconds * 1000);
    current.lifetime.unref();
    try {
      current.opening = this.options.connect(speaker, callbacks, current.abort.signal);
      const session = await current.opening;
      if (!this.usable(current)) { session.close(); throw new SessionError('consent'); }
      current.session = session;
      current.opening = undefined;
      this.options.metric?.('agent_sessions_started');
      this.idle(current);
      return current;
    } catch (error) {
      this.providerError(current, error instanceof AgentError ? error.code : 'agent_connect_failed');
      throw error;
    }
  }

  private claimTurn(): void {
    if (Date.now() - this.budgetStart >= 3_600_000) { this.budgetStart = Date.now(); this.turns = 0; }
    if (this.turns >= this.options.maxTurnsPerHour) throw new SessionError('limit');
    this.turns++;
  }

  private begin(entry: Entry): void {
    if (!this.usable(entry)) throw new SessionError('consent');
    if (entry.waiting || entry.playing) throw new SessionError('busy');
    entry.waiting = true;
    this.discardAudio(entry);
    entry.audioChunks = 0;
    entry.audioBytes = 0;
    entry.textReceived = false;
    entry.completionReceived = false;
    entry.failed = false;
    entry.incident = newIncident();
    entry.turnStarted = performance.now();
    entry.followupUntil = 0;
    if (entry.idle) clearTimeout(entry.idle);
    entry.deadline = setTimeout(() => {
      if (!this.usable(entry) || !entry.waiting) return;
      this.options.metric?.('agent_response_timeouts');
      this.options.metric?.('agent_completion_missing');
      if (entry.audioBytes > 0) this.fail(entry, 'AGENT_COMPLETION_MISSING');
      else if (entry.textReceived) {
        this.options.metric?.('agent_text_without_audio');
        this.fail(entry, 'AGENT_TEXT_WITHOUT_AUDIO');
      } else this.fail(entry, 'AGENT_RESPONSE_TIMEOUT');
    }, 45_000);
    entry.deadline.unref();
    this.options.metric?.('agent_turns');
    this.report(entry, 'jarvis_agent_turn_started');
  }

  private usable(entry: Entry): boolean {
    return !this.closed && !entry.abort.signal.aborted
      && this.entries.get(entry.speaker.discordUserId) === entry && this.options.allowed(entry.speaker);
  }

  private audio(entry: Entry, pcm: Buffer): void {
    if (!this.usable(entry)) return;
    this.options.metric?.('audio_chunks_received');
    this.options.metric?.('audio_bytes_received', pcm.length);
    if (!entry.waiting || !entry.session) { this.options.metric?.('audio_chunks_discarded'); return; }
    const max = entry.session.outputSampleRate * 2 * 30;
    if (entry.bytes + pcm.length > max) {
      this.options.metric?.('agent_audio_overflow'); this.fail(entry, 'AGENT_AUDIO_OVERFLOW'); return;
    }
    entry.chunks.push(pcm);
    entry.bytes += pcm.length;
    entry.audioChunks++;
    entry.audioBytes += pcm.length;
  }

  private complete(entry: Entry, eventId?: number): void {
    if (!this.usable(entry) || !entry.waiting) return;
    if (eventId !== undefined && eventId === entry.lastCompletionId) {
      this.options.metric?.('agent_duplicate_completions'); return;
    }
    entry.lastCompletionId = eventId;
    entry.completionReceived = true;
    entry.upload?.abort();
    this.options.metric?.('agent_responses_completed');
    this.report(entry, 'jarvis_agent_response_complete');
    if (!entry.bytes) {
      this.options.metric?.('agent_no_audio_responses');
      if (entry.textReceived) this.options.metric?.('agent_text_without_audio');
      this.fail(entry, entry.textReceived ? 'AGENT_TEXT_WITHOUT_AUDIO' : 'AGENT_EMPTY_RESPONSE');
      return;
    }
    // Documented completion includes pending tools and all output. Silence, a
    // text response, socket close, and elapsed time are never substitutes.
    void this.flush(entry);
  }

  private async flush(entry: Entry): Promise<void> {
    if (!this.usable(entry) || !entry.waiting || !entry.session) return;
    if (entry.deadline) clearTimeout(entry.deadline);
    if (!entry.completionReceived) return;
    entry.waiting = false;
    entry.playing = true;
    const pcm = Buffer.concat(entry.chunks, entry.bytes);
    this.discardAudio(entry);
    try {
      this.options.metric?.('playback_started');
      await this.options.playback.play(entry.speaker.discordUserId, pcm,
        entry.session.outputSampleRate, entry.speaker.isOwner);
      if (this.usable(entry)) {
        this.options.metric?.('playback_completed');
        this.report(entry, 'jarvis_agent_playback_completed');
        entry.followupUntil = Date.now() + this.options.followupSeconds * 1000;
      }
    } catch {
      if (this.usable(entry)) this.fail(entry, 'PLAYBACK_FAILED');
      else this.options.metric?.('playback_cancelled');
    } finally {
      pcm.fill(0);
      entry.playing = false;
      if (this.usable(entry)) {
        if (entry.providerClosed) this.remove(entry);
        else this.idle(entry);
      }
    }
  }

  private report(entry: Entry, event: string, code?: ErrorCode): void {
    this.options.logger?.event(event, code ? 'error' : 'info', {
      incident: entry.incident, operation: 'agent_turn',
      stage: entry.playing ? 'playback' : entry.textReceived && !entry.audioBytes ? 'agent_audio_wait'
        : entry.waiting ? 'agent_response_wait' : 'agent_connect',
      ...(code ? { code, category: code === 'PLAYBACK_FAILED' ? 'playback' : 'agent' } : {}),
      duration_ms: Math.max(0, Math.round(performance.now() - entry.turnStarted)),
      audio_chunks: entry.audioChunks, audio_bytes: entry.audioBytes,
      text_received: entry.textReceived, completion_received: entry.completionReceived,
    });
  }

  private fail(entry: Entry, code: ErrorCode): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry || entry.failed) return;
    entry.failed = true;
    this.report(entry, 'jarvis_agent_turn_failed', code);
    this.remove(entry);
  }

  private providerError(entry: Entry, code: string): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry) return;
    if (code === 'agent_aborted') { this.remove(entry); return; }
    if (entry.completionReceived && !entry.waiting) {
      entry.providerClosed = true;
      this.options.metric?.('agent_closed_after_completion');
      if (!entry.playing) this.remove(entry);
      return;
    }
    this.options.metric?.('agent_errors');
    const codes: Readonly<Record<string, ErrorCode>> = {
      agent_transport_error: 'AGENT_TRANSPORT_ERROR', invalid_agent_event: 'AGENT_INVALID_EVENT',
      invalid_output_audio: 'AGENT_INVALID_EVENT', unsupported_audio_format: 'AGENT_AUDIO_FORMAT_UNSUPPORTED',
      agent_metadata_timeout: 'AGENT_METADATA_TIMEOUT', agent_credit_limit: 'AGENT_CREDIT_LIMIT',
      agent_rate_limited: 'AGENT_RATE_LIMITED', agent_authentication_failed: 'AGENT_AUTHENTICATION_FAILED',
      agent_callback_error: 'AGENT_CALLBACK_ERROR', agent_backpressure: 'AGENT_BACKPRESSURE',
    };
    this.fail(entry, Object.hasOwn(codes, code) ? codes[code]! : 'AGENT_PROVIDER_ERROR');
  }

  private providerClose(entry: Entry): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry) return;
    if (entry.completionReceived && entry.playing) { entry.providerClosed = true; return; }
    if (entry.waiting || entry.opening) {
      this.options.metric?.('agent_premature_closes');
      this.options.metric?.('agent_errors');
      this.fail(entry, 'AGENT_PREMATURE_CLOSE');
    } else this.remove(entry);
  }

  private discardAudio(entry: Entry): void {
    for (const chunk of entry.chunks) chunk.fill(0);
    entry.chunks = [];
    entry.bytes = 0;
  }

  private interrupt(entry: Entry): void {
    // Closing the provider session fences late audio/completion from the old turn.
    // A new question creates a fresh session instead of trusting event arrival timing.
    this.remove(entry);
  }

  private idle(entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this.remove(entry), this.options.idleSeconds * 1000);
    entry.idle.unref();
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry) return;
    this.entries.delete(entry.speaker.discordUserId);
    entry.upload?.abort();
    entry.abort.abort();
    for (const timer of [entry.idle, entry.lifetime, entry.deadline]) if (timer) clearTimeout(timer);
    this.discardAudio(entry);
    this.options.playback.stopUser(entry.speaker.discordUserId);
    entry.session?.close();
  }

  revoke(userId: string): void {
    this.checking.get(userId)?.abort();
    this.checking.delete(userId);
    const entry = this.entries.get(userId);
    if (entry) this.remove(entry);
    this.options.playback.stopUser(userId);
  }

  close(): void {
    this.closed = true;
    for (const abort of this.checking.values()) abort.abort();
    this.checking.clear();
    for (const entry of this.entries.values()) this.remove(entry);
    this.options.playback.stop();
  }
}
