import { setTimeout as delay } from 'node:timers/promises';
import { AgentError, type AgentCallbacks, type AgentSession } from './elevenlabs-client.js';
import { convertPcm } from '../audio/pcm-conversion.js';
import type { PlaybackStream } from '../audio/playback.js';
import type { SpeakerContext } from '../policy/identity.js';
import { Logger, newIncident, type ErrorCode } from '../observability/metrics.js';

export interface Playback {
  readonly isPlaying: boolean;
  startStream(userId: string, sampleRate: number, owner: boolean,
    options?: { isAllowed?: () => boolean }): PlaybackStream;
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
  stream?: PlaybackStream;
  ingressEnded: boolean;
  playbackDone: boolean;
  recovering: boolean;
  pendingTools: number;
  acceptingAudio: boolean;
  responseIds: Set<string>;
  completedResponseIds: Set<string>;
  followupUntil: number;
  turnStarted: number;
  incident: string;
  audioChunks: number;
  audioBytes: number;
  textReceived: boolean;
  completionReceived: boolean;
  completionIds: Set<number>;
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
      ingressEnded: false, playbackDone: false, recovering: false, pendingTools: 0, acceptingAudio: false,
      responseIds: new Set(), completedResponseIds: new Set(),
      completionIds: new Set(),
      followupUntil: 0, turnStarted: performance.now(), incident: newIncident(),
      audioChunks: 0, audioBytes: 0, textReceived: false, completionReceived: false,
      providerClosed: false, failed: false };
    this.entries.set(speaker.discordUserId, entry);
    const current = entry;
    const callbacks: AgentCallbacks = {
      onAudio: (audio, _eventId, info) => this.audio(current, audio, info?.responseId),
      onResponseComplete: (id) => this.complete(current, id),
      onTextResponse: (identity) => {
        if (this.usable(current) && current.waiting && this.identifyResponse(current, identity?.responseId)) {
          current.textReceived = true;
          this.progress(current);
        }
      },
      onToolActivity: (pending) => {
        if (!this.usable(current)) return;
        current.pendingTools = pending;
        if (current.completionReceived && pending === 0) this.seal(current);
        else this.progress(current);
      },
      onProtocolEvent: (event) => {
        if (!this.usable(current)) return;
        const names = { audio: 'agent_audio_events_received', agent_response: 'agent_text_events_received',
          agent_response_complete: 'agent_response_complete_events_received', client_error: 'agent_client_errors_received' } as const;
        this.options.metric?.(names[event]);
        if (event === 'agent_response') this.options.metric?.('agent_response_received');
      },
      onInterruption: () => this.interrupt(current),
      onClose: () => this.providerClose(current),
      onError: (code) => this.providerError(current, code),
    };
    current.lifetime = setTimeout(() => {
      if (current.waiting || current.playing) this.fail(current, 'AGENT_SESSION_EXPIRED');
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
    for (const id of entry.responseIds) entry.completedResponseIds.add(id);
    entry.responseIds.clear();
    entry.stream = undefined;
    entry.ingressEnded = false;
    entry.playbackDone = false;
    entry.recovering = false;
    entry.acceptingAudio = false;
    entry.audioChunks = 0;
    entry.audioBytes = 0;
    entry.textReceived = false;
    entry.completionReceived = false;
    entry.failed = false;
    entry.incident = newIncident();
    entry.turnStarted = performance.now();
    entry.followupUntil = 0;
    if (entry.idle) clearTimeout(entry.idle);
    this.progress(entry);
    this.options.metric?.('agent_turns');
    this.report(entry, 'jarvis_agent_turn_started');
  }

  private usable(entry: Entry): boolean {
    return !this.closed && !entry.abort.signal.aborted
      && this.entries.get(entry.speaker.discordUserId) === entry && this.options.allowed(entry.speaker);
  }

  /** Correlate only identifiers actually supplied; audio IDs are not chunk sequence numbers. */
  private identifyResponse(entry: Entry, responseId?: string): boolean {
    if (responseId === undefined) return true;
    if (entry.completedResponseIds.has(responseId)) {
      this.options.metric?.('agent_stale_message_events'); return false;
    }
    if (entry.responseIds.size + entry.completedResponseIds.size >= 128 && !entry.responseIds.has(responseId)) {
      this.fail(entry, 'AGENT_AUDIO_OVERFLOW'); return false;
    }
    entry.responseIds.add(responseId);
    return true;
  }

  private async audio(entry: Entry, pcm: Buffer, responseId?: string): Promise<void> {
    if (!this.usable(entry)) return;
    this.options.metric?.('audio_chunks_received');
    this.options.metric?.('audio_bytes_received', pcm.length);
    if (!entry.waiting || entry.ingressEnded || !entry.session) {
      this.options.metric?.('audio_chunks_discarded'); return;
    }
    if (!this.identifyResponse(entry, responseId)) return;
    if (!pcm.length || pcm.length % 2) { this.fail(entry, 'AGENT_INVALID_EVENT'); return; }
    const max = entry.session.outputSampleRate * 2 * 120;
    if (entry.audioBytes + pcm.length > max) {
      this.options.metric?.('agent_audio_overflow'); this.fail(entry, 'AGENT_AUDIO_OVERFLOW'); return;
    }
    entry.audioChunks++;
    entry.audioBytes += pcm.length;
    entry.acceptingAudio = true;
    this.progress(entry);
    try {
      if (!entry.stream) {
        entry.playing = true;
        const stream = this.options.playback.startStream(entry.speaker.discordUserId,
          entry.session.outputSampleRate, entry.speaker.isOwner, { isAllowed: () => this.usable(entry) });
        entry.stream = stream;
        void stream.done.then(() => {
          if (!this.usable(entry) || entry.stream !== stream) return;
          entry.playbackDone = true;
          entry.playing = false;
          this.report(entry, 'jarvis_agent_playback_completed');
          this.finishTurn(entry);
        }, () => { if (this.usable(entry) && entry.stream === stream) this.fail(entry, 'PLAYBACK_FAILED'); });
      }
      // Acceptance is bounded by the playback queue's capacity. The adapter
      // serializes these writes and pauses provider input under backpressure.
      await entry.stream.write(pcm);
    } catch {
      if (this.usable(entry)) this.fail(entry, 'PLAYBACK_FAILED');
    } finally {
      entry.acceptingAudio = false;
      if (this.usable(entry)) {
        if (entry.completionReceived && !entry.pendingTools) this.seal(entry);
        else this.progress(entry);
      }
    }
  }

  private complete(entry: Entry, eventId?: number): void {
    if (!this.usable(entry) || !entry.waiting) return;
    if (eventId !== undefined && entry.completionIds.has(eventId)) {
      this.options.metric?.('agent_duplicate_completions'); return;
    }
    if (eventId !== undefined) {
      if (entry.completionIds.size >= 128) { this.fail(entry, 'AGENT_INVALID_EVENT'); return; }
      entry.completionIds.add(eventId);
    }
    entry.completionReceived = true;
    entry.upload?.abort();
    if (entry.deadline) clearTimeout(entry.deadline);
    this.options.metric?.('agent_response_complete_received');
    this.options.metric?.('agent_responses_completed');
    this.report(entry, 'jarvis_agent_response_complete');
    if (!entry.pendingTools) this.seal(entry);
  }

  /** Ingress closure is separate from generation confirmation and local drain. */
  private seal(entry: Entry): void {
    if (!this.usable(entry) || entry.ingressEnded || entry.acceptingAudio) return;
    if (entry.completionReceived && !entry.audioBytes) {
      this.options.metric?.('agent_no_audio_responses');
      if (entry.textReceived) this.options.metric?.('agent_text_without_audio');
      this.fail(entry, entry.textReceived ? 'AGENT_TEXT_WITHOUT_AUDIO' : 'AGENT_EMPTY_RESPONSE');
      return;
    }
    if (entry.deadline) clearTimeout(entry.deadline);
    entry.waiting = false;
    entry.ingressEnded = true;
    entry.stream?.end();
    this.finishTurn(entry);
  }

  private finishTurn(entry: Entry): void {
    if (!this.usable(entry) || !entry.ingressEnded || (entry.stream && !entry.playbackDone)) return;
    if (!entry.completionReceived || entry.recovering) { this.remove(entry); return; }
    this.options.metric?.('agent_turns_completed');
    if (entry.providerClosed) { this.remove(entry); return; }
    entry.followupUntil = Date.now() + this.options.followupSeconds * 1000;
    this.idle(entry);
  }

  /** Silence is only a resource-recovery trigger, never proof of completed generation. */
  private progress(entry: Entry): void {
    if (entry.deadline) clearTimeout(entry.deadline);
    // Local backpressure is not provider inactivity. Absolute playback/session
    // deadlines still bound waiting participants while this write is suspended.
    if (!entry.waiting || entry.recovering || entry.completionReceived || entry.pendingTools > 0 || entry.acceptingAudio) return;
    entry.deadline = setTimeout(() => {
      if (!this.usable(entry) || !entry.waiting) return;
      this.options.metric?.('agent_response_timeouts');
      this.missing(entry);
      if (entry.audioBytes > 0) {
        entry.recovering = true;
        this.report(entry, 'jarvis_agent_turn_recovering', 'AGENT_COMPLETION_MISSING');
        // Provider intake stops; validated writes queued before close are drained.
        // The onClose callback seals the local stream after those writes finish.
        entry.session?.close({ drainAudio: true });
      } else if (entry.textReceived) {
        this.options.metric?.('agent_text_without_audio');
        this.fail(entry, 'AGENT_TEXT_WITHOUT_AUDIO');
      } else this.fail(entry, 'AGENT_RESPONSE_TIMEOUT');
    }, 45_000);
    entry.deadline.unref();
  }

  private missing(entry: Entry): void {
    if (entry.recovering || entry.completionReceived) return;
    this.options.metric?.('turn_completion_missing');
    this.options.metric?.('agent_completion_missing');
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
      ingress_ended: entry.ingressEnded, playback_drained: entry.playbackDone,
      recovery: entry.recovering, pending_tools: entry.pendingTools,
    });
  }

  private fail(entry: Entry, code: ErrorCode): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry) return;
    this.primaryError(entry, code);
    this.remove(entry);
  }

  private primaryError(entry: Entry, code: ErrorCode): void {
    if (entry.failed) return;
    entry.failed = true;
    this.report(entry, 'jarvis_agent_turn_failed', code);
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
    if (entry.failed || entry.recovering) return;
    this.options.metric?.('agent_errors');
    const codes: Readonly<Record<string, ErrorCode>> = {
      agent_transport_error: 'AGENT_TRANSPORT_ERROR', invalid_agent_event: 'AGENT_INVALID_EVENT',
      invalid_output_audio: 'AGENT_INVALID_EVENT', unsupported_audio_format: 'AGENT_AUDIO_FORMAT_UNSUPPORTED',
      agent_metadata_timeout: 'AGENT_METADATA_TIMEOUT', agent_credit_limit: 'AGENT_CREDIT_LIMIT',
      agent_rate_limited: 'AGENT_RATE_LIMITED', agent_authentication_failed: 'AGENT_AUTHENTICATION_FAILED',
      agent_callback_error: 'AGENT_CALLBACK_ERROR', agent_backpressure: 'AGENT_BACKPRESSURE',
      agent_audio_backpressure: 'AGENT_BACKPRESSURE',
      agent_heartbeat_timeout: 'AGENT_HEARTBEAT_TIMEOUT',
    };
    const safeCode = Object.hasOwn(codes, code) ? codes[code]! : 'AGENT_PROVIDER_ERROR';
    if ((code === 'agent_transport_error' || code === 'agent_heartbeat_timeout') && entry.waiting) {
      this.primaryError(entry, safeCode);
      this.missing(entry);
      entry.recovering = true;
      if (entry.deadline) clearTimeout(entry.deadline);
      // Adapter will finish delivering already validated audio, then onClose.
    } else this.fail(entry, safeCode);
  }

  private providerClose(entry: Entry): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry) return;
    entry.providerClosed = true;
    if (entry.completionReceived && entry.playing) { this.seal(entry); return; }
    if (entry.waiting || entry.opening) {
      if (!entry.recovering) {
        this.options.metric?.('agent_premature_closes');
        this.options.metric?.('agent_errors');
        this.primaryError(entry, 'AGENT_PREMATURE_CLOSE');
        this.missing(entry);
        entry.recovering = true;
      }
      if (!entry.audioBytes) this.remove(entry);
      else this.seal(entry);
    } else this.remove(entry);
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
    entry.stream?.cancel();
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
