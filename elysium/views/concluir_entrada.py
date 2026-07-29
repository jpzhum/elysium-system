from __future__ import annotations

import logging

import discord

from elysium.constants import BRAND_COLOR, CONCLUIR_ENTRADA_CUSTOM_ID
from elysium.errors import create_incident_id, send_ephemeral
from elysium.services.audit_service import AuditService
from elysium.services.role_service import RoleOutcome, RoleService

logger = logging.getLogger("elysium.views.concluir_entrada")

OUTCOME_MESSAGES = {
    RoleOutcome.ROLES_NOT_FOUND: "Não consegui localizar os cargos do Portal. Avise a equipe.",
    RoleOutcome.BOT_MEMBER_UNAVAILABLE: (
        "Não consegui validar as permissões do sistema. Tente novamente em instantes."
    ),
    RoleOutcome.MISSING_PERMISSION: (
        "O Elysium System está sem a permissão **Gerenciar cargos**. Avise a equipe."
    ),
    RoleOutcome.INVALID_HIERARCHY: (
        "O cargo do Elysium System precisa ficar acima de **Habitante** e **Visitante**."
    ),
    RoleOutcome.ALREADY_APPROVED_REMOVE_FAILED: (
        "Você já possui **Habitante**, mas não consegui remover **Visitante**. Avise a equipe."
    ),
    RoleOutcome.ALREADY_APPROVED: (
        "Sua entrada já estava concluída. Você já possui o cargo **Habitante**."
    ),
    RoleOutcome.FORBIDDEN: (
        "O Discord recusou a alteração dos cargos. "
        "Verifique a hierarquia e as permissões do bot."
    ),
    RoleOutcome.HTTP_ERROR: (
        "Ocorreu um erro ao atualizar seus cargos. Tente novamente em alguns segundos."
    ),
}


class ConcluirEntradaView(discord.ui.View):
    """View persistente registrada em toda inicialização."""

    def __init__(self, role_service: RoleService, audit_service: AuditService | None = None) -> None:
        super().__init__(timeout=None)
        self._role_service = role_service
        self._audit = audit_service

    @discord.ui.button(
        label="Concluir entrada",
        emoji="✅",
        style=discord.ButtonStyle.primary,
        custom_id=CONCLUIR_ENTRADA_CUSTOM_ID,
    )
    async def concluir_entrada(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        del button
        if interaction.guild is None or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(
                "Este botão só pode ser usado dentro do Elysium.",
                ephemeral=True,
            )
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        result = await self._role_service.conclude_entry(interaction.guild, interaction.user)

        if result.outcome is not RoleOutcome.SUCCESS:
            if self._audit is not None:
                level = (
                    logging.INFO
                    if result.outcome is RoleOutcome.ALREADY_APPROVED
                    else logging.WARNING
                )
                await self._audit.send(
                    "Falha na entrada" if level == logging.WARNING else "Entrada já concluída",
                    {
                        "Nome de exibição": interaction.user.display_name,
                        "User ID": interaction.user.id,
                        "Motivo": result.outcome.name,
                        "Canal": interaction.channel_id or "indisponível",
                        "Horário UTC": discord.utils.utcnow().isoformat(),
                    },
                    level=level,
                )
            await interaction.followup.send(
                OUTCOME_MESSAGES[result.outcome],
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title="Entrada concluída",
            description=(
                "Você recebeu o cargo **Habitante** e agora pode explorar a comunidade.\n\n"
                "Bem-vindo ao Elysium."
            ),
            color=BRAND_COLOR,
        )
        embed.set_footer(text="Elysium • A place worth remembering.")
        if self._audit is not None:
            await self._audit.send(
                "Entrada concluída",
                {
                    "Nome de exibição": interaction.user.display_name,
                    "User ID": interaction.user.id,
                    "Cargo adicionado": "Habitante",
                    "Cargo removido": "Visitante",
                    "Horário UTC": discord.utils.utcnow().isoformat(),
                },
            )
        await interaction.followup.send(embed=embed, ephemeral=True)

    async def on_error(
        self,
        interaction: discord.Interaction,
        error: Exception,
        item: discord.ui.Item[discord.ui.View],
    ) -> None:
        incident_id = create_incident_id()
        logger.exception(
            "Erro inesperado na persistent view.",
            exc_info=(type(error), error, error.__traceback__),
            extra={
                "event": "view_error",
                "guild_id": interaction.guild_id,
                "user_id": interaction.user.id,
                "channel_id": interaction.channel_id,
                "incident_id": incident_id,
            },
        )
        if self._audit is not None:
            await self._audit.send(
                "Falha na entrada",
                {
                    "Nome de exibição": getattr(interaction.user, "display_name", interaction.user),
                    "User ID": interaction.user.id,
                    "Motivo": f"incidente {incident_id} ({type(error).__name__})",
                    "Canal": interaction.channel_id or "indisponível",
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
        del item
