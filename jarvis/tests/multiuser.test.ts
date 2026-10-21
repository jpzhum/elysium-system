import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionManager, type Playback, type SessionOptions } from '../src/agents/session-manager.js';
import type { AgentCallbacks, AgentSession } from '../src/agents/elevenlabs-client.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

function harness(overrides: Partial<SessionOptions> = {}) {
  const consent = new ConsentStore();
  const callbacks = new Map<string, AgentCallbacks>();
  const sessions = new Map<string, AgentSession>();
  const playback: Playback = { isPlaying: false, play: vi.fn(async () => undefined), stopUser: vi.fn(), stop: vi.fn() };
  const connect = vi.fn(async (speaker, cb) => {
    callbacks.set(speaker.discordUserId, cb);
    const session: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn() };
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
  const finish = async (id: string) => {
    callbacks.get(id)!.onAudio(Buffer.alloc(480), 1);
    callbacks.get(id)!.onResponseComplete();
    await vi.advanceTimersByTimeAsync(250);
  };
  return { manager, consent, speaker, callbacks, sessions, playback, connect, finish };
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
    expect(h.playback.play).toHaveBeenNthCalledWith(1, 'guest', expect.any(Buffer), 24000, false);
    expect(h.playback.play).toHaveBeenNthCalledWith(2, 'owner', expect.any(Buffer), 24000, true);
    h.manager.close();
  });
  test('revoke cancels session and prevents late audio playback', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Pergunta');
    h.callbacks.get('guest')!.onAudio(Buffer.alloc(480), 1);
    h.consent.revoke('guest');
    h.manager.revoke('guest');
    h.callbacks.get('guest')!.onResponseComplete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.playback.play).not.toHaveBeenCalled();
    expect(h.sessions.get('guest')!.close).toHaveBeenCalled();
    expect(h.manager.activeCount).toBe(0);
    h.manager.close();
  });
  test('completion from a preceding turn cannot flush the next turn early', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Primeira');
    await h.finish('guest');
    await h.manager.ask(h.speaker('guest'), 'Segunda');
    h.callbacks.get('guest')!.onAudio(Buffer.alloc(480), 2);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.playback.play).toHaveBeenCalledTimes(1);
    h.callbacks.get('guest')!.onResponseComplete();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.playback.play).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(1);
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
    expect(h.playback.play).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledTimes(2);
    await h.finish('guest');
    expect(h.playback.play).toHaveBeenCalledTimes(1);
    h.manager.close();
  });
});
