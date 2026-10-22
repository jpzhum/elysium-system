import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionManager, type Playback, type SessionOptions } from '../src/agents/session-manager.js';
import type { AgentCallbacks, AgentSession } from '../src/agents/elevenlabs-client.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext } from '../src/policy/identity.js';

const managers: SessionManager[] = [];
async function settle(): Promise<void> { for (let i = 0; i < 240; i++) await Promise.resolve(); }

function harness(overrides: Partial<SessionOptions> = {}) {
  const consent = new ConsentStore();
  const callbacks = new Map<string, AgentCallbacks>();
  const sessions = new Map<string, AgentSession>();
  const uploaded = new Map<string, Buffer[]>();
  const notify = vi.fn();
  const metric = vi.fn();
  const streams: {
    userId: string; chunks: Buffer[]; end: () => void; cancel: () => void;
    progress: (event: 'first_packet' | 'drained' | 'resumed', elapsedMs?: number) => void;
  }[] = [];
  const playback: Playback = { isPlaying: false,
    startStream: vi.fn((userId, _rate, _owner, options) => {
      let finish!: () => void;
      let reject!: (error: Error) => void;
      let settled = false;
      let started = false;
      const done = new Promise<void>((resolve, no) => { finish = resolve; reject = no; });
      void done.catch(() => undefined);
      const stream = { userId, chunks: [] as Buffer[],
        progress: (event: 'first_packet' | 'drained' | 'resumed', ms = 0) => options?.onProgress?.(event, ms),
        end: vi.fn(() => { if (!settled) { settled = true; finish(); } }),
        cancel: vi.fn(() => { if (!settled) { settled = true; reject(new Error('cancelled')); } }),
      };
      streams.push(stream);
      return { done, end: stream.end, cancel: stream.cancel,
        write: vi.fn(async (pcm: Buffer) => {
          if (settled || options?.isAllowed?.() === false) throw new Error('cancelled');
          stream.chunks.push(Buffer.from(pcm));
          if (!started) { started = true; stream.progress('first_packet'); }
        }),
      };
    }),
    stopUser: vi.fn(userId => { for (const stream of streams) if (stream.userId === userId) stream.cancel(); }),
    stop: vi.fn(() => { for (const stream of streams) stream.cancel(); }),
  };
  const connect = vi.fn(async (speaker, cb) => {
    callbacks.set(speaker.discordUserId, cb);
    const copies: Buffer[] = [];
    uploaded.set(speaker.discordUserId, copies);
    const session: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(pcm => { copies.push(Buffer.from(pcm)); }),
      sendContext: vi.fn(), close: vi.fn(() => cb.onClose()) };
    sessions.set(speaker.discordUserId, session);
    return session;
  }) satisfies SessionOptions['connect'];
  const manager = new SessionManager({ connect, playback, notify, metric,
    allowed: (speaker, audio) => consent.isCurrent(speaker.discordUserId, speaker.consentVersion, audio),
    detectWake: vi.fn(async () => true), maxSessions: 2, maxTurnSeconds: 12, maxSessionSeconds: 300,
    idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 100, ...overrides });
  managers.push(manager);
  const speaker = (id: string) => {
    const grant = consent.get(id) ?? consent.grant(id, true);
    return speakerContext({ discordUserId: id, displayName: id, guildId: 'guild', channelId: 'voice',
      consented: true, consentVersion: grant.version }, 'owner');
  };
  let completionId = 0;
  const finish = async (id: string) => {
    await callbacks.get(id)!.onAudio(Buffer.alloc(480), ++completionId);
    await callbacks.get(id)!.onResponseComplete(completionId);
    await settle();
  };
  const ask = async (id: string, text = 'Pergunta') => {
    const receipt = await manager.ask(speaker(id), text);
    await settle();
    return receipt;
  };
  return { manager, consent, speaker, callbacks, sessions, playback, streams, connect, finish, ask, notify, metric, uploaded };
}

afterEach(() => { for (const manager of managers.splice(0)) manager.close(); vi.useRealTimers(); });

