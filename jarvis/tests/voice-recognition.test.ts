import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionManager, type Playback, type SessionOptions } from '../src/agents/session-manager.js';
import type { AgentCallbacks, AgentSession } from '../src/agents/elevenlabs-client.js';
import { convertPcm } from '../src/audio/pcm-conversion.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

const managers: SessionManager[] = [];
async function settle(): Promise<void> { for (let i = 0; i < 600; i++) await Promise.resolve(); }

interface VoiceHarnessOptions {
  rate?: number;
  pace?: SessionOptions['pace'];
  detectWake?: SessionOptions['detectWake'];
  onSendAudio?: (callbacks: AgentCallbacks, frame: number) => void;
  onConnect?: (callbacks: AgentCallbacks) => void;
}

function harness(options: VoiceHarnessOptions = {}) {
  const consent = new ConsentStore();
  const callbacks = new Map<string, AgentCallbacks>();
  const callbackHistory: AgentCallbacks[] = [];
  const sessions = new Map<string, AgentSession>();
  const uploaded = new Map<string, Buffer[]>();
  const metric = vi.fn();
  const detectWake = vi.fn(options.detectWake ?? (async () => true));
  const streams: {
    userId: string;
    chunks: Buffer[];
    end: () => void;
    cancel: () => void;
    drain: () => void;
  }[] = [];
  const playback: Playback = {
    isPlaying: false,
    startStream: vi.fn((userId, _rate, _owner, streamOptions) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      let settled = false;
      let started = false;
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void done.catch(() => undefined);
      const stream = {
        userId, chunks: [] as Buffer[],
        end: vi.fn(() => { if (!settled) { settled = true; resolve(); } }),
        cancel: vi.fn(() => { if (!settled) { settled = true; reject(new Error('cancelled')); } }),
        drain: () => streamOptions?.onProgress?.('drained', 0),
      };
      streams.push(stream);
      return { done, end: stream.end, cancel: stream.cancel,
        write: vi.fn(async (pcm: Buffer) => {
          if (settled || streamOptions?.isAllowed?.() === false) throw new Error('cancelled');
          stream.chunks.push(Buffer.from(pcm));
          if (!started) { started = true; streamOptions?.onProgress?.('first_packet', 0); }
        }),
      };
    }),
    stopUser: vi.fn(userId => { for (const stream of streams) if (stream.userId === userId) stream.cancel(); }),
    stop: vi.fn(() => { for (const stream of streams) stream.cancel(); }),
  };
  const connect = vi.fn<SessionOptions['connect']>(async (speaker, cb) => {
    callbacks.set(speaker.discordUserId, cb);
    callbackHistory.push(cb);
    const frames: Buffer[] = [];
    uploaded.set(speaker.discordUserId, frames);
    const session: AgentSession = {
      inputSampleRate: options.rate ?? 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendContext: vi.fn(),
      sendAudio: vi.fn(pcm => {
        frames.push(Buffer.from(pcm));
        options.onSendAudio?.(cb, frames.length);
      }),
      close: vi.fn(() => cb.onClose()),
    };
    sessions.set(speaker.discordUserId, session);
    options.onConnect?.(cb);
    return session;
  });
  const manager = new SessionManager({
    connect, playback, metric, detectWake,
    allowed: (speaker, audio) => consent.isCurrent(speaker.discordUserId, speaker.consentVersion, audio),
    maxSessions: 2, maxTurnSeconds: 12, maxSessionSeconds: 300, idleSeconds: 45,
    followupSeconds: 18, maxTurnsPerHour: 100, pace: options.pace ?? (async () => undefined),
  });
  managers.push(manager);
  const speaker = (id = 'guest') => {
    const grant = consent.get(id) ?? consent.grant(id, true);
    return speakerContext({ discordUserId: id, displayName: 'Jarvis', guildId: 'guild', channelId: 'voice',
      consented: true, consentVersion: grant.version }, 'owner');
  };
  const voice = async (id = 'guest', pcm = utterance()) => {
    const receipt = await manager.voiceTurn(speaker(id), pcm);
    await settle();
    return receipt;
  };
  return { manager, consent, speaker, callbacks, callbackHistory, sessions, uploaded,
    streams, playback, connect, metric, detectWake, voice };
}

