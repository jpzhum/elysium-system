from __future__ import annotations

import logging
import secrets

import discord
from discord import app_commands

from elysium.services.audit_service import AuditService

logger = logging.getLogger("elysium.errors")


def create_incident_id() -> str:
    return secrets.token_hex(4).upper()


async def send_ephemeral(interaction: discord.Interaction, message: str) -> None:
    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)


class InteractionErrorHandler:
    def __init__(self, audit_service: AuditService) -> None:
        self._audit = audit_service

    async def handle(
        self,
        interaction: discord.Interaction,
        error: app_commands.AppCommandError,
    ) -> None:
        if isinstance(error, app_commands.CommandInvokeError):
            cause: BaseException = error.original
        else:
            cause = error

        if isinstance(error, app_commands.MissingPermissions):
            logger.warning("Comando recusado por permissões insuficientes.")
            await send_ephemeral(interaction, "Você não tem permissão para usar este comando.")
            return
        if isinstance(error, app_commands.CommandOnCooldown):
            logger.warning("Comando em cooldown.")
            await send_ephemeral(
                interaction,
                f"Aguarde {error.retry_after:.0f} segundos antes de tentar novamente.",
            )
            return
        if isinstance(error, app_commands.CheckFailure):
            logger.warning("Verificação de comando recusou a interação.")
            await send_ephemeral(interaction, "Este comando não está disponível neste contexto.")
            return

        incident_id = create_incident_id()
        logger.exception(
            "Erro inesperado em application command.",
            exc_info=(type(cause), cause, cause.__traceback__),
            extra={
                "event": "command_error",
                "guild_id": interaction.guild_id,
                "user_id": interaction.user.id,
                "channel_id": interaction.channel_id,
                "incident_id": incident_id,
            },
        )
        command_name = interaction.command.qualified_name if interaction.command else "desconhecido"
        await self._audit.send(
            "Erro de comando",
            {
                "Incident ID": incident_id,
                "Comando": command_name,
                "User ID": interaction.user.id,
                "Channel ID": interaction.channel_id or "indisponível",
                "Exceção": type(cause).__name__,
                "Horário UTC": discord.utils.utcnow().isoformat(),
            },
            level=logging.ERROR,
        )
        await send_ephemeral(
            interaction,
            "Não foi possível concluir esta ação.\n\n"
            f"O incidente foi registrado com o código:\n`{incident_id}`\n\n"
            "Tente novamente em alguns instantes.",
        )
