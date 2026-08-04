from __future__ import annotations

import math

import discord
from discord import app_commands
from discord.ext import commands

from elysium.config import ElysiumConfig
from elysium.constants import BRAND_COLOR, VERSION
from elysium.runtime import RuntimeState
from elysium.services.audit_service import AuditService
from elysium.utils.time_format import format_duration
from elysium.services.expedition_voice_service import ExpeditionVoiceService


class SystemCog(commands.Cog):
    def __init__(
        self,
        bot: commands.Bot,
        config: ElysiumConfig,
        state: RuntimeState,
        audit_service: AuditService,
        voice_service: ExpeditionVoiceService,
    ) -> None:
        self._bot = bot
        self._config = config
        self._state = state
        self._audit = audit_service
        self._voice = voice_service

    @app_commands.command(
        name="status",
        description="Exibe o estado operacional do Elysium System.",
    )
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    async def status(self, interaction: discord.Interaction) -> None:
        if interaction.guild_id != self._config.guild_id:
            await interaction.response.send_message(
                "Este comando só está disponível no servidor configurado.",
                ephemeral=True,
            )
            return
        if (
            not isinstance(interaction.user, discord.Member)
            or not interaction.user.guild_permissions.administrator
        ):
            await interaction.response.send_message(
                "Somente administradores podem consultar este status.",
                ephemeral=True,
            )
            return

        guild = self._bot.get_guild(self._config.guild_id)
        ready = self._bot.is_ready()
        if not ready:
            operational_status = "Inicializando"
        elif guild is None or (self._audit.configured and self._audit.available is False):
            operational_status = "Degradado"
        else:
            operational_status = "Operacional"

        latency = self._bot.latency
        latency_text = (
            f"{round(latency * 1000)} ms"
            if ready and math.isfinite(latency) and latency >= 0
            else "Indisponível"
        )
        if not self._audit.configured:
            audit_text = "Não configurado"
        elif self._audit.available is False:
            audit_text = "Indisponível"
        else:
            audit_text = "Configurado"

        embed = discord.Embed(
            title="Elysium System",
            description="Estado operacional do sistema.",
            color=BRAND_COLOR,
        )
        fields = {
            "Estado": operational_status,
            "Versão": VERSION,
            "Latência": latency_text,
            "Tempo online": format_duration(self._state.uptime_seconds),
            "Servidor": guild.name if guild else "Indisponível",
            "Comandos": str(self._state.command_count),
            "Canal de logs": audit_text,
            "Salas temporárias": (
                "Não configurado"
                if not self._voice.configured
                else "Degradado"
                if self._voice.degraded
                else f"Operacional — {self._voice.active_room_count} ativa(s)"
            ),
        }
        for name, value in fields.items():
            embed.add_field(name=name, value=value, inline=False)
        embed.set_footer(text="Elysium • Infraestrutura da comunidade.")
        await interaction.response.send_message(embed=embed, ephemeral=True)
