import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { AudioPlayerStatus, type AudioPlayer, type AudioResource, type VoiceConnection } from '@discordjs/voice';
import { test, vi } from 'vitest';
import { PlaybackQueue, type PlaybackOptions } from '../src/audio/playback.js';
import { StreamingPcm } from '../src/audio/streaming-pcm.js';
import { OpusDecoder } from '../src/audio/opus-decoder.js';
import { convertPcm } from '../src/audio/pcm-conversion.js';
import { rms } from '../src/audio/voice-activity.js';

class Player extends EventEmitter {
  resources: AudioResource[] = [];
  current: AudioResource | undefined;
  play(resource: AudioResource): void { this.current = resource; this.resources.push(resource); }
  stop(): boolean { this.current = undefined; this.emit(AudioPlayerStatus.Idle); return true; }
}

function setup(options: PlaybackOptions = {}) {
  const player = new Player();
  const metrics: Record<string, number> = {};
  const connection = Object.assign(new EventEmitter(), { subscribe: () => ({ unsubscribe: () => undefined }) });
  const queue = new PlaybackQueue(connection as unknown as VoiceConnection, {
    ...options, player: player as unknown as AudioPlayer,
    onMetric: (name, value) => { metrics[name] = (metrics[name] ?? 0) + value; },
  });
  return { queue, player, connection, metrics };
}

function tone(samples: number, rate = 16_000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let sample = 0; sample < samples; sample++) {
    pcm.writeInt16LE(Math.round(20_000 * Math.sin(2 * Math.PI * 440 * sample / rate)), sample * 2);
  }
  return pcm;
}

async function packet(resource: AudioResource): Promise<Buffer> {
  while (true) {
    const value = resource.playStream.read() as Buffer | null;
    if (value) return value;
    await once(resource.playStream, 'readable');
  }
}

async function drain(player: Player): Promise<Buffer[]> {
  const resource = player.current!;
  const packets: Buffer[] = [];
  for await (const value of resource.playStream) packets.push(Buffer.from(value as Buffer));
  if (player.current === resource) player.stop();
  return packets;
}

test('progressive PCM plays real Opus before ingress ends, without a completion event', async () => {
  const { queue, player, metrics } = setup();
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(1_600));
  const resource = player.current!;
  const first = await packet(resource);
  const decoder = new OpusDecoder();
  try { assert.ok(rms(decoder.decode(first)) > 0.05); }
  finally { decoder.delete(); }
  let settled = false;
  void stream.done.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(metrics.playback_started, 1);
  stream.end();
  const remaining = await drain(player);
  assert.equal(remaining.length + 1, 5);
  await stream.done;
  assert.equal(metrics.playback_completed, 1);
  assert.equal(metrics.audio_chunks_played, 1);
  assert.equal(metrics.audio_stream_buffer_bytes, 0);
  queue.stop();
});

test('continuous resampling matches one complete conversion across arbitrary 22050/44100 Hz chunks', async () => {
  for (const rate of [8_000, 16_000, 22_050, 24_000, 44_100, 48_000, 96_000, 192_000]) {
    const pcm = tone(4_001, rate);
    const source = new StreamingPcm(rate, { maxBufferBytes: 64_000, maxSeconds: 120 });
    for (let offset = 0; offset < pcm.length; offset += 34) await source.write(pcm.subarray(offset, offset + 34), () => true);
    source.end();
    const frames: Buffer[] = [];
    for await (const frame of source.frames()) frames.push(Buffer.from(frame));
    const expected = convertPcm(pcm, rate, 1, 48_000, 2);
    const output = Buffer.concat(frames);
    assert.deepEqual(output.subarray(0, expected.length), expected, `rate ${rate}`);
    assert.ok(output.subarray(expected.length).every((byte) => byte === 0));
    assert.equal(source.bufferedBytes, 0);
  }
});

test('a sub-frame waits for ingress end; generation gaps never end the stream', async () => {
  const { queue, player } = setup();
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(80));
  const getting = packet(player.current!);
  let received = false;
  void getting.then(() => { received = true; });
  await tick();
  assert.equal(received, false);
  await stream.write(tone(80));
  await tick();
  assert.equal(received, false);
  stream.end();
  const encoded = await getting;
  assert.ok(encoded.length > 0);
  assert.deepEqual(await drain(player), []);
  await stream.done;
  queue.stop();
});

