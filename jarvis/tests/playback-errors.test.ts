import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test, vi } from 'vitest';
import OpusScript from 'opusscript';
import { AudioPlayerError, AudioPlayerStatus, createAudioPlayer, type AudioPlayer, type PlayerSubscription,
  type VoiceConnection, type AudioResource } from '@discordjs/voice';
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
    const errors = events.filter(fields => fields.code);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.playback_stage, 'player_start');
    assert.equal(errors[0]!.resource_ended, true);
    assert.equal(errors[0]!.subscribed, true);
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

test('Ready recovery restores a removed subscription before the next resource is played', async () => {
  const { queue, player, connection } = setup();
  const previous = connection.state.subscription;
  assert.ok(previous);
  previous.unsubscribe();
  connection.state.subscription = undefined;
  connection.state.status = 'connecting';
  connection.emit('stateChange', { status: 'ready' }, connection.state);
  connection.state.status = 'ready';
  connection.emit('stateChange', { status: 'connecting' }, connection.state);
  try {
    assert.notEqual(connection.state.subscription, previous);
    assert.equal((connection.state.subscription as PlayerSubscription | undefined)?.player, player);
    assert.equal(queue.diagnosticState.available, true);
    const stream = queue.startStream('a', 16_000, false);
    await stream.write(Buffer.alloc(1_280)); stream.end();
    await tick();
    for (let frame = 0; queue.isPlaying && frame < 30; frame++) {
      if (Reflect.get(player, 'checkPlayable').call(player)) Reflect.get(player, '_stepPrepare').call(player);
      await tick();
    }
    await stream.done;
    assert.equal(player.state.status, AudioPlayerStatus.Idle);
  } finally { queue.stop(); }
});

test('a subscription removed while Ready is repaired before accepting new PCM', async () => {
  const { queue, player, connection } = setup();
  const previous = connection.state.subscription;
  assert.ok(previous);
  previous.unsubscribe();
  connection.state.subscription = undefined;
  const stream = queue.startStream('a', 16_000, false);
  try {
    assert.equal((connection.state.subscription as PlayerSubscription | undefined)?.player, player);
    assert.notEqual(connection.state.subscription, previous);
    assert.equal(queue.diagnosticState.available, true);
    stream.cancel();
    await assert.rejects(stream.done);
  } finally { queue.stop(); }
});

test('a stale own subscription pointer is checked against the real player receiver registry', async () => {
  const { queue, player, connection } = setup();
  const previous = connection.state.subscription;
  assert.ok(previous);
  Reflect.get(player, 'unsubscribe').call(player, previous);
  assert.equal(connection.state.subscription, previous);
  assert.deepEqual(player.playable, []);
  try {
    assert.equal(queue.diagnosticState.available, false);
    const stream = queue.startStream('a', 16_000, false);
    assert.notEqual(connection.state.subscription, previous);
    assert.deepEqual(player.playable, [connection]);
    assert.equal(queue.diagnosticState.available, true);
    stream.cancel();
    await assert.rejects(stream.done);
  } finally { queue.stop(); }
});

test('an existing subscription to another player is rejected without replacing it', () => {
  const { queue, connection, metrics } = setup();
  const previous = connection.state.subscription;
  assert.ok(previous);
  previous.unsubscribe();
  const foreign = createAudioPlayer();
  const current = Reflect.get(foreign, 'subscribe').call(foreign, connection) as PlayerSubscription;
  connection.state.subscription = current;
  const subscribe = vi.spyOn(connection, 'subscribe');
  const diagnostics: DiagnosticFields[] = [];
  try {
    assert.throws(() => queue.startStream('a', 16_000, false, {
      onDiagnostic: fields => { diagnostics.push(fields); },
    }), error => {
      const fields = playbackFailureFields(error);
      assert.equal(fields.code, 'PLAYBACK_SUBSCRIBE_FAILED');
      assert.equal(fields.playback_stage, 'subscribe');
      assert.equal(fields.subscribed, false);
      return true;
    });
    assert.equal(subscribe.mock.calls.length, 0);
    assert.equal(connection.state.subscription, current);
    assert.equal(diagnostics.length, 1);
    assert.equal(metrics.playback_failed, 1);
    assert.equal(metrics.playback_started, undefined);
    assert.equal(queue.isPlaying, false);
  } finally { queue.stop(); current.unsubscribe(); }
});

