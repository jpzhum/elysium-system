import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test, vi } from 'vitest';
import OpusScript from 'opusscript';
import { AudioPlayerError, AudioPlayerStatus, createAudioPlayer, type AudioPlayer, type PlayerSubscription,
  type VoiceConnection } from '@discordjs/voice';
import { PlaybackQueue, playbackFailureFields } from '../src/audio/playback.js';
import { OpusDecoder } from '../src/audio/opus-decoder.js';
import type { DiagnosticFields } from '../src/observability/metrics.js';

function setup() {
  const player = createAudioPlayer();
  const metrics: Record<string, number> = {};
  const state = { status: 'ready', subscription: undefined as PlayerSubscription | undefined };
  const connection = Object.assign(new EventEmitter(), { state,
    setSpeaking: () => undefined, onSubscriptionRemoved: () => undefined,
    prepareAudioPacket: () => undefined, dispatchAudio: () => undefined,
    subscribe: (actual: AudioPlayer) => {
      state.subscription = Reflect.get(actual, 'subscribe').call(actual, connection) as PlayerSubscription;
      return state.subscription;
    } });
  const queue = new PlaybackQueue(connection as unknown as VoiceConnection, { player,
    onMetric: (name, value) => { metrics[name] = (metrics[name] ?? 0) + value; } });
  return { queue, player, connection, metrics };
}

test('player start exception is preserved instead of becoming cancellation', async () => {
  const { queue, player, metrics } = setup();
  const events: DiagnosticFields[] = [];
  const play = player.play.bind(player);
  vi.spyOn(player, 'play').mockImplementationOnce(resource => {
    resource.playStream.destroy();
    play(resource); // The pinned real player throws for this ended resource.
  });
  const stream = queue.startStream('a', 16_000, false, { onDiagnostic: fields => { events.push(fields); } });
  let failure: unknown;
  try {
    await assert.rejects(stream.write(Buffer.alloc(640)), (error: Error) => {
      assert.doesNotMatch(error.message, /cancelada/);
      failure = error;
      assert.equal(playbackFailureFields(error).code, 'PLAYBACK_RESOURCE_ENDED');
      return true;
    });
    await assert.rejects(stream.done, error => error === failure);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.playback_stage, 'player_start');
    assert.equal(events[0]!.resource_ended, true);
    assert.equal(events[0]!.subscribed, true);
    assert.equal(metrics.playback_failed, 1);
    assert.equal(metrics.playback_cancelled, undefined);
  } finally { queue.stop(); }
});

test('real AudioPlayer stream error cannot be attributed to the next queued resource', async () => {
  const { queue, player, metrics } = setup();
  const first = queue.startStream('a', 16_000, false);
  const next = queue.startStream('b', 16_000, false);
  await first.write(Buffer.alloc(640));
  await next.write(Buffer.alloc(640));
  const old = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
  assert.ok(old);
  old.playStream.emit('error', new Error('PRIVATE signed-url'));
  await assert.rejects(first.done);
  await tick();
  try {
    assert.equal(queue.isPlaying, true);
    assert.notEqual(player.state.status, AudioPlayerStatus.Idle);
    assert.equal(metrics.playback_failed, 1);
  } finally {
    queue.stop();
    await assert.rejects(next.done);
  }
});