test('owner advances waiting guests while active participant is never interrupted', async () => {
  const { queue, player } = setup();
  const first = queue.startStream('guest1', 16_000, false);
  const second = queue.startStream('guest2', 16_000, false);
  await first.write(tone(320)); first.end();
  await second.write(tone(640)); second.end();
  const owner = queue.startStream('owner', 16_000, true);
  await owner.write(tone(960)); owner.end();
  assert.equal(player.resources.length, 1);
  assert.equal((await drain(player)).length, 1);
  await first.done;
  assert.equal((await drain(player)).length, 3);
  await owner.done;
  assert.equal((await drain(player)).length, 2);
  await second.done;
  assert.equal(queue.isPlaying, false);
  queue.stop();
});

test('revocation fences prefetched packets immediately and leaves another participant intact', async () => {
  const { queue, player, metrics } = setup();
  let allowed = true;
  const first = queue.startStream('revoked', 16_000, false, { isAllowed: () => allowed });
  const next = queue.startStream('allowed', 16_000, false);
  await first.write(tone(3_200));
  await next.write(tone(320)); next.end();
  await packet(player.current!);
  await tick();
  const old = player.current!;
  allowed = false;
  assert.equal(old.playStream.read(), null);
  await assert.rejects(first.done, /cancelada/);
  assert.equal(player.resources.length, 2);
  await drain(player);
  await next.done;
  assert.equal(metrics.audio_stream_buffer_bytes, 0);
  queue.stop();
});

test('backpressure bounds owned memory and cancellation rejects a pending write', async () => {
  const { queue, metrics } = setup({ maxBufferBytes: 1_024 });
  const blocker = queue.startStream('blocker', 16_000, false);
  await blocker.write(tone(320));
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(512));
  let accepted = false;
  const pending = stream.write(tone(512)).then(() => { accepted = true; });
  const rejected = assert.rejects(pending, /cancelada/);
  await tick();
  assert.equal(accepted, false);
  assert.ok(metrics.audio_stream_buffer_bytes! <= 1_024 + 640);
  stream.cancel();
  await rejected;
  await assert.rejects(stream.done, /cancelada/);
  assert.ok(metrics.audio_stream_buffer_bytes! > 0 && metrics.audio_stream_buffer_bytes! <= 640);
  queue.stop();
  await assert.rejects(blocker.done, /cancelada/);
  assert.equal(metrics.audio_stream_buffer_bytes, 0);
});

test('full-sized writes make forward progress under consumption without a lookahead deadlock', async () => {
  const { queue, player, metrics } = setup({ maxBufferBytes: 1_024 });
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(512));
  const draining = drain(player);
  for (let chunk = 0; chunk < 12; chunk++) await stream.write(tone(512));
  stream.end();
  assert.equal((await draining).length, Math.ceil(13 * 512 / 320));
  await stream.done;
  assert.equal(metrics.audio_stream_buffer_bytes, 0);
  assert.equal(metrics.audio_chunks_played, 13);
  queue.stop();
});

test('invalid chunks, simultaneous pending writes, duration and queue limits fail safely', async () => {
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(1_026)]) {
    const { queue } = setup({ maxBufferBytes: 1_024 });
    const stream = queue.startStream('a', 16_000, false);
    await assert.rejects(stream.write(invalid), /inválido|memória/);
    await assert.rejects(stream.done);
    queue.stop();
  }
  const { queue } = setup({ maxSeconds: 1, maxQueue: 1 });
  const stream = queue.startStream('a', 16_000, false);
  assert.throws(() => queue.startStream('b', 16_000, false), /cheia/);
  await assert.rejects(stream.write(tone(16_001)), /duração/);
  await assert.rejects(stream.done, /duração/);
  queue.stop();
  assert.throws(() => queue.startStream('c', 16_000, false), /encerrada/);

  const bounded = setup({ maxBufferBytes: 1_024 });
  const sending = bounded.queue.startStream('a', 16_000, false);
  await sending.write(tone(512));
  const waiting = sending.write(tone(512));
  const rejected = assert.rejects(waiting);
  await assert.rejects(sending.write(tone(1)), /simultâneo/);
  await rejected;
  await assert.rejects(sending.done);
  bounded.queue.stop();
});

