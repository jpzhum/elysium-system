import {
  entersState, joinVoiceChannel, VoiceConnectionDisconnectReason, VoiceConnectionStatus,
  type Networking, type NetworkingState, type VoiceConnection, type VoiceConnectionState,
  type VoiceWebSocket,
} from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";
import { DiagnosticError, sanitizeError, type JoinDiagnostics } from "../observability/diagnostics.js";

const JOIN_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 25_000;

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
    observeSafely(() => diagnostics?.event("voice_connection_error", "error", sanitizeError(failure)));
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
      this.reconnectAbort.abort(failure);
    } else {
      void this.recover(connection);
    }
  }

  private async recover(connection: VoiceConnection): Promise<void> {
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
      // Discord can issue a new endpoint/token while reconnecting. Give that path time first.
      const phase = new AbortController();
      const phaseDeadline = setTimeout(() => phase.abort(), 5_000);
      phaseDeadline.unref();
      const signal = AbortSignal.any([phase.signal, controller.signal]);
      try {
        await Promise.any([
          entersState(connection, VoiceConnectionStatus.Signalling, signal),
          entersState(connection, VoiceConnectionStatus.Connecting, signal),
          entersState(connection, VoiceConnectionStatus.Ready, signal),
        ]).catch(() => {
          if (this.current === connection && !controller.signal.aborted) {
            const accepted = connection.rejoin();
            observeSafely(() => diagnostics?.event("voice_recovery_rejoin", "info", {}));
            if (!accepted) throw new DiagnosticError("discord", "VOICE_ADAPTER_UNAVAILABLE");
          }
        });
      } finally {
        clearTimeout(phaseDeadline);
        phase.abort();
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.current !== connection) throw new DiagnosticError("cancelled", "JOIN_CANCELLED");
      await entersState(connection, VoiceConnectionStatus.Ready, controller.signal);
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