test('encoder exception keeps its reviewed Opus code and stage, without upstream content', async () => {
  const { queue, metrics } = setup();
  const events: DiagnosticFields[] = [];
  const encoder = vi.spyOn(OpusScript.prototype, 'encode').mockImplementationOnce(() => {
    throw new Error('Encode error: Internal error');
  });
  const stream = queue.startStream('PRIVATE_DISCORD_ID', 16_000, false, {
    onDiagnostic: fields => { events.push(fields); },
  });
  try {
    await stream.write(Buffer.alloc(1_280));
    await assert.rejects(stream.done, error => {
      const fields = playbackFailureFields(error);
      assert.equal(fields.code, 'PLAYBACK_ENCODER_FAILED');
      assert.equal(fields.opus_error_code, -3);
      assert.equal(fields.playback_stage, 'opus_encode');
      return true;
    });
    const errors = events.filter(fields => fields.code);
    assert.equal(errors.length, 1);
    const totals = events.filter(fields => fields.opus_encode_ms !== undefined);
    assert.equal(totals.length, 1);
    assert.equal(totals[0]!.playback_stage, 'opus_encode');
    assert.equal(totals[0]!.code, undefined);
    assert.equal(totals[0]!.opus_encode_ms, metrics.opus_encode_ms);
    assert.ok(Number.isFinite(totals[0]!.opus_encode_ms) && totals[0]!.opus_encode_ms! >= 0);
    assert.equal(errors[0]!.voice_status, 'ready');
    assert.equal(errors[0]!.subscribed, true);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|Internal error/);
    assert.equal(metrics.playback_failed, 1);
    assert.equal(metrics.playback_completed, undefined);
  } finally { encoder.mockRestore(); queue.stop(); }
});

test('AudioPlayer errors identify the real resource and state, and ignore stale errors', async () => {
  const { queue, player } = setup();
  const events: DiagnosticFields[] = [];
  const stream = queue.startStream('a', 16_000, false, { onDiagnostic: fields => { events.push(fields); } });
  await stream.write(Buffer.alloc(1_280));
  const resource = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
  assert.ok(resource);
  player.emit('error', new AudioPlayerError(new Error('PRIVATE signed-url transcript'), resource));
  await assert.rejects(stream.done, error => {
    const fields = playbackFailureFields(error);
    assert.equal(fields.code, 'PLAYBACK_PLAYER_ERROR');
    assert.equal(fields.playback_stage, 'player');
    assert.equal(fields.cause_name, 'AudioPlayerError');
    return true;
  });
  const next = queue.startStream('b', 16_000, false);
  try {
    await next.write(Buffer.alloc(1_280));
    player.emit('error', new AudioPlayerError(new Error('PRIVATE late-error'), resource));
    assert.equal(queue.isPlaying, true);
    assert.equal(events.filter(fields => fields.code).length, 1);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|signed-url|transcript/);
  } finally { queue.stop(); await assert.rejects(next.done); }
});

test('connection loss reports actual voice status and cancels active and queued resources once', async () => {
  for (const status of ['disconnected', 'destroyed']) {
    const { queue, player, connection, metrics } = setup();
    const events: DiagnosticFields[] = [];
    const first = queue.startStream('a', 16_000, false, { onDiagnostic: fields => { events.push(fields); } });
    const next = queue.startStream('b', 16_000, false);
    await first.write(Buffer.alloc(1_280));
    await next.write(Buffer.alloc(1_280));
    const before = { ...connection.state };
    connection.state.status = status;
    connection.emit('stateChange', before, connection.state);
    await assert.rejects(first.done);
    await assert.rejects(next.done);
    const errors = events.filter(fields => fields.code);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.code, status === 'disconnected' ? 'VOICE_DISCONNECTED' : 'VOICE_DESTROYED');
    assert.equal(errors[0]!.voice_status, status);
    assert.equal(errors[0]!.playback_stage, 'connection');
    assert.equal(player.state.status, AudioPlayerStatus.Idle);
    assert.equal(metrics.playback_cancelled, 2);
    assert.equal(metrics.audio_stream_buffer_bytes, 0);
    queue.stop();
  }
});

