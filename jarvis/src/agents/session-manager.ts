import { setTimeout as delay } from 'node:timers/promises';
import { AgentError, type AgentCallbacks, type AgentConversationText, type AgentSession } from './elevenlabs-client.js';
import { WakeError } from './wake-detector.js';
import { convertPcm } from '../audio/pcm-conversion.js';
import { CaptureWindows, type CaptureTiming } from '../audio/capture-window.js';
import { playbackFailureFields, type PlaybackStream, type PlaybackStreamOptions } from '../audio/playback.js';
import type { SpeakerContext } from '../policy/identity.js';
import { Logger, newIncident, sanitizeDiagnosticFields, type DiagnosticFields, type ErrorCode } from '../observability/metrics.js';
import type { VoiceAdmissionDetails, VoiceAdmissionEvent } from '../observability/voice-admission-evidence.js';

export interface Playback {
  readonly isPlaying: boolean;
  startStream(userId: string, sampleRate: number, owner: boolean,
    options?: PlaybackStreamOptions): PlaybackStream;
  stopUser(userId: string): void;
  stop(): void;
}
export interface SessionOptions {
  connect: (speaker: SpeakerContext, callbacks: AgentCallbacks, signal: AbortSignal) => Promise<AgentSession>;
  allowed: (speaker: SpeakerContext, audio?: boolean) => boolean;
  detectWake: (pcm: Buffer, signal: AbortSignal, speaker?: SpeakerContext) => Promise<boolean>;
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
  /** Explicit, bounded RAM-only handoff. Never forward conversational text to logs. */
  onTurnDelivered?: (speaker: SpeakerContext, event: DeliveredTurn) => void | Promise<void>;
  /** Monotonic upper bound for context already supplied to a provider socket. */
  sessionContextExpiresAt?: (speaker: SpeakerContext) => number | undefined;
  /** Bounded technical evidence only; never conversational content or identity logs. */
  observe?: (speaker: SpeakerContext, event: VoiceAdmissionEvent, details?: VoiceAdmissionDetails) => void;
}
export interface DeliveredTurn {
  turnId: string;
  inputKind: 'voice' | 'text';
  question: string;
  /** Present only for confirmed generation with intact final text and drained playback. */
  response?: string;
  /** Final text observed in an unconfirmed turn; never proof that its full audio was heard. */
  observedResponse?: string;
  generation: 'confirmed' | 'unconfirmed';
}
export interface TurnReceipt { queued: boolean; position: number; turnId: string; }
export interface TurnNotification {
  type: 'queued' | 'started' | 'cancelled' | 'failed';
  turnId: string;
  position?: number;
  reason?: 'expired' | 'revoked' | 'interrupted' | 'closed' | 'provider' | 'limit';
  /** Local delivery evidence only; never a claim that a listener heard the answer. */
  delivery?: TurnDelivery;
  generationComplete?: boolean;
  localDrained?: boolean;
}
export type TurnDelivery = 'none' | 'not_started' | 'partial' | 'unconfirmed' | 'confirmed';
type TurnOutcome = 'completed' | 'unconfirmed' | 'failed' | 'partial' | 'cancelled' | 'expired';
interface TurnRequest {
  id: string;
  inputKind: 'voice' | 'text';
  speaker: SpeakerContext;
  receivedAt: number;
  /** Monotonic timestamp supplied by this process's Discord capture, never wall time. */
  captureStartedAt?: number;
  speechEndedAt?: number;
  wakeMs?: number;
  connectMs?: number;
  dispatchAt?: number;
  text?: string;
  pcm?: Buffer;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  queuedNotified?: boolean;
  terminalNotified?: boolean;
  terminalOutcome?: TurnOutcome;
  released?: boolean;
  notify?: (event: TurnNotification) => void | Promise<void>;
}
interface Entry {
  speaker: SpeakerContext;
  abort: AbortController;
  lifetimeExpiresAt: number;
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
  followupConsumed: boolean;
  followupOffered: boolean;
  turnStarted: number;
  incident: string;
  audioChunks: number;
  audioBytes: number;
  textReceived: boolean;
  completionReceived: boolean;
  completionIds: Set<number>;
  providerClosed: boolean;
  failed: boolean;
  failureCode?: ErrorCode;
  failureStage?: DiagnosticFields['stage'];
  idle?: ReturnType<typeof setTimeout>;
  lifetime?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  recognitionDeadline?: ReturnType<typeof setTimeout>;
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
  recognizedAt?: number;
  acceptedUserEventId?: number;
  userTextPending: boolean;
  recognizedUserEventIds: Set<number>;
  inputAudioChunks: number;
  inputAudioBytes: number;
  inputAudioFinished: boolean;
  inputSourceChunks: number;
  inputSilenceChunks: number;
  inputSilenceTailMs: number;
  uploadMs?: number;
  inputStartedAt?: number;
  inputFinishedAt?: number;
  rejectedAudioIds: Set<number>;
  rejectedResponseIds: Set<string>;
  sessionReused: boolean;
  initialAudioReported: boolean;
  initialResponseReported: boolean;
  conversationQuestion?: string;
  conversationResponse?: string;
  conversationQuestionSafe: boolean;
  conversationResponseSafe: boolean;
  conversationTextIds: Set<string>;
  contextExpiresAt?: number;
  playbackFailure?: DiagnosticFields;
}
export class SessionError extends Error {
  constructor(readonly code: 'consent' | 'busy' | 'limit' | 'closed',
    readonly reason?: 'queue_full' | 'user_queue_full' | 'voice_memory_limit' | 'turn_budget'
      | 'wake_check_busy' | 'wake_capacity' | 'voice_unavailable' | 'consent_invalid') { super(code); }
}

const MIN_CAPTURE_BYTES = 48_000 * 4 / 50; // One 20 ms Discord Opus frame.
const USER_RECOGNITION_TIMEOUT_MS = 10_000;
const RESPONSE_INACTIVITY_TIMEOUT_MS = 45_000;

/** Match the actual stereo-to-mono input, including channels that cancel out. */
function hasMonoSignal(pcm: Buffer): boolean {
  for (let offset = 0; offset < pcm.length; offset += 4) {
    if (Math.round((pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2)) / 2) !== 0) return true;
  }
  return false;
}

/** Preserve every source sample and add only the missing exact digital silence. */
function silencePaddingSamples(pcm: Buffer, sampleRate: number, frameSamples: number): number {
  const target = Math.round(sampleRate * 0.8);
  let existing = 0;
  for (let offset = pcm.length - 2; offset >= 0 && existing < target; offset -= 2) {
    if (pcm.readInt16LE(offset) !== 0) break;
    existing++;
  }
  // Rounding upward never supplies less than 800 ms of trailing zero samples.
  return Math.ceil((target - existing) / frameSamples) * frameSamples;
}

