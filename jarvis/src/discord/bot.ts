import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction, type GuildMember, type VoiceChannel,
} from 'discord.js';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { Config } from '../config.js';
import { Logger, Metrics } from '../observability/metrics.js';
import { DiagnosticError, JoinDiagnostics, sanitizeError } from '../observability/diagnostics.js';
import { inspectVoiceRuntime } from '../observability/voice-runtime.js';
import { authorize, AuthorizationError } from '../policy/authorization.js';
import { ConsentStore } from '../policy/consent.js';
import { speakerContext, type SpeakerContext } from '../policy/identity.js';
import { promptVariables } from '../agents/prompt-context.js';
import { connectAgent } from '../agents/elevenlabs-client.js';
import { SessionError, SessionManager, type TurnNotification, type TurnReceipt } from '../agents/session-manager.js';
import { ElevenWakeDetector } from '../agents/wake-detector.js';
import { searchGameInfo } from '../tools/game-search.js';
import { PlaybackQueue } from '../audio/playback.js';
import { rms } from '../audio/voice-activity.js';
import { PlaybackEchoGuard } from '../audio/echo-guard.js';
import { VoiceConnectionManager } from './voice-connection.js';
import { VoiceReceiver } from './voice-receiver.js';
import { jarvisCommand, privacyNotice } from './commands.js';

type Interaction = ChatInputCommandInteraction<'cached'>;
interface Room {
  channel: VoiceChannel;
  consent: ConsentStore;
  receiver: VoiceReceiver;
  playback: PlaybackQueue;
  sessions: SessionManager;
  probe: Map<string, { turns: number; seconds: number; rms: number }>;
  echo: PlaybackEchoGuard;
  interruptions: Map<string, AbortController>;
}

export class JarvisBot {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  private readonly voice = new VoiceConnectionManager();
  private readonly metrics = new Metrics();
  private room?: Room;
  private joining = false;
  private closed = false;
  private epoch = 0;
  private readonly wake: ElevenWakeDetector;

