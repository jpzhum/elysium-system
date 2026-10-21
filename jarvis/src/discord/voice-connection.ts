import {
  entersState, joinVoiceChannel, VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";

/** Owns one guild/channel connection, with bounded join and reconnect waits. */
export class VoiceConnectionManager {
  private current: VoiceConnection | undefined;
  private joining = false;
  private reconnecting = false;
  private reconnectAbort: AbortController | undefined;
  private joinAbort: AbortController | undefined;

  get connection(): VoiceConnection | undefined { return this.current; }

  async join(channel: VoiceChannel): Promise<VoiceConnection> {
    if (this.joining) throw new Error("Uma conexão de voz já está sendo estabelecida.");
    this.joining = true;
    try {
      this.leave();
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        // Keep the library's DAVE default. Never enable unencrypted fallback.
      });
      this.current = connection;
      // Errors are handled without logging payloads, networking details or keys.
      connection.on("error", () => { void this.recover(connection); });
      connection.on("stateChange", (_previous, next) => {
        if (next.status === VoiceConnectionStatus.Disconnected) void this.recover(connection);
        if (next.status === VoiceConnectionStatus.Destroyed && this.current === connection) this.current = undefined;
      });
      const controller = new AbortController();
      this.joinAbort = controller;
      const deadline = setTimeout(() => controller.abort(), 20_000);
      deadline.unref();
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, controller.signal);
      } catch {
        if (this.current === connection) this.leave();
        throw new Error("Não foi possível estabelecer a conexão de voz no prazo.");
      } finally {
        clearTimeout(deadline);
        controller.abort();
        if (this.joinAbort === controller) this.joinAbort = undefined;
      }
      if (this.current !== connection) throw new Error("Conexão de voz cancelada.");
      return connection;
    } finally {
      this.joining = false;
    }
  }

  leave(): void {
    this.joinAbort?.abort();
    this.joinAbort = undefined;
    this.reconnectAbort?.abort();
    this.reconnectAbort = undefined;
    this.reconnecting = false;
    const connection = this.current;
    this.current = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  private async recover(connection: VoiceConnection): Promise<void> {
    if (this.current !== connection || this.joining || this.reconnecting ||
      connection.state.status === VoiceConnectionStatus.Destroyed) return;
    this.reconnecting = true;
    const controller = new AbortController();
    this.reconnectAbort = controller;
    const deadline = setTimeout(() => controller.abort(), 25_000);
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
          if (this.current === connection && !controller.signal.aborted) connection.rejoin();
        });
      } finally {
        clearTimeout(phaseDeadline);
        phase.abort();
      }
      if (this.current !== connection || controller.signal.aborted) return;
      await entersState(connection, VoiceConnectionStatus.Ready, controller.signal);
    } catch {
      // A timeout destroys this connection; manual join can create a fresh session.
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