describe('bounded conversational scheduling', () => {
  test('five consecutive questions accept immediately without completion and fence every retired provider', async () => {
    const h = harness();
    await h.ask('guest', 'Primeira');
    for (let index = 0; index < 4; index++) {
      const old = h.callbacks.get('guest')!;
      old.onTextResponse?.({ responseId: `message-${index}` });
      await old.onAudio(Buffer.alloc(480, index + 1), index);
      h.streams[index]!.progress('drained');
      const receipt = await h.ask('guest', `Próxima ${index}`);
      expect(receipt).toMatchObject({ queued: true, position: 1 });
      expect(h.connect).toHaveBeenCalledTimes(index + 2);
      const before = h.streams.length;
      await old.onAudio(Buffer.alloc(480, 99), 999);
      old.onResponseComplete(999);
      expect(h.streams).toHaveLength(before);
    }
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_turns_superseded')).toHaveLength(4);
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_turns_completed')).toHaveLength(0);
    expect(h.sessions.get('guest')!.sendText).toHaveBeenCalledWith('Próxima 3');
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: true });
  });

  test('local silence alone never closes provider or fabricates a completed turn', async () => {
    const h = harness();
    await h.ask('guest');
    h.callbacks.get('guest')!.onTextResponse?.();
    await h.callbacks.get('guest')!.onAudio(Buffer.alloc(480), 1);
    h.streams[0]!.progress('drained');
    await settle();
    expect(h.sessions.get('guest')!.close).not.toHaveBeenCalled();
    expect(h.metric.mock.calls.filter(([name]) => name === 'agent_turns_completed')).toHaveLength(0);
    expect(h.manager.queueStatus.active).toBe(true);
  });

  test('queue requires local drain and text, and new audio invalidates an earlier drain', async () => {
    const h = harness();
    await h.ask('guest');
    const cb = h.callbacks.get('guest')!;
    await cb.onAudio(Buffer.alloc(480), 1);
    h.streams[0]!.progress('drained');
    await h.ask('owner');
    expect(h.connect).toHaveBeenCalledOnce();
    await cb.onAudio(Buffer.alloc(480), 2);
    cb.onTextResponse?.();
    expect(h.sessions.get('guest')!.close).not.toHaveBeenCalled();
    h.streams[0]!.progress('drained'); await settle();
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.sessions.get('guest')!.close).toHaveBeenCalledWith({ drainAudio: true });
  });

  test('owners move before queued guests while the active guest finishes normally', async () => {
    const h = harness();
    await h.ask('guest-one', 'Um');
    expect(await h.ask('guest-two', 'Dois')).toMatchObject({ queued: true, position: 1 });
    expect(await h.ask('owner', 'Três')).toMatchObject({ queued: true, position: 1 });
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.sessions.get('guest-one')!.close).not.toHaveBeenCalled();
    await h.finish('guest-one');
    expect(h.connect.mock.calls.map(([s]) => [s.discordUserId, s.isOwner])).toEqual([
      ['guest-one', false], ['owner', true],
    ]);
    await h.finish('owner');
    expect(h.connect.mock.calls.map(([s]) => s.discordUserId)).toEqual(['guest-one', 'owner', 'guest-two']);
    await h.finish('guest-two');
    expect(h.streams.map(stream => stream.userId)).toEqual(['guest-one', 'owner', 'guest-two']);
    expect(h.manager.activeCount).toBeLessThanOrEqual(2);
  });

  test('per-speaker and global queue limits reject explicitly without charging a turn or opening sessions', async () => {
    const h = harness({ maxQueuedTurns: 3, maxQueuedPerUser: 2 });
    await h.ask('guest');
    await h.ask('guest'); await h.ask('guest');
    await expect(h.ask('guest')).rejects.toMatchObject({ code: 'limit' });
    await h.ask('owner');
    await expect(h.ask('other')).rejects.toMatchObject({ code: 'limit' });
    expect(h.manager.queuedCount).toBe(3);
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.metric.mock.calls.filter(([name]) => name === 'questions_received')).toHaveLength(4);
  });

  test('queue TTL gives cancellation feedback and never submits expired text', async () => {
    vi.useFakeTimers();
    const h = harness({ queueTtlSeconds: 2 });
    await h.ask('guest');
    const notification = vi.fn();
    const receipt = await h.manager.ask(h.speaker('owner'), 'Expired', notification);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(notification).toHaveBeenLastCalledWith({ turnId: receipt.turnId, type: 'cancelled', reason: 'expired' });
    expect(h.manager.queuedCount).toBe(0);
    await h.finish('guest');
    expect(h.connect).toHaveBeenCalledOnce();
  });

  test('pending tools preserve the current turn until resolved even with a drained buffer and another caller', async () => {
    const h = harness();
    await h.ask('guest');
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.(); cb.onToolActivity?.(1);
    await cb.onAudio(Buffer.alloc(480), 1);
    h.streams[0]!.progress('drained');
    await h.ask('owner');
    expect(h.connect).toHaveBeenCalledOnce();
    cb.onToolActivity?.(0); await settle();
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  test('hourly budget rejects before opening another provider session', async () => {
    const h = harness({ maxTurnsPerHour: 1 });
    await h.ask('guest'); await h.finish('guest');
    await expect(h.ask('owner')).rejects.toMatchObject({ code: 'limit' });
    expect(h.connect).toHaveBeenCalledOnce();
  });

  test('queued raw PCM stays under the global memory ceiling independently of configured queue slots', async () => {
    const h = harness({ maxQueuedTurns: 16, maxQueuedPerUser: 4, maxTurnSeconds: 30 });
    await h.ask('owner');
    const pcm = Buffer.alloc(30 * 48_000 * 4);
    await h.manager.voiceTurn(h.speaker('one'), pcm);
    await h.manager.voiceTurn(h.speaker('two'), pcm);
    await expect(h.manager.voiceTurn(h.speaker('three'), pcm)).rejects.toMatchObject({ code: 'limit' });
    expect(h.manager.queuedCount).toBe(2);
    expect(h.connect).toHaveBeenCalledOnce();
  });

  test('an async per-question failure notification is isolated from provider payloads and other questions', async () => {
    const notifications = vi.fn();
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Private question', notifications); await settle();
    await h.ask('owner');
    h.callbacks.get('guest')!.onError('unknown-provider-detail'); await settle();
    expect(notifications).toHaveBeenLastCalledWith({ type: 'failed', reason: 'provider', turnId: expect.any(String) });
    expect(JSON.stringify(notifications.mock.calls)).not.toContain('Private question');
    expect(JSON.stringify(notifications.mock.calls)).not.toContain('unknown-provider-detail');
    expect(h.sessions.get('owner')!.sendText).toHaveBeenCalled();
  });
});