test('initial disconnected connection fails immediately even without a new stateChange', () => {
  const player = createAudioPlayer();
  const events: DiagnosticFields[] = [];
  const connection = Object.assign(new EventEmitter(), { state: { status: 'disconnected' },
    subscribe: () => ({ unsubscribe: () => undefined }) });
  const queue = new PlaybackQueue(connection as unknown as VoiceConnection, { player });
  try {
    assert.throws(() => queue.startStream('a', 16_000, false, { onDiagnostic: fields => { events.push(fields); } }), error => {
      assert.equal(playbackFailureFields(error).code, 'VOICE_DISCONNECTED');
      return true;
    });
    assert.equal(queue.isPlaying, false);
    assert.equal(events[0]!.voice_status, 'disconnected');
  } finally { queue.stop(); }
});

test.each(['signalling', 'connecting'])('transport %s suspends playback even without a Disconnected event', async status => {
  const { queue, player, connection, metrics } = setup();
  const events: DiagnosticFields[] = [];
  const first = queue.startStream('a', 16_000, false, { onDiagnostic: fields => { events.push(fields); } });
  const waiting = queue.startStream('b', 16_000, false);
  await first.write(Buffer.alloc(1_280));
  await waiting.write(Buffer.alloc(1_280));
  const old = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
  assert.ok(old);
  const before = { ...connection.state };
  connection.state.status = status;
  connection.emit('stateChange', before, connection.state);
  try {
    assert.equal(player.state.status, AudioPlayerStatus.Idle);
    await assert.rejects(first.done);
    await assert.rejects(waiting.done);
    assert.equal(metrics.playback_cancelled, 2);
    assert.equal(metrics.audio_stream_buffer_bytes, 0);
    assert.equal(queue.isPlaying, false);
    assert.equal(events.filter(fields => fields.code === 'VOICE_NOT_READY').length, 1);
    assert.throws(() => queue.startStream('c', 16_000, false), error => {
      assert.equal(playbackFailureFields(error).code, 'VOICE_NOT_READY');
      return true;
    });
    connection.state.status = 'ready';
    connection.emit('stateChange', { status }, connection.state);
    const recovered = queue.startStream('c', 16_000, false);
    await recovered.write(Buffer.alloc(1_280));
    old.playStream.emit('error', new Error('PRIVATE old response'));
    await tick();
    assert.equal(queue.isPlaying, true);
    assert.equal(metrics.playback_started, 2); // Only A and the newly requested C; never replay A/B.
    recovered.cancel();
    await assert.rejects(recovered.done);
  } finally { queue.stop(); }
});

test('cancelling an encoder waiting for more PCM disposes it exactly once', async () => {
  const { queue } = setup();
  const disposal = vi.spyOn(OpusScript.prototype, 'delete');
  const encoding = vi.spyOn(OpusScript.prototype, 'encode');
  const stream = queue.startStream('a', 16_000, false);
  try {
    await stream.write(Buffer.alloc(1_280));
    await tick();
    stream.cancel();
    await assert.rejects(stream.done);
    await tick();
    const count = encoding.mock.calls.length;
    assert.equal(disposal.mock.calls.length, 1);
    queue.stop();
    await tick();
    assert.equal(disposal.mock.calls.length, 1);
    assert.equal(encoding.mock.calls.length, count);
  } finally { queue.stop(); disposal.mockRestore(); encoding.mockRestore(); }
});

test('playback diagnostics preserve unready DAVE independently of a ready connection', async () => {
  const { queue, player, connection } = setup();
  Object.assign(connection.state, { networking: { state: { code: 4,
    dave: { protocolVersion: 1, session: { ready: false } } } } });
  vi.spyOn(player, 'play').mockImplementationOnce(() => { throw new Error('PRIVATE provider-data'); });
  const stream = queue.startStream('a', 16_000, false);
  try {
    await assert.rejects(stream.write(Buffer.alloc(640)), error => {
      const fields = playbackFailureFields(error);
      assert.equal(fields.voice_status, 'ready');
      assert.equal(fields.network_status, 4);
      assert.equal(fields.dave_protocol_version, 1);
      assert.equal(fields.dave_ready, false);
      assert.doesNotMatch(JSON.stringify(fields), /PRIVATE|provider-data/);
      return true;
    });
    await assert.rejects(stream.done);
  } finally { queue.stop(); }
});