/** Distinct stereo segments stand in for wake word and the entire following question. */
function utterance(): Buffer {
  const pcm = Buffer.alloc(48_000 * 4 * 0.16);
  for (let frame = 0; frame < pcm.length / 4; frame++) {
    const amplitude = frame < 48_000 * 0.08 ? 1200 : 3200;
    const value = Math.round(amplitude * Math.sin(frame * Math.PI / 50));
    pcm.writeInt16LE(value, frame * 4);
    pcm.writeInt16LE(Math.round(value / 2), frame * 4 + 2);
  }
  return pcm;
}

afterEach(() => { for (const manager of managers.splice(0)) manager.close(); vi.useRealTimers(); });

describe('voice recognition fences initial agent greetings', () => {
  test('sub-frame, silent and cancelling stereo captures cannot buy wake detection or a session, including follow-ups', async () => {
    const h = harness(); const speaker = h.speaker();
    await h.manager.ask(speaker, 'Primeira pergunta'); await settle();
    const cb = h.callbacks.get('guest')!;
    await cb.onAudio(Buffer.alloc(480, 1), 1); cb.onResponseComplete(1); await settle();
    const stereoCancellation = Buffer.alloc(3_840);
    for (let offset = 0; offset < stereoCancellation.length; offset += 4) {
      stereoCancellation.writeInt16LE(2000, offset); stereoCancellation.writeInt16LE(-2000, offset + 2);
    }
    for (const invalid of [Buffer.alloc(3_836, 1), Buffer.alloc(19_200), stereoCancellation]) {
      expect(await h.manager.voiceTurn(speaker, invalid)).toBeUndefined();
    }
    expect(h.detectWake).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.sessions.get('guest')!.sendAudio).not.toHaveBeenCalled();
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
    expect(h.metric).toHaveBeenCalledWith('voice_capture_too_short_rejected');
    expect(h.metric.mock.calls.filter(([name]) => name === 'voice_capture_silent_rejected')).toHaveLength(2);
    // One complete frame with a signal is accepted without imposing a
    // speculative minimum of 360–600 ms on short spoken follow-ups.
    expect(await h.manager.voiceTurn(speaker, Buffer.alloc(3_840, 1))).toMatchObject({ queued: false });
    await settle();
    expect(h.sessions.get('guest')!.sendAudio).toHaveBeenCalled();
  });

  test('missing recognition releases the queue ten seconds after upload without revoking another caller', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    const guest = h.speaker('guest'); const guestSession = h.sessions.get('guest')!;
    await h.manager.ask(h.speaker('owner'), 'Próxima pergunta'); await settle();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(guestSession.close).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2); await settle();
    expect(guestSession.close).toHaveBeenCalledOnce();
    expect(h.metric).toHaveBeenCalledWith('agent_user_turn_missing');
    expect(h.sessions.get('owner')!.sendText).toHaveBeenCalledExactlyOnceWith('Próxima pergunta');
    expect(h.consent.isCurrent('guest', guest.consentVersion, true)).toBe(true);
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: true });
  });

  test('cancelled wake detection is not counted as an unheard wake word', async () => {
    let resolve!: (activated: boolean) => void;
    const h = harness({ detectWake: () => new Promise<boolean>(yes => { resolve = yes; }) });
    const pending = h.manager.voiceTurn(h.speaker(), utterance());
    h.manager.cancelUser('guest', 'revoked');
    resolve(false);
    expect(await pending).toBeUndefined();
    expect(h.metric).not.toHaveBeenCalledWith('wake_rejections');
    expect(h.connect).not.toHaveBeenCalled();
  });

  test('post-upload recognition has its own single timing sample', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    await vi.advanceTimersByTimeAsync(125);
    const cb = h.callbacks.get('guest')!;
    cb.onUserTranscript?.({ eventId: 10 });
    cb.onUserTranscript?.({ eventId: 10 });
    const samples = h.metric.mock.calls.filter(([name]) => name === 'agent_user_recognition_ms');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.[1]).toBe(125);
    expect(h.metric).toHaveBeenCalledWith('agent_post_upload_recognition_ms', 125);
  });

  test.each([
    { phase: 'source', frame: 6, elapsed: 100 },
    { phase: 'VAD tail', frame: 14, elapsed: 260 },
  ])('recognition during $phase measures elapsed input without inventing a post-upload sample', async ({ frame, elapsed }) => {
    vi.useFakeTimers();
    const h = harness({ pace: async () => { vi.advanceTimersByTime(20); }, onSendAudio: (cb, currentFrame) => {
      if (currentFrame === frame) cb.onUserTranscript?.({ eventId: 10 });
    } });
    await h.voice();
    expect(h.metric).toHaveBeenCalledWith('agent_user_turns_recognized');
    expect(h.metric).toHaveBeenCalledWith('agent_user_recognition_ms', elapsed);
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_post_upload_recognition_ms')).toHaveLength(0);
  });

  test('a reused socket measures recognition from its current input rather than a previous turn', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    await vi.advanceTimersByTimeAsync(125);
    cb.onUserTranscript?.({ eventId: 10 });
    await cb.onAudio(Buffer.alloc(480, 1), 11); cb.onResponseComplete(11); await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    await h.voice();
    await vi.advanceTimersByTimeAsync(250);
    cb.onUserTranscript?.({ eventId: 20 });
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_user_recognition_ms'))
      .toEqual([['agent_user_recognition_ms', 125], ['agent_user_recognition_ms', 250]]);
  });

  test('playback duration starts at the first local packet rather than question arrival', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    await vi.advanceTimersByTimeAsync(300);
    const cb = h.callbacks.get('guest')!;
    cb.onUserTranscript?.({ eventId: 10 });
    await cb.onAudio(Buffer.alloc(480, 1), 11);
    await vi.advanceTimersByTimeAsync(125);
    h.streams[0]!.drain();
    expect(h.metric).toHaveBeenCalledWith('agent_playback_ms', 125);
    expect(h.metric).toHaveBeenCalledWith('agent_playback_drained_ms', 425);
  });

  test('recognition deadline starts after the entire paced upload rather than during a long question', async () => {
    vi.useFakeTimers();
    const h = harness({ pace: async () => { vi.advanceTimersByTime(20); } });
    await h.voice('guest', Buffer.alloc(12 * 48_000 * 4, 1));
    await settle();
    expect(h.sessions.get('guest')!.sendAudio).toHaveBeenCalledTimes(640);
    expect(h.metric).not.toHaveBeenCalledWith('agent_user_turn_missing');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.manager.queueStatus.active).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.manager.queueStatus.active).toBe(false);
  });

  test('recognized speech clears its ten-second deadline while slow generation keeps the existing forty-five-second bound', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    await vi.advanceTimersByTimeAsync(9_000);
    const cb = h.callbacks.get('guest')!;
    cb.onUserTranscript?.({ eventId: 10 });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(h.metric).not.toHaveBeenCalledWith('agent_user_turn_missing');
    expect(h.manager.queueStatus.active).toBe(true);
    await cb.onAudio(Buffer.alloc(480, 1), 11); cb.onResponseComplete(11); await settle();
    expect(h.metric).toHaveBeenCalledWith('agent_turns_completed');
  });

  test.each(['revoke', 'close'] as const)('%s clears a pending recognition deadline and late provider markers cannot revive it', async action => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    if (action === 'revoke') { h.consent.revoke('guest'); h.manager.revoke('guest'); }
    else h.manager.close();
    await vi.advanceTimersByTimeAsync(12_000);
    cb.onUserTranscript?.({ eventId: 10 }); await cb.onAudio(Buffer.alloc(480, 1), 11);
    expect(h.metric).not.toHaveBeenCalledWith('agent_user_turn_missing');
    expect(h.metric).not.toHaveBeenCalledWith('agent_user_turns_recognized');
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
    expect(h.streams).toHaveLength(0);
  });

  test('closing the provider during upload drains valid output without claiming the whole input was sent', async () => {
    const h = harness({ onSendAudio: (cb, frame) => {
      if (frame === 1) {
        cb.onUserTranscript?.({ eventId: 30 });
        void cb.onAudio(Buffer.alloc(480, 4), 31);
        void cb.onResponseComplete(31);
        cb.onClose();
      }
    } });
    await h.voice();
    expect(h.uploaded.get('guest')).toHaveLength(1);
    expect(h.streams[0]!.chunks).toEqual([Buffer.alloc(480, 4)]);
    expect(h.streams[0]!.end).toHaveBeenCalledOnce();
    expect(h.metric).toHaveBeenCalledWith('agent_input_incomplete');
    expect(h.metric).not.toHaveBeenCalledWith('agent_turns_completed');
    expect(h.manager.activeCount).toBe(0);
  });
  test('an early recognized response cannot truncate the recorded question or its final VAD silence', async () => {
    const h = harness({ onSendAudio: (cb, frame) => {
      if (frame === 1) {
        cb.onUserTranscript?.({ eventId: 20 });
        void cb.onAudio(Buffer.alloc(480, 3), 21);
        void cb.onResponseComplete(21);
      }
    } });
    await h.voice();
    expect(Buffer.concat(h.uploaded.get('guest')!)).toEqual(Buffer.concat([
      convertPcm(utterance(), 48_000, 2, 16_000, 1), Buffer.alloc(16_000 * 0.8 * 2),
    ]));
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.end).toHaveBeenCalledOnce();
    expect(h.metric).toHaveBeenCalledWith('agent_completion_during_input');
  });
  test('provider interruption of startup output preserves the complete microphone input', async () => {
    const h = harness({ onSendAudio: (cb, frame) => { if (frame === 1) cb.onInterruption(); } });
    await h.voice();
    const session = h.sessions.get('guest')!;
    expect(session.close).not.toHaveBeenCalled();
    expect(Buffer.concat(h.uploaded.get('guest')!)).toEqual(Buffer.concat([
      convertPcm(utterance(), 48_000, 2, 16_000, 1), Buffer.alloc(16_000 * 0.8 * 2),
    ]));
    const cb = h.callbacks.get('guest')!;
    cb.onUserTranscript?.({ eventId: 50 });
    await cb.onAudio(Buffer.alloc(480, 2), 51);
    await cb.onResponseComplete(51); await settle();
    expect(h.playback.startStream).toHaveBeenCalledOnce();
    expect(h.metric).toHaveBeenCalledWith('agent_input_interruptions');
  });

  test('an old final-recognition ID cannot authorize startup audio in the next voice turn', async () => {
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    cb.onUserTranscript?.({ eventId: 50 });
    await cb.onAudio(Buffer.alloc(480, 1), 51);
    await cb.onResponseComplete(51); await settle();
    await h.voice();
    cb.onUserTranscript?.({ eventId: 50 });
    await cb.onAudio(Buffer.alloc(480, 2), 52);
    expect(h.playback.startStream).toHaveBeenCalledTimes(1);
    cb.onUserTranscript?.({ eventId: 53 });
    await cb.onAudio(Buffer.alloc(480, 3), 54);
    expect(h.playback.startStream).toHaveBeenCalledTimes(2);
    expect(h.metric).toHaveBeenCalledWith('agent_stale_user_turns');
  });
  test('a greeting during connect and upload cannot answer a fresh microphone question or abort its audio', async () => {
    const h = harness({
      onConnect: cb => {
        cb.onUserTranscript?.({ eventId: 9 });
        cb.onTextResponse?.({ responseId: 'opening-greeting' });
        void cb.onAudio(Buffer.alloc(480, 11), 10, { responseId: 'opening-greeting' });
        void cb.onResponseComplete(10);
      },
      onSendAudio: (cb, frame) => {
        if (frame !== 1) return;
        cb.onTextResponse?.({ responseId: 'upload-greeting' });
        void cb.onAudio(Buffer.alloc(480, 12), 11, { responseId: 'upload-greeting' });
        void cb.onResponseComplete(11);
      },
    });
    await h.voice();
    expect(h.streams).toHaveLength(0);
    expect(h.sessions.get('guest')!.sendAudio).toHaveBeenCalledTimes(48);
    expect(h.manager.queueStatus.active).toBe(true);
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_turns_completed')).toHaveLength(0);

    const cb = h.callbacks.get('guest')!;
    cb.onUserTranscript?.({ eventId: 20 });
    await cb.onAudio(Buffer.alloc(480, 14), 10, { responseId: 'opening-greeting' });
    await cb.onAudio(Buffer.alloc(480, 13), 12, { responseId: 'upload-greeting' });
    cb.onResponseComplete(11);
    expect(h.streams).toHaveLength(0);
    cb.onTextResponse?.({ responseId: 'answer-after-recognition' });
    await cb.onAudio(Buffer.alloc(480, 21), 21, { responseId: 'answer-after-recognition' });
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.chunks).toEqual([Buffer.alloc(480, 21)]);
    expect(h.streams[0]!.end).not.toHaveBeenCalled();
    cb.onResponseComplete(21); await settle();
    expect(h.metric).toHaveBeenCalledWith('agent_turns_completed');
  });

  test('a greeting delivered only with event IDs stays excluded after recognized speech', async () => {
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.({ eventId: 30 });
    await cb.onAudio(Buffer.alloc(480, 31), 30);
    cb.onResponseComplete(30);
    expect(h.streams).toHaveLength(0);
    cb.onUserTranscript?.({ eventId: 40 });
    await cb.onAudio(Buffer.alloc(480, 32), 30);
    expect(h.streams).toHaveLength(0);
    await cb.onAudio(Buffer.alloc(480, 41), 41);
    expect(h.streams[0]!.chunks).toEqual([Buffer.alloc(480, 41)]);
  });

  test('five explicit voice turns reuse one session and each turn requires fresh user recognition', async () => {
    const h = harness();
    for (let index = 0; index < 5; index++) {
      await h.voice();
      const cb = h.callbacks.get('guest')!;
      await cb.onAudio(Buffer.alloc(480, 99), 100 + index, { responseId: `premature-${index}` });
      expect(h.streams).toHaveLength(index);
      cb.onUserTranscript?.({ eventId: index * 10 + 1 });
      cb.onTextResponse?.({ responseId: `answer-${index}` });
      await cb.onAudio(Buffer.alloc(480, index + 1), index * 10 + 2, { responseId: `answer-${index}` });
      expect(h.streams).toHaveLength(index + 1);
      cb.onResponseComplete(index * 10 + 3); await settle();
      expect(h.manager.queueStatus.active).toBe(false);
    }
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.detectWake).toHaveBeenCalledOnce();
    expect(h.sessions.get('guest')!.sendText).not.toHaveBeenCalled();
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_turns_completed')).toHaveLength(5);
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_session_reused')).toHaveLength(4);
  });

  test('an active turn without completion keeps its session until a queued question authorizes retirement', async () => {
    const h = harness(); await h.voice();
    const old = h.callbacks.get('guest')!;
    old.onUserTranscript?.({ eventId: 1 });
    old.onTextResponse?.({ responseId: 'first-answer' });
    await old.onAudio(Buffer.alloc(480, 1), 2, { responseId: 'first-answer' });
    h.streams[0]!.drain(); await settle();
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.sessions.get('guest')!.close).not.toHaveBeenCalled();
    expect(await h.voice()).toMatchObject({ queued: true });
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.callbackHistory[1]).not.toBe(old);
    await old.onAudio(Buffer.alloc(480, 99), 3, { responseId: 'late-old-answer' });
    old.onUserTranscript?.({ eventId: 4 }); old.onResponseComplete(4);
    expect(h.streams).toHaveLength(1);
    const current = h.callbacks.get('guest')!;
    current.onUserTranscript?.({ eventId: 5 });
    await current.onAudio(Buffer.alloc(480, 2), 6, { responseId: 'new-answer' });
    expect(h.streams[1]!.chunks).toEqual([Buffer.alloc(480, 2)]);
  });

  test('a known initial response cannot return as late audio in a later recognized turn on the same session', async () => {
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.({ responseId: 'initial-greeting' });
    await cb.onAudio(Buffer.alloc(480, 90), 90, { responseId: 'initial-greeting' });
    cb.onUserTranscript?.({ eventId: 1 });
    await cb.onAudio(Buffer.alloc(480, 2), 2, { responseId: 'first-answer' });
    cb.onResponseComplete(3); await settle();
    await h.voice();
    cb.onUserTranscript?.({ eventId: 4 });
    await cb.onAudio(Buffer.alloc(480, 91), 90, { responseId: 'initial-greeting' });
    expect(h.streams).toHaveLength(1);
    await cb.onAudio(Buffer.alloc(480, 5), 5, { responseId: 'second-answer' });
    expect(h.streams[1]!.chunks).toEqual([Buffer.alloc(480, 5)]);
    expect(h.connect).toHaveBeenCalledOnce();
  });

  test('a later text question excludes a known voice greeting while streaming its own response without ASR', async () => {
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.({ responseId: 'voice-greeting' });
    await cb.onAudio(Buffer.alloc(480, 90), 90, { responseId: 'voice-greeting' });
    cb.onUserTranscript?.({ eventId: 1 });
    await cb.onAudio(Buffer.alloc(480, 2), 2, { responseId: 'voice-answer' });
    cb.onResponseComplete(3); await settle();
    await h.manager.ask(h.speaker(), 'Nova pergunta escrita'); await settle();
    await cb.onAudio(Buffer.alloc(480, 91), 90, { responseId: 'voice-greeting' });
    expect(h.streams).toHaveLength(1);
    await cb.onAudio(Buffer.alloc(480, 4), 4, { responseId: 'text-answer' });
    expect(h.streams[1]!.chunks).toEqual([Buffer.alloc(480, 4)]);
    expect(h.streams[1]!.end).not.toHaveBeenCalled();
    cb.onResponseComplete(5); await settle();
    expect(h.manager.queueStatus.active).toBe(false);
    expect(h.connect).toHaveBeenCalledOnce();
  });

  test.each([8000, 16000, 22050, 24000, 44100, 48000])('uploads the complete captured question as %i Hz mono frames and final silence', async rate => {
    const h = harness({ rate });
    const pcm = utterance(); const original = Buffer.from(pcm);
    await h.voice('guest', pcm);
    const frames = h.uploaded.get('guest')!;
    const expectedSpeech = convertPcm(original, 48_000, 2, rate, 1);
    expect(frames).toHaveLength(48);
    expect(frames.every(frame => frame.length === rate / 50 * 2)).toBe(true);
    const uploaded = Buffer.concat(frames);
    expect(uploaded.length).toBe((rate * 0.16 + rate * 0.8) * 2);
    expect(uploaded.subarray(0, expectedSpeech.length)).toEqual(expectedSpeech);
    expect(uploaded.subarray(expectedSpeech.length)).toEqual(Buffer.alloc(rate * 0.8 * 2));
    expect(pcm).toEqual(original);
    expect(h.detectWake.mock.calls[0]![0]).toEqual(Buffer.alloc(original.length));
    expect(h.sessions.get('guest')!.sendText).not.toHaveBeenCalled();
    expect(h.streams).toHaveLength(0);
  });

  test('missing recognition never promotes initial speech to a completed answer', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.voice();
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.({ responseId: 'greeting' });
    await cb.onAudio(Buffer.alloc(480, 9), 1, { responseId: 'greeting' });
    cb.onResponseComplete(1); await settle();
    expect(h.streams).toHaveLength(0);
    expect(h.manager.queueStatus.active).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(h.streams).toHaveLength(0);
    expect(h.manager.queueStatus.active).toBe(false);
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_turns_completed')).toHaveLength(0);
  });

  test('voice recognition belongs only to the Discord ID and consent version that opened the session', async () => {
    const h = harness(); await h.voice('guest');
    const old = h.callbacks.get('guest')!;
    h.consent.revoke('guest'); h.manager.revoke('guest'); await settle();
    await h.voice('owner');
    const owner = h.callbacks.get('owner')!;
    old.onUserTranscript?.({ eventId: 1 });
    await owner.onAudio(Buffer.alloc(480, 99), 2, { responseId: 'owner-greeting' });
    await old.onAudio(Buffer.alloc(480, 88), 3); old.onResponseComplete(3);
    expect(h.streams).toHaveLength(0);
    owner.onUserTranscript?.({ eventId: 4 });
    await owner.onAudio(Buffer.alloc(480, 4), 5, { responseId: 'owner-answer' });
    expect(h.streams.map(stream => stream.userId)).toEqual(['owner']);
    owner.onResponseComplete(5); await settle();
    h.consent.grant('guest', true); await h.voice('guest');
    old.onUserTranscript?.({ eventId: 6 });
    await h.callbacks.get('guest')!.onAudio(Buffer.alloc(480, 77), 7);
    expect(h.streams).toHaveLength(1);
    const current = h.callbacks.get('guest')!;
    current.onUserTranscript?.({ eventId: 8 });
    await current.onAudio(Buffer.alloc(480, 8), 9);
    expect(h.streams[1]!.userId).toBe('guest');
    expect(h.streams[1]!.chunks).toEqual([Buffer.alloc(480, 8)]);
  });

  test('text questions retain progressive output without requiring a microphone transcript', async () => {
    const h = harness();
    await h.manager.ask(h.speaker(), 'Quanto é dois mais dois?'); await settle();
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.({ responseId: 'text-answer' });
    await cb.onAudio(Buffer.alloc(480, 4), 1, { responseId: 'text-answer' });
    expect(h.streams[0]!.chunks).toEqual([Buffer.alloc(480, 4)]);
    expect(h.streams[0]!.end).not.toHaveBeenCalled();
    cb.onResponseComplete(1); await settle();
    expect(h.manager.queueStatus.active).toBe(false);
    expect(h.sessions.get('guest')!.sendText).toHaveBeenCalledWith('Quanto é dois mais dois?');
  });
});
