from __future__ import annotations

import logging

import discord

from elysium.config import ElysiumConfig
from elysium.constants import (
    PRESENTATION_CREATE_CUSTOM_ID,
    PRESENTATION_DELETE_CUSTOM_ID,
    PRESENTATION_EDIT_CUSTOM_ID,
)
from elysium.errors import create_incident_id, send_ephemeral
from elysium.modals.presentation import PresentationModal
from elysium.services.audit_service import AuditService
from elysium.services.presentation_service import PresentationOutcome, PresentationService

logger = logging.getLogger("elysium.views.presentation_panel")


class DeletePresentationView(discord.ui.View):
    def __init__(
        self, service: PresentationService, audit_service: AuditService, owner_id: int
    ) -> None:
        super().__init__(timeout=60)
        self._service = service
        self._audit = audit_service
        self._owner_id = owner_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self._owner_id:
            return True
        await interaction.response.send_message(
            "Somente o proprietário pode confirmar esta exclusão.", ephemeral=True
        )
        return False

    @discord.ui.button(label="Confirmar exclusão", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        result = await self._service.delete(
            interaction.user.id,
            self._owner_id,
            getattr(interaction.user, "display_name", str(interaction.user)),
        )
        if result.outcome is PresentationOutcome.SUCCESS:
            await interaction.response.edit_message(
                content="Sua apresentação foi excluída.", view=None
            )
        else:
            await interaction.response.edit_message(
                content="Sua apresentação não foi encontrada.", view=None
            )
        self.stop()

    async def on_error(
        self,
        interaction: discord.Interaction,
        error: Exception,
        item: discord.ui.Item[discord.ui.View],
    ) -> None:
        incident_id = create_incident_id()
        logger.exception(
            "Erro inesperado na confirmação de exclusão.",
            exc_info=(type(error), error, error.__traceback__),
            extra={"incident_id": incident_id, "user_id": interaction.user.id},
        )
        await self._audit.send(
            "Falha inesperada em apresentação",
            {
                "User ID": interaction.user.id,
                "Nome de exibição": getattr(interaction.user, "display_name", str(interaction.user)),
                "Message ID": "indisponível",
                "Channel ID": interaction.channel_id or "indisponível",
                "Ação": "exclusão",
                "Horário UTC": discord.utils.utcnow().isoformat(),
                "Incident ID": incident_id,
            },
            level=logging.ERROR,
        )
        await send_ephemeral(
            interaction,
            "Não foi possível concluir esta ação.\n\n"
            f"O incidente foi registrado com o código:\n`{incident_id}`",
        )
        del item

    @discord.ui.button(label="Cancelar", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        await interaction.response.edit_message(content="Exclusão cancelada.", view=None)
        self.stop()


class PresentationPanelView(discord.ui.View):
    def __init__(
        self,
        config: ElysiumConfig,
        service: PresentationService,
        audit_service: AuditService,
    ) -> None:
        super().__init__(timeout=None)
        self._config = config
        self._service = service
        self._audit = audit_service

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        member = interaction.user
        valid_context = (
            interaction.guild_id == self._config.guild_id
            and interaction.channel_id == self._config.presentation_channel_id
            and isinstance(member, discord.Member)
        )
        if valid_context and (
            member.guild_permissions.administrator
            or any(
                role.id in {self._config.visitante_role_id, self._config.habitante_role_id}
                for role in member.roles
            )
        ):
            return True
        await interaction.response.send_message(
            "Este painel não está disponível para você neste contexto.", ephemeral=True
        )
        return False

    @discord.ui.button(
        label="Criar apresentação",
        emoji="👋",
        style=discord.ButtonStyle.primary,
        custom_id=PRESENTATION_CREATE_CUSTOM_ID,
    )
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        found = await self._service.find(interaction.user.id)
        if found.outcome is PresentationOutcome.SUCCESS:
            await interaction.response.send_message(
                "Você já possui uma apresentação.\n\n"
                "Use “Editar minha apresentação” para atualizá-la.",
                ephemeral=True,
            )
            return
        await interaction.response.send_modal(
            PresentationModal(self._service, self._audit)
        )

    @discord.ui.button(
        label="Editar minha apresentação",
        emoji="✏️",
        style=discord.ButtonStyle.secondary,
        custom_id=PRESENTATION_EDIT_CUSTOM_ID,
    )
    async def edit(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        found = await self._service.find(interaction.user.id)
        if found.outcome is not PresentationOutcome.SUCCESS:
            await interaction.response.send_message(
                "Você ainda não possui uma apresentação.\n\n"
                "Use “Criar apresentação” para começar.",
                ephemeral=True,
            )
            return
        await interaction.response.send_modal(
            PresentationModal(self._service, self._audit, found.presentation)
        )

    @discord.ui.button(
        label="Excluir minha apresentação",
        emoji="🗑️",
        style=discord.ButtonStyle.danger,
        custom_id=PRESENTATION_DELETE_CUSTOM_ID,
    )
    async def delete(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        found = await self._service.find(interaction.user.id)
        if found.outcome is not PresentationOutcome.SUCCESS:
            await interaction.response.send_message(
                "Você ainda não possui uma apresentação.\n\n"
                "Use “Criar apresentação” para começar.",
                ephemeral=True,
            )
            return
        await interaction.response.send_message(
            "**Excluir sua apresentação?**\n\n"
            "Essa ação removerá o cartão do canal. Você poderá criar outra apresentação posteriormente.",
            view=DeletePresentationView(self._service, self._audit, interaction.user.id),
            ephemeral=True,
        )

    async def on_error(
        self,
        interaction: discord.Interaction,
        error: Exception,
        item: discord.ui.Item[discord.ui.View],
    ) -> None:
        incident_id = create_incident_id()
        logger.exception(
            "Erro inesperado no painel de apresentações.",
            exc_info=(type(error), error, error.__traceback__),
            extra={"incident_id": incident_id, "user_id": interaction.user.id},
        )
        await self._audit.send(
            "Falha inesperada em apresentação",
            {
                "User ID": interaction.user.id,
                "Nome de exibição": getattr(interaction.user, "display_name", str(interaction.user)),
                "Message ID": "indisponível",
                "Channel ID": interaction.channel_id or "indisponível",
                "Ação": getattr(item, "custom_id", "painel"),
                "Horário UTC": discord.utils.utcnow().isoformat(),
                "Incident ID": incident_id,
            },
            level=logging.ERROR,
        )
        await send_ephemeral(
            interaction,
            "Não foi possível concluir esta ação.\n\n"
            f"O incidente foi registrado com o código:\n`{incident_id}`",
        )
