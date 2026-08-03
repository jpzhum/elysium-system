from __future__ import annotations

import logging
from datetime import UTC, datetime

import discord

from elysium.errors import create_incident_id, send_ephemeral
from elysium.models.expedition import Expedition
from elysium.services.expedition_service import (
    ExpeditionOutcome,
    ExpeditionService,
    new_expedition_id,
)
from elysium.services.audit_service import AuditService

logger = logging.getLogger("elysium.modals.expedition")


class ExpeditionModal(discord.ui.Modal):
    def __init__(
        self,
        service: ExpeditionService,
        audit: AuditService,
        existing: Expedition | None = None,
    ) -> None:
        super().__init__(title="Editar expedição" if existing else "Criar expedição")
        self._service = service
        self._audit = audit
        self._existing = existing
        specifications = (
            ("game", "Jogo ou atividade", discord.TextStyle.short, 2, 60, "Minecraft, Dying Light, sessão de cinema..."),
            ("scheduled_for", "Quando?", discord.TextStyle.short, 2, 80, "Hoje às 21h, sábado à tarde..."),
            ("platform", "Plataforma", discord.TextStyle.short, 2, 40, "PC, PlayStation, Xbox, Mobile..."),
            ("capacity", "Total de participantes", discord.TextStyle.short, 1, 2, "De 2 a 12"),
            ("details", "Estilo e detalhes", discord.TextStyle.paragraph, 10, 400, "Casual ou competitivo, requisitos, objetivo da sessão..."),
        )
        for attribute, label, style, minimum, maximum, placeholder in specifications:
            current = getattr(existing, attribute) if existing else None
            item = discord.ui.TextInput(
                label=label,
                style=style,
                required=True,
                min_length=minimum,
                max_length=maximum,
                placeholder=placeholder,
                default=str(current) if current is not None else None,
            )
            setattr(self, attribute, item)
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        from elysium.views.expedition_panel import member_can_use

        if not member_can_use(interaction, interaction.client.config):
            await interaction.response.send_message(
                "Você não pode usar o sistema de expedições neste contexto.", ephemeral=True
            )
            return
        if self._existing is not None:
            member = interaction.user
            if (
                member.id != self._existing.owner_user_id
                and not member.guild_permissions.administrator
            ):
                await interaction.response.send_message(
                    "Somente o organizador ou um administrador pode editar esta expedição.",
                    ephemeral=True,
                )
                return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            capacity = int(str(self.capacity))
        except ValueError:
            await interaction.followup.send("O total de participantes deve ser um número entre 2 e 12.", ephemeral=True)
            return
        user = interaction.user
        if self._existing is None:
            model = Expedition(
                expedition_id=new_expedition_id(),
                owner_user_id=user.id,
                game=str(self.game),
                scheduled_for=str(self.scheduled_for),
                platform=str(self.platform),
                capacity=capacity,
                details=str(self.details),
                participant_user_ids=(user.id,),
                created_at=datetime.now(UTC),
            )
            result = await self._service.create(
                model,
                getattr(user, "display_name", str(user)),
                str(user.display_avatar.url) if getattr(user, "display_avatar", None) else None,
            )
            success = "Expedição criada."
        else:
            result = await self._service.mutate(
                self._existing.expedition_id,
                user.id,
                "edit",
                game=str(self.game),
                scheduled_for=str(self.scheduled_for),
                platform=str(self.platform),
                capacity=capacity,
                details=str(self.details),
            )
            success = "Expedição atualizada."
        if result.outcome is ExpeditionOutcome.SUCCESS:
            await interaction.followup.send(
                f"{success}\n\n[Ver expedição]({result.message.jump_url})",
                ephemeral=True,
                allowed_mentions=discord.AllowedMentions.none(),
            )
        elif result.outcome is ExpeditionOutcome.DUPLICATE:
            await interaction.followup.send(
                "Você já possui uma expedição ativa.\n\n"
                f"Use “Minha expedição” para encontrá-la ou encerre a atividade atual antes de criar outra.\n\n[Ver expedição]({result.message.jump_url})",
                ephemeral=True,
                allowed_mentions=discord.AllowedMentions.none(),
            )
        elif result.outcome is ExpeditionOutcome.INVALID_CONTENT:
            await interaction.followup.send("Os detalhes da expedição não podem conter links, convites ou menções.", ephemeral=True)
        elif result.outcome is ExpeditionOutcome.INVALID_CAPACITY:
            await interaction.followup.send("A capacidade deve ficar entre 2 e 12 e não pode ser menor que a ocupação atual.", ephemeral=True)
        else:
            await interaction.followup.send("Não foi possível concluir a operação nesta expedição.", ephemeral=True)

    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        incident_id = create_incident_id()
        logger.exception(
            "Erro inesperado em modal de expedição.",
            exc_info=(type(error), error, error.__traceback__),
            extra={"incident_id": incident_id, "user_id": interaction.user.id},
        )
        await self._audit.send(
            "Falha inesperada",
            {
                "Actor User ID": interaction.user.id,
                "Channel ID": interaction.channel_id or "indisponível",
                "Ação": "modal",
                "Horário UTC": discord.utils.utcnow().isoformat(),
                "Incident ID": incident_id,
            },
            level=logging.ERROR,
        )
        await send_ephemeral(interaction, f"Não foi possível concluir esta ação.\n\nIncidente: `{incident_id}`")
