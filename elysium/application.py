from __future__ import annotations

import logging
import math
from asyncio import Lock
from time import perf_counter

import discord
from discord import app_commands
from discord.ext import commands

from elysium.cogs.portal import PortalCog
from elysium.cogs.expeditions import ExpeditionsCog
from elysium.cogs.boletim import BoletimCog
from elysium.cogs.presentations import PresentationsCog
from elysium.cogs.system import SystemCog
from elysium.config import ElysiumConfig
from elysium.constants import VERSION
from elysium.errors import InteractionErrorHandler
from elysium.runtime import RuntimeState
from elysium.services.audit_service import AuditService
from elysium.services.role_service import RoleService
from elysium.services.presentation_service import PresentationService
from elysium.services.expedition_service import ExpeditionService
from elysium.services.expedition_voice_service import ExpeditionVoiceService
from elysium.views.concluir_entrada import ConcluirEntradaView
from elysium.views.presentation_panel import PresentationPanelView
from elysium.views.expedition_items import DYNAMIC_EXPEDITION_ITEMS
from elysium.views.expedition_panel import ExpeditionPanelView
from elysium.web.health import HealthServer

logger = logging.getLogger("elysium")


class ElysiumCommandTree(app_commands.CommandTree):
    async def on_error(
        self,
        interaction: discord.Interaction,
        error: app_commands.AppCommandError,
    ) -> None:
        bot = self.client
        if isinstance(bot, ElysiumBot):
            await bot.interaction_error_handler.handle(interaction, error)
            return
        await super().on_error(interaction, error)


