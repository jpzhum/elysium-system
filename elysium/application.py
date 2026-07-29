from __future__ import annotations

import logging
import math
from asyncio import Lock
from time import perf_counter

import discord
from discord import app_commands
from discord.ext import commands

from elysium.cogs.portal import PortalCog
from elysium.cogs.system import SystemCog
from elysium.config import ElysiumConfig
from elysium.constants import VERSION
from elysium.errors import InteractionErrorHandler
from elysium.runtime import RuntimeState
from elysium.services.audit_service import AuditService
from elysium.services.role_service import RoleService
from elysium.views.concluir_entrada import ConcluirEntradaView
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
        self.interaction_error_handler = InteractionErrorHandler(self.audit_service)
        self.health_server = HealthServer(
            config.port,
            self.is_ready,
            lambda: self.runtime_state.uptime_seconds,
            self._latency_ms,
            lambda: self.get_guild(config.guild_id) is not None,
            config.log_channel_id is not None,
        )
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
        self.add_view(ConcluirEntradaView(self.role_service, self.audit_service))
        await self.add_cog(
            PortalCog(self.config, self.role_service, self.audit_service),
            guild=self.guild_object,
        )
        await self.add_cog(
            SystemCog(self, self.config, self.runtime_state, self.audit_service),
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
                return
            if self.runtime_state.disconnected_at is not None:
                await self._log_reconnection()

    async def on_disconnect(self) -> None:
        self.runtime_state.mark_disconnected()
        logger.warning(
            "Conexão com o Discord interrompida.",
            extra={"event": "discord_disconnected"},
        )

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
        await self.health_server.close()
        await super().close()


def create_bot(config: ElysiumConfig) -> ElysiumBot:
    return ElysiumBot(config)
