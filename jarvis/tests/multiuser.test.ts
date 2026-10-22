import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionManager, type Playback, type SessionOptions } from '../src/agents/session-manager.js';
import type { AgentCallbacks, AgentSession } from '../src/agents/elevenlabs-client.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

function harness(overrides: Partial<SessionOptions> = {}) {
  const consent = new ConsentStore();
  const callbacks = new Map<string, AgentCallbacks>();
  const sessions = new Map<string, AgentSession>();
  const streams: {
    userId: string;
    chunks: Buffer[];
    end: () => void;
    cancel: () => void;
  }[] = [];
  const playback: Playback = { isPlaying: false,
    startStream: vi.fn((userId, _rate, _owner, options) => {
      let finish!: () => void;
      let reject!: (error: Error) => void;
      let settled = false;
      const done = new Promise<void>((resolve, no) => { finish = resolve; reject = no; });
      void done.catch(() => undefined);
      const stream = { userId, chunks: [] as Buffer[],
        end: vi.fn(() => { if (!settled) { settled = true; finish(); } }),
        cancel: vi.fn(() => {
          if (!settled) { settled = true; reject(new Error('Reprodução cancelada.')); }
        }),
      };
      streams.push(stream);
      return { done, end: stream.end, cancel: stream.cancel,
        write: vi.fn(async (pcm: Buffer) => {
          if (settled || options?.isAllowed?.() === false) throw new Error('Reprodução cancelada.');
          stream.chunks.push(Buffer.from(pcm));
        }),
      };
    }),
    stopUser: vi.fn((userId) => { for (const stream of streams) if (stream.userId === userId) stream.cancel(); }),
    stop: vi.fn(() => { for (const stream of streams) stream.cancel(); }),
  };
  const connect = vi.fn(async (speaker, cb) => {
    callbacks.set(speaker.discordUserId, cb);
    const session: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn(() => cb.onClose()) };
    sessions.set(speaker.discordUserId, session);
    return session;
  }) satisfies SessionOptions['connect'];
  const manager = new SessionManager({ connect, playback,
    allowed: (speaker, audio) => consent.isCurrent(speaker.discordUserId, speaker.consentVersion, audio),
    detectWake: vi.fn(async () => true), maxSessions: 2, maxTurnSeconds: 12, maxSessionSeconds: 300,
    idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 100, ...overrides });
  const speaker = (id: string) => {
    const grant = consent.get(id) ?? consent.grant(id, true);
    return speakerContext({ discordUserId: id, displayName: id, guildId: 'guild', channelId: 'voice',
      consented: true, consentVersion: grant.version }, 'owner');
  };
  let completionId = 0;
  const finish = async (id: string) => {
    await callbacks.get(id)!.onAudio(Buffer.alloc(480), ++completionId);
    await callbacks.get(id)!.onResponseComplete(completionId);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { manager, consent, speaker, callbacks, sessions, playback, streams, connect, finish };
}

afterEach(() => vi.useRealTimers());

