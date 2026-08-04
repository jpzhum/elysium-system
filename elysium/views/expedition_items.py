from __future__ import annotations

import logging
import re
from typing import Any, ClassVar

import discord

from elysium.constants import EXPEDITION_ID_PATTERN
from elysium.errors import create_incident_id, send_ephemeral
from elysium.modals.expedition import ExpeditionModal
from elysium.models.expedition import Expedition, ExpeditionStatus
from elysium.services.expedition_service import (
    ExpeditionOutcome,
    ExpeditionService,
    can_close_expedition,
)
from elysium.views.expedition_confirmation import CloseExpeditionView
from elysium.views.expedition_panel import member_can_use

logger = logging.getLogger("elysium.views.expedition_items")


async def _unexpected(interaction: discord.Interaction, error: Exception, action: str) -> None:
    incident_id = create_incident_id()
    logger.exception(
        "Erro inesperado em componente dinâmico de expedição.",
        exc_info=(type(error), error, error.__traceback__),
        extra={"incident_id": incident_id, "user_id": interaction.user.id, "action": action},
    )
    audit = interaction.client.audit_service
    await audit.send(
        "Falha inesperada",
        {
            "Actor User ID": interaction.user.id,
            "Message ID": interaction.message.id if interaction.message else "indisponível",
            "Channel ID": interaction.channel_id or "indisponível",
            "Ação": action,
            "Horário UTC": discord.utils.utcnow().isoformat(),
            "Incident ID": incident_id,
        },
        level=logging.ERROR,
    )
    await send_ephemeral(interaction, f"Não foi possível concluir esta ação.\n\nIncidente: `{incident_id}`")


class ExpeditionDynamicItem(discord.ui.DynamicItem[discord.ui.Button], template=r"a^"):
    action: ClassVar[str]
    label: ClassVar[str]
    emoji: ClassVar[str]
    style: ClassVar[discord.ButtonStyle]
    def __init__(self, expedition_id: str, *, disabled: bool = False) -> None:
        self.expedition_id = expedition_id
        super().__init__(
            discord.ui.Button(
                label=self.label,
                emoji=self.emoji,
                style=self.style,
                custom_id=f"elysium:expedition:{self.action}:{expedition_id}",
                disabled=disabled,
            )
        )

    @classmethod
    async def from_custom_id(
        cls,
        interaction: discord.Interaction,
        item: discord.ui.Item[Any],
        match: re.Match[str],
    ) -> ExpeditionDynamicItem:
        del interaction, item
        return cls(match.group("expedition_id"))

    async def callback(self, interaction: discord.Interaction) -> None:
        try:
            await self.run(interaction)
        except Exception as error:
            await _unexpected(interaction, error, self.action)

    async def require_member(self, interaction: discord.Interaction) -> bool:
        if member_can_use(interaction, interaction.client.config):
            return True
        await interaction.response.send_message("Você não pode usar esta expedição neste contexto.", ephemeral=True)
        return False

    async def run(self, interaction: discord.Interaction) -> None:
        raise NotImplementedError


class JoinExpeditionItem(ExpeditionDynamicItem, template=rf"elysium:expedition:join:(?P<expedition_id>{EXPEDITION_ID_PATTERN})"):
    action, label, emoji, style = "join", "Participar", "✅", discord.ButtonStyle.success

    async def run(self, interaction: discord.Interaction) -> None:
        if not await self.require_member(interaction):
            return
        result = await interaction.client.expedition_service.mutate(self.expedition_id, interaction.user.id, "join")
        messages = {
            ExpeditionOutcome.SUCCESS: "Você entrou na expedição.",
            ExpeditionOutcome.ALREADY_JOINED: "Você já participa desta expedição.",
            ExpeditionOutcome.FULL: "Esta expedição já está completa.",
            ExpeditionOutcome.CLOSED: "Esta expedição está encerrada.",
        }
        await send_ephemeral(interaction, messages.get(result.outcome, "Esta expedição não foi encontrada."))


class LeaveExpeditionItem(ExpeditionDynamicItem, template=rf"elysium:expedition:leave:(?P<expedition_id>{EXPEDITION_ID_PATTERN})"):
    action, label, emoji, style = "leave", "Sair", "↩️", discord.ButtonStyle.secondary

    async def run(self, interaction: discord.Interaction) -> None:
        if not await self.require_member(interaction):
            return
        result = await interaction.client.expedition_service.mutate(self.expedition_id, interaction.user.id, "leave")
        messages = {
            ExpeditionOutcome.SUCCESS: "Você saiu da expedição.",
            ExpeditionOutcome.NOT_JOINED: "Você não participa desta expedição.",
            ExpeditionOutcome.OWNER_CANNOT_LEAVE: "Como organizador, você precisa encerrar a expedição.",
            ExpeditionOutcome.CLOSED: "Esta expedição está encerrada.",
        }
        await send_ephemeral(interaction, messages.get(result.outcome, "Esta expedição não foi encontrada."))


