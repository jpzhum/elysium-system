import {
  entersState, joinVoiceChannel, VoiceConnectionDisconnectReason, VoiceConnectionStatus,
  type Networking, type NetworkingState, type VoiceConnection, type VoiceConnectionState,
  type VoiceWebSocket,
} from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";
import { DiagnosticError, exceptionDetails, sanitizeError, type JoinDiagnostics } from "../observability/diagnostics.js";

const JOIN_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 25_000;
const RECONNECT_ATTEMPTS = 3;
const RECOVERY_PHASE_MS = 5_000;

function transientFailure(failure: DiagnosticError): boolean {
  return failure.category === "network" || failure.code === "ETIMEDOUT" || failure.code === "VOICE_DISCONNECTED" ||
    ["WS_CLOSE_4006", "WS_CLOSE_4009", "WS_CLOSE_4015"].includes(failure.code);
}

function backoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

// Like @discordjs/voice's disposed Networking instances, a destroyed connection
// may still receive a late error. This shared listener retains no attempt data.
const ignoreLateError = (): void => {};

/** Logging must never interrupt voice callbacks or their cleanup. */
function observeSafely(action: () => void): void {
  try { action(); } catch { /* Diagnostics are best effort; never print raw errors. */ }
}

function classified(error: unknown): DiagnosticError {
  if (error instanceof DiagnosticError) return error;
  const { category, code } = sanitizeError(error);
  return new DiagnosticError(category, code);
}

function closeFailure(code: number): DiagnosticError {
  const safe = sanitizeError({ closeCode: code });
  return safe.code === "UNKNOWN"
    ? new DiagnosticError("network", "VOICE_DISCONNECTED")
    : new DiagnosticError(safe.category, safe.code);
}

