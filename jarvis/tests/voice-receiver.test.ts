import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { afterEach, expect, test, vi } from 'vitest';
import { VoiceReceiver, type VoiceTurnTiming } from '../src/discord/voice-receiver.js';

const decode = vi.hoisted(() => vi.fn((packet: Buffer) => Buffer.from(packet)));
vi.mock('../src/audio/opus-decoder.js', () => ({ OpusDecoder: class {
  decode = decode;
  delete = vi.fn();
} }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function harness(maxTurnSeconds = 12) {
  const speaking = new EventEmitter();
  const streams = new Map<string, PassThrough>();
  const consent = new Set<string>();
  const subscriptions: string[] = [];
  const delivered: { userId: string; pcm: Buffer; timing: VoiceTurnTiming }[] = [];
  const metric = vi.fn();
  let playing = true;
  let enabled = true;
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    receiver: { speaking, subscribe(userId: string) {
      subscriptions.push(userId);
      const stream = new PassThrough({ objectMode: true });
      streams.set(userId, stream);
      return stream;
    } },
  });
  const receiver = new VoiceReceiver(connection as unknown as VoiceConnection, {
    ownUserId: 'bot', canReceive: (id) => consent.has(id), isPlaying: () => playing,
    canBargeIn: (id) => enabled && id === 'owner', maxTurnSeconds,
    onTurn(userId, pcm, timing) { delivered.push({ userId, pcm: Buffer.from(pcm), timing }); },
    onMetric: metric,
  });
  receiver.start();
  return { receiver, speaking, streams, consent, subscriptions, delivered, metric, connection,
    setPlaying(value: boolean) { playing = value; }, setEnabled(value: boolean) { enabled = value; } };
}

function packet(): Buffer {
  const pcm = Buffer.alloc(960 * 4);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(8_000, offset);
  return pcm;
}

test('only the backend-authorized owner with individual consent is captured during playback', () => {
  const h = harness();
  for (const id of ['bot', 'guest', 'owner']) h.consent.add(id);
  h.speaking.emit('start', 'bot');
  h.speaking.emit('start', 'guest');
  h.speaking.emit('start', 'owner');
  expect(h.subscriptions).toEqual(['owner']);
  h.receiver.stop();
  const unconsented = harness();
  unconsented.speaking.emit('start', 'owner');
  expect(unconsented.subscriptions).toEqual([]);
  unconsented.receiver.stop();
});

test('owner barge-in is capped at four seconds and two-second cooldown prevents repeated paid checks', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.consent.add('owner');
  h.speaking.emit('start', 'owner');
  const stream = h.streams.get('owner')!;
  for (let index = 0; index < 200; index += 1) stream.write(packet());
  expect(stream.destroyed).toBe(true);
  expect(h.delivered).toHaveLength(1);
  expect(h.delivered[0]!.pcm.length).toBe(4 * 48_000 * 4);
  expect(h.delivered[0]!.timing.duringPlayback).toBe(true);
  h.speaking.emit('start', 'owner');
  expect(h.subscriptions).toHaveLength(1);
  expect(h.metric).toHaveBeenCalledWith('voice_barge_in_rate_limited', 1);
  await vi.advanceTimersByTimeAsync(2_000);
  h.speaking.emit('start', 'owner');
  expect(h.subscriptions).toHaveLength(2);
  h.receiver.stop();
});

test.each(['revocation', 'disablement'])('%s fences decoding and discards partial audio immediately', (mode) => {
  const h = harness();
  h.consent.add('owner');
  h.speaking.emit('start', 'owner');
  const stream = h.streams.get('owner')!;
  stream.write(packet());
  const calls = decode.mock.calls.length;
  if (mode === 'revocation') h.consent.delete('owner');
  else h.setEnabled(false);
  stream.write(packet());
  expect(decode).toHaveBeenCalledTimes(calls);
  expect(h.delivered).toHaveLength(0);
  expect(stream.destroyed).toBe(true);
  h.receiver.stop();
});

test('normal speech is discarded if playback starts; it is never reclassified as an interruption', () => {
  const h = harness();
  h.setPlaying(false);
  h.consent.add('owner');
  h.speaking.emit('start', 'owner');
  const stream = h.streams.get('owner')!;
  stream.write(packet());
  h.setPlaying(true);
  stream.write(packet());
  expect(h.delivered).toHaveLength(0);
  expect(stream.destroyed).toBe(true);
  h.receiver.stop();
});