test('absolute deadline is failure, never generation or playback success', async () => {
  const { queue, metrics } = setup({ maxWallMs: 10 });
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(320));
  await assert.rejects(stream.done, /prazo/);
  assert.equal(metrics.playback_completed, undefined);
  assert.equal(metrics.playback_failed, 1);
  assert.equal(metrics.audio_stream_buffer_bytes, 0);
  queue.stop();
});

test('pre-start validation counts each failure or cancellation once without fabricating a started stream', async () => {
  const { queue, metrics } = setup({ maxSeconds: 1, maxQueue: 1 });
  assert.throws(() => queue.startStream('a', 7_999, false), /inválido/);
  assert.equal(metrics.playback_failed, 1);
  await assert.rejects(queue.play('a', Buffer.alloc(0), 16_000, false), /inválido/);
  await assert.rejects(queue.play('a', Buffer.alloc(3), 16_000, false), /inválido/);
  await assert.rejects(queue.play('a', tone(16_001), 16_000, false), /duração/);
  assert.equal(metrics.playback_failed, 4);
  const reserved = queue.startStream('a', 16_000, false);
  assert.throws(() => queue.startStream('b', 16_000, false), /cheia/);
  assert.equal(metrics.playback_failed, 5);
  reserved.cancel();
  await assert.rejects(reserved.done, /cancelada/);
  assert.equal(metrics.playback_cancelled, 1);
  queue.stop();
  await assert.rejects(queue.play('c', tone(320), 16_000, false), /encerrada/);
  assert.equal(metrics.playback_cancelled, 2);
  assert.equal(metrics.playback_failed, 5);
  assert.equal(metrics.playback_started, undefined);

  const disconnected = setup();
  disconnected.connection.emit('stateChange', {}, { status: 'disconnected' });
  assert.throws(() => disconnected.queue.startStream('a', 16_000, false), /indisponível/);
  assert.equal(disconnected.metrics.playback_cancelled, 1);
  assert.equal(disconnected.metrics.playback_failed, undefined);
  disconnected.queue.stop();
});

test('disconnect and destroyed calls reject active and queued streams', async () => {
  for (const status of ['disconnected', 'destroyed']) {
    const { queue, connection, metrics } = setup();
    const first = queue.startStream('a', 16_000, false);
    const second = queue.startStream('b', 16_000, false);
    await first.write(tone(320));
    await second.write(tone(320));
    connection.emit('stateChange', {}, { status });
    await assert.rejects(first.done, /cancelada/);
    await assert.rejects(second.done, /cancelada/);
    assert.equal(metrics.audio_stream_buffer_bytes, 0);
    assert.equal(queue.isPlaying, false);
    if (status === 'disconnected') {
      assert.throws(() => queue.startStream('c', 16_000, false), /indisponível/);
      connection.emit('stateChange', {}, { status: 'ready' });
      const reconnected = queue.startStream('c', 16_000, false);
      reconnected.cancel();
      await assert.rejects(reconnected.done, /cancelada/);
      queue.stop();
    }
  }
});

test('sanitized resource errors and late errors cannot cancel the next participant', async () => {
  const { queue, player } = setup();
  const first = queue.startStream('a', 16_000, false);
  await first.write(tone(320));
  const old = player.current!;
  const next = queue.startStream('b', 16_000, false);
  await next.write(tone(320)); next.end();
  player.emit('error', { message: 'PRIVATE signed-url', resource: old });
  await assert.rejects(first.done, (error: Error) => {
    assert.match(error.message, /Falha/); assert.doesNotMatch(error.message, /PRIVATE|signed-url/); return true;
  });
  old.playStream.emit('error', new Error('PRIVATE'));
  player.emit('error', { resource: old });
  assert.equal(queue.isPlaying, true);
  await drain(player);
  await next.done;
  queue.stop();
});