class ElysiumBot(commands.Bot):
    def __init__(self, config: ElysiumConfig) -> None:
        intents = discord.Intents.default()
        intents.members = False
        intents.presences = False
        intents.message_content = False
        intents.voice_states = True
        super().__init__(
            command_prefix="!",
            intents=intents,
            tree_cls=ElysiumCommandTree,
        )
        self.config = config
        self.runtime_state = RuntimeState()
        self.role_service = RoleService(
            config.habitante_role_id,
            config.visitante_role_id,
        )
        self.audit_service = AuditService(self, config.log_channel_id)
        self.presentation_service = PresentationService(
            self, config.presentation_channel_id, self.audit_service
        )
        self.expedition_service = ExpeditionService(
            self, config.expedition_channel_id, self.audit_service
        )
        self.expedition_voice_service = ExpeditionVoiceService(
            self, config, self.expedition_service, self.audit_service
        )
        self.expedition_service.set_mutation_callback(
            self.expedition_voice_service.on_expedition_mutation
        )
        self.interaction_error_handler = InteractionErrorHandler(self.audit_service)
        self.health_server = HealthServer(config.port)
        self.guild_object = discord.Object(id=config.guild_id)
        self._lifecycle_lock = Lock()
        self._last_reconnect_log_at: float | None = None

    async def setup_hook(self) -> None:
        await self.health_server.start()
        if not self.audit_service.configured:
            logger.warning(
                "LOG_CHANNEL_ID não configurado; auditoria disponível somente no stdout.",
                extra={"event": "audit_channel_not_configured"},
            )
        if not self.presentation_service.configured:
            logger.warning(
                "PRESENTATION_CHANNEL_ID não configurado; apresentações indisponíveis.",
                extra={"event": "presentations_not_configured"},
            )
        if not self.expedition_service.configured:
            logger.warning(
                "EXPEDITION_CHANNEL_ID não configurado; expedições indisponíveis.",
                extra={"event": "expeditions_not_configured"},
            )
        if not self.expedition_voice_service.configured:
            logger.warning(
                "EXPEDITION_VOICE_CATEGORY_ID não configurado; salas temporárias desativadas.",
                extra={"event": "expedition_voice_not_configured"},
            )
        self.add_view(ConcluirEntradaView(self.role_service, self.audit_service))
        self.add_view(
            PresentationPanelView(
                self.config, self.presentation_service, self.audit_service
            )
        )
        self.add_view(ExpeditionPanelView(self.config, self.expedition_service, self.audit_service))
        self.add_dynamic_items(*DYNAMIC_EXPEDITION_ITEMS)
        await self.add_cog(
            ExpeditionsCog(
                self.config,
                self.expedition_service,
                self.expedition_voice_service,
                self.audit_service,
            ),
            guild=self.guild_object,
        )
        await self.add_cog(
            BoletimCog(self, self.config, self.audit_service),
            guild=self.guild_object,
        )
        await self.add_cog(
            PresentationsCog(
                self.config, self.presentation_service, self.audit_service
            ),
            guild=self.guild_object,
        )
        await self.add_cog(
            PortalCog(self.config, self.role_service, self.audit_service),
            guild=self.guild_object,
        )
        await self.add_cog(
            SystemCog(
                self,
                self.config,
                self.runtime_state,
                self.audit_service,
                self.expedition_voice_service,
            ),
            guild=self.guild_object,
        )
        synced = await self.tree.sync(guild=self.guild_object)
        self.runtime_state.command_count = len(synced)
        logger.info(
            "%s comando(s) sincronizado(s) no servidor %s.",
            len(synced),
            self.config.guild_id,
        )

    async def on_ready(self) -> None:
        async with self._lifecycle_lock:
            if not self.runtime_state.initial_ready_logged:
                self.runtime_state.initial_ready_logged = True
                guild = self.get_guild(self.config.guild_id)
                user_name = str(self.user) if self.user is not None else "indisponível"
                logger.info(
                    "Elysium System %s iniciado como %s.",
                    VERSION,
                    user_name,
                    extra={"event": "startup_complete", "guild_id": self.config.guild_id},
                )
                await self.audit_service.send(
                    "Elysium System iniciado",
                    {
                        "Versão": VERSION,
                        "Bot": user_name,
                        "Servidor configurado": guild.name if guild else "indisponível",
                        "Comandos sincronizados": self.runtime_state.command_count,
                        "Horário UTC": discord.utils.utcnow().isoformat(),
                        "Ambiente": "operacional",
                    },
                )
                self.runtime_state.log_channel_available = self.audit_service.available
                if guild is not None and self.expedition_voice_service.configured:
                    await self.expedition_voice_service.reconcile(
                        guild, schedule_orphans=True
                    )
                return
            if self.runtime_state.disconnected_at is not None:
                await self._log_reconnection()

    async def on_disconnect(self) -> None:
        self.runtime_state.mark_disconnected()
        logger.warning(
            "Conexão com o Discord interrompida.",
            extra={"event": "discord_disconnected"},
        )

    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        if payload.channel_id == self.config.expedition_channel_id:
            self.expedition_service.invalidate_message(payload.message_id)

    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        del member
        await self.expedition_voice_service.on_voice_state_update(before, after)

    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        await self.expedition_voice_service.on_channel_delete(channel)

    async def on_resumed(self) -> None:
        async with self._lifecycle_lock:
            await self._log_reconnection()

    async def _log_reconnection(self) -> None:
        interruption = self.runtime_state.mark_resumed()
        now = perf_counter()
        if self._last_reconnect_log_at is not None and now - self._last_reconnect_log_at < 10:
            logger.info(
                "Evento de retomada suprimido para evitar duplicação.",
                extra={"event": "resume_suppressed"},
            )
            return
        self._last_reconnect_log_at = now
        duration = (
            f"{round(interruption)} segundos"
            if interruption is not None
            else "indisponível"
        )
        await self.audit_service.send(
            "Conexão restabelecida",
            {
                "Duração aproximada": duration,
                "Latência atual": (
                    f"{self._latency_ms()} ms"
                    if self._latency_ms() is not None
                    else "indisponível"
                ),
                "Horário UTC": discord.utils.utcnow().isoformat(),
            },
        )
        self.runtime_state.log_channel_available = self.audit_service.available

    def _latency_ms(self) -> int | None:
        latency = self.latency
        if not self.is_ready() or not math.isfinite(latency) or latency < 0:
            return None
        return round(latency * 1000)

    async def close(self) -> None:
        await self.expedition_voice_service.shutdown()
        await self.health_server.close()
        await super().close()


def create_bot(config: ElysiumConfig) -> ElysiumBot:
    return ElysiumBot(config)
