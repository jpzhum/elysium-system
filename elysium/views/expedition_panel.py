from __future__ import annotations

import discord

from elysium.config import ElysiumConfig
from elysium.constants import EXPEDITION_CREATE_CUSTOM_ID, EXPEDITION_MINE_CUSTOM_ID
from elysium.modals.expedition import ExpeditionModal
from elysium.services.audit_service import AuditService
from elysium.services.expedition_service import ExpeditionOutcome, ExpeditionService


def member_can_use(interaction: discord.Interaction, config: ElysiumConfig) -> bool:
    member = interaction.user
    return bool(
        interaction.guild_id == config.guild_id
        and interaction.channel_id == config.expedition_channel_id
        and isinstance(member, discord.Member)
        and (member.guild_permissions.administrator or any(role.id == config.habitante_role_id for role in member.roles))
    )


class ExpeditionPanelView(discord.ui.View):
    def __init__(self, config: ElysiumConfig, service: ExpeditionService, audit: AuditService) -> None:
        super().__init__(timeout=None)
        self._config = config
        self._service = service
        self._audit = audit

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if member_can_use(interaction, self._config):
            return True
        await interaction.response.send_message("Este painel não está disponível para você neste contexto.", ephemeral=True)
        return False

    @discord.ui.button(label="Criar expedição", emoji="🎮", style=discord.ButtonStyle.primary, custom_id=EXPEDITION_CREATE_CUSTOM_ID)
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        found = await self._service.find_owner(interaction.user.id)
        if found.outcome is ExpeditionOutcome.SUCCESS:
            await interaction.response.send_message(
                "Você já possui uma expedição ativa.\n\nUse “Minha expedição” para encontrá-la ou encerre a atividade atual antes de criar outra.\n\n"
                f"[Ver expedição]({found.message.jump_url})",
                ephemeral=True,
                allowed_mentions=discord.AllowedMentions.none(),
            )
            return
        await interaction.response.send_modal(ExpeditionModal(self._service, self._audit))

    @discord.ui.button(label="Minha expedição", emoji="🧭", style=discord.ButtonStyle.secondary, custom_id=EXPEDITION_MINE_CUSTOM_ID)
    async def mine(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        found = await self._service.find_owner(interaction.user.id)
        if found.outcome is ExpeditionOutcome.SUCCESS:
            content = f"Sua expedição ativa:\n[Ver expedição]({found.message.jump_url})"
        else:
            content = "Você não possui uma expedição ativa."
        await interaction.response.send_message(content, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
