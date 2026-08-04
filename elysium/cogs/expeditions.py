from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from elysium.config import ElysiumConfig
from elysium.constants import BRAND_COLOR, EXPEDITION_CREATE_CUSTOM_ID
from elysium.services.audit_service import AuditService
from elysium.services.expedition_service import ExpeditionService
from elysium.services.expedition_voice_service import ExpeditionVoiceService
from elysium.views.expedition_panel import ExpeditionPanelView


def build_expedition_panel_embed(config: ElysiumConfig) -> discord.Embed:
    embed = discord.Embed(
        title="Expedições do Elysium",
        description=(
            "Encontre companhia para jogos, sessões cooperativas e outras experiências da comunidade.\n\n"
            "Crie uma expedição, defina os detalhes e permita que outros Habitantes participem diretamente pelo cartão."
        ),
        color=BRAND_COLOR,
    )
    embed.add_field(
        name="Como funciona",
        value=(
            "• Cada membro pode manter uma expedição ativa.\n"
            "• Participantes entram e saem pelos botões.\n"
            "• O organizador pode atualizar ou encerrar a atividade."
        ),
        inline=False,
    )
    embed.set_footer(text="Elysium • Nenhuma jornada precisa ser solitária.")
    if config.expedition_banner_url:
        embed.set_image(url=config.expedition_banner_url)
    return embed


class ExpeditionsCog(commands.Cog):
    def __init__(self, config: ElysiumConfig, service: ExpeditionService, voice: ExpeditionVoiceService, audit: AuditService) -> None:
        self._config = config
        self._service = service
        self._audit = audit
        self._voice = voice

    @app_commands.command(
        name="sincronizar_salas_expedicao",
        description="Reconcilia as salas temporárias das expedições.",
    )
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    async def sincronizar_salas_expedicao(self, interaction: discord.Interaction) -> None:
        if interaction.guild_id != self._config.guild_id or interaction.guild is None:
            await interaction.response.send_message(
                "Este comando só está disponível no servidor configurado.", ephemeral=True
            )
            return
        if not isinstance(interaction.user, discord.Member) or not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message(
                "Somente administradores podem sincronizar as salas.", ephemeral=True
            )
            return
        if not self._voice.configured:
            await interaction.response.send_message(
                "As salas temporárias não estão configuradas.", ephemeral=True
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        summary = await self._voice.reconcile(
            interaction.guild, schedule_orphans=True, repair_cards=True
        )
        await interaction.followup.send(
            "Sincronização concluída.\n\n"
            f"Expedições verificadas: {summary.expeditions_checked}\n"
            f"Salas ativas: {summary.active_rooms}\n"
            f"Referências inválidas: {summary.invalid_references}\n"
            f"Salas órfãs: {summary.orphan_rooms}\n"
            f"Limpezas agendadas: {summary.cleanups_scheduled}",
            ephemeral=True,
        )

    @app_commands.command(
        name="publicar_expedicoes",
        description="Publica o painel oficial de expedições do Elysium.",
    )
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    async def publicar_expedicoes(self, interaction: discord.Interaction) -> None:
        if self._config.expedition_channel_id is None:
            await interaction.response.send_message("O canal de expedições não está configurado.", ephemeral=True)
            return
        if interaction.guild_id != self._config.guild_id or interaction.channel_id != self._config.expedition_channel_id:
            await interaction.response.send_message("Use este comando somente no canal de expedições configurado.", ephemeral=True)
            return
        if not isinstance(interaction.user, discord.Member) or not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("Somente administradores podem publicar este painel.", ephemeral=True)
            return
        channel = await self._service.resolve_channel()
        if channel is None:
            await interaction.response.send_message("O canal de expedições está indisponível.", ephemeral=True)
            return
        async for message in channel.history(limit=100):
            if any(
                getattr(component, "custom_id", None) == EXPEDITION_CREATE_CUSTOM_ID
                for row in message.components
                for component in getattr(row, "children", ())
            ):
                await interaction.response.send_message(
                    f"O painel de expedições já existe.\n\n[Ver painel]({message.jump_url})",
                    ephemeral=True,
                    allowed_mentions=discord.AllowedMentions.none(),
                )
                return
        message = await channel.send(
            embed=build_expedition_panel_embed(self._config),
            view=ExpeditionPanelView(self._config, self._service, self._audit),
            allowed_mentions=discord.AllowedMentions.none(),
        )
        await interaction.response.send_message(
            f"Painel de expedições publicado com sucesso.\n\n[Ver painel]({message.jump_url})",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )
