import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";
import { DAVESession, DAVE_PROTOCOL_VERSION } from "@snazzah/davey";
import OpusScript from "opusscript";
import { test, vi } from "vitest";
import { VoiceReceiver } from "../src/discord/voice-receiver.js";
import { VoiceConnectionManager } from "../src/discord/voice-connection.js";

const connectionMocks = vi.hoisted(() => ({ join: vi.fn() }));
vi.mock("@discordjs/voice", async (importActual) => ({
  ...await importActual<typeof import("@discordjs/voice")>(),
  joinVoiceChannel: connectionMocks.join,
}));

class SimulatedConnection extends EventEmitter {
  state = { status: VoiceConnectionStatus.Signalling };
  destroy = vi.fn(() => this.transition(VoiceConnectionStatus.Destroyed));
  rejoin = vi.fn(() => true);
  transition(status: VoiceConnectionStatus): void {
    const previous = this.state;
    this.state = { status };
    this.emit("stateChange", previous, this.state);
    this.emit(status, previous, this.state);
  }
}

const testChannel = {
  id: "111111111111111111",
  guild: { id: "222222222222222222", voiceAdapterCreator: () => undefined },
} as unknown as VoiceChannel;

test("native Davey creates and resets a synthetic session without Discord/network", () => {
  const session = new DAVESession(DAVE_PROTOCOL_VERSION, "111111111111111111", "222222222222222222");
  assert.equal(session.protocolVersion, DAVE_PROTOCOL_VERSION);
  assert.equal(session.ready, false);
  session.reset();
});

test("connection joins undeafened with DAVE defaults and destroys on leave", async () => {
  const connection = new SimulatedConnection();
  connectionMocks.join.mockReturnValueOnce(connection);
  const manager = new VoiceConnectionManager();
  const joining = manager.join(testChannel);
  connection.transition(VoiceConnectionStatus.Ready);
  await joining;
  const args = connectionMocks.join.mock.lastCall?.[0] as Record<string, unknown>;
  assert.equal(args.selfDeaf, false);
  assert.equal("daveEncryption" in args, false);
  assert.equal(manager.connection, connection);
  manager.leave();
  assert.equal(connection.destroy.mock.calls.length, 1);
  assert.equal(manager.connection, undefined);
  assert.equal(connection.listenerCount(VoiceConnectionStatus.Ready), 0);
});

test("leaving during pending join cancels Ready waits; errors never expose payloads", async () => {
  const connection = new SimulatedConnection();
  connectionMocks.join.mockReturnValueOnce(connection);
  const manager = new VoiceConnectionManager();
  const joining = manager.join(testChannel);
  const rejected = assert.rejects(joining, /Não foi possível/);
  manager.leave();
  await rejected;
  assert.equal(connection.listenerCount(VoiceConnectionStatus.Ready), 0);
  const failure = new SimulatedConnection();
  connectionMocks.join.mockReturnValueOnce(failure);
  const attempt = manager.join(testChannel);
  const sanitized = assert.rejects(attempt, (error: Error) => {
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  failure.emit("error", new Error("PRIVATE NETWORK PAYLOAD"));
  await sanitized;
  assert.equal(manager.connection, undefined);
});

test("bounded reconnect rejoins after grace and cancellation removes waits", async () => {
  vi.useFakeTimers();
  try {
    const connection = new SimulatedConnection();
    connectionMocks.join.mockReturnValueOnce(connection);
    const manager = new VoiceConnectionManager();
    const joining = manager.join(testChannel);
    connection.transition(VoiceConnectionStatus.Ready);
    await joining;
    connection.transition(VoiceConnectionStatus.Disconnected);
    await vi.advanceTimersByTimeAsync(5_001);
    assert.equal(connection.rejoin.mock.calls.length, 1);
    connection.transition(VoiceConnectionStatus.Connecting);
    connection.transition(VoiceConnectionStatus.Ready);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.connection, connection);
    connection.transition(VoiceConnectionStatus.Disconnected);
    manager.leave();
    await vi.runAllTimersAsync();
    assert.equal(manager.connection, undefined);
    assert.equal(connection.listenerCount(VoiceConnectionStatus.Ready), 0);
    assert.equal(connection.listenerCount(VoiceConnectionStatus.Connecting), 0);
    assert.equal(connection.listenerCount(VoiceConnectionStatus.Signalling), 0);
  } finally { vi.useRealTimers(); }
});

function syntheticPacket(frequency = 440): Buffer {
  const codec = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const pcm = Buffer.alloc(960 * 4);
  for (let frame = 0; frame < 960; frame += 1) {
    const value = Math.round(20_000 * Math.sin(2 * Math.PI * frequency * frame / 48_000));
    pcm.writeInt16LE(value, frame * 4);
    pcm.writeInt16LE(value, frame * 4 + 2);
  }
  try { return codec.encode(pcm, 960); } finally { codec.delete(); }
}

function setup(maxTurnSeconds = 2) {
  const speaking = new EventEmitter();
  const streams = new Map<string, PassThrough>();
  const subscriptions: string[] = [];
  const consent = new Set<string>();
  const turns: { userId: string; pcm: Buffer }[] = [];
  const metrics: string[] = [];
  let playing = false;
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    receiver: {
      speaking,
      subscribe(userId: string) {
        subscriptions.push(userId);
        const stream = new PassThrough({ objectMode: true });
        streams.set(userId, stream);
        return stream;
      },
    },
  });
  const receiver = new VoiceReceiver(connection as unknown as VoiceConnection, {
    ownUserId: "bot",
    canReceive: (userId) => consent.has(userId),
    isPlaying: () => playing,
    maxTurnSeconds,
    onTurn: (userId, pcm) => { turns.push({ userId, pcm }); },
    onMetric: (name) => { metrics.push(name); },
  });
  receiver.start();
  return { receiver, connection, speaking, streams, subscriptions, consent, turns, metrics,
    setPlaying(value: boolean) { playing = value; } };
}

