from __future__ import annotations

import logging
from datetime import UTC, datetime

import discord

from elysium.errors import create_incident_id, send_ephemeral
from elysium.models.presentation import Presentation
from elysium.services.audit_service import AuditService
from elysium.services.presentation_service import PresentationOutcome, PresentationService

logger = logging.getLogger("elysium.modals.presentation")


class PresentationModal(discord.ui.Modal, title="Sua apresentação"):
    def __init__(
        self,
        service: PresentationService,
        audit_service: AuditService,
        existing: Presentation | None = None,
    ) -> None:
        super().__init__()
        self._service = service
        self._audit = audit_service
        self._existing = existing
        self.preferred_name = discord.ui.TextInput(
            label="Como prefere ser chamado?",
            style=discord.TextStyle.short,
            required=True,
            min_length=2,
            max_length=32,
            placeholder="Nome, apelido ou como prefere ser chamado.",
            default=existing.preferred_name if existing else None,
        )
        self.about = discord.ui.TextInput(
            label="Conte um pouco sobre você",
            style=discord.TextStyle.paragraph,
            required=True,
            min_length=10,
            max_length=300,
            placeholder="Uma descrição breve e confortável sobre você.",
            default=existing.about if existing else None,
        )
        self.interests = discord.ui.TextInput(
            label="Principais interesses",
            style=discord.TextStyle.paragraph,
            required=True,
            min_length=2,
            max_length=180,
            placeholder="Jogos, tecnologia, filmes, arte, música...",
            default=existing.interests if existing else None,
        )
        self.current_activity = discord.ui.TextInput(
            label="O que está fazendo atualmente?",
            style=discord.TextStyle.paragraph,
            required=False,
            max_length=180,
            placeholder="Jogos, séries, projetos ou atividades atuais.",
            default=existing.current_activity if existing else None,
        )
        self.expectations = discord.ui.TextInput(
            label="O que procura no Elysium?",
            style=discord.TextStyle.paragraph,
            required=True,
            min_length=2,
            max_length=240,
            placeholder="Amizades, grupos para jogar, conversas, projetos...",
            default=existing.expectations if existing else None,
        )
        for item in (
            self.preferred_name,
            self.about,
            self.interests,
            self.current_activity,
            self.expectations,
        ):
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        user = interaction.user
        presentation = Presentation(
            user_id=user.id,
            preferred_name=str(self.preferred_name),
            about=str(self.about),
            interests=str(self.interests),
            current_activity=str(self.current_activity),
            expectations=str(self.expectations),
            created_at=self._existing.created_at if self._existing else datetime.now(UTC),
        )
        avatar_url = str(user.display_avatar.url) if user.display_avatar else None
        display_name = getattr(user, "display_name", str(user))
        if self._existing is None:
            result = await self._service.create(presentation, avatar_url, display_name)
        else:
            result = await self._service.update(user.id, presentation, avatar_url, display_name)
        if result.outcome is PresentationOutcome.SUCCESS:
            action = "publicada" if self._existing is None else "atualizada"
            await interaction.followup.send(
                f"Sua apresentação foi {action}.\n\n[Ver apresentação]({result.message.jump_url})",
                ephemeral=True,
                allowed_mentions=discord.AllowedMentions.none(),
            )
        elif result.outcome is PresentationOutcome.DUPLICATE:
            await interaction.followup.send(
                "Você já possui uma apresentação.\n\nUse “Editar minha apresentação” para atualizá-la.",
                ephemeral=True,
            )
        elif result.outcome is PresentationOutcome.INVALID_CONTENT:
            await interaction.followup.send(
                "Sua apresentação não pode conter links, convites ou menções.", ephemeral=True
            )
        else:
            await interaction.followup.send(
                "Não foi possível localizar ou publicar sua apresentação.", ephemeral=True
            )

    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        incident_id = create_incident_id()
        logger.exception(
            "Erro inesperado em modal de apresentação.",
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
                "Ação": "modal",
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
