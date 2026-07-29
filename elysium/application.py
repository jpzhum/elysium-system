from __future__ import annotations

import logging

import discord
from discord.ext import commands

from elysium.cogs.portal import PortalCog
from elysium.config import ElysiumConfig
from elysium.services.role_service import RoleService
from elysium.views.concluir_entrada import ConcluirEntradaView
from elysium.web.health import HealthServer

logger = logging.getLogger("elysium")


class ElysiumBot(commands.Bot):
    def __init__(self, config: ElysiumConfig) -> None:
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)
        self.config = config
        self.role_service = RoleService(
            config.habitante_role_id,
            config.visitante_role_id,
        )
        self.health_server = HealthServer(config.port, self.is_ready)
        self.guild_object = discord.Object(id=config.guild_id)

    async def setup_hook(self) -> None:
        await self.health_server.start()
        self.add_view(ConcluirEntradaView(self.role_service))
        await self.add_cog(
            PortalCog(self.config, self.role_service),
            guild=self.guild_object,
        )
        synced = await self.tree.sync(guild=self.guild_object)
        logger.info(
            "%s comando(s) sincronizado(s) no servidor %s.",
            len(synced),
            self.config.guild_id,
        )

    async def on_ready(self) -> None:
        if self.user is not None:
            logger.info("Conectado como %s (%s).", self.user, self.user.id)

    async def close(self) -> None:
        await self.health_server.close()
        await super().close()


def create_bot(config: ElysiumConfig) -> ElysiumBot:
    return ElysiumBot(config)
