import { setTimeout as delay } from 'node:timers/promises';
import { AgentError, type AgentCallbacks, type AgentSession } from './elevenlabs-client.js';
import { convertPcm } from '../audio/pcm-conversion.js';
import { CaptureWindows, type CaptureTiming } from '../audio/capture-window.js';
import type { PlaybackStream } from '../audio/playback.js';
import type { SpeakerContext } from '../policy/identity.js';
import { Logger, newIncident, type DiagnosticFields, type ErrorCode } from '../observability/metrics.js';

export interface Playback {
  readonly isPlaying: boolean;
  startStream(userId: string, sampleRate: number, owner: boolean,
    options?: { isAllowed?: () => boolean;
      onProgress?: (event: 'first_packet' | 'drained' | 'resumed', elapsedMs: number) => void }): PlaybackStream;
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
  maxQueuedTurns?: number;
  maxQueuedPerUser?: number;
  queueTtlSeconds?: number;
  notify?: (speaker: SpeakerContext, event: TurnNotification) => void | Promise<void>;
  /** Refresh trusted Discord context before a question, including reused sockets. */
  prepareSession?: (speaker: SpeakerContext, session: AgentSession, reused: boolean,
    metadata?: { incident: string; inputKind: 'voice' | 'text' }) => void | Promise<void>;
}
export interface TurnReceipt { queued: boolean; position: number; turnId: string; }
export interface TurnNotification {
  type: 'queued' | 'started' | 'cancelled' | 'failed';
  turnId: string;
  position?: number;
  reason?: 'expired' | 'revoked' | 'interrupted' | 'closed' | 'provider' | 'limit';
}
interface TurnRequest {
  id: string;
  speaker: SpeakerContext;
  receivedAt: number;
  dispatchAt?: number;
  text?: string;
  pcm?: Buffer;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  notify?: (event: TurnNotification) => void | Promise<void>;
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
  superseded: boolean;
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
  request?: TurnRequest;
  localDrained: boolean;
  firstAudioAt?: number;
  firstPlaybackAt?: number;
  lastAudioAt?: number;
  drainedAt?: number;
  turnReleased: boolean;
  voiceInput: boolean;
  userTurnRecognized: boolean;
  recognizedUserEventIds: Set<number>;
  inputAudioChunks: number;
  inputAudioBytes: number;
  inputAudioFinished: boolean;
  inputSourceChunks: number;
  inputSilenceChunks: number;
  uploadMs?: number;
  rejectedAudioIds: Set<number>;
  rejectedResponseIds: Set<string>;
  sessionReused: boolean;
  initialAudioReported: boolean;
  initialResponseReported: boolean;
}
export class SessionError extends Error {
  constructor(readonly code: 'consent' | 'busy' | 'limit' | 'closed',
    readonly reason?: 'queue_full' | 'user_queue_full' | 'voice_memory_limit' | 'turn_budget') { super(code); }
}