test('a stopped finished encoder with unread packets cannot report successful playback', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { queue, player, metrics } = setup();
  const progress: string[] = [];
  const diagnostics: DiagnosticFields[] = [];
  const prepare = Reflect.get(player, '_stepPrepare');
  Reflect.set(player, '_stepPrepare', () => undefined);
  const stream = queue.startStream('a', 16_000, false, {
    onProgress: event => { progress.push(event); }, onDiagnostic: fields => { diagnostics.push(fields); },
  });
  try {
    await stream.write(Buffer.alloc(640)); stream.end();
    const resource = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
    assert.ok(resource);
    for (let turn = 0; turn < 10 && !resource.started; turn++) await tick();
    assert.equal(resource.playStream.readableLength, 1);
    assert.equal(resource.playbackDuration, 0);
    assert.deepEqual(progress, []); // Readability/prefetch does not count as resource consumption.
    player.stop(true);
    await assert.rejects(stream.done, error => playbackFailureFields(error).code === 'PLAYBACK_PREMATURE_IDLE');
    assert.deepEqual(progress, []);
    assert.equal(diagnostics.filter(fields => fields.playback_event === 'packet_read').length, 0);
    const settled = diagnostics.find(fields => fields.playback_event === 'settled');
    assert.equal(settled?.encoded_packets, 1);
    assert.equal(settled.consumed_packets, 0);
    assert.equal(settled.stream_destroyed, true);
    assert.equal(metrics.playback_completed, undefined);
    assert.equal(metrics.playback_failed, 1);
  } finally { queue.stop(); Reflect.set(player, '_stepPrepare', prepare); vi.useRealTimers(); }
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
    assert.equal(observed[0]!.filter(fields => fields.opus_encode_ms !== undefined).length, 0);
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

test('one real AudioPlayer and PlaybackQueue survive twenty responses with a fourth-turn stream failure', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const scheduled = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  const { queue, player, connection, metrics } = setup();
  const decoder = new OpusDecoder();
  const disposal = vi.spyOn(OpusScript.prototype, 'delete');
  const subscription = connection.state.subscription;
  const listenerCounts = player.eventNames().map(name => [name, player.listenerCount(name)] as const);
  const voiceListeners = connection.listenerCount('stateChange');
  let packets = 0;
  let failedResource: AudioResource | undefined;
  Reflect.set(connection, 'prepareAudioPacket', (packet: Buffer) => {
    assert.equal(decoder.decode(packet).length, 960 * 4);
    if (packet.length > 3) packets++;
  });
  const pcm = Buffer.alloc(16_000 * 2 / 5);
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    pcm.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 440 * sample / 16_000)), sample * 2);
  }
  try {
    for (let turn = 1; turn <= 20; turn++) {
      let terminal = 0;
      const diagnostics: DiagnosticFields[] = [];
      const stream = queue.startStream(turn % 2 ? 'a' : 'b', 16_000, false, {
        onDiagnostic: fields => { diagnostics.push(fields); },
      });
      void stream.done.then(() => { terminal++; }, () => { terminal++; });
      await stream.write(pcm); stream.end();
      await tick();
      const before = packets;
      for (let frame = 0; queue.isPlaying && frame < 100; frame++) {
        // Exercise the pinned player's real resource reader and packet preparation;
        // only the Discord transport and wall-clock scheduler are controlled.
        if (Reflect.get(player, 'checkPlayable').call(player)) {
          Reflect.get(player, '_stepDispatch').call(player);
          Reflect.get(player, '_stepPrepare').call(player);
        }
        await tick();
        if (turn === 4 && frame === 2) {
          failedResource = player.state.status === AudioPlayerStatus.Idle ? undefined : player.state.resource;
          assert.ok(failedResource);
          failedResource.playStream.emit('error', new Error('PRIVATE simulated stream failure'));
        }
        if (turn === 5 && frame === 2) {
          assert.ok(failedResource);
          failedResource.playStream.emit('error', new Error('PRIVATE disposed stream'));
          player.emit('error', new AudioPlayerError(new Error('PRIVATE stale player error'), failedResource));
        }
      }
      assert.equal(queue.isPlaying, false, `turn ${turn} released within the bounded player steps`);
      if (turn === 4) await assert.rejects(stream.done);
      else await stream.done;
      await tick();
      // Allow the library's process-wide 20 ms scheduler to observe Idle too.
      // Resource deadlines must already be cancelled, rather than expiring here.
      await vi.advanceTimersByTimeAsync(20);
      await tick();
      assert.ok(packets > before, `turn ${turn} consumed valid Opus locally`);
      assert.equal(terminal, 1);
      assert.equal(queue.isPlaying, false);
      assert.equal(player.state.status, AudioPlayerStatus.Idle);
      assert.equal(connection.state.subscription, subscription);
      assert.equal(queue.diagnosticState.available, true);
      assert.equal(metrics.audio_stream_buffer_bytes, 0);
      assert.equal(disposal.mock.calls.length, turn);
      assert.deepEqual(player.eventNames().map(name => [name, player.listenerCount(name)] as const), listenerCounts);
      assert.equal(connection.listenerCount('stateChange'), voiceListeners);
      // The pinned library also owns a process-wide AudioPlayer scheduler. Its
      // pending setImmediate chain can overlap fake-clock boundaries; assert the
      // resource deadlines/drain debounce owned by this queue are all cleared.
      const clearedTimers = new Set(cleared.mock.calls.map(([timer]) => timer));
      const resourceTimers = scheduled.mock.calls.flatMap(([, delay], index) =>
        delay === 180_000 || delay === 250 ? [scheduled.mock.results[index]!.value] : []);
      assert.ok(resourceTimers.length >= turn);
      for (const timer of resourceTimers) assert.ok(clearedTimers.has(timer), `turn ${turn} cleared every resource timer`);
      assert.equal(diagnostics.filter(fields => fields.opus_encode_ms !== undefined).length, 1);
      assert.equal(diagnostics.filter(fields => fields.playback_event === 'stream_accepted').length, 1);
      assert.equal(diagnostics.filter(fields => fields.playback_event === 'subscribed').length, 1);
      assert.equal(diagnostics.filter(fields => fields.playback_event === 'pcm_accepted').length, 1);
      assert.equal(diagnostics.filter(fields => fields.playback_event === 'resource_created').length, 1);
      assert.equal(diagnostics.filter(fields => fields.playback_event === 'play_called').length, 1);
      assert.equal(diagnostics.filter(fields => fields.playback_event === 'packet_read').length, 1);
      const settled = diagnostics.filter(fields => fields.playback_event === 'settled');
      assert.equal(settled.length, 1);
      assert.equal(settled[0]!.stream_destroyed, true);
      assert.ok(settled[0]!.consumed_packets! > 0);
      assert.equal(settled[0]!.playback_token, turn);
      if (turn !== 4) assert.equal(settled[0]!.consumed_packets, settled[0]!.encoded_packets);
      assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
    }
    assert.equal(metrics.playback_started, 20);
    assert.equal(metrics.playback_completed, 19);
    assert.equal(metrics.playback_failed, 1);
  } finally {
    queue.stop();
    disposal.mockRestore();
    decoder.delete();
    scheduled.mockRestore();
    cleared.mockRestore();
    vi.useRealTimers();
  }
});