test("simulated receiver gates consent, its own bot and playback before subscribing", () => {
  const state = setup();
  state.consent.add("bot");
  state.speaking.emit("start", "bot");
  state.speaking.emit("start", "unconsented");
  state.consent.add("allowed");
  state.setPlaying(true);
  state.speaking.emit("start", "allowed");
  assert.deepEqual(state.subscriptions, []);
  state.setPlaying(false);
  state.speaking.emit("start", "allowed");
  assert.deepEqual(state.subscriptions, ["allowed"]);
  state.receiver.stop();
  assert.equal(state.speaking.listenerCount("start"), 0);
});

test("synthetic Opus frames produce separate bounded PCM turns attributed to Discord IDs", async () => {
  const state = setup(1);
  const packetA = syntheticPacket();
  const packetB = syntheticPacket(1_000);
  for (const user of ["a", "b"]) {
    state.consent.add(user);
    state.speaking.emit("start", user);
  }
  for (let frame = 0; frame < 50; frame += 1) {
    state.streams.get("a")!.write(packetA);
    state.streams.get("b")!.write(packetB);
  }
  await setImmediate();
  assert.equal(state.turns.length, 2);
  assert.deepEqual(state.turns.map(({ userId }) => userId), ["a", "b"]);
  for (const turn of state.turns) {
    assert.ok(turn.pcm.length > 0 && turn.pcm.length <= 192_000);
    assert.equal(turn.pcm.length % 4, 0);
  }
  assert.notDeepEqual(state.turns[0]!.pcm, state.turns[1]!.pcm);
  state.receiver.stop();
});

test("revocation is checked before every decode and drops any partial turn", async () => {
  const state = setup();
  state.consent.add("a");
  state.speaking.emit("start", "a");
  state.streams.get("a")!.write(syntheticPacket());
  state.consent.delete("a");
  state.streams.get("a")!.write(Buffer.from([255]));
  await setImmediate();
  assert.equal(state.turns.length, 0);
  assert.equal(state.metrics.includes("voice_decode_errors"), false);
  assert.equal(state.streams.get("a")!.destroyed, true);
  state.receiver.stop();
});

test("DAVE receive-stream error is contained and the next speaking event can resubscribe", async () => {
  const state = setup();
  state.consent.add("a");
  state.speaking.emit("start", "a");
  const failed = state.streams.get("a")!;
  failed.emit("error", new Error("Simulated DecryptionFailed"));
  state.speaking.emit("start", "a");
  const recovered = state.streams.get("a")!;
  assert.notEqual(failed, recovered);
  recovered.write(syntheticPacket());
  recovered.end();
  await setImmediate();
  assert.deepEqual(state.subscriptions, ["a", "a"]);
  assert.equal(state.turns.length, 1);
  assert.equal(state.metrics.filter((name) => name === "voice_receive_errors").length, 1);
  state.receiver.stop();
});

test("silence produces no turn and playback suppresses an already open stream", async () => {
  const state = setup();
  state.consent.add("a");
  state.speaking.emit("start", "a");
  state.streams.get("a")!.write(Buffer.from([0xf8, 0xff, 0xfe]));
  state.streams.get("a")!.end();
  await setImmediate();
  assert.equal(state.turns.length, 0);
  state.speaking.emit("start", "a");
  state.streams.get("a")!.write(syntheticPacket());
  state.setPlaying(true);
  state.streams.get("a")!.write(syntheticPacket());
  await setImmediate();
  assert.equal(state.turns.length, 0);
  state.receiver.stop();
});

test("disconnect drops partial audio; destroy removes listeners and ignores late packets", async () => {
  const state = setup();
  state.consent.add("a");
  const packet = syntheticPacket();
  state.speaking.emit("start", "a");
  const oldStream = state.streams.get("a")!;
  oldStream.write(packet);
  state.connection.state.status = VoiceConnectionStatus.Disconnected;
  state.connection.emit("stateChange", {}, { status: VoiceConnectionStatus.Disconnected });
  assert.equal(oldStream.destroyed, true);
  oldStream.emit("data", packet);
  assert.equal(state.turns.length, 0);
  state.speaking.emit("start", "a");
  assert.equal(state.subscriptions.length, 1);
  state.connection.state.status = VoiceConnectionStatus.Ready;
  state.connection.emit("stateChange", {}, { status: VoiceConnectionStatus.Ready });
  state.speaking.emit("start", "a");
  const currentStream = state.streams.get("a")!;
  currentStream.write(packet);
  state.connection.state.status = VoiceConnectionStatus.Destroyed;
  state.connection.emit("stateChange", {}, { status: VoiceConnectionStatus.Destroyed });
  currentStream.emit("data", packet);
  currentStream.emit("end");
  await setImmediate();
  assert.equal(currentStream.destroyed, true);
  assert.equal(state.turns.length, 0);
  assert.equal(state.speaking.listenerCount("start"), 0);
  assert.equal(state.connection.listenerCount("stateChange"), 0);
});

// This is an explicit acceptance gate, not proof supplied by mocked streams.
test.skip("DAVE REAL: humans before/after bot, MLS transitions, reconnect and audible playback — follow docs/DAVE.md", () => {});
