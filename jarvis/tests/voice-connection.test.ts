import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  NetworkingStatusCode, VoiceConnectionDisconnectReason, VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";
import { afterEach, test, vi } from "vitest";
import { VoiceConnectionManager } from "../src/discord/voice-connection.js";
import { DiagnosticError, JoinDiagnostics } from "../src/observability/diagnostics.js";
import { Logger } from "../src/observability/metrics.js";

const mocks = vi.hoisted(() => ({ join: vi.fn() }));
vi.mock("@discordjs/voice", async (importActual) => ({
  ...await importActual<typeof import("@discordjs/voice")>(),
  joinVoiceChannel: mocks.join,
}));

class SimulatedNetworking extends EventEmitter {
  websocket = new EventEmitter();
  state: { code: NetworkingStatusCode; ws?: EventEmitter; [key: string]: unknown } = {
    code: NetworkingStatusCode.OpeningWs,
    ws: this.websocket,
    connectionOptions: { token: "PRIVATE_DISCORD_TOKEN", endpoint: "PRIVATE_SIGNED_URL" },
  };
  transition(code: NetworkingStatusCode, extra: Record<string, unknown> = {}): void {
    const previous = this.state;
    this.state = { ...this.state, code, ...extra };
    this.emit("stateChange", previous, this.state);
  }
}

class SimulatedConnection extends EventEmitter {
  state: { status: VoiceConnectionStatus; [key: string]: unknown } = { status: VoiceConnectionStatus.Signalling };
  destroy = vi.fn(() => this.transition(VoiceConnectionStatus.Destroyed));
  rejoin = vi.fn(() => true);
  transition(status: VoiceConnectionStatus, extra: Record<string, unknown> = {}): void {
    const previous = this.state;
    this.state = { status, ...extra };
    this.emit("stateChange", previous, this.state);
    this.emit(status, previous, this.state);
  }
}

const channel = {
  id: "111111111111111111",
  guild: { id: "222222222222222222", voiceAdapterCreator: () => undefined },
} as unknown as VoiceChannel;

function setup() {
  const lines: string[] = [];
  const diagnostics = new JoinDiagnostics(new Logger("info", (line) => { lines.push(line); }));
  const connection = new SimulatedConnection();
  const networking = new SimulatedNetworking();
  mocks.join.mockReturnValueOnce(connection);
  const manager = new VoiceConnectionManager();
  return { manager, connection, networking, diagnostics, lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function assertClean(connection: SimulatedConnection, networking?: SimulatedNetworking): void {
  assert.equal(connection.listenerCount(VoiceConnectionStatus.Ready), 0);
  assert.equal(connection.listenerCount(VoiceConnectionStatus.Signalling), 0);
  assert.equal(connection.listenerCount(VoiceConnectionStatus.Connecting), 0);
  assert.equal(connection.listenerCount("stateChange"), 0);
  assert.equal(connection.listenerCount("transitioned"), 0);
  // One shared, inert sink handles disposed sockets' late EventEmitter errors.
  assert.equal(connection.listenerCount("error"), 1);
  assert.equal(networking?.listenerCount("stateChange") ?? 0, 0);
  assert.equal(networking?.listenerCount("close") ?? 0, 0);
  assert.equal(networking?.websocket.listenerCount("close") ?? 0, 0);
}

afterEach(() => { vi.useRealTimers(); mocks.join.mockReset(); });

test("creation failures retain a sanitized native dependency classification", async () => {
  const lines: string[] = [];
  const diagnostics = new JoinDiagnostics(new Logger("info", (line) => { lines.push(line); }));
  mocks.join.mockImplementationOnce(() => { throw new Error("Failed to load native binding PRIVATE_TOKEN https://signed/private"); });
  const manager = new VoiceConnectionManager();
  const error = await manager.join(channel, diagnostics).catch((failure: unknown) => failure);
  assert.ok(error instanceof DiagnosticError);
  assert.deepEqual({ category: error.category, code: error.code }, { category: "dependency", code: "NATIVE_BINDING_UNAVAILABLE" });
  diagnostics.failure(error);
  assert.equal(manager.connection, undefined);
  const record = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  assert.equal(record.stage, "voice_connect");
  assert.equal(record.code, "NATIVE_BINDING_UNAVAILABLE");
  assert.doesNotMatch(lines.join(""), /PRIVATE|https:/);
});

test("Ready timeout logs the last gateway and UDP negotiation states then cleans up", async () => {
  vi.useFakeTimers();
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  state.connection.transition(VoiceConnectionStatus.Connecting, { networking: state.networking });
  state.networking.transition(NetworkingStatusCode.Identifying);
  state.networking.transition(NetworkingStatusCode.UdpHandshaking);
  await vi.advanceTimersByTimeAsync(20_000);
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.category, "timeout");
  assert.equal(error.code, "JOIN_TIMEOUT");
  state.diagnostics.failure(error);
  const record = state.records().at(-1)!;
  assert.equal(record.stage, "voice_ready_wait");
  assert.equal(record.voice_status, "connecting");
  assert.equal(record.network_status, NetworkingStatusCode.UdpHandshaking);
  assert.equal(record.timeout_ms, 20_000);
  assert.ok(Number.isSafeInteger(record.duration_ms) && Number(record.duration_ms) >= 0);
  assert.equal(new Set(state.records().map((entry) => entry.incident)).size, 1);
  assert.equal(state.manager.connection, undefined);
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection, state.networking);
  assert.doesNotMatch(state.lines.join(""), /PRIVATE|token|endpoint/);
});