  constructor(private readonly config: Config, private readonly logger: Logger) {
    this.wake = new ElevenWakeDetector(config.ELEVENLABS_API_KEY ?? '', config.JARVIS_WAKE_WORD,
      config.JARVIS_MAX_WAKE_CHECKS_PER_MINUTE, this.metrics.record);
    this.client.once(Events.ClientReady, () => {
      void this.ready().catch(() => { this.logger.event('command_registration_failed', 'error'); void this.stop(); });
    });
    this.client.on(Events.Error, () => this.logger.event('discord_client_error', 'error'));
    this.client.on(Events.ShardError, () => this.logger.event('discord_gateway_error', 'warn'));
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'jarvis') {
        void this.handle(interaction).catch(() => this.logger.event('interaction_response_failed', 'warn'));
      }
    });
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      const room = this.room;
      if (!room || before.guild.id !== config.JARVIS_GUILD_ID) return;
      if (after.id === this.client.user?.id && after.channelId !== room.channel.id) { this.reset(); return; }
      if (before.channelId === room.channel.id && after.channelId !== room.channel.id) this.revoke(room, after.id);
      if (!room.channel.members.some((member) => !member.user.bot)) this.reset();
    });
  }

  async start(): Promise<void> { await this.client.login(this.config.JARVIS_DISCORD_TOKEN); }
  private async ready(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.JARVIS_GUILD_ID);
    if (this.closed) return;
    // Create/upsert only Jarvis; do not bulk replace other application commands.
    await guild.commands.create(jarvisCommand.toJSON());
    this.logger.event(this.config.daveSmoke ? 'dave_probe_ready' : 'jarvis_ready', 'info', {
      diagnostics_version: 5,
      ...(!this.config.daveSmoke ? { first_message_override_requested: this.config.JARVIS_SUPPRESS_FIRST_MESSAGE } : {}),
    });
  }

  private async reply(interaction: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
    const payload = { content, allowedMentions: { parse: [] as [] } };
    if (interaction.deferred) await interaction.editReply(payload);
    else if (interaction.replied) await interaction.followUp({ ...payload, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    else await interaction.reply({ ...payload, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  }

  private context(room: Room, member: GuildMember): SpeakerContext {
    const consent = room.consent.get(member.id);
    return speakerContext({ discordUserId: member.id, displayName: member.displayName,
      guildId: member.guild.id, channelId: room.channel.id, consented: Boolean(consent),
      consentVersion: consent?.version ?? -1 }, this.config.JARVIS_OWNER_USER_ID);
  }

  private allowed(room: Room, speaker: SpeakerContext, audio = false): boolean {
    const member = room.channel.members.get(speaker.discordUserId);
    return this.room === room && Boolean(member && !member.user.bot)
      && room.consent.isCurrent(speaker.discordUserId, speaker.consentVersion, audio);
  }

  private requireRoom(interaction: Interaction): Room {
    const room = this.room;
    if (!room || interaction.member.voice.channelId !== room.channel.id) {
      throw new Error('same_channel');
    }
    return room;
  }

  private async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild() || interaction.guildId !== this.config.JARVIS_GUILD_ID || this.closed) {
      await this.reply(interaction, 'Jarvis está disponível somente no servidor configurado.'); return;
    }
    const command = interaction.options.getSubcommand();
    const diagnostic = command === 'join' ? new JoinDiagnostics(this.logger) : undefined;
    try {
      if (command === 'privacy') {
        await this.reply(interaction, privacyNotice(this.config.JARVIS_VOICE_INPUT, this.config.daveSmoke,
          this.config.JARVIS_FOLLOWUP_SECONDS, this.config.JARVIS_BARGE_IN_ENABLED)); return;
      }
      if (command === 'status') {
        const room = this.room;
        let probe = '';
        if (room && this.config.daveSmoke && interaction.user.id === this.config.JARVIS_OWNER_USER_ID) {
          // Ephemeral ID-labelled counters are for verifying gateway attribution, never production logs.
          probe = '\nProva por falante consentido: ' + JSON.stringify(Object.fromEntries(room.probe));
        }
        const snapshot = this.metrics.snapshot();
        // Streaming evidence remains visible even when legacy counters fill the reply.
        const streaming = ['voice_turns_captured', 'voice_wake_activations', 'agent_input_audio_chunks',
          'agent_user_turns_recognized', 'agent_responses_after_recognition', 'agent_initial_audio_discarded',
          'agent_user_turn_missing', 'questions_received', 'questions_queued', 'questions_cancelled', 'turn_queue_depth',
          'agent_turns_superseded', 'agent_first_audio_ms_last', 'agent_first_playback_ms_last',
          'next_question_ready_ms_last', 'audio_stream_started', 'audio_chunks_received', 'audio_chunks_played',
          'audio_stream_buffer_bytes', 'playback_started', 'playback_completed', 'agent_response_received',
          'agent_response_complete_received', 'turn_completion_missing', 'playback_failed'];
        const counters = JSON.stringify({ ...Object.fromEntries(streaming.map((name) => [name, snapshot[name] ?? 0])), ...snapshot });
        await this.reply(interaction, `${room ? 'Conectado' : 'Desconectado'}; modo: ${this.config.daveSmoke
          ? 'diagnóstico DAVE local' : this.config.JARVIS_VOICE_INPUT}; sessões: ${room?.sessions.activeCount ?? 0};`
          + ` perguntas na fila: ${room?.sessions.queuedCount ?? 0}; interrupção por voz: ${this.config.JARVIS_BARGE_IN_ENABLED ? 'experimental' : 'desativada'}.`
          + `\nContadores (não estimam créditos): ${counters}${probe}`.slice(0, 1750)); return;
      }
      if (command === 'revoke') {
        if (this.room) this.revoke(this.room, interaction.user.id);
        await this.reply(interaction, 'Consentimento revogado; sua captura, sessão e resposta foram canceladas.'); return;
      }
      if (command === 'join') {
        diagnostic!.stage('authorize');
        authorize(interaction.user.id, 'join', this.config.JARVIS_OWNER_USER_ID);
        const requestEpoch = this.epoch;
        diagnostic!.stage('interaction_ack');
        await interaction.deferReply();
        if (this.closed || this.epoch !== requestEpoch) throw new SessionError('closed');
        diagnostic!.stage('channel_lookup');
        await this.join(interaction, diagnostic);
        diagnostic!.stage('join_reply');
        await this.reply(interaction, 'Jarvis conectado. ' + privacyNotice(this.config.JARVIS_VOICE_INPUT, this.config.daveSmoke,
          this.config.JARVIS_FOLLOWUP_SECONDS, this.config.JARVIS_BARGE_IN_ENABLED), false);
        diagnostic!.success();
        return;
      }
      if (command === 'leave') {
        authorize(interaction.user.id, 'leave', this.config.JARVIS_OWNER_USER_ID);
        this.reset();
        await this.reply(interaction, 'Jarvis desconectado; consentimentos e buffers apagados.'); return;
      }
      const room = this.requireRoom(interaction);
      if (command === 'cancel') {
        room.sessions.cancelUser(interaction.user.id);
        await this.reply(interaction, 'Suas perguntas pendentes e sua resposta em andamento foram canceladas.'); return;
      }
      if (command === 'tone') {
        authorize(interaction.user.id, 'configure', this.config.JARVIS_OWNER_USER_ID);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tone = Buffer.alloc(48_000 * 2);
        for (let i = 0; i < 48_000; i++) tone.writeInt16LE(Math.round(1200 * Math.sin(2 * Math.PI * 440 * i / 48_000)), i * 2);
        await room.playback.play(interaction.user.id, tone, 48_000, true);
        tone.fill(0);
        await this.reply(interaction, 'Tom reproduzido. Confirme a audição para registrar o teste de playback.'); return;
      }
      if (command === 'consent') {
        const audio = interaction.options.getBoolean('audio') === true;
        if (audio && !this.config.daveSmoke && this.config.JARVIS_VOICE_INPUT === 'disabled') {
          await this.reply(interaction, 'Captura de voz desativada. Use /jarvis consent sem áudio e /jarvis ask.'); return;
        }
        this.revoke(room, interaction.user.id);
        room.consent.grant(interaction.user.id, audio);
        await this.reply(interaction, (audio ? 'Aceite de áudio registrado. ' : 'Aceite de perguntas escritas registrado. ')
          + privacyNotice(this.config.JARVIS_VOICE_INPUT, this.config.daveSmoke,
            this.config.JARVIS_FOLLOWUP_SECONDS, this.config.JARVIS_BARGE_IN_ENABLED)); return;
      }
      if (command === 'ask') {
        if (this.config.daveSmoke) { await this.reply(interaction, 'Diagnóstico DAVE não conecta à ElevenLabs.'); return; }
        authorize(interaction.user.id, 'ask', this.config.JARVIS_OWNER_USER_ID);
        const speaker = this.context(room, interaction.member);
        if (!speaker.consented) { await this.reply(interaction, 'Leia /jarvis privacy e aceite com /jarvis consent.'); return; }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let acknowledge!: () => void;
        const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
        let receipt: TurnReceipt | undefined;
        try {
          receipt = await room.sessions.ask(speaker, interaction.options.getString('texto', true), async (event) => {
            if (event.type === 'queued') return;
            await acknowledged;
            // Replies contain only status. Do not re-send questions or provider text.
            if (event.type === 'started' && (!receipt?.queued || this.closed || this.room !== room)) return;
            const content = this.turnNotice(event);
            if (content) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          });
          await this.reply(interaction, receipt.queued
            ? `Pergunta enfileirada (posição ${receipt.position}). Avisarei quando começar ou for cancelada.`
            : 'Pergunta aceita. A resposta será falada nesta chamada.');
        } finally { acknowledge(); }
      }
    } catch (error) {
      // Report before attempting a Discord response, which can fail independently.
      diagnostic?.failure(error);
      let message: string;
      if (error instanceof AuthorizationError) message = 'Ação reservada ao criador autenticado do Jarvis.';
      else if (error instanceof SessionError) {
        message = error.code === 'consent' ? 'Renove o consentimento para continuar.'
          : error.code === 'busy' ? 'Jarvis está atendendo. Aguarde o fim da resposta e tente novamente.'
            : error.code === 'limit' ? 'Limite de uso atingido. Aguarde antes de tentar novamente.'
              : 'A sessão foi encerrada. Tente novamente.';
      } else {
        const id = diagnostic?.incident ?? this.logger.event('jarvis_command_failed', 'warn');
        message = (error instanceof Error && error.message === 'same_channel')
          || (error instanceof DiagnosticError && error.code === 'CHANNEL_NOT_FOUND')
          ? 'Entre na mesma chamada que Jarvis antes de usar este comando.'
          : error instanceof DiagnosticError && error.code === 'CHANNEL_RESTRICTED'
            ? 'Este canal de voz não é o canal configurado para Jarvis.'
          : error instanceof DiagnosticError && error.code === 'CHANNEL_FULL'
            ? 'O canal de voz está lotado. Libere uma vaga e tente novamente.'
          : error instanceof DiagnosticError && error.category === 'permissions'
            ? 'Sem permissão Connect, View Channel ou Speak. Revise as permissões deste canal.'
            : `Não foi possível concluir. Verifique a configuração e tente novamente. Incidente ${id}.`;
      }
      // Always give join failures the same correlation ID, including expected denials.
      if (diagnostic && !message.includes(diagnostic.incident)) message += ` Incidente ${diagnostic.incident}.`;
      try { await this.reply(interaction, message); }
      catch (responseError) {
        if (!diagnostic) throw responseError;
        diagnostic.event('interaction_response_failed', 'error', { stage: 'join_reply', ...sanitizeError(responseError) });
      }
    }
  }

  private async join(interaction: Interaction, diagnostic?: JoinDiagnostics): Promise<void> {
    if (this.joining) throw new SessionError('busy');
    if (this.closed) throw new SessionError('closed');
    // Lock before the first await: /leave must invalidate even a pending fetchMe().
    this.joining = true;
    const preparationEpoch = this.epoch;
    let connection: VoiceConnection | undefined;
    let initialized: Room | undefined;
    try {
      diagnostic?.stage('channel_lookup');
      const channel = interaction.member.voice.channel;
      if (!channel || channel.type !== ChannelType.GuildVoice) throw new DiagnosticError('channel', 'CHANNEL_NOT_FOUND');
      diagnostic?.stage('channel_restriction');
      if (this.config.JARVIS_DEFAULT_VOICE_CHANNEL_ID && channel.id !== this.config.JARVIS_DEFAULT_VOICE_CHANNEL_ID) {
        throw new DiagnosticError('channel', 'CHANNEL_RESTRICTED');
      }
      if (this.room?.channel.id === channel.id) return;
      diagnostic?.stage('member_fetch');
      const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (this.closed || this.epoch !== preparationEpoch) throw new SessionError('closed');
      diagnostic?.stage('permissions');
      const permissions = channel.permissionsFor(me);
      const view = permissions?.has(PermissionFlagsBits.ViewChannel) ?? false;
      const connect = permissions?.has(PermissionFlagsBits.Connect) ?? false;
      const speak = permissions?.has(PermissionFlagsBits.Speak) ?? false;
      diagnostic?.event('jarvis_join_step', 'info', { permission_view: view, permission_connect: connect, permission_speak: speak });
      if (!view || !connect || !speak) {
        throw new DiagnosticError('permissions', 'DISCORD_MISSING_PERMISSIONS');
      }
      diagnostic?.stage('channel_capacity');
      diagnostic?.event('jarvis_join_step', 'info', { permission_full: channel.full });
      if (channel.full && !permissions?.has(PermissionFlagsBits.MoveMembers)) throw new DiagnosticError('channel', 'CHANNEL_FULL');
      diagnostic?.stage('runtime_probe');
      if (diagnostic) await inspectVoiceRuntime(diagnostic);
      // Neither a delayed lookup nor a native probe may reconnect after /leave.
      if (this.closed || this.epoch !== preparationEpoch) throw new SessionError('closed');
      if (interaction.member.voice.channel?.id !== channel.id) throw new DiagnosticError('cancelled', 'JOIN_CANCELLED');
      diagnostic?.stage('previous_room_cleanup');
      this.reset();
      const epoch = this.epoch;
      diagnostic?.stage('voice_connect');
      connection = await this.voice.join(channel, diagnostic);
      if (this.closed || this.epoch !== epoch) { this.voice.leave(); throw new SessionError('closed'); }
      diagnostic?.stage('playback_setup');
      const echo = new PlaybackEchoGuard();
      const playback = new PlaybackQueue(connection, { maxQueue: 4, maxSeconds: 120,
        maxBufferBytes: 384 * 1024, onMetric: this.metrics.record,
        onPcmFrame: (pcm) => { if (this.config.JARVIS_BARGE_IN_ENABLED) echo.remember(pcm); } });
      const consent = new ConsentStore();
      // Closure is assigned before any receiver subscriptions are started.
      const room = { channel, consent, playback, echo, probe: new Map(), interruptions: new Map() } as Room;
      initialized = room;
      diagnostic?.stage('session_setup');
      room.sessions = new SessionManager({
        connect: (speaker, callbacks, signal) => connectAgent({
          apiKey: this.config.ELEVENLABS_API_KEY!, agentId: this.config.ELEVENLABS_AGENT_ID!,
          suppressFirstMessage: this.config.JARVIS_SUPPRESS_FIRST_MESSAGE,
          dynamicVariables: promptVariables(speaker, channel.guild.name), callbacks, signal,
          tools: async (name, parameters) => {
            if (!this.allowed(room, speaker)) throw new AuthorizationError();
            // No administrative tools exposed. Unknown tools fail closed regardless of agent claims.
            if (name !== 'search_game_info') throw new AuthorizationError();
            authorize(speaker.discordUserId, 'search_game_info', this.config.JARVIS_OWNER_USER_ID);
            if (!parameters || typeof parameters !== 'object') throw new Error('tool_parameters');
            const values = parameters as Record<string, unknown>;
            if (typeof values.game !== 'string' || typeof values.query !== 'string') throw new Error('tool_parameters');
            this.metrics.add('search_calls');
            return searchGameInfo(values.game, values.query, this.config.JARVIS_SEARCH_API_KEY, signal);
          },
        }),
        allowed: (speaker, audio) => this.allowed(room, speaker, audio),
        detectWake: (pcm, signal) => this.wake.detect(pcm, signal),
        playback, maxSessions: this.config.JARVIS_MAX_ACTIVE_SESSIONS,
        maxTurnSeconds: this.config.JARVIS_MAX_AUDIO_SECONDS_PER_TURN,
        maxSessionSeconds: this.config.JARVIS_MAX_SESSION_SECONDS,
        idleSeconds: this.config.JARVIS_SESSION_IDLE_SECONDS, followupSeconds: this.config.JARVIS_FOLLOWUP_SECONDS,
        maxTurnsPerHour: this.config.JARVIS_MAX_TURNS_PER_HOUR, metric: this.metrics.record, logger: this.logger,
        maxQueuedTurns: this.config.JARVIS_MAX_QUEUED_TURNS,
        maxQueuedPerUser: this.config.JARVIS_MAX_QUEUED_PER_USER,
        queueTtlSeconds: this.config.JARVIS_QUESTION_QUEUE_TTL_SECONDS,
        notify: async (speaker, event) => {
          if (event.type === 'started') return;
          if ((this.room !== room || this.closed) && event.type !== 'cancelled' && event.type !== 'failed') return;
          const content = this.turnNotice(event);
          if (content) await channel.send({ content: `<@${speaker.discordUserId}> ${content}`, allowedMentions: { parse: [] } });
        },
      });
      diagnostic?.stage('receiver_setup');
      room.receiver = new VoiceReceiver(connection, {
        ownUserId: this.client.user!.id, maxTurnSeconds: this.config.JARVIS_MAX_AUDIO_SECONDS_PER_TURN,
        isPlaying: () => playback.isAudible,
        playbackToken: () => playback.currentStreamToken,
        canBargeIn: (id) => this.config.JARVIS_BARGE_IN_ENABLED && !this.config.daveSmoke
          && id === this.config.JARVIS_OWNER_USER_ID && this.room === room && Boolean(consent.get(id)?.audio),
        canReceive: (id) => {
          const member = channel.members.get(id);
          return this.room === room && Boolean(member && !member.user.bot && consent.get(id)?.audio)
            && (this.config.daveSmoke || this.config.JARVIS_VOICE_INPUT === 'elevenlabs-stt');
        },
        onTurn: async (id, pcm, timing) => {
          const member = channel.members.get(id);
          if (!member || this.room !== room || !consent.get(id)?.audio) return;
          if (this.config.daveSmoke) {
            if (room.probe.size >= 16 && !room.probe.has(id)) return;
            const prior = room.probe.get(id) ?? { turns: 0, seconds: 0, rms: 0 };
            room.probe.set(id, { turns: prior.turns + 1, seconds: prior.seconds + pcm.length / 192_000, rms: rms(pcm) });
            return;
          }
          if (timing.duringPlayback) {
            await this.voiceInterruption(room, member, pcm, timing.playbackToken);
            return;
          }
          try { await room.sessions.voiceTurn(this.context(room, member), pcm, timing); }
          catch {
            this.metrics.add('voice_turn_rejected');
            if (this.room === room && consent.get(id)?.audio) {
              await channel.send({ content: `<@${id}> Não foi possível aceitar a pergunta de voz. Confira /jarvis status ou use /jarvis ask.`,
                allowedMentions: { parse: [] } }).catch(() => this.metrics.add('turn_notification_failed'));
            }
          }
        }, onMetric: this.metrics.record,
      });
      this.room = room;
      connection.on('stateChange', (_oldState, state) => {
        if (state.status === VoiceConnectionStatus.Destroyed && this.room === room) this.reset();
        else if (this.room === room && state.status === VoiceConnectionStatus.Disconnected) {
          for (const abort of room.interruptions.values()) abort.abort();
          room.interruptions.clear();
          room.echo.clear();
          room.sessions.setAvailable(false);
        } else if (this.room === room && state.status === VoiceConnectionStatus.Ready) room.sessions.setAvailable(true);
      });
      room.receiver.start();
      this.metrics.add('voice_joins');
    } catch (error) {
      // Failed setup must not leave a connected bot with half-initialized resources.
      // Guard by connection ownership so a cancelled attempt cannot destroy a successor.
      if (connection && this.voice.connection === connection) {
        if (this.room === initialized) this.room = undefined;
        const cleanup = [
          () => initialized?.consent.clear(),
          () => initialized?.receiver?.stop(),
          () => initialized?.sessions?.close(),
          () => initialized?.playback.stop(),
          () => initialized?.echo.clear(),
          () => this.voice.leave(),
        ];
        for (const action of cleanup) {
          try { action(); }
          catch (cleanupError) {
            diagnostic?.event('jarvis_voice_error', 'error', { stage: 'previous_room_cleanup', ...sanitizeError(cleanupError) });
          }
        }
      }
      throw error;
    } finally { this.joining = false; }
  }

  private revoke(room: Room, userId: string): void {
    room.interruptions.get(userId)?.abort();
    room.interruptions.delete(userId);
    room.consent.revoke(userId);
    room.receiver.stopUser(userId);
    room.sessions.revoke(userId);
    room.probe.delete(userId);
  }
  private reset(): void {
    this.epoch++;
    const room = this.room;
    this.room = undefined;
    if (room) {
      for (const abort of room.interruptions.values()) abort.abort();
      room.interruptions.clear();
      room.consent.clear();
      room.receiver.stop();
      room.sessions.close();
      room.playback.stop();
      room.probe.clear();
      room.echo.clear();
    }
    this.voice.leave();
  }

  private turnNotice(event: TurnNotification): string | undefined {
    if (event.type === 'queued') return `Pergunta de voz enfileirada (posição ${event.position ?? 1}).`;
    if (event.type === 'started') return 'Sua pergunta saiu da fila e está sendo atendida.';
    if (event.type === 'failed') return 'Não foi possível responder à sua pergunta. Tente novamente ou confira /jarvis status.';
    if (event.reason === 'expired') return 'Sua pergunta foi cancelada porque o prazo na fila expirou.';
    if (event.type === 'cancelled') return 'Sua pergunta ou resposta pendente foi cancelada.';
    return undefined;
  }

  private async voiceInterruption(room: Room, member: GuildMember, pcm: Buffer, playbackToken?: number): Promise<void> {
    const speaker = this.context(room, member);
    if (!this.config.JARVIS_BARGE_IN_ENABLED || member.id !== this.config.JARVIS_OWNER_USER_ID
      || !speaker.isOwner || !this.allowed(room, speaker, true) || room.interruptions.has(member.id)
      || playbackToken === undefined || room.playback.currentStreamToken !== playbackToken || !room.playback.isAudible) return;
    if (room.echo.isLikelyEcho(pcm)) { this.metrics.add('barge_in_echo_rejected'); return; }
    const abort = new AbortController();
    room.interruptions.set(member.id, abort);
    try {
      const result = await this.wake.inspect(pcm, abort.signal, { allowInterruption: true });
      if (!abort.signal.aborted && this.allowed(room, speaker, true) && result.interrupt
        && room.playback.currentStreamToken === playbackToken && room.playback.isAudible
        && this.voice.connection?.state.status === VoiceConnectionStatus.Ready) {
        room.sessions.interruptOwner(speaker);
      } else this.metrics.add('barge_in_not_confirmed');
    } catch { if (!abort.signal.aborted) this.metrics.add('barge_in_failed'); }
    finally { if (room.interruptions.get(member.id) === abort) room.interruptions.delete(member.id); }
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.reset();
    await this.client.destroy();
    this.logger.event('jarvis_stopped');
  }
}