/** Observe only enumerated statuses, close codes and public DAVE readiness. */
function observeConnection(
  connection: VoiceConnection,
  diagnostics: JoinDiagnostics | undefined,
  onFailure: (error: DiagnosticError) => void,
  onDisconnected: () => void,
  onDestroyed: () => void,
): () => void {
  let networking: Networking | undefined;
  let websocket: VoiceWebSocket | undefined;

  const rememberNetwork = (state: NetworkingState): void => {
    if (!diagnostics) return;
    diagnostics.remember({
      network_status: state.code,
      ...("dave" in state && state.dave ? {
        dave_protocol_version: state.dave.protocolVersion,
        dave_ready: state.dave.session?.ready,
      } : {}),
    });
  };
  const onWebSocketClose = ({ code }: { code: number }): void => {
    observeSafely(() => {
      diagnostics?.remember({ websocket_close_code: code });
      diagnostics?.event("voice_websocket_close", "warn", { websocket_close_code: code });
    });
    // 4017 explicitly requires the supported DAVE protocol; do not wait for a
    // generic Ready timeout and do not disable encryption to get past it.
    if (code === 4017) onFailure(closeFailure(code));
  };
  const bindWebSocket = (state: NetworkingState): void => {
    const next = "ws" in state ? state.ws : undefined;
    if (next === websocket) return;
    websocket?.off("close", onWebSocketClose);
    websocket = next;
    websocket?.on("close", onWebSocketClose);
  };
  const onNetworkState = (previous: NetworkingState, next: NetworkingState): void => {
    observeSafely(() => {
      rememberNetwork(next);
      diagnostics?.event("voice_network_state", "info", {
        previous_network_status: previous.code,
        network_status: next.code,
      });
      bindWebSocket(next);
    });
  };
  const onNetworkClose = (code: number): void => {
    observeSafely(() => {
      diagnostics?.remember({ websocket_close_code: code });
      diagnostics?.event("voice_websocket_close", "warn", { websocket_close_code: code });
    });
    onFailure(closeFailure(code));
  };
  const unbindNetwork = (): void => {
    websocket?.off("close", onWebSocketClose);
    websocket = undefined;
    networking?.off("stateChange", onNetworkState);
    networking?.off("close", onNetworkClose);
    networking = undefined;
  };
  const snapshot = (state: VoiceConnectionState, previous?: VoiceConnectionState): void => {
    diagnostics?.remember({ voice_status: state.status });
    diagnostics?.event("voice_connection_state", "info", {
      voice_status: state.status,
      ...(previous ? { previous_voice_status: previous.status } : {}),
    });
    const nextNetwork = "networking" in state ? state.networking : undefined;
    if (networking !== nextNetwork) {
      unbindNetwork();
      networking = nextNetwork;
      networking?.on("stateChange", onNetworkState);
      networking?.on("close", onNetworkClose);
    }
    if (networking) {
      rememberNetwork(networking.state);
      bindWebSocket(networking.state);
      diagnostics?.event("voice_network_state", "info", { network_status: networking.state.code });
    }
    if (state.status === VoiceConnectionStatus.Disconnected) {
      const fields = {
        disconnect_reason: state.reason,
        ...("closeCode" in state ? { websocket_close_code: state.closeCode } : {}),
      };
      diagnostics?.remember(fields);
      diagnostics?.event("voice_connection_disconnected", "warn", fields);
    }
  };
  const onError = (error: Error): void => {
    const failure = classified(error);
    observeSafely(() => diagnostics?.event("voice_connection_error", "error", { ...exceptionDetails(error), ...sanitizeError(failure) }));
    onFailure(failure);
  };
  const onState = (previous: VoiceConnectionState, next: VoiceConnectionState): void => {
    observeSafely(() => snapshot(next, previous));
    if (next.status === VoiceConnectionStatus.Disconnected) {
      if (next.reason === VoiceConnectionDisconnectReason.AdapterUnavailable) {
        onFailure(new DiagnosticError("discord", "VOICE_ADAPTER_UNAVAILABLE"));
      } else if ("closeCode" in next) {
        onFailure(closeFailure(next.closeCode));
      } else {
        onDisconnected();
      }
    }
    if (next.status === VoiceConnectionStatus.Destroyed) onDestroyed();
  };
  const onTransitioned = (): void => {
    observeSafely(() => {
      if (!networking) return;
      rememberNetwork(networking.state);
      const state = networking.state;
      if ("dave" in state && state.dave) {
        diagnostics?.event("voice_dave_state", "info", {
          dave_protocol_version: state.dave.protocolVersion,
          dave_ready: state.dave.session?.ready,
        });
      }
    });
  };
  connection.on("error", onError);
  connection.on("stateChange", onState);
  connection.on("transitioned", onTransitioned);
  observeSafely(() => snapshot(connection.state));
  // A failed Discord adapter can already have disconnected during construction.
  if (connection.state.status === VoiceConnectionStatus.Disconnected &&
      connection.state.reason === VoiceConnectionDisconnectReason.AdapterUnavailable) {
    onFailure(new DiagnosticError("discord", "VOICE_ADAPTER_UNAVAILABLE"));
  }
  if (connection.state.status === VoiceConnectionStatus.Destroyed) {
    onFailure(new DiagnosticError("voice", "VOICE_DESTROYED"));
  }
  return () => {
    unbindNetwork();
    connection.on("error", ignoreLateError);
    connection.off("error", onError);
    connection.off("stateChange", onState);
    connection.off("transitioned", onTransitioned);
  };
}

/** Owns one guild/channel connection, with bounded join and reconnect waits. */
export class VoiceConnectionManager {
  private current: VoiceConnection | undefined;
  private joining = false;
  private reconnecting = false;
  private reconnectAbort: AbortController | undefined;
  private reconnectAttemptAbort: AbortController | undefined;
  private joinAbort: AbortController | undefined;
  private stopObserving: (() => void) | undefined;
  private diagnostics: JoinDiagnostics | undefined;

  get connection(): VoiceConnection | undefined { return this.current; }