test("a voice websocket close 4017 is reported as DAVE before a timeout", async () => {
  vi.useFakeTimers();
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  state.connection.transition(VoiceConnectionStatus.Connecting, { networking: state.networking });
  // @discordjs/voice can automatically signal again instead of preserving 4017
  // in VoiceConnection.state; observing Networking.close retains that code.
  state.networking.emit("close", 4017);
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.category, "dave");
  assert.equal(error.code, "WS_CLOSE_4017");
  state.diagnostics.failure(error);
  assert.equal(state.records().at(-1)!.websocket_close_code, 4017);
  assert.equal(state.records().some((entry) => entry.event === "voice_join_timeout"), false);
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection, state.networking);
});

test("close codes in Disconnected state and adapter errors keep their origin", async () => {
  for (const [extra, category, code] of [
    [{ reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4017 }, "dave", "WS_CLOSE_4017"],
    [{ reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 }, "voice", "WS_CLOSE_4014"],
    [{ reason: VoiceConnectionDisconnectReason.AdapterUnavailable }, "discord", "VOICE_ADAPTER_UNAVAILABLE"],
  ] as const) {
    const state = setup();
    const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
    state.connection.transition(VoiceConnectionStatus.Disconnected, extra);
    const error = await failed;
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    state.diagnostics.failure(error);
    assert.equal(state.records().at(-1)!.disconnect_reason, extra.reason);
    assertClean(state.connection);
  }
});

test("initial adapter failure rejects immediately rather than waiting 20 seconds", async () => {
  vi.useFakeTimers();
  const state = setup();
  state.connection.state = {
    status: VoiceConnectionStatus.Disconnected,
    reason: VoiceConnectionDisconnectReason.AdapterUnavailable,
  };
  const error = await state.manager.join(channel, state.diagnostics).catch((failure: unknown) => failure);
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.code, "VOICE_ADAPTER_UNAVAILABLE");
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("an asynchronous DAVE negotiation failure is classified without exposing its message", async () => {
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  state.connection.emit("error", new Error("Unsupported DAVE protocol PRIVATE_TOKEN"));
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.category, "dave");
  assert.equal(error.code, "DAVE_UNSUPPORTED_PROTOCOL");
  assert.doesNotMatch(state.lines.join(""), /PRIVATE/);
  assertClean(state.connection);
});

test("a concurrent join leaves the active attempt untouched", async () => {
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  const error = await state.manager.join(channel).catch((failure: unknown) => failure);
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.code, "JOIN_IN_PROGRESS");
  assert.equal(state.connection.destroy.mock.calls.length, 0);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await joining;
  state.manager.leave();
  assertClean(state.connection);
});