class EditExpeditionItem(ExpeditionDynamicItem, template=rf"elysium:expedition:edit:(?P<expedition_id>{EXPEDITION_ID_PATTERN})"):
    action, label, emoji, style = "edit", "Editar", "✏️", discord.ButtonStyle.primary

    async def run(self, interaction: discord.Interaction) -> None:
        config = interaction.client.config
        if not member_can_use(interaction, config):
            await interaction.response.send_message("Você não pode editar esta expedição.", ephemeral=True)
            return
        found = await interaction.client.expedition_service.find(self.expedition_id)
        if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
            await interaction.response.send_message("Esta expedição não foi encontrada.", ephemeral=True)
            return
        member = interaction.user
        if member.id != found.expedition.owner_user_id and not member.guild_permissions.administrator:
            await interaction.response.send_message("Somente o organizador ou um administrador pode editar esta expedição.", ephemeral=True)
            return
        await interaction.response.send_modal(
            ExpeditionModal(interaction.client.expedition_service, interaction.client.audit_service, found.expedition)
        )


class CloseExpeditionItem(ExpeditionDynamicItem, template=rf"elysium:expedition:close:(?P<expedition_id>{EXPEDITION_ID_PATTERN})"):
    action, label, emoji, style = "close", "Encerrar", "🛑", discord.ButtonStyle.danger

    async def run(self, interaction: discord.Interaction) -> None:
        config = interaction.client.config
        if not member_can_use(interaction, config):
            await interaction.response.send_message("Você não pode encerrar esta expedição.", ephemeral=True)
            return
        found = await interaction.client.expedition_service.find(self.expedition_id)
        if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
            await interaction.response.send_message("Esta expedição não foi encontrada.", ephemeral=True)
            return
        member = interaction.user
        has_host = config.host_role_id is not None and any(role.id == config.host_role_id for role in member.roles)
        if not can_close_expedition(
            member.id,
            found.expedition.owner_user_id,
            administrator=member.guild_permissions.administrator,
            has_host_role=has_host,
        ):
            await interaction.response.send_message("Você não pode encerrar esta expedição.", ephemeral=True)
            return
        await interaction.response.send_message(
            "Deseja encerrar esta expedição?",
            view=CloseExpeditionView(interaction.client.expedition_service, self.expedition_id, member.id),
            ephemeral=True,
        )


class VoiceExpeditionItem(ExpeditionDynamicItem, template=rf"elysium:expedition:voice:(?P<expedition_id>{EXPEDITION_ID_PATTERN})"):
    action, label, emoji, style = "voice", "Criar sala", "🔊", discord.ButtonStyle.secondary

    def __init__(
        self, expedition_id: str, *, disabled: bool = False, existing: bool = False
    ) -> None:
        self.label = "Abrir sala" if existing else "Criar sala"
        super().__init__(expedition_id, disabled=disabled)

    async def run(self, interaction: discord.Interaction) -> None:
        config = interaction.client.config
        member = interaction.user
        allowed_context = (
            interaction.guild_id == config.guild_id
            and interaction.channel_id == config.expedition_channel_id
            and isinstance(member, discord.Member)
            and (
                member.guild_permissions.administrator
                or any(
                    role.id in {config.habitante_role_id, config.host_role_id}
                    for role in member.roles
                )
            )
        )
        if not allowed_context:
            await send_ephemeral(
                interaction, "Você não pode usar esta expedição neste contexto."
            )
            return
        await interaction.client.expedition_voice_service.handle_button(
            interaction, self.expedition_id
        )


DYNAMIC_EXPEDITION_ITEMS = (
    JoinExpeditionItem,
    LeaveExpeditionItem,
    EditExpeditionItem,
    CloseExpeditionItem,
    VoiceExpeditionItem,
)


def build_expedition_card_view(
    service: ExpeditionService, audit: Any, expedition: Expedition
) -> discord.ui.View:
    del service, audit
    view = discord.ui.View(timeout=None)
    closed = expedition.status is ExpeditionStatus.CLOSED
    full = len(expedition.participant_user_ids) >= expedition.capacity
    view.add_item(JoinExpeditionItem(expedition.expedition_id, disabled=closed or full))
    view.add_item(LeaveExpeditionItem(expedition.expedition_id, disabled=closed))
    view.add_item(EditExpeditionItem(expedition.expedition_id, disabled=closed))
    view.add_item(CloseExpeditionItem(expedition.expedition_id, disabled=closed))
    view.add_item(
        VoiceExpeditionItem(
            expedition.expedition_id,
            disabled=closed,
            existing=expedition.voice_channel_id is not None,
        )
    )
    return view
