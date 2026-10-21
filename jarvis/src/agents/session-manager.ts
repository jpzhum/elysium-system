import { setTimeout as delay } from 'node:timers/promises';
import type { AgentCallbacks, AgentSession } from './elevenlabs-client.js';
import { convertPcm } from '../audio/pcm-conversion.js';
import type { SpeakerContext } from '../policy/identity.js';

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
  started: number;
  idle?: ReturnType<typeof setTimeout>;
  lifetime?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  completion?: ReturnType<typeof setTimeout>;
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
    catch { this.remove(entry); throw new SessionError('closed'); }
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
      chunks: [], bytes: 0, followupUntil: 0, started: Date.now() };
    this.entries.set(speaker.discordUserId, entry);
    const current = entry;
    const callbacks: AgentCallbacks = {
      onAudio: (audio) => this.audio(current, audio),
      onResponseComplete: () => this.completeSoon(current),
      onInterruption: () => this.interrupt(current),
      onClose: () => this.remove(current),
      onError: () => { this.options.metric?.('agent_errors'); this.remove(current); },
    };
    current.lifetime = setTimeout(() => this.remove(current), this.options.maxSessionSeconds * 1000);
    current.lifetime.unref();
    current.opening = this.options.connect(speaker, callbacks, current.abort.signal);
    try {
      const session = await current.opening;
      if (!this.usable(current)) { session.close(); throw new SessionError('consent'); }
      current.session = session;
      current.opening = undefined;
      this.options.metric?.('agent_sessions_started');
      this.idle(current);
      return current;
    } catch (error) { this.remove(current); throw error; }
  }

  private claimTurn(): void {
    if (Date.now() - this.budgetStart >= 3_600_000) { this.budgetStart = Date.now(); this.turns = 0; }
    if (this.turns >= this.options.maxTurnsPerHour) throw new SessionError('limit');
    this.turns++;
  }

  private begin(entry: Entry): void {
    if (!this.usable(entry)) throw new SessionError('consent');
    if (entry.waiting || entry.playing) throw new SessionError('busy');
    if (entry.completion) clearTimeout(entry.completion);
    entry.completion = undefined;
    entry.waiting = true;
    entry.chunks = [];
    entry.bytes = 0;
    entry.followupUntil = 0;
    if (entry.idle) clearTimeout(entry.idle);
    entry.deadline = setTimeout(() => { this.options.metric?.('agent_response_timeouts'); this.remove(entry); }, 45_000);
    entry.deadline.unref();
    this.options.metric?.('agent_turns');
  }

  private usable(entry: Entry): boolean {
    return !this.closed && !entry.abort.signal.aborted
      && this.entries.get(entry.speaker.discordUserId) === entry && this.options.allowed(entry.speaker);
  }

  private audio(entry: Entry, pcm: Buffer): void {
    if (!this.usable(entry) || !entry.waiting || !entry.session) return;
    const max = entry.session.outputSampleRate * 2 * 30;
    if (entry.bytes + pcm.length > max) { this.options.metric?.('agent_audio_overflow'); this.remove(entry); return; }
    entry.chunks.push(pcm);
    entry.bytes += pcm.length;
    // Completion is not inferred from agent_response (text may precede audio).
    if (entry.completion) this.completeSoon(entry);
  }

  private completeSoon(entry: Entry): void {
    if (!this.usable(entry) || !entry.waiting) return;
    if (entry.completion) clearTimeout(entry.completion);
    entry.completion = setTimeout(() => { void this.flush(entry); }, 200);
    entry.completion.unref();
  }

  private async flush(entry: Entry): Promise<void> {
    if (!this.usable(entry) || !entry.waiting || !entry.session) return;
    if (entry.deadline) clearTimeout(entry.deadline);
    entry.completion = undefined;
    entry.waiting = false;
    entry.playing = true;
    const pcm = Buffer.concat(entry.chunks, entry.bytes);
    entry.chunks = [];
    entry.bytes = 0;
    try {
      if (pcm.length) await this.options.playback.play(entry.speaker.discordUserId, pcm,
        entry.session.outputSampleRate, entry.speaker.isOwner);
      if (this.usable(entry)) entry.followupUntil = Date.now() + this.options.followupSeconds * 1000;
    } catch { this.options.metric?.('playback_cancelled'); }
    finally { entry.playing = false; if (this.usable(entry)) this.idle(entry); }
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
    for (const timer of [entry.idle, entry.lifetime, entry.deadline, entry.completion]) if (timer) clearTimeout(timer);
    entry.chunks = [];
    entry.bytes = 0;
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
