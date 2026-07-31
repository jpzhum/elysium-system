from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from elysium.config import ElysiumConfig
from elysium.constants import BRAND_COLOR, PRESENTATION_CREATE_CUSTOM_ID
from elysium.services.audit_service import AuditService
from elysium.services.presentation_service import PresentationService
from elysium.views.presentation_panel import PresentationPanelView


def build_panel_embed(config: ElysiumConfig) -> discord.Embed:
    embed = discord.Embed(
        title="Apresente-se ao Elysium",
        description=(
            "Toda presença começa com uma primeira impressão.\n\n"
            "Use os controles abaixo para criar e administrar sua apresentação. "
            "Compartilhe apenas aquilo com que se sentir confortável."
        ),
        color=BRAND_COLOR,
    )
    embed.add_field(
        name="Como funciona",
        value=(
            "• Crie somente uma apresentação.\n"
            "• Atualize suas informações quando quiser.\n"
            "• Nenhum dado pessoal é obrigatório."
        ),
        inline=False,
    )
    embed.set_footer(text="Elysium • Toda conexão começa com um primeiro passo.")
    if config.presentation_banner_url:
        embed.set_image(url=config.presentation_banner_url)
    return embed


class PresentationsCog(commands.Cog):
    def __init__(
        self,
        config: ElysiumConfig,
        service: PresentationService,
        audit_service: AuditService,
    ) -> None:
        self._config = config
        self._service = service
        self._audit = audit_service

    @app_commands.command(
        name="publicar_apresentacoes",
        description="Publica o painel oficial de apresentações do Elysium.",
    )
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    async def publicar_apresentacoes(self, interaction: discord.Interaction) -> None:
        if self._config.presentation_channel_id is None:
            await interaction.response.send_message(
                "O canal de apresentações não está configurado.", ephemeral=True
            )
            return
        if (
            interaction.guild_id != self._config.guild_id
            or interaction.channel_id != self._config.presentation_channel_id
        ):
            await interaction.response.send_message(
                "Use este comando somente no canal de apresentações configurado.", ephemeral=True
            )
            return
        if (
            not isinstance(interaction.user, discord.Member)
            or not interaction.user.guild_permissions.administrator
        ):
            await interaction.response.send_message(
                "Somente administradores podem publicar este painel.", ephemeral=True
            )
            return
        channel = await self._service.resolve_channel()
        if channel is None:
            await interaction.response.send_message(
                "O canal de apresentações está indisponível.", ephemeral=True
            )
            return
        async for message in channel.history(limit=100):
            if any(
                getattr(component, "custom_id", None) == PRESENTATION_CREATE_CUSTOM_ID
                for row in message.components
                for component in getattr(row, "children", ())
            ):
                await interaction.response.send_message(
                    f"O painel de apresentações já existe.\n\n[Ver painel]({message.jump_url})",
                    ephemeral=True,
                    allowed_mentions=discord.AllowedMentions.none(),
                )
                return
        message = await channel.send(
            embed=build_panel_embed(self._config),
            view=PresentationPanelView(self._config, self._service, self._audit),
            allowed_mentions=discord.AllowedMentions.none(),
        )
        await interaction.response.send_message(
            "Painel de apresentações publicado com sucesso.\n\n"
            f"[Ver painel]({message.jump_url})",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )
