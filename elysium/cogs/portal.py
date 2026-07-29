from __future__ import annotations

import logging

import discord
from discord import app_commands
from discord.ext import commands

from elysium.config import ElysiumConfig
from elysium.constants import BRAND_COLOR
from elysium.services.role_service import RoleService
from elysium.views.concluir_entrada import ConcluirEntradaView

logger = logging.getLogger("elysium.portal")


class PortalCog(commands.Cog):
    def __init__(self, config: ElysiumConfig, role_service: RoleService) -> None:
        self._config = config
        self._role_service = role_service

    @app_commands.command(
        name="publicar_entrada",
        description="Publica o painel oficial para concluir a entrada no Elysium.",
    )
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    async def publicar_entrada(self, interaction: discord.Interaction) -> None:
        if interaction.guild is None or interaction.channel_id != self._config.panel_channel_id:
            await interaction.response.send_message(
                "Use este comando somente no canal **✅・concluir-entrada** configurado.",
                ephemeral=True,
            )
            return

        if (
            not isinstance(interaction.user, discord.Member)
            or not interaction.user.guild_permissions.administrator
        ):
            await interaction.response.send_message(
                "Somente administradores podem publicar este painel.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title="Conclua sua entrada",
            description=(
                "Finalize sua passagem pelo Portal para acessar a comunidade.\n\n"
                "Antes de continuar:\n"
                "• conheça o **Código**;\n"
                "• escolha seus interesses em **Identidade**;\n"
                "• apresente-se quando se sentir confortável.\n\n"
                "Ao clicar no botão, o cargo **Visitante** será substituído por **Habitante**."
            ),
            color=BRAND_COLOR,
        )
        embed.set_footer(text="Elysium • Sua jornada começa aqui.")
        await interaction.response.send_message(
            embed=embed,
            view=ConcluirEntradaView(self._role_service),
        )

    @publicar_entrada.error
    async def publicar_entrada_error(
        self,
        interaction: discord.Interaction,
        error: app_commands.AppCommandError,
    ) -> None:
        logger.exception("Erro no comando /publicar_entrada", exc_info=error)
        message = "Não foi possível publicar o painel. Consulte os logs do serviço."
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