/** One provider session per authenticated Discord speaker; no mixed audio streams. */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly checking = new Map<string, AbortController>();
  private readonly captures = new CaptureWindows();
  private readonly queue: TurnRequest[] = [];
  private readonly followups = new Map<string, { consentVersion: number; channelId: string; until: number; turnId: string }>();
  private active?: TurnRequest;
  private lastDispatchedUserId?: string;
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
    return this.enqueue({ id: newIncident(), inputKind: 'text', speaker, text, notify,
      receivedAt: performance.now(), cancelled: false });
  }

  async voiceTurn(speaker: SpeakerContext, pcm: Buffer, timing?: CaptureTiming): Promise<TurnReceipt | undefined> {
    this.assertAllowed(speaker, true);
    this.observe(speaker, 'capture');
    if (!pcm.length || pcm.length % 4 || pcm.length > Math.min(this.options.maxTurnSeconds, 30) * 48_000 * 4) {
      this.options.metric?.('voice_capture_limit_rejected'); throw new SessionError('limit');
    }
    const incident = newIncident();
    const rejection = pcm.length < MIN_CAPTURE_BYTES ? 'too_short' : !hasMonoSignal(pcm) ? 'silent' : undefined;
    if (rejection) {
      this.options.metric?.(`voice_capture_${rejection}_rejected`);
      this.inputReport(incident, 'jarvis_voice_capture_rejected', 'voice_capture', {
        code: 'AGENT_INPUT_INVALID', capture_rejection: rejection,
        capture_bytes: pcm.length, capture_ms: Math.round(pcm.length / 192_000 * 1000),
      });
      return;
    }
    // Claim before asynchronous wake detection, so a duplicate delivery cannot
    // purchase another STT check or occupy a second queue position. No PCM hashes.
    if (this.captures.duplicate(speaker.discordUserId, speaker.consentVersion, speaker.channelId, timing)) {
      this.options.metric?.('voice_capture_duplicates'); this.observe(speaker, 'duplicate'); return;
    }
    // No paid wake inspection can make a known-full question queue usable.
    // Recheck during enqueue as other speakers can be accepted while STT awaits.
    try { this.assertQueueCapacity(speaker, pcm.length, incident); }
    catch (error) { this.options.metric?.('voice_queue_rejected'); throw error; }
    if (this.checking.has(speaker.discordUserId)) {
      this.options.metric?.('voice_wake_busy'); throw new SessionError('busy', 'wake_check_busy');
    }
    if (this.checking.size >= this.options.maxSessions) {
      this.options.metric?.('voice_capture_limit_rejected'); throw new SessionError('limit', 'wake_capacity');
    }
    const existing = this.entries.get(speaker.discordUserId);
    this.options.metric?.('voice_turns_captured');
    this.inputReport(incident, 'jarvis_voice_captured', 'voice_capture', {
      capture_bytes: pcm.length, capture_ms: Math.round(pcm.length / 192_000 * 1000),
      ...(timing ? { capture_wait_ms: timing.captureMs, end_detection_ms: timing.endDetectionMs,
        first_pcm_ms: timing.firstPcmMs, voice_start_ms: timing.voiceStartMs } : {}),
    });
    const abort = new AbortController();
    let owned: Buffer | undefined = Buffer.from(pcm);
    this.checking.set(speaker.discordUserId, abort);
    try {
      const prior = this.followups.get(speaker.discordUserId);
      const followup = prior && prior.consentVersion === speaker.consentVersion
        && prior.channelId === speaker.channelId && prior.until > performance.now();
      const wakeStart = performance.now();
      let wakeMs: number | undefined;
      if (!followup) {
        let activated: boolean;
        try { activated = await this.options.detectWake(owned, abort.signal, speaker); }
        catch (error) {
          if (!abort.signal.aborted) this.options.logger?.event('jarvis_wake_failed', 'warn', {
            incident, operation: 'agent_turn', stage: 'wake_detection', input_kind: 'voice',
            rejection_reason: error instanceof WakeError
              ? error.rateLimitSource === 'speaker_backoff' ? 'wake_speaker_backoff'
                : error.rateLimitSource === 'speaker_budget' ? 'wake_speaker_rate_limited' : error.code : 'unexpected',
            retry_after_ms: error instanceof WakeError ? error.retryAfterMs : undefined,
            duration_ms: Math.max(0, Math.round(performance.now() - wakeStart)),
          });
          throw error;
        }
        wakeMs = Math.max(0, Math.round(performance.now() - wakeStart));
        this.options.metric?.('wake_detection_ms', wakeMs);
        // Cancellation settles the detector as false; it is not evidence that
        // consenting speech was inspected and lacked the wake word.
        if (abort.signal.aborted) return;
        this.options.metric?.(activated ? 'voice_wake_activations' : 'wake_rejections');
        this.inputReport(incident, 'jarvis_wake_detected', 'wake_detection', { wake_detected: activated, followup: false,
          duration_ms: Math.max(0, Math.round(performance.now() - wakeStart)) });
        if (!activated) return;
      } else this.inputReport(incident, 'jarvis_wake_detected', 'wake_detection', { wake_detected: false, followup: true });
      if (abort.signal.aborted) return;
      this.assertAllowed(speaker, true);
      const receivedAt = performance.now();
      const captureStart = timing?.captureStartedAtMs;
      const captureEnd = timing?.captureEndedAtMs;
      const speechEnd = timing?.speechEndedAtMs;
      const trustedCaptureTime = captureStart !== undefined && captureEnd !== undefined
        && Number.isFinite(captureStart) && Number.isFinite(captureEnd)
        && captureStart >= 0 && captureEnd >= captureStart && captureEnd <= receivedAt
        && receivedAt - captureStart <= 120_000;
      const trustedSpeechEnd = trustedCaptureTime && speechEnd !== undefined && Number.isFinite(speechEnd)
        && speechEnd >= captureStart! && speechEnd <= captureEnd!;
      const request: TurnRequest = { id: incident, inputKind: 'voice', speaker, pcm: owned,
        receivedAt, cancelled: false, ...(trustedCaptureTime ? { captureStartedAt: captureStart } : {}),
        ...(trustedSpeechEnd ? { speechEndedAt: speechEnd } : {}),
        ...(wakeMs === undefined ? {} : { wakeMs }) };
      let receipt: TurnReceipt;
      try { receipt = this.enqueue(request); }
      catch (error) {
        if (error instanceof SessionError && error.code === 'limit') this.options.metric?.('voice_queue_rejected');
        throw error;
      }
      owned = undefined;
      if (followup) {
        if (this.followups.get(speaker.discordUserId) === prior) this.followups.delete(speaker.discordUserId);
        if (existing?.incident === prior.turnId) existing.followupConsumed = true;
        this.observe(speaker, 'followup', { turnId: receipt.turnId });
      }
      return receipt;
    } finally {
      owned?.fill(0);
      if (this.checking.get(speaker.discordUserId) === abort) this.checking.delete(speaker.discordUserId);
    }
  }

  private enqueue(request: TurnRequest): TurnReceipt {
    const waiting = !!this.active || this.queue.length > 0;
    this.assertQueueCapacity(request.speaker, request.pcm?.length ?? 0, request.id);
    this.claimTurn();
    this.options.metric?.('questions_received');
    this.observe(request.speaker, 'question_accepted', { turnId: request.id });
    // Preserve creator priority between speakers, without repeatedly bypassing
    // a guest already waiting behind that creator's own previous response.
    const firstGuest = request.speaker.isOwner && request.speaker.discordUserId !== this.lastDispatchedUserId
      ? this.queue.findIndex(item => !item.speaker.isOwner) : -1;
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

  private assertQueueCapacity(speaker: SpeakerContext, bytes: number, turnId: string): void {
    if (!this.active && !this.queue.length) return;
    const perUser = this.queue.filter(item => item.speaker.discordUserId === speaker.discordUserId).length;
    const queuedBytes = this.queue.reduce((total, item) => total + (item.pcm?.length ?? 0), 0);
    const reason = this.queue.length >= this.maxQueuedTurns ? 'queue_full'
      : perUser >= this.maxQueuedPerUser ? 'user_queue_full'
      : queuedBytes + bytes > 16 * 1024 * 1024 ? 'voice_memory_limit' : undefined;
    if (reason) {
      this.observe(speaker, 'queue_rejected', { turnId });
      throw new SessionError('limit', reason);
    }
  }

  private observe(speaker: SpeakerContext, event: VoiceAdmissionEvent, details?: VoiceAdmissionDetails): void {
    try { this.options.observe?.(speaker, event, details); }
    catch { this.options.metric?.('voice_evidence_callback_failed'); }
  }

  private pump(): void {
    if (this.closed || !this.available || this.active) return;
    const request = this.queue.shift();
    if (!request) return;
    this.options.metric?.('turn_queue_depth', -1);
    if (request.timer) clearTimeout(request.timer);
    this.active = request;
    this.lastDispatchedUserId = request.speaker.discordUserId;
    void this.dispatch(request).finally(() => this.pump());
  }

  private async dispatch(request: TurnRequest): Promise<void> {
    let entry: Entry | undefined;
    let stage: 'agent_connect' | 'session_setup' | 'agent_audio_upload' = 'agent_connect';
    try {
      this.assertAllowed(request.speaker, !!request.pcm);
      request.dispatchAt = performance.now();
      this.options.metric?.('question_queue_wait_ms', Math.round(request.dispatchAt - request.receivedAt));
      this.queueReport(request, 0);
      let reacquired = false;
      for (;;) {
        const previous = this.entries.get(request.speaker.discordUserId);
        try {
          stage = 'agent_connect';
          entry = await this.ensure(request.speaker, request);
          if (request.cancelled || this.active !== request) return;
          this.assertAllowed(request.speaker, !!request.pcm);
          stage = 'session_setup';
          await this.options.prepareSession?.(request.speaker, entry.session!, entry.sessionReused,
            { incident: request.id, inputKind: request.inputKind });
          if (request.cancelled || this.active !== request) return;
          if (!this.usable(entry)) throw new AgentError('agent_closed');
          if (entry.sessionReused && !this.hasTurnLifetime(entry, request)) {
            this.options.metric?.('agent_lifetime_renewed_sessions');
            this.remove(entry, false);
            throw new AgentError('agent_closed');
          }
          break;
        } catch (error) {
          const lost = entry ?? previous;
          if (request.cancelled || this.active !== request) return;
          // Only a reused idle socket that disappeared before begin is eligible.
          // No user text/PCM has been sent and the request budget is not reserved again.
          if (!reacquired && lost?.sessionReused && this.entries.get(request.speaker.discordUserId) !== lost) {
            this.assertAllowed(request.speaker, request.inputKind === 'voice');
            reacquired = true;
            this.options.metric?.('agent_idle_session_reacquired');
            entry = undefined;
            continue;
          }
          throw error;
        }
      }
      this.assertAllowed(request.speaker, !!request.pcm);
      this.begin(entry, request);
      this.options.metric?.('questions_started');
      this.notify(request, { type: 'started' });
      stage = 'agent_audio_upload';
      if (request.text !== undefined) {
        entry.inputFinishedAt = performance.now();
        entry.session!.sendText(request.text);
        request.text = undefined;
      } else if (request.pcm) await this.upload(entry, request.pcm);
    } catch (error) {
      if (!request.cancelled && this.active === request) {
        const code = error instanceof AgentError ? error.code : stage === 'agent_connect' ? 'agent_connect_failed' : 'agent_send_failed';
        if (entry?.request === request && this.entries.get(request.speaker.discordUserId) === entry) this.providerError(entry, code);
        else {
          // A reused idle socket may disappear while trusted context refresh is
          // awaiting. It does not own this newer request and cannot consume it.
          if (entry && this.entries.get(request.speaker.discordUserId) === entry) this.remove(entry, false);
          this.requestFailure(request, this.providerCode(code), stage);
        }
      }
    } finally { this.eraseRequest(request); }
  }

  private async upload(entry: Entry, pcm: Buffer): Promise<void> {
    const abort = new AbortController();
    entry.upload = abort;
    const rate = entry.session!.inputSampleRate;
    const prepareStarted = performance.now();
    const mono = convertPcm(pcm, 48_000, 2, rate, 1);
    const frameSamples = Math.round(rate / 50);
    const tail = Buffer.alloc(silencePaddingSamples(mono, rate, frameSamples) * 2);
    entry.inputSilenceTailMs = Math.round(tail.length / (rate * 2) * 1_000);
    const prepareMs = Math.max(0, performance.now() - prepareStarted);
    this.options.metric?.('agent_audio_prepare_ms', prepareMs);
    this.report(entry, 'jarvis_agent_input_prepared', undefined, prepareMs);
    const uploadStartedAt = performance.now();
    entry.inputStartedAt = uploadStartedAt;
    this.report(entry, 'jarvis_agent_input_started');
    try {
      const frameBytes = frameSamples * 2;
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
      entry.inputFinishedAt = performance.now();
      entry.uploadMs = Math.max(0, Math.round(performance.now() - uploadStartedAt));
      this.options.metric?.('agent_audio_upload_ms', entry.uploadMs);
      this.options.metric?.('agent_input_source_chunks', entry.inputSourceChunks);
      this.options.metric?.('agent_input_silence_chunks', entry.inputSilenceChunks);
      this.options.metric?.('agent_input_silence_saved_ms', 800 - entry.inputSilenceTailMs);
      this.report(entry, 'jarvis_agent_input_sent');
      // Upload duration is not recognition latency. No provider retry or extra
      // API request follows this fail-fast bound; the next question starts fresh.
      if (!entry.userTurnRecognized && this.usable(entry)) {
        entry.recognitionDeadline = setTimeout(() => {
          if (!this.usable(entry) || !entry.waiting || entry.userTurnRecognized) return;
          this.options.metric?.('agent_user_turn_missing');
          this.fail(entry, 'AGENT_USER_TURN_MISSING');
        }, USER_RECOGNITION_TIMEOUT_MS);
        entry.recognitionDeadline.unref();
      }
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
    if (event.type === 'queued') {
      if (request.queuedNotified) return;
      request.queuedNotified = true;
    }
    if (event.type === 'cancelled' || event.type === 'failed') {
      if (request.terminalNotified) return;
      request.terminalNotified = true;
      if (event.type === 'cancelled') {
        request.terminalOutcome = event.reason === 'expired' ? 'expired' : 'cancelled';
        if (event.delivery === 'partial') this.observe(request.speaker, 'turn_partial', { turnId: request.id });
        this.options.logger?.event('jarvis_agent_turn_cancelled', 'info', {
          incident: request.id, operation: 'agent_turn',
          stage: request.dispatchAt === undefined ? 'turn_enqueue' : 'agent_response_wait',
          turn_outcome: request.terminalOutcome, input_kind: request.inputKind,
          cancellation_reason: event.reason, turn_delivery: event.delivery ?? 'none', queue_depth: this.queue.length,
        });
      }
    }
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
    request.released = true;
    this.notify(request, { type: 'cancelled', reason });
    this.observe(request.speaker, 'turn_released', { turnId: request.id });
    this.options.logger?.event('jarvis_agent_turn_released', 'info', {
      incident: request.id, operation: 'agent_turn', stage: 'turn_enqueue', input_kind: request.inputKind,
      turn_outcome: request.terminalOutcome, turn_delivery: 'none', queue_depth: this.queue.length,
      duration_ms: Math.max(0, Math.round(performance.now() - request.receivedAt)),
    });
  }

  private assertAllowed(speaker: SpeakerContext, audio = false): void {
    if (this.closed || !this.available) throw new SessionError('closed', 'voice_unavailable');
    if (!speaker.consented || !this.options.allowed(speaker, audio)) throw new SessionError('consent', 'consent_invalid');
  }

  private async ensure(speaker: SpeakerContext, request: TurnRequest): Promise<Entry> {
    let entry = this.entries.get(speaker.discordUserId);
    if (entry && (entry.speaker.consentVersion !== speaker.consentVersion
      || entry.speaker.channelId !== speaker.channelId)) { this.remove(entry, false); entry = undefined; }
    if (entry && entry.contextExpiresAt !== undefined && entry.contextExpiresAt <= performance.now()) {
      // Only an idle socket can be considered here: the global scheduler keeps
      // a playing request active. Expiry never cuts packets from that request.
      this.options.metric?.('agent_context_expired_sessions');
      this.remove(entry, false); entry = undefined;
    }
    if (entry && !this.hasTurnLifetime(entry, request)) {
      // Renew only on a new accepted question. A known paced upload and the
      // existing recognition/response deadlines must fit the remaining lifetime;
      // otherwise the old socket can expire halfway through valid input.
      this.options.metric?.('agent_lifetime_renewed_sessions');
      this.remove(entry, false); entry = undefined;
    }
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
    const expiresAt = this.options.sessionContextExpiresAt?.(speaker);
    entry = { speaker, request, abort: new AbortController(), waiting: false, playing: false,
      lifetimeExpiresAt: performance.now() + this.options.maxSessionSeconds * 1000,
      ingressEnded: false, playbackDone: false, recovering: false, pendingTools: 0, acceptingAudio: false,
      responseIds: new Set(), completedResponseIds: new Set(),
      completionIds: new Set(),
      followupConsumed: false, followupOffered: false, turnStarted: request.receivedAt, incident: request.id,
      audioChunks: 0, audioBytes: 0, textReceived: false, completionReceived: false,
      providerClosed: false, failed: false, localDrained: false, turnReleased: true,
      voiceInput: request.pcm !== undefined, userTurnRecognized: false, userTextPending: false, inputAudioChunks: 0, inputAudioBytes: 0,
      recognizedUserEventIds: new Set(),
      inputAudioFinished: false, rejectedAudioIds: new Set(), rejectedResponseIds: new Set(), sessionReused: false,
      inputSourceChunks: 0, inputSilenceChunks: 0, inputSilenceTailMs: 0,
      initialAudioReported: false, initialResponseReported: false,
      conversationQuestionSafe: true, conversationResponseSafe: true, conversationTextIds: new Set(),
      ...(expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt >= 0 ? { contextExpiresAt: expiresAt } : {}) };
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
        current.recognizedAt = performance.now();
        if (current.recognitionDeadline) clearTimeout(current.recognitionDeadline);
        current.recognitionDeadline = undefined;
        current.acceptedUserEventId = identity?.eventId;
        current.userTextPending = true;
        this.options.metric?.('agent_user_turns_recognized');
        if (current.inputStartedAt !== undefined) this.options.metric?.('agent_user_recognition_ms',
          Math.max(0, Math.round(performance.now() - current.inputStartedAt)));
        if (current.inputFinishedAt !== undefined) this.options.metric?.('agent_post_upload_recognition_ms',
          Math.max(0, Math.round(performance.now() - current.inputFinishedAt)));
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
            if (current.recognizedAt !== undefined) this.options.metric?.('agent_recognition_to_response_ms',
              Math.max(0, performance.now() - current.recognizedAt));
            this.report(current, 'jarvis_agent_response_observed', undefined,
              current.recognizedAt === undefined ? undefined : Math.max(0, performance.now() - current.recognizedAt));
          }
          this.progress(current);
        }
      },
      onConversationText: (event) => this.conversationText(current, event),
      onToolActivity: (pending) => {
        if (!this.usable(current)) return;
        if (current.turnReleased) {
          this.options.metric?.('agent_unsolicited_tool_activity');
          // An idle provider's autonomous/late tool cannot be inherited by a
          // newer request. Closing this socket does not close Discord or replay input.
          if (pending > 0) this.remove(current, false);
          return;
        }
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
      request.connectMs = Math.max(0, Math.round(performance.now() - startedAt));
      this.options.metric?.('agent_session_open_ms', request.connectMs);
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

  private hasTurnLifetime(entry: Entry, request: TurnRequest): boolean {
    const inputBudgetMs = request.pcm
      ? request.pcm.length / (48_000 * 4) * 1000 + 800 + USER_RECOGNITION_TIMEOUT_MS : 0;
    return entry.lifetimeExpiresAt - performance.now() > inputBudgetMs + RESPONSE_INACTIVITY_TIMEOUT_MS;
  }

  private begin(entry: Entry, request: TurnRequest): void {
    if (!this.usable(entry)) throw new SessionError('consent');
    if (entry.waiting || entry.playing) throw new SessionError('busy');
    entry.waiting = true;
    entry.request = request;
    entry.voiceInput = request.pcm !== undefined;
    entry.userTurnRecognized = false;
    entry.recognizedAt = undefined;
    entry.acceptedUserEventId = undefined;
    entry.userTextPending = false;
    entry.inputAudioChunks = entry.inputAudioBytes = 0;
    entry.inputAudioFinished = false;
    entry.inputSourceChunks = entry.inputSilenceChunks = 0;
    entry.inputSilenceTailMs = 0;
    entry.uploadMs = undefined;
    entry.inputStartedAt = undefined;
    entry.inputFinishedAt = undefined;
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
    entry.playbackFailure = undefined;
    entry.ingressEnded = false;
    entry.playbackDone = false;
    entry.recovering = false;
    entry.conversationQuestion = request.text;
    entry.conversationResponse = undefined;
    entry.conversationQuestionSafe = entry.conversationResponseSafe = true;
    entry.conversationTextIds.clear();
    entry.acceptingAudio = false;
    entry.audioChunks = 0;
    entry.audioBytes = 0;
    entry.textReceived = false;
    entry.completionReceived = false;
    entry.failed = false;
    entry.failureCode = undefined;
    entry.failureStage = undefined;
    entry.incident = request.id;
    entry.turnStarted = request.receivedAt;
    this.followups.delete(entry.speaker.discordUserId);
    entry.followupConsumed = false;
    entry.followupOffered = false;
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

  /** Final text is optional conversation context; it is never a playback/end signal. */
  private conversationText(entry: Entry, event: AgentConversationText): void {
    if (!this.usable(entry) || entry.turnReleased || entry.failed
      || !entry.request || this.active !== entry.request
      || (entry.voiceInput && !entry.userTurnRecognized)) return;
    if (event.responseId !== undefined && (entry.rejectedResponseIds.has(event.responseId)
      || entry.completedResponseIds.has(event.responseId))) return;
    if (entry.voiceInput && event.eventId !== undefined && entry.rejectedAudioIds.has(event.eventId)) return;
    if (event.kind === 'user_final' && (!entry.waiting || entry.recovering || !entry.voiceInput || !entry.inputAudioChunks)) return;
    if (event.kind === 'user_final') {
      if (!entry.userTextPending || event.eventId !== entry.acceptedUserEventId) return;
      // The adapter delivers this immediately after its matching accepted ASR
      // marker. A stale/duplicate marker can never supply another turn's text.
      entry.userTextPending = false;
    }
    if (event.kind !== 'user_final' && !entry.textReceived) return;
    // An output correction does not prove that its replacement audio was heard.
    // Keep the genuine question, but omit the response from recalled context.
    if (event.kind === 'agent_correction') {
      entry.conversationResponse = undefined;
      entry.conversationResponseSafe = false;
      return;
    }
    // Graceful recovery may still deliver already validated final text. It can
    // only become observedResponse, never a confirmed/fully delivered answer.
    if (!entry.waiting) return;
    if (event.eventId !== undefined || event.responseId !== undefined) {
      const key = `${event.kind}:${event.eventId ?? ''}:${event.responseId ?? ''}`;
      if (entry.conversationTextIds.has(key)) return;
      if (entry.conversationTextIds.size >= 128) {
        entry.conversationQuestion = entry.conversationResponse = undefined;
        entry.conversationQuestionSafe = entry.conversationResponseSafe = false;
        return;
      }
      entry.conversationTextIds.add(key);
    }
    const isQuestion = event.kind === 'user_final';
    if (!(isQuestion ? entry.conversationQuestionSafe : entry.conversationResponseSafe)) return;
    const previous = isQuestion ? entry.conversationQuestion : entry.conversationResponse;
    const combined = previous ? `${previous}\n${event.text}` : event.text;
    if (event.truncated || !event.text.trim() || Buffer.byteLength(combined, 'utf8') > 4 * 1024) {
      if (isQuestion) { entry.conversationQuestion = undefined; entry.conversationQuestionSafe = false; }
      else { entry.conversationResponse = undefined; entry.conversationResponseSafe = false; }
      return;
    }
    if (isQuestion) entry.conversationQuestion = combined;
    else entry.conversationResponse = combined;
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
    this.revokeFollowup(entry);
    entry.localDrained = false;
    entry.lastAudioAt = performance.now();
    if (entry.firstAudioAt === undefined) {
      entry.firstAudioAt = entry.lastAudioAt;
      this.observe(entry.speaker, 'first_audio', { turnId: entry.incident,
        durationMs: Math.max(0, entry.firstAudioAt - entry.turnStarted) });
      this.options.metric?.('agent_first_audio_ms', Math.round(entry.firstAudioAt - entry.turnStarted));
      if (entry.recognizedAt !== undefined) this.options.metric?.('agent_recognition_to_first_audio_ms',
        Math.max(0, entry.firstAudioAt - entry.recognizedAt));
      if (entry.inputFinishedAt !== undefined) this.options.metric?.('agent_remote_first_audio_ms',
        Math.max(0, Math.round(entry.firstAudioAt - entry.inputFinishedAt)));
      else if (entry.voiceInput) this.options.metric?.('agent_audio_before_input_finished');
      this.report(entry, 'jarvis_agent_first_audio', undefined, entry.recognizedAt === undefined
        ? undefined : Math.max(0, entry.firstAudioAt - entry.recognizedAt));
    }
    entry.acceptingAudio = true;
    this.progress(entry);
    try {
      if (!entry.stream) {
        entry.playing = true;
        const originatingTurn = entry.incident;
        const stream = this.options.playback.startStream(entry.speaker.discordUserId,
          entry.session.outputSampleRate, entry.speaker.isOwner, {
            isAllowed: () => this.usable(entry),
            onProgress: (event) => { if (entry.incident === originatingTurn) this.playbackProgress(entry, event); },
            onDiagnostic: (fields) => { if (entry.incident === originatingTurn) this.playbackDiagnostic(entry, fields); },
          });
        entry.stream = stream;
        void stream.done.then(() => {
          if (!this.usable(entry) || entry.stream !== stream) return;
          entry.playbackDone = true;
          entry.playing = false;
          this.report(entry, 'jarvis_agent_playback_completed');
          this.finishTurn(entry);
        }, (error: unknown) => {
          if (this.usable(entry) && entry.stream === stream) this.playbackError(entry, error, 'player');
        });
      }
      // Acceptance is bounded by the playback queue's capacity. The adapter
      // serializes these writes and pauses provider input under backpressure.
      await entry.stream.write(pcm);
    } catch (error) {
      if (this.usable(entry)) this.playbackError(entry, error, entry.stream ? 'pcm_input' : 'player_start');
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
    this.terminal(entry);
    this.delivered(entry);
    if (entry.failed || !entry.completionReceived || entry.recovering || entry.pendingTools > 0) { this.remove(entry); return; }
    this.options.metric?.('agent_turns_completed');
    this.offerFollowup(entry);
    if (entry.providerClosed) { this.remove(entry); return; }
    this.idle(entry);
    this.release(entry);
  }

  private delivered(entry: Entry): void {
    const question = entry.conversationQuestion;
    const confirmed = entry.completionReceived && !entry.recovering;
    if (!entry.failed && entry.audioBytes > 0 && entry.playbackDone && question
      && entry.conversationQuestionSafe && this.options.allowed(entry.speaker, entry.voiceInput)) {
      const event: DeliveredTurn = { turnId: entry.incident, inputKind: entry.voiceInput ? 'voice' : 'text',
        question, generation: confirmed ? 'confirmed' : 'unconfirmed',
        ...(entry.conversationResponseSafe && entry.conversationResponse
          ? confirmed ? { response: entry.conversationResponse } : { observedResponse: entry.conversationResponse } : {}) };
      try {
        void Promise.resolve(this.options.onTurnDelivered?.(entry.speaker, event))
          .catch(() => this.options.metric?.('turn_delivery_callback_failed'));
      } catch { this.options.metric?.('turn_delivery_callback_failed'); }
    }
    entry.conversationQuestion = entry.conversationResponse = undefined;
    entry.conversationTextIds.clear();
  }

  private playbackProgress(entry: Entry, event: 'first_packet' | 'drained' | 'resumed'): void {
    if (!this.usable(entry) || entry.turnReleased) return;
    const now = performance.now();
    if (event === 'first_packet' && entry.firstPlaybackAt === undefined) {
      entry.firstPlaybackAt = now;
      this.options.metric?.('agent_first_playback_ms', Math.round(now - entry.turnStarted));
      if (entry.firstAudioAt !== undefined) this.options.metric?.('agent_audio_buffering_ms',
        Math.max(0, now - entry.firstAudioAt));
      if (entry.request?.captureStartedAt !== undefined) this.options.metric?.('agent_end_to_end_first_playback_ms',
        Math.max(0, Math.round(now - entry.request.captureStartedAt)));
      if (entry.request?.speechEndedAt !== undefined) this.options.metric?.('speech_end_to_first_packet_ms',
        Math.max(0, Math.round(now - entry.request.speechEndedAt)));
    }
    if (event === 'drained') {
      const alreadyDrained = entry.localDrained;
      entry.localDrained = true;
      entry.drainedAt = now;
      this.options.metric?.('agent_playback_drained_ms', Math.round(now - entry.turnStarted));
      if (entry.firstPlaybackAt !== undefined) this.options.metric?.('agent_playback_ms',
        Math.max(0, Math.round(now - entry.firstPlaybackAt)));
      // A perceptual follow-up window is authorization to hear this speaker's
      // next utterance, not proof that the provider has completed generation.
      if (!alreadyDrained) this.offerFollowup(entry);
    } else if (event === 'resumed') { this.revokeFollowup(entry); entry.localDrained = false; }
    this.report(entry, 'jarvis_agent_audio_progress', undefined,
      event === 'first_packet' && entry.firstAudioAt !== undefined ? Math.max(0, now - entry.firstAudioAt) : undefined);
    this.retireForQueued(entry);
  }

  private playbackDiagnostic(entry: Entry, fields: DiagnosticFields): void {
    const clean = sanitizeDiagnosticFields(fields);
    if (clean.code && !entry.playbackFailure) entry.playbackFailure = {
      // The terminal summary wraps this failure as PLAYBACK_FAILED. Keep its
      // specific classification even when the upstream native code is unknown.
      ...clean, cause_code: clean.code,
    };
    try {
      this.options.logger?.event(clean.code ? 'jarvis_playback_failed' : 'jarvis_playback_state',
        clean.code ? 'error' : 'info', {
          ...clean, incident: entry.incident, operation: 'agent_turn', stage: 'playback',
        });
    } catch { /* A diagnostic sink cannot abort playback or replace its primary failure. */ }
  }

  private playbackError(entry: Entry, error: unknown, stage: DiagnosticFields['playback_stage']): void {
    if (!entry.playbackFailure) this.playbackDiagnostic(entry, { playback_stage: stage, ...playbackFailureFields(error) });
    this.fail(entry, 'PLAYBACK_FAILED');
  }

  private retireForQueued(entry: Entry): void {
    if (!this.queue.length || !this.usable(entry) || entry.turnReleased || entry.recovering
      || entry.completionReceived || !entry.waiting || !entry.audioBytes
      || !entry.localDrained || entry.acceptingAudio || entry.pendingTools || entry.upload
      || (entry.voiceInput && (!entry.inputAudioFinished || !entry.userTurnRecognized))) return;
    // The NEW REQUEST authorizes recovering an unconfirmed old provider turn.
    // A quiet interval alone never does. Drain validated adapter input before
    // ending the local stream; a fresh provider session fences all late events.
    this.missing(entry);
    entry.recovering = true;
    this.options.metric?.('agent_turns_recovered');
    this.report(entry, 'jarvis_agent_turn_recovered');
    if (entry.deadline) clearTimeout(entry.deadline);
    entry.session?.close({ drainAudio: true });
  }

  private release(entry: Entry): void {
    if (!this.active || entry.request !== this.active || this.active.released) return;
    this.active.released = true;
    if (entry.drainedAt !== undefined) this.options.metric?.('next_question_ready_ms',
      Math.round(performance.now() - entry.drainedAt));
    if (entry.lastAudioAt !== undefined) this.options.metric?.('agent_last_audio_ms',
      Math.round(entry.lastAudioAt - entry.turnStarted));
    this.report(entry, 'jarvis_agent_turn_released');
    this.observe(this.active.speaker, 'turn_released', { turnId: this.active.id,
      ...(this.active.dispatchAt === undefined ? {} : { durationMs: Math.max(0, performance.now() - this.active.dispatchAt) }) });
    this.active = undefined;
    entry.request = undefined;
    queueMicrotask(() => this.pump());
  }

  private offerFollowup(entry: Entry): void {
    if (entry.failed || entry.followupConsumed || entry.followupOffered) return;
    entry.followupOffered = true;
    this.rememberFollowup(entry.speaker, entry.incident);
  }

  private revokeFollowup(entry: Entry): void {
    if (this.followups.get(entry.speaker.discordUserId)?.turnId === entry.incident) {
      this.followups.delete(entry.speaker.discordUserId);
    }
    entry.followupOffered = false;
  }

  private rememberFollowup(speaker: SpeakerContext, turnId: string): void {
    if (this.options.followupSeconds <= 0) return;
    for (const [id, value] of this.followups) if (value.until <= performance.now()) this.followups.delete(id);
    if (!this.followups.has(speaker.discordUserId) && this.followups.size >= 16) {
      const oldest = this.followups.keys().next().value;
      if (oldest !== undefined) this.followups.delete(oldest);
    }
    this.followups.set(speaker.discordUserId, { consentVersion: speaker.consentVersion,
      channelId: speaker.channelId, until: performance.now() + this.options.followupSeconds * 1000, turnId });
  }

  /** Silence is only a resource-recovery trigger, never proof of completed generation. */
  private progress(entry: Entry): void {
    if (entry.deadline) clearTimeout(entry.deadline);
    // Local backpressure is not provider inactivity. Absolute playback/session
    // deadlines still bound waiting participants while this write is suspended.
    if (!entry.waiting || entry.recovering || entry.completionReceived || entry.pendingTools > 0 || entry.acceptingAudio
      || (entry.voiceInput && !entry.userTurnRecognized)) return;
    entry.deadline = setTimeout(() => {
      if (!this.usable(entry) || !entry.waiting) return;
      this.options.metric?.(entry.audioBytes > 0
        ? 'agent_completion_recovery_timeouts' : 'agent_response_timeouts');
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
    }, RESPONSE_INACTIVITY_TIMEOUT_MS);
    entry.deadline.unref();
  }

  private missing(entry: Entry): void {
    if (entry.recovering || entry.completionReceived) return;
    this.options.metric?.('turn_completion_missing');
    this.options.metric?.('agent_completion_missing');
  }

  private report(entry: Entry, event: string, code?: ErrorCode, stageDurationMs?: number): void {
    const stage: DiagnosticFields['stage'] = event === 'jarvis_agent_input_started' || event === 'jarvis_agent_input_sent'
      || event === 'jarvis_agent_input_prepared' ? 'agent_audio_upload'
      : event === 'jarvis_agent_session_ready' ? 'agent_connect'
      : event === 'jarvis_agent_first_audio' ? 'agent_audio_wait'
      : event === 'jarvis_agent_user_turn_recognized' ? 'agent_user_recognition'
      : entry.voiceInput && !entry.userTurnRecognized ? 'agent_user_recognition'
      : entry.playing ? 'playback' : entry.textReceived && !entry.audioBytes ? 'agent_audio_wait'
      : entry.waiting ? 'agent_response_wait' : 'agent_connect';
    if (event === 'jarvis_agent_turn_error' && entry.failureStage === undefined) entry.failureStage = stage;
    this.options.logger?.event(event, code ? 'error' : 'info', {
      ...(code === 'PLAYBACK_FAILED' ? entry.playbackFailure : {}),
      incident: entry.incident, operation: 'agent_turn',
      stage: code ? entry.failureStage ?? stage : stage,
      ...(code ? { code, category: code === 'PLAYBACK_FAILED' ? 'playback' : 'agent' } : {}),
      ...(code === 'AGENT_USER_TURN_MISSING' ? { timeout_ms: USER_RECOGNITION_TIMEOUT_MS } : {}),
      duration_ms: Math.max(0, Math.round(performance.now() - entry.turnStarted)),
      ...(stageDurationMs === undefined ? {} : { stage_duration_ms: Math.max(0, Math.round(stageDurationMs)) }),
      audio_chunks: entry.audioChunks, audio_bytes: entry.audioBytes,
      text_received: entry.textReceived, completion_received: entry.completionReceived,
      ingress_ended: entry.ingressEnded, playback_drained: entry.playbackDone,
      local_playback_drained: entry.localDrained,
      recovery: entry.recovering, pending_tools: entry.pendingTools,
      input_kind: entry.voiceInput ? 'voice' : 'text', user_turn_recognized: entry.userTurnRecognized,
      input_audio_chunks: entry.inputAudioChunks, input_audio_bytes: entry.inputAudioBytes,
      input_source_chunks: entry.inputSourceChunks, input_silence_chunks: entry.inputSilenceChunks,
      ...(entry.uploadMs === undefined ? {} : { upload_ms: entry.uploadMs }),
      input_audio_finished: entry.inputAudioFinished, silence_tail_ms: entry.inputSilenceTailMs,
      ...(entry.session ? { input_sample_rate: entry.session.inputSampleRate, output_sample_rate: entry.session.outputSampleRate } : {}),
      session_reused: entry.sessionReused, speaker_verified: true,
      consent_current: this.options.allowed(entry.speaker, entry.voiceInput),
      queue_depth: this.queue.length,
      turn_outcome: entry.request?.terminalOutcome,
      turn_delivery: this.delivery(entry),
      ...(entry.request?.dispatchAt === undefined ? {} : {
        question_wait_ms: Math.round(entry.request.dispatchAt - entry.request.receivedAt),
      }),
      ...(entry.request?.wakeMs === undefined ? {} : { wake_detection_ms: entry.request.wakeMs }),
      ...(entry.request?.connectMs === undefined ? {} : { agent_connect_ms: entry.request.connectMs }),
      ...(entry.firstAudioAt === undefined ? {} : { first_audio_ms: Math.round(entry.firstAudioAt - entry.turnStarted) }),
      ...(entry.firstAudioAt === undefined || entry.inputFinishedAt === undefined
        || entry.firstAudioAt < entry.inputFinishedAt ? {} : {
          remote_first_audio_ms: Math.round(entry.firstAudioAt - entry.inputFinishedAt),
        }),
      ...(entry.lastAudioAt === undefined ? {} : { last_audio_ms: Math.round(entry.lastAudioAt - entry.turnStarted) }),
      ...(entry.firstPlaybackAt === undefined ? {} : { first_playback_ms: Math.round(entry.firstPlaybackAt - entry.turnStarted) }),
      ...(entry.firstPlaybackAt === undefined || entry.firstAudioAt === undefined ? {} : {
        playback_start_ms: Math.max(0, Math.round(entry.firstPlaybackAt - entry.firstAudioAt)),
      }),
      ...(entry.firstPlaybackAt === undefined || entry.request?.speechEndedAt === undefined ? {} : {
        speech_end_to_first_packet_ms: Math.max(0, Math.round(entry.firstPlaybackAt - entry.request.speechEndedAt)),
      }),
      ...(entry.drainedAt === undefined ? {} : { drain_ms: Math.round(entry.drainedAt - entry.turnStarted) }),
      ...(event !== 'jarvis_agent_turn_released' || entry.drainedAt === undefined ? {} : {
        next_question_ready_ms: Math.max(0, Math.round(performance.now() - entry.drainedAt)),
      }),
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
    entry.failureCode = code;
    this.revokeFollowup(entry);
    this.report(entry, 'jarvis_agent_turn_error', code);
  }

  private delivery(entry: Entry): TurnDelivery {
    if (!entry.audioBytes) return 'none';
    if (entry.firstPlaybackAt === undefined) return 'not_started';
    if (entry.completionReceived && entry.playbackDone && !entry.failed && !entry.recovering) return 'confirmed';
    return entry.localDrained && !entry.completionReceived ? 'unconfirmed' : 'partial';
  }

  /** One terminal result per accepted request, after recovery/drain has settled. */
  private terminal(entry: Entry): void {
    const request = entry.request;
    if (!request || request.terminalOutcome) return;
    request.terminalOutcome = entry.failed ? entry.failureCode === 'AGENT_SESSION_EXPIRED' ? 'expired'
      : entry.firstPlaybackAt === undefined ? 'failed' : 'partial'
      : entry.completionReceived && !entry.recovering ? 'completed' : 'unconfirmed';
    this.report(entry, entry.failed ? 'jarvis_agent_turn_failed' : 'jarvis_agent_turn_finished', entry.failureCode);
    if (request.terminalOutcome === 'completed') this.observe(request.speaker, 'turn_responded', { turnId: request.id });
    else if (request.terminalOutcome === 'unconfirmed') this.observe(request.speaker, 'turn_unconfirmed', { turnId: request.id });
    else if (request.terminalOutcome === 'partial') this.observe(request.speaker, 'turn_partial', { turnId: request.id });
    if (entry.failureCode === 'PLAYBACK_FAILED') this.observe(request.speaker, 'playback_failed', { turnId: request.id });
    if (entry.failed) {
      this.options.metric?.('questions_failed');
      this.notify(request, { type: 'failed', reason: 'provider', delivery: this.delivery(entry),
        generationComplete: entry.completionReceived, localDrained: entry.localDrained });
    } else request.terminalNotified = true;
  }

  /** Failed acquisition/context refresh has no provider input or playback to replay. */
  private requestFailure(request: TurnRequest, code: ErrorCode, stage: 'agent_connect' | 'session_setup' | 'agent_audio_upload'): void {
    if (request.terminalOutcome || request.cancelled || this.active !== request) return;
    request.terminalOutcome = 'failed';
    this.followups.delete(request.speaker.discordUserId);
    this.options.metric?.('questions_failed');
    const fields: DiagnosticFields = { incident: request.id, operation: 'agent_turn', stage,
      code, category: 'agent', input_kind: request.inputKind, turn_outcome: 'failed', turn_delivery: 'none',
      duration_ms: Math.max(0, Math.round(performance.now() - request.receivedAt)), queue_depth: this.queue.length };
    this.options.logger?.event('jarvis_agent_turn_failed', 'error', fields);
    this.notify(request, { type: 'failed', reason: 'provider', delivery: 'none', generationComplete: false, localDrained: false });
    this.releaseDetached(request);
  }

  private releaseDetached(request: TurnRequest): void {
    if (this.active !== request || request.released) return;
    request.released = true;
    this.observe(request.speaker, 'turn_released', { turnId: request.id,
      ...(request.dispatchAt === undefined ? {} : { durationMs: Math.max(0, performance.now() - request.dispatchAt) }) });
    this.options.logger?.event('jarvis_agent_turn_released', 'info', {
      incident: request.id, operation: 'agent_turn', stage: 'session_setup', input_kind: request.inputKind,
      turn_outcome: request.terminalOutcome, turn_delivery: 'none', queue_depth: this.queue.length,
      duration_ms: Math.max(0, Math.round(performance.now() - request.receivedAt)),
    });
    this.active = undefined;
    queueMicrotask(() => this.pump());
  }

  private cancelDetached(request: TurnRequest, reason: NonNullable<TurnNotification['reason']>): void {
    if (this.active !== request || request.cancelled || request.terminalOutcome) return;
    request.cancelled = true;
    this.options.metric?.('questions_cancelled');
    this.notify(request, { type: 'cancelled', reason, delivery: 'none', generationComplete: false, localDrained: false });
    this.eraseRequest(request);
    this.releaseDetached(request);
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
    if (code === 'agent_guardrail') this.options.metric?.('agent_guardrail_rejections');
    if (code === 'agent_concurrency_limit') this.options.metric?.('agent_concurrency_rejections');
    const safeCode = this.providerCode(code);
    if ((code === 'agent_transport_error' || code === 'agent_heartbeat_timeout') && entry.waiting) {
      this.primaryError(entry, safeCode);
      this.missing(entry);
      entry.recovering = true;
      if (entry.deadline) clearTimeout(entry.deadline);
      // Adapter will finish delivering already validated audio, then onClose.
    } else this.fail(entry, safeCode);
  }

  private providerCode(code: string): ErrorCode {
    const codes: Readonly<Record<string, ErrorCode>> = {
      agent_transport_error: 'AGENT_TRANSPORT_ERROR', invalid_agent_event: 'AGENT_INVALID_EVENT',
      invalid_output_audio: 'AGENT_INVALID_EVENT', unsupported_audio_format: 'AGENT_AUDIO_FORMAT_UNSUPPORTED',
      agent_metadata_timeout: 'AGENT_METADATA_TIMEOUT', agent_credit_limit: 'AGENT_CREDIT_LIMIT',
      agent_request_timeout: 'AGENT_REQUEST_TIMEOUT',
      invalid_input_audio: 'AGENT_INPUT_INVALID', agent_send_failed: 'AGENT_INPUT_SEND_FAILED',
      agent_connect_failed: 'AGENT_CONNECT_FAILED',
      agent_closed: 'AGENT_PREMATURE_CLOSE', agent_closed_before_metadata: 'AGENT_PREMATURE_CLOSE',
      agent_rate_limited: 'AGENT_RATE_LIMITED', agent_authentication_failed: 'AGENT_AUTHENTICATION_FAILED',
      agent_callback_error: 'AGENT_CALLBACK_ERROR', agent_backpressure: 'AGENT_BACKPRESSURE',
      agent_audio_backpressure: 'AGENT_BACKPRESSURE',
      agent_heartbeat_timeout: 'AGENT_HEARTBEAT_TIMEOUT',
      agent_initiation_rejected: 'AGENT_INITIATION_REJECTED',
      agent_guardrail: 'AGENT_GUARDRAIL_REJECTED', agent_concurrency_limit: 'AGENT_CONCURRENCY_LIMIT',
    };
    return Object.hasOwn(codes, code) ? codes[code]! : 'AGENT_PROVIDER_ERROR';
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
    if (entry.waiting || entry.opening || (entry.request !== undefined && entry.request === this.active)) {
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
    if (release && this.active && this.active === entry.request) {
      if (!this.active.cancelled && !this.active.terminalOutcome) {
        if (entry.failed) this.terminal(entry);
        else {
          this.revokeFollowup(entry);
          this.options.metric?.('questions_cancelled');
          this.notify(this.active, { type: 'cancelled', reason, delivery: this.delivery(entry),
            generationComplete: entry.completionReceived, localDrained: entry.localDrained });
        }
      }
      this.active.cancelled = true;
      this.eraseRequest(this.active);
      this.release(entry);
    }
    entry.upload?.abort();
    entry.conversationQuestion = entry.conversationResponse = undefined;
    entry.conversationTextIds.clear();
    entry.abort.abort();
    for (const timer of [entry.idle, entry.lifetime, entry.deadline, entry.recognitionDeadline]) if (timer) clearTimeout(timer);
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
    if (this.active?.speaker.discordUserId === userId) this.cancelDetached(this.active, reason);
    this.options.playback.stopUser(userId);
  }

  interruptOwner(speaker: SpeakerContext): boolean {
    this.assertAllowed(speaker, true);
    if (!speaker.isOwner || !this.active) return false;
    this.options.metric?.('owner_interruptions');
    const active = this.active;
    const current = active.speaker.discordUserId;
    // Owner barge-in cancels only the active turn, preserving waiting callers.
    const entry = this.entries.get(current);
    if (entry) this.remove(entry, true, 'interrupted');
    if (this.active === active) this.cancelDetached(active, 'interrupted');
    this.rememberFollowup(speaker, newIncident());
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
    if (this.active) this.cancelDetached(this.active, 'closed');
  }

  close(): void {
    this.closed = true;
    this.followups.clear();
    this.captures.clear();
    for (const request of [...this.queue]) this.cancelQueued(request, 'closed');
    for (const abort of this.checking.values()) abort.abort();
    this.checking.clear();
    for (const entry of this.entries.values()) this.remove(entry);
    if (this.active) this.cancelDetached(this.active, 'closed');
    this.options.playback.stop();
  }
}