test("an asynchronous pre-Ready connection error preserves its safe network code", async () => {
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  const original = Object.assign(new Error("PRIVATE_TRANSCRIPT https://signed/credential"), { code: "ECONNRESET", token: "PRIVATE_TOKEN" });
  state.connection.emit("error", original);
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.category, "network");
  assert.equal(error.code, "ECONNRESET");
  assert.equal(error.message, "ECONNRESET");
  state.diagnostics.failure(error);
  assert.equal(state.records().at(-1)!.code, "ECONNRESET");
  assert.doesNotMatch(state.lines.join(""), /PRIVATE|https:|credential|stack|"cause":/);
  assert.equal(state.records().at(-1)!.cause_code, "ECONNRESET");
  assert.equal(state.records().find(record => record.event === "voice_connection_error")!.cause_name, "Error");
  assertClean(state.connection);
});

test("an unknown error code and arbitrary message never enter diagnostic output", async () => {
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  state.connection.emit("error", Object.assign(new Error("PRIVATE_AUDIO"), { code: "PRIVATE_TOKEN" }));
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.category, "unknown");
  assert.equal(error.code, "UNKNOWN");
  assert.doesNotMatch(state.lines.join(""), /PRIVATE/);
});

test("Ready records public DAVE readiness without serializing transport secrets", async () => {
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Connecting, { networking: state.networking });
  state.networking.transition(NetworkingStatusCode.Ready, {
    dave: { protocolVersion: 1, session: { ready: true, secretKey: "PRIVATE_MLS_KEY" } },
    connectionData: { secretKey: "PRIVATE_TRANSPORT_KEY", connectedClients: ["PRIVATE_USER"] },
    preparedPacket: Buffer.from("PRIVATE_AUDIO"),
  });
  state.connection.transition(VoiceConnectionStatus.Ready, { networking: state.networking });
  state.connection.emit("transitioned", 999999);
  assert.equal(await joining, state.connection as unknown as VoiceConnection);
  const ready = state.records().find((entry) => entry.event === "voice_join_ready")!;
  assert.equal(ready.dave_ready, true);
  assert.equal(ready.dave_protocol_version, 1);
  assert.equal(ready.network_status, NetworkingStatusCode.Ready);
  assert.doesNotMatch(state.lines.join(""), /PRIVATE|999999|secretKey|preparedPacket|connectedClients/);
  const options = mocks.join.mock.lastCall?.[0] as Record<string, unknown>;
  assert.equal(options.selfDeaf, false);
  assert.equal("daveEncryption" in options, false);
  state.manager.leave();
  assertClean(state.connection, state.networking);
});

test("leave cancels pending Ready and disposes observers before late events", async () => {
  vi.useFakeTimers();
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  state.connection.transition(VoiceConnectionStatus.Connecting, { networking: state.networking });
  state.manager.leave();
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.category, "cancelled");
  assert.equal(error.code, "JOIN_CANCELLED");
  const count = state.lines.length;
  state.connection.emit("error", new Error("PRIVATE_LATE_TOKEN"));
  state.networking.emit("close", 4017);
  state.networking.transition(NetworkingStatusCode.Ready);
  assert.equal(state.lines.length, count);
  assert.equal(state.connection.destroy.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection, state.networking);
});

test("external destruction before Ready retains its distinct failure classification", async () => {
  const state = setup();
  const failed = state.manager.join(channel, state.diagnostics).catch((error: unknown) => error);
  state.connection.transition(VoiceConnectionStatus.Destroyed);
  const error = await failed;
  assert.ok(error instanceof DiagnosticError);
  assert.equal(error.code, "VOICE_DESTROYED");
  assert.equal(state.manager.connection, undefined);
  assertClean(state.connection);
});

