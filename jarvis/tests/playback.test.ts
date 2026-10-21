import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AudioPlayerStatus, type AudioPlayer, type AudioResource, type VoiceConnection } from "@discordjs/voice";
import { test } from "vitest";
import { PlaybackQueue } from "../src/audio/playback.js";
import { OpusDecoder } from "../src/audio/opus-decoder.js";
import { rms } from "../src/audio/voice-activity.js";

class Player extends EventEmitter {
  resources: AudioResource[] = [];
  current: AudioResource | undefined;
  play(resource: AudioResource): void { this.current = resource; this.resources.push(resource); }
  stop(): boolean { this.current = undefined; this.emit(AudioPlayerStatus.Idle); return true; }
}

function setup(options: { maxQueue?: number; maxSeconds?: number } = {}) {
  const player = new Player();
  const connection = Object.assign(new EventEmitter(), {
    subscribe: () => ({ unsubscribe: () => undefined }),
  });
  const queue = new PlaybackQueue(connection as unknown as VoiceConnection, {
    ...options, player: player as unknown as AudioPlayer,
  });
  return { queue, player, connection };
}

test("one complete response remains active until Idle; owner waits then precedes guests", async () => {
  const { queue, player } = setup();
  const order: string[] = [];
  const pcm = Buffer.alloc(320);
  const first = queue.play("guest1", pcm, 16_000, false).then(() => order.push("guest1"));
  const second = queue.play("guest2", pcm, 16_000, false).then(() => order.push("guest2"));
  const owner = queue.play("owner", pcm, 16_000, true).then(() => order.push("owner"));
  assert.equal(player.resources.length, 1);
  assert.equal(queue.isPlaying, true);
  await Promise.resolve();
  assert.deepEqual(order, []);
  player.stop();
  await first;
  assert.deepEqual(order, ["guest1"]);
  assert.equal(player.resources.length, 2);
  player.stop();
  await owner;
  player.stop();
  await second;
  assert.deepEqual(order, ["guest1", "owner", "guest2"]);
  assert.equal(queue.isPlaying, false);
  queue.stop();
});

test("revocation cancels active/waiting responses without affecting other users", async () => {
  const { queue, player } = setup();
  const pcm = Buffer.alloc(320);
  const cancelled = queue.play("revoked", pcm, 16_000, false);
  const pending = queue.play("revoked", pcm, 16_000, false);
  const remaining = queue.play("allowed", pcm, 16_000, false);
  const rejected1 = assert.rejects(cancelled, /cancelada/);
  const rejected2 = assert.rejects(pending, /cancelada/);
  queue.stopUser("revoked");
  await Promise.all([rejected1, rejected2]);
  assert.equal(player.resources.length, 2);
  player.stop();
  await remaining;
  queue.stop();
});

test("queue and duration limits reject excess work; stop rejects all promises", async () => {
  const { queue } = setup({ maxQueue: 1, maxSeconds: 1 });
  await assert.rejects(queue.play("user", Buffer.alloc(32_002), 16_000, false), /duração/);
  const active = queue.play("user", Buffer.alloc(320), 16_000, false);
  const cancelled = assert.rejects(active, /cancelada/);
  await assert.rejects(queue.play("other", Buffer.alloc(320), 16_000, false), /cheia/);
  queue.stop();
  await cancelled;
  await assert.rejects(queue.play("other", Buffer.alloc(320), 16_000, false), /encerrada/);
});

test("resource errors are sanitized, rejected and permit later responses", async () => {
  const { queue, player } = setup();
  const active = queue.play("user", Buffer.alloc(320), 16_000, false);
  const rejected = assert.rejects(active, (error: Error) => {
    assert.match(error.message, /Falha/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  player.emit("error", { message: "PRIVATE", resource: player.current });
  await rejected;
  const next = queue.play("user", Buffer.alloc(320), 16_000, false);
  player.stop();
  await next;
  queue.stop();
});

test("connection destruction rejects pending output", async () => {
  const { queue, connection } = setup();
  const active = queue.play("user", Buffer.alloc(320), 16_000, false);
  const rejected = assert.rejects(active, /cancelada/);
  connection.emit("stateChange", {}, { status: "destroyed" });
  await rejected;
  assert.equal(queue.isPlaying, false);
});

test("playback emits actual Opus frames from negotiated PCM without FFmpeg", async () => {
  const { queue, player } = setup();
  const pcm = Buffer.alloc(3_200);
  for (let sample = 0; sample < pcm.length / 2; sample += 1) {
    pcm.writeInt16LE(Math.round(20_000 * Math.sin(2 * Math.PI * 440 * sample / 16_000)), sample * 2);
  }
  const playing = queue.play("user", pcm, 16_000, false);
  const resource = player.current!;
  const packet = await new Promise<Buffer>((resolve) => resource.playStream.once("data", resolve));
  const decoder = new OpusDecoder();
  try {
    const decoded = decoder.decode(packet);
    assert.equal(decoded.length, 960 * 4);
    assert.ok(rms(decoded) > 0.05);
  } finally { decoder.delete(); }
  player.stop();
  await playing;
  queue.stop();
});

test("late resource errors after Idle never cancel the next user's response", async () => {
  const { queue, player } = setup();
  const first = queue.play("a", Buffer.alloc(320), 16_000, false);
  const oldResource = player.current!;
  const second = queue.play("b", Buffer.alloc(320), 16_000, false);
  player.stop();
  await first;
  oldResource.playStream.emit("error", new Error("late stream error"));
  player.emit("error", { resource: oldResource });
  assert.equal(queue.isPlaying, true);
  player.stop();
  await second;
  queue.stop();
});