test('capture and end-of-speech latency are numeric and a barge-in retains its purpose after playback drains', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.consent.add('owner');
  h.speaking.emit('start', 'owner');
  const stream = h.streams.get('owner')!;
  stream.write(packet());
  await vi.advanceTimersByTimeAsync(40);
  stream.write(packet());
  h.setPlaying(false);
  await vi.advanceTimersByTimeAsync(600);
  stream.emit('end');
  expect(h.delivered[0]!.timing).toMatchObject({ duringPlayback: true, captureMs: 640, endDetectionMs: 600,
    captureStartedAtMs: 0, captureEndedAtMs: 640 });
  expect(h.delivered[0]!.timing.captureId).toMatch(/:1$/);
  expect(h.metric).toHaveBeenCalledWith('voice_capture_ms', 640);
  expect(h.metric).toHaveBeenCalledWith('voice_end_detection_ms', 600);
  h.receiver.stop();
});

test('received PCM is zeroed only after the asynchronous consumer has finished', async () => {
  let release!: () => void;
  let received!: Buffer;
  const h = harness();
  h.receiver.stop();
  const receiver = new VoiceReceiver(h.connection as unknown as VoiceConnection, {
    ownUserId: 'bot', canReceive: () => true, isPlaying: () => false, maxTurnSeconds: 1,
    onTurn: async (_id, pcm) => { received = pcm; await new Promise<void>((resolve) => { release = resolve; }); },
  });
  receiver.start();
  h.speaking.emit('start', 'guest');
  h.streams.get('guest')!.write(packet());
  h.streams.get('guest')!.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(received.some((value) => value !== 0)).toBe(true);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(received.every((value) => value === 0)).toBe(true);
  receiver.stop();
});

test('repeated speaking starts and microphone microgaps belong to one capture until VAD ends', async () => {
  vi.useFakeTimers();
  const h = harness(); h.setPlaying(false); h.consent.add('guest');
  h.speaking.emit('start', 'guest');
  const stream = h.streams.get('guest')!;
  stream.write(packet());
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(100);
    h.speaking.emit('start', 'guest');
    stream.write(Buffer.alloc(960 * 4));
  }
  stream.write(packet()); stream.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.subscriptions).toEqual(['guest']);
  expect(h.delivered).toHaveLength(1);
  expect(h.delivered[0]!.pcm.length).toBe(5 * 960 * 4);
  expect(h.metric.mock.calls.filter(([name]) => name === 'voice_capture_start_debounced')).toHaveLength(3);
  h.receiver.stop();
});

test('separate questions have new capture identities without a normal-speech cooldown', async () => {
  vi.useFakeTimers();
  const h = harness(); h.setPlaying(false); h.consent.add('guest'); h.consent.add('other');
  for (const userId of ['guest', 'guest', 'other']) {
    h.speaking.emit('start', userId);
    h.streams.get(userId)!.write(packet());
    await vi.advanceTimersByTimeAsync(20);
    h.streams.get(userId)!.end();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(h.subscriptions).toEqual(['guest', 'guest', 'other']);
  expect(h.delivered.map(item => item.timing.captureId)).toEqual([
    expect.stringMatching(/:1$/), expect.stringMatching(/:2$/), expect.stringMatching(/:3$/),
  ]);
  expect(h.delivered[0]!.timing.captureEndedAtMs).toBe(h.delivered[1]!.timing.captureStartedAtMs);
  h.receiver.stop();
});

test('disconnect clears capture state and old packets cannot become a new user turn', async () => {
  vi.useFakeTimers();
  const h = harness(); h.setPlaying(false); h.consent.add('guest');
  h.speaking.emit('start', 'guest');
  const old = h.streams.get('guest')!; old.write(packet());
  h.connection.state.status = VoiceConnectionStatus.Disconnected;
  h.connection.emit('stateChange', {}, h.connection.state);
  old.emit('data', packet()); old.emit('end');
  expect(h.delivered).toHaveLength(0);
  h.connection.state.status = VoiceConnectionStatus.Ready;
  h.speaking.emit('start', 'guest'); h.streams.get('guest')!.write(packet());
  h.streams.get('guest')!.end(); await vi.advanceTimersByTimeAsync(0);
  expect(h.delivered).toHaveLength(1);
  expect(h.delivered[0]!.timing.captureId).toMatch(/:2$/);
  h.receiver.stop();
});