test('local playback readiness requires its current subscription and reports DAVE separately from Ready', () => {
  const { queue, connection, metrics } = setup();
  assert.equal(queue.diagnosticState.available, true);
  assert.equal(queue.diagnosticState.player_status, AudioPlayerStatus.Idle);
  assert.equal(queue.diagnosticState.subscribed, true);
  const subscription = connection.state.subscription;
  connection.state.subscription = undefined;
  assert.equal(queue.diagnosticState.available, false);
  connection.state.subscription = subscription;
  Object.assign(connection.state, { networking: { state: { code: 4,
    dave: { protocolVersion: 1, session: { ready: false } } } } });
  assert.equal(queue.diagnosticState.voice_status, 'ready');
  assert.equal(queue.diagnosticState.available, false);
  assert.equal(queue.diagnosticState.dave_ready, false);
  assert.equal(metrics.playback_started, undefined);
  assert.equal(metrics.playback_completed, undefined);
  queue.stop();
  assert.equal(queue.diagnosticState.available, false);
  assert.equal(queue.diagnosticState.stopped, true);
});

test('a 33884-byte PCM16 mono chunk at 16 kHz encodes into 53 valid Discord packets', async () => {
  const { queue, player, metrics } = setup();
  const decoder = new OpusDecoder();
  const stream = queue.startStream('a', 16_000, false);
  try {
    await stream.write(Buffer.alloc(33_884));
    stream.end();
    const resource = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
    assert.ok(resource);
    let packets = 0;
    for await (const value of resource.playStream) {
      assert.ok(Buffer.isBuffer(value));
      assert.equal(decoder.decode(value as Buffer).length, 960 * 2 * 2);
      packets++;
    }
    player.stop(true);
    await stream.done;
    assert.equal(packets, 53);
    assert.equal(metrics.playback_completed, 1);
    assert.equal(metrics.playback_failed, undefined);
    assert.equal(metrics.audio_stream_buffer_bytes, 0);
  } finally { decoder.delete(); queue.stop(); }
});

test('Opus CPU totals stay with each resource and are emitted once without claiming audibility', async () => {
  const { queue, player, metrics } = setup();
  const observed: DiagnosticFields[][] = [[], []];
  try {
    const untouched = queue.startStream('cancelled-in-queue', 16_000, false, {
      onDiagnostic: fields => { observed[0]!.push(fields); },
    });
    untouched.cancel();
    await assert.rejects(untouched.done);
    assert.equal(observed[0]!.length, 0); // No attempted frame means no fabricated zero-time sample.
    for (let index = 0; index < 2; index++) {
      const stream = queue.startStream(`speaker-${index}`, 16_000, false, {
        onDiagnostic: fields => { observed[index]!.push(fields); },
      });
      await stream.write(Buffer.alloc(1_280));
      stream.end();
      const resource = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
      assert.ok(resource);
      for await (const value of resource.playStream) assert.ok(Buffer.isBuffer(value));
      player.stop(true);
      await stream.done;
      stream.cancel(); stream.end(); // Repeated termination cannot emit another subtotal.
      await tick();
      const totals = observed[index]!.filter(fields => fields.opus_encode_ms !== undefined);
      assert.equal(totals.length, 1);
      assert.equal(totals[0]!.playback_stage, 'opus_encode');
      assert.equal(totals[0]!.code, undefined);
      assert.equal(totals[0]!.playback_drained, undefined);
      assert.ok(Number.isFinite(totals[0]!.opus_encode_ms) && totals[0]!.opus_encode_ms! >= 0);
    }
    const total = observed.flat().reduce((sum, fields) => sum + (fields.opus_encode_ms ?? 0), 0);
    assert.ok(Math.abs(total - metrics.opus_encode_ms!) < 1e-6);
    assert.equal(metrics.playback_completed, 2);
  } finally { queue.stop(); }
});