  async join(channel: VoiceChannel, diagnostics?: JoinDiagnostics): Promise<VoiceConnection> {
    if (this.joining) throw new DiagnosticError("voice", "JOIN_IN_PROGRESS");
    this.joining = true;
    const started = performance.now();
    let connection: VoiceConnection | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    try {
      this.leave();
      this.diagnostics = diagnostics;
      observeSafely(() => diagnostics?.stage("voice_connect"));
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        // Keep the library's DAVE default. Never enable unencrypted fallback.
      });
      this.current = connection;
      this.joinAbort = controller;
      const ownedConnection = connection;
      this.stopObserving = observeConnection(connection, diagnostics,
        (failure) => this.failOrRecover(ownedConnection, failure),
        () => { void this.recover(ownedConnection); },
        () => {
          if (this.current !== ownedConnection) return;
          const failure = new DiagnosticError("voice", "VOICE_DESTROYED");
          this.joinAbort?.abort(failure);
          this.reconnectAbort?.abort(failure);
          this.leave();
        });
      observeSafely(() => diagnostics?.stage("voice_ready_wait"));
      deadline = setTimeout(() => {
        controller.abort(new DiagnosticError("timeout", "JOIN_TIMEOUT"));
      }, JOIN_TIMEOUT_MS);
      deadline.unref();
      await entersState(connection, VoiceConnectionStatus.Ready, controller.signal);
      // A synchronous failure can arrive in the same turn as a Ready event.
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.current !== connection) throw new DiagnosticError("cancelled", "JOIN_CANCELLED");
      observeSafely(() => diagnostics?.event("voice_join_ready", "info", {
        voice_status: ownedConnection.state.status,
        duration_ms: Math.round(performance.now() - started),
      }));
      return connection;
    } catch (error) {
      const failure = classified(controller.signal.aborted ? controller.signal.reason : error);
      observeSafely(() => diagnostics?.event(
        failure.code === "JOIN_TIMEOUT" ? "voice_join_timeout" :
          failure.code === "JOIN_CANCELLED" ? "voice_join_cancelled" : "voice_join_failed",
        failure.category === "cancelled" ? "info" : "error",
        { ...sanitizeError(failure), timeout_ms: JOIN_TIMEOUT_MS, duration_ms: Math.round(performance.now() - started) },
      ));
      if (connection && this.current === connection) this.leave();
      if (!connection) this.diagnostics = undefined;
      throw failure;
    } finally {
      clearTimeout(deadline);
      controller.abort();
      if (this.joinAbort === controller) this.joinAbort = undefined;
      this.joining = false;
    }
  }

  leave(): void {
    this.joinAbort?.abort(new DiagnosticError("cancelled", "JOIN_CANCELLED"));
    this.joinAbort = undefined;
    this.reconnectAbort?.abort(new DiagnosticError("cancelled", "JOIN_CANCELLED"));
    this.reconnectAbort = undefined;
    this.reconnectAttemptAbort?.abort(new DiagnosticError("cancelled", "JOIN_CANCELLED"));
    this.reconnectAttemptAbort = undefined;
    this.reconnecting = false;
    const connection = this.current;
    this.current = undefined;
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.diagnostics = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  private failOrRecover(connection: VoiceConnection, failure: DiagnosticError): void {
    if (this.current !== connection) return;
    if (this.joinAbort && !this.joinAbort.signal.aborted) {
      this.joinAbort.abort(failure);
    } else if (this.reconnectAbort && !this.reconnectAbort.signal.aborted) {
      // A transport hiccup ends this attempt, not the channel's valid consent
      // session. Fatal permission/encryption failures still end recovery.
      if (transientFailure(failure)) this.reconnectAttemptAbort?.abort(failure);
      else this.reconnectAbort.abort(failure);
    } else {
      if (!transientFailure(failure)) { this.leave(); return; }
      void this.recover(connection, true);
    }
  }

  private async recover(connection: VoiceConnection, forceRejoin = false): Promise<void> {
    if (this.current !== connection || this.joining || this.reconnecting ||
      connection.state.status === VoiceConnectionStatus.Destroyed) return;
    this.reconnecting = true;
    const started = performance.now();
    const diagnostics = this.diagnostics;
    observeSafely(() => {
      diagnostics?.stage("voice_reconnect");
      diagnostics?.event("voice_recovery_started", "warn", { timeout_ms: RECONNECT_TIMEOUT_MS });
    });
    const controller = new AbortController();
    this.reconnectAbort = controller;
    const deadline = setTimeout(() => {
      controller.abort(new DiagnosticError("timeout", "RECONNECT_TIMEOUT"));
    }, RECONNECT_TIMEOUT_MS);
    deadline.unref();
    try {
      const waitReady = async (timeoutMs?: number, rejoin = false): Promise<void> => {
        const attempt = new AbortController();
        this.reconnectAttemptAbort = attempt;
        const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
          attempt.abort(new DiagnosticError("timeout", "RECONNECT_TIMEOUT"));
        }, timeoutMs);
        timer?.unref();
        try {
          if (rejoin && !connection.rejoin()) throw new DiagnosticError("discord", "VOICE_ADAPTER_UNAVAILABLE");
          await entersState(connection, VoiceConnectionStatus.Ready,
            AbortSignal.any([controller.signal, attempt.signal]));
          if (controller.signal.aborted) throw controller.signal.reason;
          if (attempt.signal.aborted) throw attempt.signal.reason;
          if (this.current !== connection) throw new DiagnosticError("cancelled", "JOIN_CANCELLED");
        } catch (error) {
          throw controller.signal.aborted ? controller.signal.reason
            : attempt.signal.aborted ? attempt.signal.reason : error;
        } finally {
          clearTimeout(timer);
          attempt.abort();
          if (this.reconnectAttemptAbort === attempt) this.reconnectAttemptAbort = undefined;
        }
      };
      // Discord can issue a replacement endpoint/token itself. Preserve that
      // recovery path before requesting up to three rejoins of this connection.
      let ready = false;
      if (!forceRejoin) {
        try { await waitReady(RECOVERY_PHASE_MS); ready = true; }
        catch { if (controller.signal.aborted) throw controller.signal.reason; }
      }
      for (let attempt = 1; !ready && attempt <= RECONNECT_ATTEMPTS; attempt++) {
        const backoffMs = attempt === 1 ? 0 : 1_000 * 2 ** (attempt - 2);
        if (backoffMs) await backoff(backoffMs, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (this.current !== connection) throw new DiagnosticError("cancelled", "JOIN_CANCELLED");
        // A late Discord endpoint can become Ready during backoff. Do not tear
        // down that recovered transport after the bot has resumed its receiver.
        if (attempt > 1 && connection.state.status === VoiceConnectionStatus.Ready) { ready = true; break; }
        observeSafely(() => diagnostics?.event("voice_recovery_rejoin", "info", {
          recovery_attempt: attempt, retry_delay_ms: backoffMs,
        }));
        try {
          // The final attempt is bounded by the original overall 25 s deadline.
          await waitReady(attempt === RECONNECT_ATTEMPTS ? undefined : RECOVERY_PHASE_MS, true);
          ready = true;
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const failure = classified(error);
          if (attempt === RECONNECT_ATTEMPTS ||
            (!transientFailure(failure) && failure.code !== "RECONNECT_TIMEOUT")) throw failure;
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      observeSafely(() => diagnostics?.event("voice_recovery_ready", "info", {
        duration_ms: Math.round(performance.now() - started),
      }));
    } catch (error) {
      const failure = classified(controller.signal.aborted ? controller.signal.reason : error);
      observeSafely(() => diagnostics?.event(
        failure.code === "RECONNECT_TIMEOUT" ? "voice_recovery_timeout" :
          failure.category === "cancelled" ? "voice_recovery_cancelled" : "voice_recovery_failed",
        failure.category === "cancelled" ? "info" : "error",
        { ...sanitizeError(failure), timeout_ms: RECONNECT_TIMEOUT_MS, duration_ms: Math.round(performance.now() - started) },
      ));
      if (this.current === connection) this.leave();
    } finally {
      clearTimeout(deadline);
      controller.abort();
      if (this.reconnectAbort === controller) {
        this.reconnectAbort = undefined;
        this.reconnecting = false;
      }
    }
  }
}
