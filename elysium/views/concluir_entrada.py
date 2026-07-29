from __future__ import annotations

import discord

from elysium.constants import BRAND_COLOR, CONCLUIR_ENTRADA_CUSTOM_ID
from elysium.services.role_service import RoleOutcome, RoleService

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

    def __init__(self, role_service: RoleService) -> None:
        super().__init__(timeout=None)
        self._role_service = role_service

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
        await interaction.followup.send(embed=embed, ephemeral=True)