describe('speaker session isolation and cancellation', () => {
  test('separate sessions and trusted owner flags; responses use associated speaker', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('owner'), 'Pergunta um');
    await h.manager.ask(h.speaker('guest'), 'Pergunta dois');
    expect(h.connect.mock.calls.map(([s]) => [s.discordUserId, s.isOwner])).toEqual([['owner', true], ['guest', false]]);
    expect(h.sessions.get('owner')!.sendText).toHaveBeenCalledWith('Pergunta um');
    expect(h.sessions.get('guest')!.sendText).toHaveBeenCalledWith('Pergunta dois');
    await h.finish('guest');
    await h.finish('owner');
    expect(h.playback.startStream).toHaveBeenNthCalledWith(1, 'guest', 24000, false, { isAllowed: expect.any(Function) });
    expect(h.playback.startStream).toHaveBeenNthCalledWith(2, 'owner', 24000, true, { isAllowed: expect.any(Function) });
    h.manager.close();
  });
  test('progressive chunks keep their speaker while another participant revokes', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('owner'), 'Pergunta um');
    await h.manager.ask(h.speaker('guest'), 'Pergunta dois');
    const ownerAudio = Buffer.alloc(480, 1);
    const guestAudio = Buffer.alloc(480, 2);
    await h.callbacks.get('owner')!.onAudio(ownerAudio, 1);
    await h.callbacks.get('guest')!.onAudio(guestAudio, 1);
    expect(h.streams.map((stream) => [stream.userId, stream.chunks])).toEqual([
      ['owner', [ownerAudio]], ['guest', [guestAudio]],
    ]);
    for (const stream of h.streams) expect(stream.end).not.toHaveBeenCalled();
    h.consent.revoke('guest');
    h.manager.revoke('guest');
    await h.callbacks.get('guest')!.onAudio(ownerAudio, 2);
    expect(h.streams[1]!.chunks).toEqual([guestAudio]);
    expect(h.streams[0]!.cancel).not.toHaveBeenCalled();
    h.callbacks.get('owner')!.onResponseComplete(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams[0]!.end).toHaveBeenCalledOnce();
    expect(h.streams[1]!.end).not.toHaveBeenCalled();
    h.manager.close();
  });
  test('revoke cancels session and prevents late audio playback', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Pergunta');
    await h.callbacks.get('guest')!.onAudio(Buffer.alloc(480), 1);
    const active = h.streams[0]!;
    expect(active.chunks).toHaveLength(1);
    h.consent.revoke('guest');
    h.manager.revoke('guest');
    await h.callbacks.get('guest')!.onAudio(Buffer.alloc(480, 2), 2);
    h.callbacks.get('guest')!.onResponseComplete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.playback.startStream).toHaveBeenCalledTimes(1);
    expect(active.cancel).toHaveBeenCalled();
    expect(active.chunks).toHaveLength(1);
    expect(active.end).not.toHaveBeenCalled();
    expect(h.sessions.get('guest')!.close).toHaveBeenCalled();
    expect(h.manager.activeCount).toBe(0);
    h.manager.close();
  });
  test('duplicate completion from a preceding turn cannot end the next progressive stream', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    await h.finish('guest');
    await h.manager.ask(h.speaker('guest'), 'Segunda');
    await h.callbacks.get('guest')!.onAudio(Buffer.alloc(480), 2);
    expect(h.playback.startStream).toHaveBeenCalledTimes(2);
    h.callbacks.get('guest')!.onResponseComplete(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams[1]!.end).not.toHaveBeenCalled();
    h.callbacks.get('guest')!.onResponseComplete(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams[1]!.end).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.manager.close();
  });
  test('response IDs fence an old completed message while preserving multiple messages in the new turn', async () => {
    vi.useFakeTimers();
    const metric = vi.fn();
    const h = harness({ metric });
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    const callbacks = h.callbacks.get('guest')!;
    callbacks.onTextResponse?.({ eventId: 1, responseId: 'completed-message' });
    await callbacks.onAudio(Buffer.alloc(480, 1), 1, { responseId: 'completed-message' });
    callbacks.onResponseComplete(1);
    await vi.advanceTimersByTimeAsync(0);
    await h.manager.ask(h.speaker('guest'), 'Segunda');
    callbacks.onTextResponse?.({ eventId: 1, responseId: 'completed-message' });
    await callbacks.onAudio(Buffer.alloc(480, 2), 1, { responseId: 'completed-message' });
    expect(h.playback.startStream).toHaveBeenCalledTimes(1);
    expect(metric.mock.calls.filter(([name]) => name === 'agent_stale_message_events')).toHaveLength(2);
    const messageOne = Buffer.alloc(480, 3);
    const messageTwo = Buffer.alloc(480, 4);
    callbacks.onTextResponse?.({ eventId: 2, responseId: 'new-message-one' });
    await callbacks.onAudio(messageOne, 2, { responseId: 'new-message-one' });
    callbacks.onTextResponse?.({ eventId: 3, responseId: 'new-message-two' });
    await callbacks.onAudio(messageTwo, 3, { responseId: 'new-message-two' });
    expect(h.playback.startStream).toHaveBeenCalledTimes(2);
    expect(h.streams[1]!.chunks).toEqual([messageOne, messageTwo]);
    expect(h.streams[1]!.end).not.toHaveBeenCalled();
    callbacks.onResponseComplete(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams[1]!.end).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.manager.close();
  });
  test('a completion from two turns ago cannot terminate a current stream', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    await h.finish('guest');
    await h.manager.ask(h.speaker('guest'), 'Segunda');
    await h.finish('guest');
    await h.manager.ask(h.speaker('guest'), 'Terceira');
    await h.callbacks.get('guest')!.onAudio(Buffer.alloc(480, 3), 3);
    h.callbacks.get('guest')!.onResponseComplete(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams[2]!.end).not.toHaveBeenCalled();
    h.callbacks.get('guest')!.onResponseComplete(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.streams[2]!.end).toHaveBeenCalledOnce();
    h.manager.close();
  });
  test('hourly budget rejects before opening another provider session', async () => {
    vi.useFakeTimers();
    const h = harness({ maxTurnsPerHour: 1 });
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    await h.finish('guest');
    h.manager.revoke('guest');
    await expect(h.manager.ask(h.speaker('owner'), 'Segunda')).rejects.toMatchObject({ code: 'limit' });
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.manager.close();
  });
  test('revocation during pending connect closes the resulting session', async () => {
    let resolve!: (session: AgentSession) => void;
    const pending = new Promise<AgentSession>((r) => { resolve = r; });
    const session: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn() };
    const h = harness({ connect: () => pending });
    const question = h.manager.ask(h.speaker('guest'), 'Pergunta');
    const rejected = expect(question).rejects.toMatchObject({ code: 'consent' });
    h.consent.revoke('guest');
    h.manager.revoke('guest');
    resolve(session);
    await rejected;
    expect(session.close).toHaveBeenCalled();
    expect(session.sendText).not.toHaveBeenCalled();
    h.manager.close();
  });
  test('voice awaiting wake detection cannot activate after revoke', async () => {
    let resolve!: (activated: boolean) => void;
    const h = harness({ detectWake: () => new Promise<boolean>((r) => { resolve = r; }) });
    const voice = h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    h.consent.revoke('guest');
    h.manager.revoke('guest');
    resolve(true);
    await voice;
    expect(h.connect).not.toHaveBeenCalled();
    h.manager.close();
  });
  test('no provider session for nonactivated or nonconsented audio', async () => {
    const h = harness({ detectWake: async () => false });
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    expect(h.connect).not.toHaveBeenCalled();
    const guest = h.speaker('guest');
    h.consent.revoke('guest');
    await expect(h.manager.voiceTurn(guest, Buffer.alloc(480))).rejects.toMatchObject({ code: 'consent' });
    h.manager.close();
  });
  test('idle TTL and response deadline close unused provider sessions', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Pergunta');
    await h.finish('guest');
    await vi.advanceTimersByTimeAsync(46_000);
    expect(h.manager.activeCount).toBe(0);
    expect(h.sessions.get('guest')!.close).toHaveBeenCalled();
    await h.manager.ask(h.speaker('owner'), 'Pergunta sem resposta');
    await vi.advanceTimersByTimeAsync(46_000);
    expect(h.manager.activeCount).toBe(0);
    h.manager.close();
  });
  test('missing completion drains once, fences the old session and opens no follow-up window', async () => {
    vi.useFakeTimers();
    const detectWake = vi.fn(async () => false);
    const h = harness({ detectWake });
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    const stale = h.callbacks.get('guest')!;
    await stale.onAudio(Buffer.alloc(480, 1), 1);
    expect(h.streams[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_001);
    expect(h.streams[0]!.end).toHaveBeenCalledOnce();
    expect(h.sessions.get('guest')!.close).toHaveBeenCalledWith({ drainAudio: true });
    expect(h.manager.activeCount).toBe(0);
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    expect(detectWake).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledTimes(1);
    await h.manager.ask(h.speaker('guest'), 'Segunda');
    expect(h.connect).toHaveBeenCalledTimes(2);
    await stale.onAudio(Buffer.alloc(480, 2), 2);
    stale.onResponseComplete(2);
    expect(h.playback.startStream).toHaveBeenCalledTimes(1);
    h.manager.close();
  });
  test('bounded sessions reject third simultaneous speaker', async () => {
    const h = harness();
    await h.manager.ask(h.speaker('owner'), 'Um');
    await h.manager.ask(h.speaker('guest'), 'Dois');
    await expect(h.manager.ask(h.speaker('other'), 'Três')).rejects.toMatchObject({ code: 'busy' });
    expect(h.connect).toHaveBeenCalledTimes(2);
    h.manager.close();
  });
  test('follow-up belongs only to its speaker and expires after playback', async () => {
    vi.useFakeTimers();
    const detect = vi.fn(async () => true);
    const h = harness({ detectWake: detect, pace: async () => undefined });
    await h.manager.voiceTurn(h.speaker('owner'), Buffer.alloc(480));
    expect(detect).toHaveBeenCalledTimes(1);
    await h.finish('owner');
    await h.manager.voiceTurn(h.speaker('owner'), Buffer.alloc(480));
    expect(detect).toHaveBeenCalledTimes(1);
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    expect(detect).toHaveBeenCalledTimes(2);
    await h.finish('owner');
    await vi.advanceTimersByTimeAsync(19_000);
    await h.manager.voiceTurn(h.speaker('owner'), Buffer.alloc(480));
    expect(detect).toHaveBeenCalledTimes(3);
    h.manager.close();
  });
  test('interruption aborts the previous audio upload before a new question', async () => {
    let first = true;
    const h = harness({ pace: async () => {
      if (first) { first = false; h.callbacks.get('guest')!.onInterruption(); }
    } });
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(48_000));
    const oldSession = h.sessions.get('guest')!;
    expect(oldSession.sendAudio).toHaveBeenCalledTimes(1);
    await h.manager.ask(h.speaker('guest'), 'Novo turno');
    expect(h.sessions.get('guest')!.sendText).toHaveBeenCalledWith('Novo turno');
    expect(h.sessions.get('guest')!.sendAudio).not.toHaveBeenCalled();
    expect(oldSession.close).toHaveBeenCalled();
    h.manager.close();
  });
  test('late audio/completion from an interrupted session cannot contaminate the next turn', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    const stale = h.callbacks.get('guest')!;
    stale.onInterruption();
    await h.manager.ask(h.speaker('guest'), 'Segunda');
    stale.onAudio(Buffer.alloc(480, 1), 1);
    stale.onResponseComplete();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.playback.startStream).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledTimes(2);
    await h.finish('guest');
    expect(h.playback.startStream).toHaveBeenCalledTimes(1);
    h.manager.close();
  });
});