/** One provider session per authenticated Discord speaker; no mixed audio streams. */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly checking = new Map<string, AbortController>();
  private readonly captures = new CaptureWindows();
  private readonly queue: TurnRequest[] = [];
  private readonly followups = new Map<string, { consentVersion: number; channelId: string; until: number }>();
  private active?: TurnRequest;
  private readonly maxQueuedTurns: number;
  private readonly maxQueuedPerUser: number;
  private readonly queueTtlSeconds: number;
  private closed = false;
  private available = true;
  private budgetStart = Date.now();
  private turns = 0;
  constructor(private readonly options: SessionOptions) {
    const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
      value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(maximum, Math.floor(value)));
    this.maxQueuedTurns = bounded(options.maxQueuedTurns, 8, 16);
    this.maxQueuedPerUser = bounded(options.maxQueuedPerUser, 2, 4);
    this.queueTtlSeconds = bounded(options.queueTtlSeconds, 60, 120);
  }
  get activeCount(): number { return this.entries.size; }
  get queuedCount(): number { return this.queue.length; }
  get queueStatus(): { waiting: number; active: boolean } { return { waiting: this.queue.length, active: !!this.active }; }

  /** Client tools are scoped to the originating active turn, never an idle socket. */
  isTurnActive(speaker: SpeakerContext): boolean {
    const entry = this.entries.get(speaker.discordUserId);
    return !!entry && entry.speaker.channelId === speaker.channelId &&
      entry.speaker.consentVersion === speaker.consentVersion &&
      entry.request !== undefined && this.active === entry.request && !entry.turnReleased &&
      (entry.waiting || entry.playing) && (!entry.voiceInput || entry.userTurnRecognized) && this.usable(entry);
  }

  /** Content-free correlation also covers tools received before final voice ASR. */
  turnIncident(speaker: SpeakerContext): string | undefined {
    const entry = this.entries.get(speaker.discordUserId);
    return entry && this.usable(entry) && entry.speaker.channelId === speaker.channelId
      && entry.speaker.consentVersion === speaker.consentVersion
      && this.active?.speaker.discordUserId === speaker.discordUserId
      && this.active.speaker.channelId === speaker.channelId
      && this.active.speaker.consentVersion === speaker.consentVersion
      ? this.active.id : undefined;
  }

  async ask(speaker: SpeakerContext, text: string,
    notify?: (event: TurnNotification) => void | Promise<void>): Promise<TurnReceipt> {
    if (!text.trim() || text.length > 1800) throw new SessionError('limit');
    this.assertAllowed(speaker);
    return this.enqueue({ id: newIncident(), speaker, text, notify, receivedAt: performance.now(), cancelled: false });
  }

  async voiceTurn(speaker: SpeakerContext, pcm: Buffer, timing?: CaptureTiming): Promise<TurnReceipt | undefined> {
    this.assertAllowed(speaker, true);
    if (!pcm.length || pcm.length % 4 || pcm.length > Math.min(this.options.maxTurnSeconds, 30) * 48_000 * 4) {
      this.options.metric?.('voice_capture_limit_rejected'); throw new SessionError('limit');
    }
    // Claim before asynchronous wake detection, so a duplicate delivery cannot
    // purchase another STT check or occupy a second queue position. No PCM hashes.
    if (this.captures.duplicate(speaker.discordUserId, speaker.consentVersion, speaker.channelId, timing)) {
      this.options.metric?.('voice_capture_duplicates'); return;
    }
    if (this.checking.has(speaker.discordUserId)) {
      this.options.metric?.('voice_wake_busy'); throw new SessionError('busy');
    }
    if (this.checking.size >= this.options.maxSessions) {
      this.options.metric?.('voice_capture_limit_rejected'); throw new SessionError('limit');
    }
    const existing = this.entries.get(speaker.discordUserId);
    const incident = newIncident();
    this.options.metric?.('voice_turns_captured');
    this.inputReport(incident, 'jarvis_voice_captured', 'voice_capture', {
      capture_bytes: pcm.length, capture_ms: Math.round(pcm.length / 192_000 * 1000),
      ...(timing ? { capture_wait_ms: timing.captureMs, end_detection_ms: timing.endDetectionMs } : {}),
    });
    const abort = new AbortController();
    let owned: Buffer | undefined = Buffer.from(pcm);
    this.checking.set(speaker.discordUserId, abort);
    try {
      const prior = this.followups.get(speaker.discordUserId);
      const followup = (existing && existing.speaker.consentVersion === speaker.consentVersion
        && existing.speaker.channelId === speaker.channelId
        && existing.followupUntil > Date.now()) || (prior && prior.consentVersion === speaker.consentVersion
          && prior.channelId === speaker.channelId && prior.until > Date.now());
      const wakeStart = performance.now();
      if (!followup) {
        const activated = await this.options.detectWake(owned, abort.signal);
        this.options.metric?.('wake_detection_ms', Math.round(performance.now() - wakeStart));
        this.options.metric?.(activated ? 'voice_wake_activations' : 'wake_rejections');
        this.inputReport(incident, 'jarvis_wake_detected', 'wake_detection', { wake_detected: activated, followup: false,
          duration_ms: Math.max(0, Math.round(performance.now() - wakeStart)) });
        if (!activated) return;
      } else this.inputReport(incident, 'jarvis_wake_detected', 'wake_detection', { wake_detected: false, followup: true });
      if (abort.signal.aborted) return;
      this.assertAllowed(speaker, true);
      const request: TurnRequest = { id: incident, speaker, pcm: owned,
        receivedAt: performance.now(), cancelled: false };
      let receipt: TurnReceipt;
      try { receipt = this.enqueue(request); }
      catch (error) {
        if (error instanceof SessionError && error.code === 'limit') this.options.metric?.('voice_queue_rejected');
        throw error;
      }
      owned = undefined;
      return receipt;
    } finally {
      owned?.fill(0);
      if (this.checking.get(speaker.discordUserId) === abort) this.checking.delete(speaker.discordUserId);
    }
  }

  private enqueue(request: TurnRequest): TurnReceipt {
    const waiting = !!this.active || this.queue.length > 0;
    const perUser = this.queue.filter(item => item.speaker.discordUserId === request.speaker.discordUserId).length;
    const queuedBytes = this.queue.reduce((total, item) => total + (item.pcm?.length ?? 0), 0);
    if (waiting && this.queue.length >= this.maxQueuedTurns) throw new SessionError('limit', 'queue_full');
    if (waiting && perUser >= this.maxQueuedPerUser) throw new SessionError('limit', 'user_queue_full');
    if (waiting && queuedBytes + (request.pcm?.length ?? 0) > 16 * 1024 * 1024)
      throw new SessionError('limit', 'voice_memory_limit');
    this.claimTurn();
    this.options.metric?.('questions_received');
    // Owners move ahead of waiting guests; the active request is never displaced.
    const firstGuest = request.speaker.isOwner ? this.queue.findIndex(item => !item.speaker.isOwner) : -1;
    if (firstGuest < 0) this.queue.push(request); else this.queue.splice(firstGuest, 0, request);
    this.options.metric?.('turn_queue_depth', 1);
    const position = waiting ? this.queue.indexOf(request) + 1 : 0;
    this.queueReport(request, position);
    request.timer = setTimeout(() => this.cancelQueued(request, 'expired'),
      this.queueTtlSeconds * 1000);
    request.timer.unref();
    if (waiting) {
      this.options.metric?.('questions_queued');
      this.notify(request, { type: 'queued', position });
    }
    this.pump();
    if (this.active) {
      const entry = this.entries.get(this.active.speaker.discordUserId);
      if (entry) this.retireForQueued(entry);
    }
    return { queued: waiting, position, turnId: request.id };
  }

  private pump(): void {
    if (this.closed || !this.available || this.active) return;
    const request = this.queue.shift();
    if (!request) return;
    this.options.metric?.('turn_queue_depth', -1);
    if (request.timer) clearTimeout(request.timer);
    this.active = request;
    void this.dispatch(request).finally(() => this.pump());
  }

  private async dispatch(request: TurnRequest): Promise<void> {
    let entry: Entry | undefined;
    try {
      this.assertAllowed(request.speaker, !!request.pcm);
      request.dispatchAt = performance.now();
      this.options.metric?.('question_queue_wait_ms', Math.round(request.dispatchAt - request.receivedAt));
      this.queueReport(request, 0);
      entry = await this.ensure(request.speaker, request);
      if (request.cancelled || this.active !== request) return;
      this.assertAllowed(request.speaker, !!request.pcm);
      await this.options.prepareSession?.(request.speaker, entry.session!, entry.sessionReused,
        { incident: request.id, inputKind: request.pcm ? 'voice' : 'text' });
      if (request.cancelled || this.active !== request || !this.usable(entry)) return;
      this.assertAllowed(request.speaker, !!request.pcm);
      this.begin(entry, request);
      this.options.metric?.('questions_started');
      this.notify(request, { type: 'started' });
      if (request.text !== undefined) {
        entry.session!.sendText(request.text);
        request.text = undefined;
      } else if (request.pcm) await this.upload(entry, request.pcm);
    } catch (error) {
      if (!request.cancelled && this.active === request) {
        if (entry) this.providerError(entry, error instanceof AgentError ? error.code : 'agent_send_failed');
        else {
          this.options.metric?.('questions_failed');
          this.notify(request, { type: 'failed', reason: 'provider' });
          this.active = undefined;
        }
      }
    } finally { this.eraseRequest(request); }
  }

  private async upload(entry: Entry, pcm: Buffer): Promise<void> {
    const abort = new AbortController();
    entry.upload = abort;
    const rate = entry.session!.inputSampleRate;
    const mono = convertPcm(pcm, 48_000, 2, rate, 1);
    const tail = Buffer.alloc(Math.round(rate * 0.8) * 2);
    const uploadStartedAt = performance.now();
    this.report(entry, 'jarvis_agent_input_started');
    try {
      const frameBytes = Math.round(rate / 50) * 2;
      for (const segment of [mono, tail]) {
        for (let offset = 0; offset < segment.length; offset += frameBytes) {
          if (!this.usable(entry) || !this.options.allowed(entry.speaker, true) || abort.signal.aborted) return;
          const chunk = segment.subarray(offset, offset + frameBytes);
          // Set the phase before sendAudio: providers/tests may emit synchronously.
          entry.inputAudioChunks++;
          entry.inputAudioBytes += chunk.length;
          if (segment === mono) entry.inputSourceChunks++; else entry.inputSilenceChunks++;
          entry.session!.sendAudio(chunk);
          this.options.metric?.('agent_input_audio_chunks');
          this.options.metric?.('agent_input_audio_bytes', chunk.length);
          await (this.options.pace?.(abort.signal) ?? delay(20, undefined, { signal: abort.signal }));
        }
      }
      entry.inputAudioFinished = true;
      entry.uploadMs = Math.max(0, Math.round(performance.now() - uploadStartedAt));
      this.options.metric?.('agent_audio_upload_ms', entry.uploadMs);
      this.options.metric?.('agent_input_source_chunks', entry.inputSourceChunks);
      this.options.metric?.('agent_input_silence_chunks', entry.inputSilenceChunks);
      this.report(entry, 'jarvis_agent_input_sent');
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally {
      mono.fill(0); tail.fill(0);
      if (entry.upload === abort) entry.upload = undefined;
      if ((entry.inputAudioFinished && entry.completionReceived && !entry.pendingTools)
        || (entry.providerClosed && entry.audioBytes > 0)) this.seal(entry);
      this.retireForQueued(entry);
    }
  }

  private notify(request: TurnRequest, event: Omit<TurnNotification, 'turnId'>): void {
    const notification = { ...event, turnId: request.id };
    try { void Promise.resolve(request.notify ? request.notify(notification)
      : this.options.notify?.(request.speaker, notification))
      .catch(() => this.options.metric?.('turn_notification_failed')); }
    catch { this.options.metric?.('turn_notification_failed'); }
  }

  private queueReport(request: TurnRequest, position: number): void {
    this.options.logger?.event('jarvis_turn_queue_changed', 'info', {
      incident: request.id, operation: 'agent_turn', stage: 'agent_response_wait',
      queue_position: position, queue_depth: this.queue.length,
      question_wait_ms: Math.round((request.dispatchAt ?? performance.now()) - request.receivedAt),
    });
  }

  private eraseRequest(request: TurnRequest): void {
    request.pcm?.fill(0); request.pcm = undefined; request.text = undefined;
  }

  private cancelQueued(request: TurnRequest, reason: NonNullable<TurnNotification['reason']>): void {
    const index = this.queue.indexOf(request);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.options.metric?.('turn_queue_depth', -1);
    if (request.timer) clearTimeout(request.timer);
    request.cancelled = true;
    this.eraseRequest(request);
    this.options.metric?.('questions_cancelled');
    this.queueReport(request, 0);
    this.notify(request, { type: 'cancelled', reason });
  }

  private assertAllowed(speaker: SpeakerContext, audio = false): void {
    if (this.closed || !this.available) throw new SessionError('closed');
    if (!speaker.consented || !this.options.allowed(speaker, audio)) throw new SessionError('consent');
  }

  private async ensure(speaker: SpeakerContext, request: TurnRequest): Promise<Entry> {
    let entry = this.entries.get(speaker.discordUserId);
    if (entry && (entry.speaker.consentVersion !== speaker.consentVersion
      || entry.speaker.channelId !== speaker.channelId)) { this.remove(entry, false); entry = undefined; }
    if (entry) {
      if (entry.opening) await entry.opening;
      this.assertAllowed(speaker);
      if (!this.usable(entry)) throw new SessionError('closed');
      entry.speaker = speaker;
      this.options.metric?.('agent_session_reused');
      entry.sessionReused = true;
      return entry;
    }
    // Idle contexts can be evicted independently of the global request queue.
    // This keeps bounded per-speaker isolation without refusing a third caller.
    if (this.entries.size >= this.options.maxSessions) {
      const inactive = [...this.entries.values()].find(item => !item.waiting && !item.playing && !item.opening);
      if (inactive) this.remove(inactive);
    }
    if (this.entries.size >= this.options.maxSessions) throw new SessionError('busy');
    entry = { speaker, abort: new AbortController(), waiting: false, playing: false,
      ingressEnded: false, playbackDone: false, recovering: false, superseded: false, pendingTools: 0, acceptingAudio: false,
      responseIds: new Set(), completedResponseIds: new Set(),
      completionIds: new Set(),
      followupUntil: 0, turnStarted: request.receivedAt, incident: request.id,
      audioChunks: 0, audioBytes: 0, textReceived: false, completionReceived: false,
      providerClosed: false, failed: false, localDrained: false, turnReleased: true,
      voiceInput: request.pcm !== undefined, userTurnRecognized: false, inputAudioChunks: 0, inputAudioBytes: 0,
      recognizedUserEventIds: new Set(),
      inputAudioFinished: false, rejectedAudioIds: new Set(), rejectedResponseIds: new Set(), sessionReused: false,
      inputSourceChunks: 0, inputSilenceChunks: 0,
      initialAudioReported: false, initialResponseReported: false };
    this.entries.set(speaker.discordUserId, entry);
    const current = entry;
    const callbacks: AgentCallbacks = {
      onAudio: (audio, eventId, info) => this.audio(current, audio, eventId, info?.responseId),
      onResponseComplete: (id) => this.complete(current, id),
      onUserTranscript: (identity) => {
        if (!this.usable(current)) return;
        if (identity?.eventId !== undefined) {
          if (current.recognizedUserEventIds.has(identity.eventId)) {
            this.options.metric?.('agent_stale_user_turns'); return;
          }
          if (!this.quarantineId(current, current.recognizedUserEventIds, identity.eventId)) return;
        }
        if (!current.waiting || !current.voiceInput || !current.inputAudioChunks) {
          this.options.metric?.('agent_unsolicited_user_turns'); return;
        }
        if (current.userTurnRecognized) return;
        current.userTurnRecognized = true;
        this.options.metric?.('agent_user_turns_recognized');
        this.report(current, 'jarvis_agent_user_turn_recognized');
        this.progress(current);
      },
      onTextResponse: (identity) => {
        if (this.blockInitial(current, identity?.eventId, identity?.responseId)) return;
        if (this.usable(current) && current.waiting && this.identifyResponse(current, identity?.responseId)) {
          const first = !current.textReceived;
          current.textReceived = true;
          if (first) {
            if (current.voiceInput) this.options.metric?.('agent_responses_after_recognition');
            this.report(current, 'jarvis_agent_response_observed');
          }
          this.progress(current);
          this.retireForQueued(current);
        }
      },
      onToolActivity: (pending) => {
        if (!this.usable(current)) return;
        current.pendingTools = pending;
        if (current.completionReceived && pending === 0) this.seal(current);
        else this.progress(current);
        this.retireForQueued(current);
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
      const startedAt = performance.now();
      current.opening = this.options.connect(speaker, callbacks, current.abort.signal);
      const session = await current.opening;
      if (!this.usable(current)) { session.close(); throw new SessionError('consent'); }
      current.session = session;
      current.opening = undefined;
      this.options.metric?.('agent_sessions_started');
      this.options.metric?.('agent_session_open_ms', Math.round(performance.now() - startedAt));
      this.report(current, 'jarvis_agent_session_ready');
      this.idle(current);
      return current;
    } catch (error) {
      this.providerError(current, error instanceof AgentError ? error.code : 'agent_connect_failed');
      throw error;
    }
  }

  private claimTurn(): void {
    if (Date.now() - this.budgetStart >= 3_600_000) { this.budgetStart = Date.now(); this.turns = 0; }
    if (this.turns >= this.options.maxTurnsPerHour) throw new SessionError('limit', 'turn_budget');
    this.turns++;
  }

  private begin(entry: Entry, request: TurnRequest): void {
    if (!this.usable(entry)) throw new SessionError('consent');
    if (entry.waiting || entry.playing) throw new SessionError('busy');
    entry.waiting = true;
    entry.request = request;
    entry.voiceInput = request.pcm !== undefined;
    entry.userTurnRecognized = false;
    entry.inputAudioChunks = entry.inputAudioBytes = 0;
    entry.inputAudioFinished = false;
    entry.inputSourceChunks = entry.inputSilenceChunks = 0;
    entry.uploadMs = undefined;
    // Keep the greeting identifiers observed while a fresh socket was opening.
    // Later turns reset this quarantine; IDs are not assumed monotonic or unique chunks.
    if (entry.sessionReused) entry.rejectedAudioIds.clear();
    entry.initialAudioReported = entry.initialResponseReported = false;
    entry.turnReleased = false;
    entry.localDrained = false;
    entry.firstAudioAt = entry.firstPlaybackAt = entry.lastAudioAt = entry.drainedAt = undefined;
    for (const id of entry.responseIds) entry.completedResponseIds.add(id);
    entry.responseIds.clear();
    entry.stream = undefined;
    entry.ingressEnded = false;
    entry.playbackDone = false;
    entry.recovering = false;
    entry.superseded = false;
    entry.acceptingAudio = false;
    entry.audioChunks = 0;
    entry.audioBytes = 0;
    entry.textReceived = false;
    entry.completionReceived = false;
    entry.failed = false;
    entry.incident = request.id;
    entry.turnStarted = request.receivedAt;
    entry.followupUntil = 0;
    if (entry.idle) clearTimeout(entry.idle);
    this.progress(entry);
    this.options.metric?.('agent_turns');
    this.report(entry, 'jarvis_agent_turn_started');
  }

  private usable(entry: Entry): boolean {
    return !this.closed && this.available && !entry.abort.signal.aborted
      && this.entries.get(entry.speaker.discordUserId) === entry && this.options.allowed(entry.speaker);
  }

  private inputReport(incident: string, event: string, stage: 'voice_capture' | 'wake_detection', fields: DiagnosticFields): void {
    this.options.logger?.event(event, 'info', {
      ...fields, incident, operation: 'agent_turn', stage, input_kind: 'voice', speaker_verified: true, consent_current: true,
    });
  }

  /** ASR confirms a user's utterance; startup output cannot stand in for that signal. */
  private blockInitial(entry: Entry, eventId?: number, responseId?: string, audio = false): boolean {
    if (!this.usable(entry)) return true;
    const beforeRecognition = entry.voiceInput && !entry.userTurnRecognized;
    const quarantined = (entry.voiceInput && eventId !== undefined && entry.rejectedAudioIds.has(eventId))
      || (responseId !== undefined && entry.rejectedResponseIds.has(responseId));
    if (!beforeRecognition && !quarantined) return false;
    if (beforeRecognition) {
      if (!this.quarantineId(entry, entry.rejectedAudioIds, eventId)
        || !this.quarantineId(entry, entry.rejectedResponseIds, responseId)) return true;
    }
    this.options.metric?.(audio ? 'agent_initial_audio_discarded' : 'agent_initial_response_discarded');
    if (audio ? !entry.initialAudioReported : !entry.initialResponseReported) {
      if (audio) entry.initialAudioReported = true; else entry.initialResponseReported = true;
      this.report(entry, 'jarvis_agent_initial_output_discarded');
    }
    return true;
  }

  private quarantineId<T>(entry: Entry, set: Set<T>, id: T | undefined): boolean {
    if (id === undefined) return true;
    // Store identities only in bounded process memory, never in diagnostics.
    if (set.size >= 128 && !set.has(id)) { this.fail(entry, 'AGENT_INVALID_EVENT'); return false; }
    set.add(id);
    return true;
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

  private async audio(entry: Entry, pcm: Buffer, eventId: number, responseId?: string): Promise<void> {
    if (!this.usable(entry)) return;
    this.options.metric?.('audio_chunks_received');
    this.options.metric?.('audio_bytes_received', pcm.length);
    if (this.blockInitial(entry, eventId, responseId, true)) return;
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
    // New ingress invalidates a previous local drain before any asynchronous
    // write or playback observer can race with a waiting request.
    entry.localDrained = false;
    entry.lastAudioAt = performance.now();
    if (entry.firstAudioAt === undefined) {
      entry.firstAudioAt = entry.lastAudioAt;
      this.options.metric?.('agent_first_audio_ms', Math.round(entry.firstAudioAt - entry.turnStarted));
    }
    entry.acceptingAudio = true;
    this.progress(entry);
    try {
      if (!entry.stream) {
        entry.playing = true;
        const stream = this.options.playback.startStream(entry.speaker.discordUserId,
          entry.session.outputSampleRate, entry.speaker.isOwner, {
            isAllowed: () => this.usable(entry),
            onProgress: (event) => this.playbackProgress(entry, event),
          });
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
        this.retireForQueued(entry);
      }
    }
  }

  private complete(entry: Entry, eventId?: number): void {
    if (!this.usable(entry)) return;
    if (this.blockInitial(entry, eventId)) return;
    if (!entry.waiting) return;
    if (eventId !== undefined && entry.completionIds.has(eventId)) {
      this.options.metric?.('agent_duplicate_completions'); return;
    }
    if (eventId !== undefined) {
      if (entry.completionIds.size >= 128) { this.fail(entry, 'AGENT_INVALID_EVENT'); return; }
      entry.completionIds.add(eventId);
    }
    entry.completionReceived = true;
    if (entry.deadline) clearTimeout(entry.deadline);
    this.options.metric?.('agent_response_complete_received');
    this.options.metric?.('agent_responses_completed');
    this.report(entry, 'jarvis_agent_response_complete');
    // A provider response must not truncate recorded microphone input. Output
    // remains progressive while the complete capture and VAD tail finish uploading.
    if (entry.voiceInput && !entry.inputAudioFinished) {
      this.options.metric?.('agent_completion_during_input'); return;
    }
    if (!entry.pendingTools) this.seal(entry);
  }

  /** Ingress closure is separate from generation confirmation and local drain. */
  private seal(entry: Entry): void {
    if (!this.usable(entry) || entry.ingressEnded || entry.acceptingAudio
      || (entry.voiceInput && !entry.inputAudioFinished && entry.upload !== undefined)) return;
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
    if (entry.turnReleased) return;
    entry.turnReleased = true;
    this.options.metric?.('agent_turn_logical_end_ms', Math.round(performance.now() - entry.turnStarted));
    this.report(entry, 'jarvis_agent_turn_finished');
    if (!entry.completionReceived || entry.recovering) { this.remove(entry); return; }
    this.options.metric?.('agent_turns_completed');
    if (entry.providerClosed) { this.remove(entry); return; }
    entry.followupUntil = Date.now() + this.options.followupSeconds * 1000;
    this.rememberFollowup(entry.speaker);
    this.idle(entry);
    this.release(entry);
  }

  private playbackProgress(entry: Entry, event: 'first_packet' | 'drained' | 'resumed'): void {
    if (!this.usable(entry) || entry.turnReleased) return;
    const now = performance.now();
    if (event === 'first_packet' && entry.firstPlaybackAt === undefined) {
      entry.firstPlaybackAt = now;
      this.options.metric?.('agent_first_playback_ms', Math.round(now - entry.turnStarted));
    }
    if (event === 'drained') {
      entry.localDrained = true;
      entry.drainedAt = now;
      this.options.metric?.('agent_playback_drained_ms', Math.round(now - entry.turnStarted));
      // A perceptual follow-up window is authorization to hear this speaker's
      // next utterance, not proof that the provider has completed generation.
      entry.followupUntil = Date.now() + this.options.followupSeconds * 1000;
      this.rememberFollowup(entry.speaker);
    } else if (event === 'resumed') entry.localDrained = false;
    this.report(entry, 'jarvis_agent_audio_progress');
    this.retireForQueued(entry);
  }

  private retireForQueued(entry: Entry): void {
    if (!this.queue.length || !this.usable(entry) || entry.turnReleased || entry.recovering
      || entry.completionReceived || !entry.waiting || !entry.textReceived || !entry.audioBytes
      || !entry.localDrained || entry.acceptingAudio || entry.pendingTools || entry.upload) return;
    // The NEW REQUEST authorizes retiring an unconfirmed old provider turn.
    // A quiet interval alone never does. Drain validated adapter input before
    // ending the local stream; a fresh provider session fences all late events.
    this.missing(entry);
    entry.recovering = true;
    entry.superseded = true;
    this.options.metric?.('agent_turns_superseded');
    this.report(entry, 'jarvis_agent_turn_superseded');
    if (entry.deadline) clearTimeout(entry.deadline);
    entry.session?.close({ drainAudio: true });
  }

  private release(entry: Entry): void {
    if (!this.active || (entry.request !== this.active && this.active.speaker.discordUserId !== entry.speaker.discordUserId)) return;
    if (entry.drainedAt !== undefined) this.options.metric?.('next_question_ready_ms',
      Math.round(performance.now() - entry.drainedAt));
    if (entry.lastAudioAt !== undefined) this.options.metric?.('agent_last_audio_ms',
      Math.round(entry.lastAudioAt - entry.turnStarted));
    this.active = undefined;
    entry.request = undefined;
    queueMicrotask(() => this.pump());
  }

  private rememberFollowup(speaker: SpeakerContext): void {
    for (const [id, value] of this.followups) if (value.until <= Date.now()) this.followups.delete(id);
    if (!this.followups.has(speaker.discordUserId) && this.followups.size >= 16) {
      const oldest = this.followups.keys().next().value;
      if (oldest !== undefined) this.followups.delete(oldest);
    }
    this.followups.set(speaker.discordUserId, { consentVersion: speaker.consentVersion,
      channelId: speaker.channelId, until: Date.now() + this.options.followupSeconds * 1000 });
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
      if (entry.voiceInput && !entry.userTurnRecognized) {
        this.options.metric?.('agent_user_turn_missing');
        this.fail(entry, 'AGENT_USER_TURN_MISSING');
      } else if (entry.audioBytes > 0) {
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
      stage: event === 'jarvis_agent_input_started' || event === 'jarvis_agent_input_sent' ? 'agent_audio_upload'
        : event === 'jarvis_agent_session_ready' ? 'agent_connect'
        : event === 'jarvis_agent_user_turn_recognized' ? 'agent_user_recognition'
        : entry.voiceInput && !entry.userTurnRecognized ? 'agent_user_recognition'
        : entry.playing ? 'playback' : entry.textReceived && !entry.audioBytes ? 'agent_audio_wait'
        : entry.waiting ? 'agent_response_wait' : 'agent_connect',
      ...(code ? { code, category: code === 'PLAYBACK_FAILED' ? 'playback' : 'agent' } : {}),
      duration_ms: Math.max(0, Math.round(performance.now() - entry.turnStarted)),
      audio_chunks: entry.audioChunks, audio_bytes: entry.audioBytes,
      text_received: entry.textReceived, completion_received: entry.completionReceived,
      ingress_ended: entry.ingressEnded, playback_drained: entry.playbackDone,
      local_playback_drained: entry.localDrained,
      recovery: entry.recovering, pending_tools: entry.pendingTools,
      input_kind: entry.voiceInput ? 'voice' : 'text', user_turn_recognized: entry.userTurnRecognized,
      input_audio_chunks: entry.inputAudioChunks, input_audio_bytes: entry.inputAudioBytes,
      input_source_chunks: entry.inputSourceChunks, input_silence_chunks: entry.inputSilenceChunks,
      ...(entry.uploadMs === undefined ? {} : { upload_ms: entry.uploadMs }),
      input_audio_finished: entry.inputAudioFinished, silence_tail_ms: entry.voiceInput ? 800 : 0,
      ...(entry.session ? { input_sample_rate: entry.session.inputSampleRate, output_sample_rate: entry.session.outputSampleRate } : {}),
      session_reused: entry.sessionReused, speaker_verified: true,
      consent_current: this.options.allowed(entry.speaker, entry.voiceInput),
      queue_depth: this.queue.length,
      turn_outcome: entry.failed ? 'failed' : entry.turnReleased
        ? entry.completionReceived && !entry.recovering ? 'completed' : entry.superseded ? 'superseded' : 'unconfirmed' : undefined,
      ...(entry.request?.dispatchAt === undefined ? {} : {
        question_wait_ms: Math.round(entry.request.dispatchAt - entry.request.receivedAt),
      }),
      ...(entry.firstAudioAt === undefined ? {} : { first_audio_ms: Math.round(entry.firstAudioAt - entry.turnStarted) }),
      ...(entry.lastAudioAt === undefined ? {} : { last_audio_ms: Math.round(entry.lastAudioAt - entry.turnStarted) }),
      ...(entry.firstPlaybackAt === undefined ? {} : { first_playback_ms: Math.round(entry.firstPlaybackAt - entry.turnStarted) }),
      ...(entry.drainedAt === undefined ? {} : { drain_ms: Math.round(entry.drainedAt - entry.turnStarted) }),
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
      agent_initiation_rejected: 'AGENT_INITIATION_REJECTED',
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
    if (entry.voiceInput && entry.upload && !entry.inputAudioFinished) {
      entry.upload.abort();
      this.options.metric?.('agent_input_incomplete');
      entry.recovering = true;
      if (!entry.failed) {
        this.options.metric?.('agent_errors');
        this.primaryError(entry, 'AGENT_INPUT_INCOMPLETE');
      }
      // The upload's finally releases the ingress guard and seals valid output.
      // A partial input must not become a completed conversational turn.
    }
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
    // The provider can interrupt its initial output upon detecting incoming speech.
    // Like the SDK's output.interrupt(), this must not cut off the user's upload.
    if (this.usable(entry) && entry.waiting && entry.voiceInput && !entry.userTurnRecognized
      && entry.inputAudioChunks > 0 && !entry.stream && !entry.playing) {
      this.options.metric?.('agent_input_interruptions');
      this.report(entry, 'jarvis_agent_initial_output_discarded');
      return;
    }
    // Closing the provider session fences late audio/completion from the old turn.
    // A new question creates a fresh session instead of trusting event arrival timing.
    this.remove(entry, true, 'interrupted');
  }

  private idle(entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this.remove(entry), this.options.idleSeconds * 1000);
    entry.idle.unref();
  }

  private remove(entry: Entry, release = true, reason: NonNullable<TurnNotification['reason']> = 'closed'): void {
    if (this.entries.get(entry.speaker.discordUserId) !== entry) return;
    this.entries.delete(entry.speaker.discordUserId);
    if (release && this.active?.speaker.discordUserId === entry.speaker.discordUserId) {
      if (!this.active.cancelled && (!entry.turnReleased || entry.failed || entry.opening)) {
        this.options.metric?.(entry.failed ? 'questions_failed' : 'questions_cancelled');
        this.notify(this.active, { type: entry.failed ? 'failed' : 'cancelled',
          reason: entry.failed ? 'provider' : reason });
      }
      this.active.cancelled = true;
      this.eraseRequest(this.active);
      this.release(entry);
    }
    entry.upload?.abort();
    entry.abort.abort();
    for (const timer of [entry.idle, entry.lifetime, entry.deadline]) if (timer) clearTimeout(timer);
    entry.stream?.cancel();
    this.options.playback.stopUser(entry.speaker.discordUserId);
    entry.session?.close();
  }

  revoke(userId: string): void {
    this.cancelUser(userId, 'revoked');
  }

  cancelUser(userId: string, reason: NonNullable<TurnNotification['reason']> = 'closed'): void {
    this.followups.delete(userId);
    this.captures.forget(userId);
    for (const request of [...this.queue]) if (request.speaker.discordUserId === userId) this.cancelQueued(request, reason);
    this.checking.get(userId)?.abort();
    this.checking.delete(userId);
    const entry = this.entries.get(userId);
    if (entry) this.remove(entry, true, reason);
    else if (this.active?.speaker.discordUserId === userId) {
      this.active.cancelled = true;
      this.eraseRequest(this.active);
      this.options.metric?.('questions_cancelled');
      this.notify(this.active, { type: 'cancelled', reason });
      this.active = undefined;
      queueMicrotask(() => this.pump());
    }
    this.options.playback.stopUser(userId);
  }

  interruptOwner(speaker: SpeakerContext): boolean {
    this.assertAllowed(speaker, true);
    if (!speaker.isOwner || !this.active) return false;
    this.options.metric?.('owner_interruptions');
    this.rememberFollowup(speaker);
    const current = this.active.speaker.discordUserId;
    // Owner barge-in cancels only the active turn, preserving waiting callers.
    const entry = this.entries.get(current);
    if (entry) this.remove(entry, true, 'interrupted');
    else {
      this.active.cancelled = true;
      this.eraseRequest(this.active);
      this.notify(this.active, { type: 'cancelled', reason: 'interrupted' });
      this.options.metric?.('questions_cancelled');
      this.active = undefined;
      queueMicrotask(() => this.pump());
    }
    return true;
  }

  setAvailable(available: boolean): void {
    if (this.closed) return;
    this.available = available;
    if (available) { this.pump(); return; }
    this.followups.clear();
    this.captures.clear();
    for (const request of [...this.queue]) this.cancelQueued(request, 'closed');
    for (const abort of this.checking.values()) abort.abort();
    this.checking.clear();
    for (const entry of [...this.entries.values()]) this.remove(entry);
    if (this.active) {
      this.active.cancelled = true;
      this.eraseRequest(this.active);
      this.notify(this.active, { type: 'cancelled', reason: 'closed' });
      this.active = undefined;
    }
  }

  close(): void {
    this.closed = true;
    this.followups.clear();
    this.captures.clear();
    for (const request of [...this.queue]) this.cancelQueued(request, 'closed');
    for (const abort of this.checking.values()) abort.abort();
    this.checking.clear();
    for (const entry of this.entries.values()) this.remove(entry);
    if (this.active) {
      this.eraseRequest(this.active);
      this.notify(this.active, { type: 'cancelled', reason: 'closed' });
      this.active.cancelled = true;
      this.active = undefined;
    }
    this.options.playback.stop();
  }
}
