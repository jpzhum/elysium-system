from __future__ import annotations

import discord

from elysium.services.expedition_service import ExpeditionOutcome, ExpeditionService


class CloseExpeditionView(discord.ui.View):
    def __init__(self, service: ExpeditionService, expedition_id: str, initiator_id: int) -> None:
        super().__init__(timeout=60)
        self._service = service
        self._expedition_id = expedition_id
        self._initiator_id = initiator_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self._initiator_id:
            return True
        await interaction.response.send_message("Somente quem iniciou a confirmação pode responder.", ephemeral=True)
        return False

    @discord.ui.button(label="Encerrar expedição", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        result = await self._service.mutate(self._expedition_id, interaction.user.id, "close")
        content = "Expedição encerrada." if result.outcome is ExpeditionOutcome.SUCCESS else "A expedição não está mais disponível."
        await interaction.response.edit_message(content=content, view=None)
        self.stop()

    @discord.ui.button(label="Cancelar", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        await interaction.response.edit_message(content="Encerramento cancelado.", view=None)
        self.stop()