test('unexpected Idle before ingress ends is not reported as completed playback', async () => {
  const { queue, player, metrics } = setup();
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(320));
  player.stop();
  await assert.rejects(stream.done, /antes/);
  assert.equal(metrics.playback_completed, undefined);
  queue.stop();
});

test('legacy play remains available for tone', async () => {
  const { queue, player } = setup();
  const done = queue.play('a', tone(320), 16_000, false);
  await tick();
  assert.equal((await drain(player)).length, 1);
  await done;
  queue.stop();
});

test('real voice player survives more than five missing frames and resumes the same stream', async () => {
  let player!: AudioPlayer;
  const packets: Buffer[] = [];
  const connection = Object.assign(new EventEmitter(), {
    state: { status: 'ready' },
    setSpeaking: () => undefined,
    prepareAudioPacket: (value: Buffer) => { packets.push(Buffer.from(value)); },
    dispatchAudio: () => undefined,
    onSubscriptionRemoved: () => undefined,
    subscribe: (actual: AudioPlayer) => {
      player = actual;
      // Isolate Discord networking while exercising the pinned voice package's
      // real player and packet cadence, including its starvation behavior.
      return Reflect.get(actual, 'subscribe').call(actual, connection);
    },
  });
  const queue = new PlaybackQueue(connection as unknown as VoiceConnection);
  assert.equal(Reflect.get(player, 'behaviors').maxMissedFrames, Number.MAX_SAFE_INTEGER);
  const stream = queue.startStream('a', 16_000, false);
  await stream.write(tone(640));
  await tick();
  const step = () => {
    if (Reflect.get(player, 'checkPlayable').call(player)) Reflect.get(player, '_stepPrepare').call(player);
  };
  for (let frame = 0; frame < 20; frame++) { step(); await tick(); }
  assert.equal(player.state.status, AudioPlayerStatus.Playing);
  assert.equal(queue.isPlaying, true);
  assert.ok(packets.some(value => value.length > 3));
  const beforeResume = packets.filter(value => value.length > 3).length;
  await stream.write(tone(640)); stream.end();
  for (let frame = 0; frame < 30 && queue.isPlaying; frame++) { step(); await tick(); }
  await stream.done;
  assert.ok(packets.filter(value => value.length > 3).length > beforeResume);
  assert.equal(player.state.status, AudioPlayerStatus.Idle);
  queue.stop();
});

test('open-stream local drain reopens listening without inventing EOF, then resumes on new PCM', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const observations: string[] = [];
  const { queue, player } = setup();
  try {
    const stream = queue.startStream('a', 16_000, false, {
      onProgress: event => { observations.push(event); },
    });
    const token = queue.currentStreamToken;
    await stream.write(tone(1_600));
    const resource = player.current!;
    for (let i = 0; i < 4; i++) await packet(resource);
    for (let i = 0; i < 4; i++) { resource.playStream.read(); await tick(); }
    await vi.advanceTimersByTimeAsync(249);
    assert.deepEqual(observations, ['first_packet']);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(observations, ['first_packet', 'drained']);
    assert.equal(queue.isAudible, false);
    assert.equal(queue.isPlaying, true);
    let done = false; void stream.done.then(() => { done = true; });
    await tick(); assert.equal(done, false);
    assert.ok(token === undefined); // Streams obtain their identity after the first accepted write.
    const activeToken = queue.currentStreamToken;
    assert.equal(typeof activeToken, 'number');
    await stream.write(tone(640));
    assert.equal(queue.isAudible, true);
    assert.equal(queue.currentStreamToken, activeToken);
    assert.deepEqual(observations, ['first_packet', 'drained', 'resumed']);
    await packet(resource);
    stream.end(); await drain(player); await stream.done;
    assert.equal(queue.currentStreamToken, undefined);
    const next = queue.startStream('a', 16_000, false);
    await next.write(tone(640));
    assert.notEqual(queue.currentStreamToken, activeToken);
    next.cancel(); await assert.rejects(next.done);
  } finally { queue.stop(); vi.useRealTimers(); }
});