describe('speaker authorization and cancellation', () => {
  test('revocation immediately cancels active and queued questions and fences stale output', async () => {
    const h = harness();
    await h.ask('guest'); await h.ask('guest');
    const stale = h.callbacks.get('guest')!;
    await stale.onAudio(Buffer.alloc(480), 1);
    h.consent.revoke('guest'); h.manager.revoke('guest');
    await stale.onAudio(Buffer.alloc(480, 99), 2); stale.onResponseComplete(2);
    await settle();
    expect(h.streams[0]!.cancel).toHaveBeenCalled();
    expect(h.streams[0]!.chunks).toHaveLength(1);
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
    expect(h.notify.mock.calls.filter(([, event]) => event.type === 'cancelled')).toHaveLength(2);
  });

  test('disconnect cancels only that speaker and lets another participant proceed', async () => {
    const h = harness();
    await h.ask('guest'); await h.ask('owner');
    h.manager.cancelUser('guest'); await settle();
    expect(h.sessions.get('guest')!.close).toHaveBeenCalled();
    expect(h.sessions.get('owner')!.sendText).toHaveBeenCalled();
  });

  test('call disconnection cancels a pre-audio active request and queue; reconnection uses fresh fenced context', async () => {
    const h = harness();
    await h.ask('guest');
    const stale = h.callbacks.get('guest')!;
    await h.ask('owner');
    h.manager.setAvailable(false);
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
    await expect(h.ask('guest')).rejects.toMatchObject({ code: 'closed' });
    await stale.onAudio(Buffer.alloc(480, 99), 1);
    expect(h.streams).toHaveLength(0);
    h.manager.setAvailable(true);
    await h.ask('guest');
    expect(h.connect).toHaveBeenCalledTimes(2);
    await h.finish('guest');
    expect(h.streams).toHaveLength(1);
    expect(h.playback.stop).not.toHaveBeenCalled();
    expect(h.notify.mock.calls.filter(([, event]) => event.type === 'cancelled')).toHaveLength(2);
  });

  test('owner interruption is ID-authorized, cancels current playback and preserves waiting guests', async () => {
    const h = harness();
    await h.ask('guest');
    const stale = h.callbacks.get('guest')!;
    await stale.onAudio(Buffer.alloc(480), 1);
    await h.ask('other');
    expect(h.manager.interruptOwner(h.speaker('other'))).toBe(false);
    expect(h.streams[0]!.cancel).not.toHaveBeenCalled();
    expect(h.manager.interruptOwner(h.speaker('owner'))).toBe(true);
    await settle();
    expect(h.streams[0]!.cancel).toHaveBeenCalled();
    expect(h.sessions.get('other')!.sendText).toHaveBeenCalled();
    await stale.onAudio(Buffer.alloc(480, 99), 2);
    expect(h.streams).toHaveLength(1);
    expect(h.metric).toHaveBeenCalledWith('owner_interruptions');
  });

  test('owner without current audio consent cannot interrupt', async () => {
    const h = harness();
    await h.ask('guest');
    const owner = h.speaker('owner'); h.consent.revoke('owner');
    expect(() => h.manager.interruptOwner(owner)).toThrow('consent');
    expect(h.sessions.get('guest')!.close).not.toHaveBeenCalled();
  });

  test('revocation during pending connect returns receipt and closes the late session', async () => {
    let resolve!: (session: AgentSession) => void;
    const pending = new Promise<AgentSession>(yes => { resolve = yes; });
    const late: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn() };
    const h = harness({ connect: vi.fn(() => pending) });
    const receipt = await h.manager.ask(h.speaker('guest'), 'Pergunta');
    expect(receipt.queued).toBe(false);
    h.consent.revoke('guest'); h.manager.revoke('guest');
    resolve(late); await settle();
    expect(late.close).toHaveBeenCalled();
    expect(late.sendText).not.toHaveBeenCalled();
    expect(h.manager.queueStatus.active).toBe(false);
  });

  test('cancelling an unresolved provider connection immediately releases another queued speaker', async () => {
    let resolve!: (session: AgentSession) => void;
    const pending = new Promise<AgentSession>(yes => { resolve = yes; });
    const late: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn() };
    const next: AgentSession = { inputSampleRate: 16000, outputSampleRate: 24000,
      sendText: vi.fn(), sendAudio: vi.fn(), sendContext: vi.fn(), close: vi.fn() };
    const connect = vi.fn<SessionOptions['connect']>(async speaker =>
      speaker.discordUserId === 'guest' ? pending : next);
    const h = harness({ connect });
    await h.ask('guest'); await h.ask('owner');
    h.manager.cancelUser('guest'); await settle();
    expect(next.sendText).toHaveBeenCalled();
    expect(late.sendText).not.toHaveBeenCalled();
    resolve(late); await settle();
    expect(late.close).toHaveBeenCalled();
    expect(next.close).not.toHaveBeenCalled();
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: true });
  });

  test('a notification sink that throws cannot block or fail an accepted question', async () => {
    const h = harness();
    await h.manager.ask(h.speaker('guest'), 'Pergunta', () => { throw new Error('private callback failure'); });
    await settle();
    expect(h.sessions.get('guest')!.sendText).toHaveBeenCalled();
    expect(h.metric).toHaveBeenCalledWith('turn_notification_failed');
    await h.finish('guest');
    expect(h.manager.queueStatus.active).toBe(false);
  });

  test('voice awaiting wake detection cannot activate after revoke', async () => {
    let resolve!: (activated: boolean) => void;
    const h = harness({ detectWake: () => new Promise<boolean>(yes => { resolve = yes; }) });
    const voice = h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    h.consent.revoke('guest'); h.manager.revoke('guest'); resolve(true); await voice;
    expect(h.connect).not.toHaveBeenCalled();
  });

  test('false wake and missing consent cannot open provider sessions', async () => {
    const h = harness({ detectWake: async () => false });
    expect(await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480))).toBeUndefined();
    expect(h.connect).not.toHaveBeenCalled();
    const guest = h.speaker('guest'); h.consent.revoke('guest');
    await expect(h.manager.voiceTurn(guest, Buffer.alloc(480))).rejects.toMatchObject({ code: 'consent' });
  });

  test('wake concurrency and captured duration are bounded before external detection', async () => {
    let resolve!: (activated: boolean) => void;
    const detect = vi.fn(() => new Promise<boolean>(yes => { resolve = yes; }));
    const h = harness({ maxSessions: 1, detectWake: detect });
    const pending = h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    await expect(h.manager.voiceTurn(h.speaker('owner'), Buffer.alloc(480))).rejects.toMatchObject({ code: 'limit' });
    await expect(h.manager.voiceTurn(h.speaker('other'), Buffer.alloc(12 * 48_000 * 4 + 4)))
      .rejects.toMatchObject({ code: 'limit' });
    resolve(false); await pending;
    expect(detect).toHaveBeenCalledOnce();
  });

  test('voice activation enqueues owned PCM while another speaker is active', async () => {
    const h = harness({ pace: async () => undefined });
    await h.ask('owner');
    const pcm = Buffer.alloc(480, 1);
    expect(await h.manager.voiceTurn(h.speaker('guest'), pcm)).toMatchObject({ queued: true });
    pcm.fill(0);
    expect(h.sessions.has('guest')).toBe(false);
    await h.finish('owner'); await settle();
    expect(h.sessions.get('guest')!.sendAudio).toHaveBeenCalled();
    expect(h.uploaded.get('guest')!.some(frame => frame.some(byte => byte !== 0))).toBe(true);
    expect(h.notify.mock.calls.some(([, event]) => event.type === 'queued')).toBe(true);
  });

  test('local playback drain opens a bounded same-speaker follow-up without declaring provider completion', async () => {
    vi.useFakeTimers();
    const detect = vi.fn(async () => true);
    const h = harness({ detectWake: detect, pace: async () => undefined });
    await h.ask('guest');
    const old = h.callbacks.get('guest')!;
    old.onTextResponse?.(); await old.onAudio(Buffer.alloc(480), 1);
    h.streams[0]!.progress('drained');
    expect(await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480))).toMatchObject({ queued: true });
    await settle();
    expect(detect).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledTimes(2);
    await h.finish('guest');
    await vi.advanceTimersByTimeAsync(19_000);
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    expect(detect).toHaveBeenCalledOnce();
  });

  test('provider interruption aborts paced upload and allows a fresh next request', async () => {
    let first = true;
    const h = harness({ pace: async () => {
      if (first) { first = false; h.callbacks.get('guest')!.onInterruption(); }
    } });
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(48_000)); await settle();
    const oldSession = h.sessions.get('guest')!;
    expect(oldSession.sendAudio).toHaveBeenCalledTimes(1);
    await h.ask('guest', 'Novo turno');
    expect(h.sessions.get('guest')!.sendText).toHaveBeenCalledWith('Novo turno');
    expect(oldSession.close).toHaveBeenCalled();
  });

  test('owner interruption grants only that authenticated speaker a bounded follow-up activation', async () => {
    const detect = vi.fn(async () => false);
    const h = harness({ detectWake: detect, pace: async () => undefined });
    await h.ask('guest');
    expect(h.manager.interruptOwner(h.speaker('owner'))).toBe(true); await settle();
    await h.manager.voiceTurn(h.speaker('owner'), Buffer.alloc(480)); await settle();
    expect(detect).not.toHaveBeenCalled();
    expect(h.sessions.get('owner')!.sendAudio).toHaveBeenCalled();
    await h.manager.voiceTurn(h.speaker('guest'), Buffer.alloc(480));
    expect(detect).toHaveBeenCalledOnce();
  });

  test('duplicate completions and old response IDs cannot end the next explicit turn', async () => {
    const h = harness();
    await h.ask('guest');
    const cb = h.callbacks.get('guest')!;
    cb.onTextResponse?.({ responseId: 'old' });
    await cb.onAudio(Buffer.alloc(480), 1, { responseId: 'old' });
    cb.onResponseComplete(1); await settle();
    await h.ask('guest');
    await cb.onAudio(Buffer.alloc(480, 99), 1, { responseId: 'old' });
    expect(h.streams).toHaveLength(1);
    await cb.onAudio(Buffer.alloc(480, 2), 2, { responseId: 'new' });
    cb.onResponseComplete(1); await settle();
    expect(h.streams[1]!.end).not.toHaveBeenCalled();
    cb.onResponseComplete(2); await settle();
    expect(h.streams[1]!.end).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledOnce();
  });

  test('close cancels waiting requests, clears pending playback and refuses future asks', async () => {
    const h = harness();
    await h.ask('guest'); await h.ask('owner');
    h.manager.close(); await settle();
    expect(h.manager.queueStatus).toEqual({ waiting: 0, active: false });
    await expect(h.ask('other')).rejects.toMatchObject({ code: 'closed' });
    expect(h.notify.mock.calls.filter(([, event]) => event.type === 'cancelled')).toHaveLength(2);
  });
});