test("recovery preserves the grace/rejoin policy and records the same incident", async () => {
  vi.useFakeTimers();
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await joining;
  state.connection.transition(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(state.connection.rejoin.mock.calls.length, 1);
  state.connection.transition(VoiceConnectionStatus.Connecting);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(state.manager.connection, state.connection);
  assert.equal(state.records().some((entry) => entry.event === "voice_recovery_ready"), true);
  assert.equal(new Set(state.records().map((entry) => entry.incident)).size, 1);
  state.manager.leave();
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("recovery timeout destroys after 25 seconds with no remaining waits", async () => {
  vi.useFakeTimers();
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await joining;
  state.connection.transition(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
  await vi.advanceTimersByTimeAsync(25_000);
  const record = state.records().find((entry) => entry.event === "voice_recovery_timeout")!;
  assert.equal(record.code, "RECONNECT_TIMEOUT");
  assert.equal(record.timeout_ms, 25_000);
  assert.equal(state.manager.connection, undefined);
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("transient errors during recovery retry with backoff without destroying the live connection", async () => {
  vi.useFakeTimers();
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await joining;
  state.connection.transition(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
  state.connection.emit("error", Object.assign(new Error("PRIVATE"), { code: "ENOTFOUND" }));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(state.connection.rejoin.mock.calls.length, 1);
  state.connection.emit("error", Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }));
  // Repeated callbacks do not create parallel recovery loops or connections.
  state.connection.emit("error", Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }));
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(state.connection.rejoin.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(state.connection.rejoin.mock.calls.length, 2);
  assert.equal(state.connection.destroy.mock.calls.length, 0);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(state.manager.connection, state.connection);
  assert.equal(mocks.join.mock.calls.length, 1);
  assert.equal(state.records().some((entry) => entry.event === "voice_recovery_ready"), true);
  assert.equal(state.records().some((entry) => entry.event === "voice_recovery_failed"), false);
  assert.deepEqual(state.records().filter((entry) => entry.event === "voice_recovery_rejoin")
    .map(({ recovery_attempt, retry_delay_ms }) => ({ recovery_attempt, retry_delay_ms })), [
    { recovery_attempt: 1, retry_delay_ms: 0 }, { recovery_attempt: 2, retry_delay_ms: 1_000 },
  ]);
  assert.doesNotMatch(state.lines.join(""), /PRIVATE/);
  state.manager.leave();
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("recovery uses at most three rejoins and cancels all waits at its original deadline", async () => {
  vi.useFakeTimers();
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Ready); await joining;
  state.connection.transition(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
  await vi.advanceTimersByTimeAsync(25_000);
  assert.equal(state.connection.rejoin.mock.calls.length, 3);
  assert.equal(state.connection.destroy.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(state.connection.rejoin.mock.calls.length, 3);
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("a transport that becomes ready during backoff is retained without another rejoin", async () => {
  vi.useFakeTimers();
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Ready); await joining;
  state.connection.transition(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
  await vi.advanceTimersByTimeAsync(10_000); // Grace + first attempt end; 1 s backoff is pending.
  assert.equal(state.connection.rejoin.mock.calls.length, 1);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(state.connection.rejoin.mock.calls.length, 1);
  assert.equal(state.manager.connection, state.connection);
  assert.equal(state.records().some((entry) => entry.event === "voice_recovery_ready"), true);
  state.manager.leave();
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("fatal permission and encryption failures do not automatically rejoin a ready channel", async () => {
  for (const extra of [
    { reason: VoiceConnectionDisconnectReason.AdapterUnavailable },
    { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4017 },
    { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 },
  ]) {
    const state = setup();
    const joining = state.manager.join(channel, state.diagnostics);
    state.connection.transition(VoiceConnectionStatus.Ready); await joining;
    state.connection.transition(VoiceConnectionStatus.Disconnected, extra);
    assert.equal(state.manager.connection, undefined);
    assert.equal(state.connection.rejoin.mock.calls.length, 0);
    assertClean(state.connection);
  }
});

test("cancel during reconnect does not reconnect later or retain observers", async () => {
  vi.useFakeTimers();
  const state = setup();
  const joining = state.manager.join(channel, state.diagnostics);
  state.connection.transition(VoiceConnectionStatus.Ready);
  await joining;
  state.connection.transition(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
  state.manager.leave();
  await vi.runAllTimersAsync();
  assert.equal(state.connection.rejoin.mock.calls.length, 0);
  assert.equal(state.records().some((entry) => entry.event === "voice_recovery_cancelled"), true);
  assert.equal(vi.getTimerCount(), 0);
  assertClean(state.connection);
});

test("a failing diagnostics writer cannot break connection state callbacks", async () => {
  const diagnostics = new JoinDiagnostics(new Logger("info", () => { throw new Error("PRIVATE_LOGGER_FAILURE"); }));
  const connection = new SimulatedConnection();
  mocks.join.mockReturnValueOnce(connection);
  const manager = new VoiceConnectionManager();
  const joining = manager.join(channel, diagnostics);
  assert.doesNotThrow(() => connection.transition(VoiceConnectionStatus.Ready));
  await joining;
  assert.doesNotThrow(() => manager.leave());
  assertClean(connection);
});
