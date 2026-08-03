from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from urllib.parse import urlparse

import discord
from discord import app_commands
from discord.ext import commands

from elysium.config import ElysiumConfig
from elysium.errors import create_incident_id, send_ephemeral
from elysium.services.audit_service import AuditService
from elysium.utils.content_validation import normalize_text

logger = logging.getLogger("elysium.boletim")

BOLETIM_COLOR = discord.Color.from_str("#6E7DFF")
BOLETIM_SYMBOL = "✦"
BOLETIM_FOOTER = "Elysium — A place worth remembering."
MAX_EMBED_CHARACTERS = 6000
MAX_DESCRIPTION_CHARACTERS = 4096


class MentionType(Enum):
    NONE = "nenhuma"
    EVENTS = "eventos"
    EVERYONE = "everyone"

    @property
    def display_name(self) -> str:
        return {
            MentionType.NONE: "Nenhuma",
            MentionType.EVENTS: "@Eventos",
            MentionType.EVERYONE: "@everyone",
        }[self]


class BulletinValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class BulletinDraft:
    title: str
    subtitle: str
    body: str
    call_to_action: str
    image_url: str


def is_valid_http_url(value: str) -> bool:
    if not value:
        return True
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def embed_character_count(embed: discord.Embed) -> int:
    return len(embed)


def validate_draft(draft: BulletinDraft) -> BulletinDraft:
    cleaned = BulletinDraft(
        title=normalize_text(draft.title),
        subtitle=normalize_text(draft.subtitle),
        body=normalize_text(draft.body),
        call_to_action=normalize_text(draft.call_to_action),
        image_url=draft.image_url.strip(),
    )
    if not cleaned.title or len(cleaned.title) > 200:
        raise BulletinValidationError("O título deve possuir entre 1 e 200 caracteres.")
    if len(cleaned.subtitle) > 300:
        raise BulletinValidationError("O subtítulo excede 300 caracteres.")
    if not cleaned.body:
        raise BulletinValidationError("O texto principal não pode ficar vazio.")
    if not is_valid_http_url(cleaned.image_url):
        raise BulletinValidationError("A URL da imagem deve ser uma URL HTTP ou HTTPS válida.")
    embed = build_bulletin_embed(cleaned, validate=False)
    if not embed.description or len(embed.description) > MAX_DESCRIPTION_CHARACTERS:
        raise BulletinValidationError("A descrição excede o limite de 4.096 caracteres do Discord.")
    if embed_character_count(embed) > MAX_EMBED_CHARACTERS:
        raise BulletinValidationError("O boletim excede o limite total de 6.000 caracteres do Discord.")
    return cleaned


def build_bulletin_embed(draft: BulletinDraft, *, validate: bool = True) -> discord.Embed:
    if validate:
        draft = validate_draft(draft)
    sections: list[str] = []
    if draft.subtitle:
        sections.append(f"*{draft.subtitle}*")
    sections.append(draft.body)
    if draft.call_to_action:
        sections.append(f"**{draft.call_to_action}**")
    embed = discord.Embed(
        title=f"{BOLETIM_SYMBOL} {draft.title.upper()}",
        description="\n\n".join(sections),
        color=BOLETIM_COLOR,
        timestamp=discord.utils.utcnow(),
    )
    embed.set_footer(text=BOLETIM_FOOTER)
    if draft.image_url:
        embed.set_image(url=draft.image_url)
    return embed


def is_bulletin_manager(member: object, manager_role_ids: tuple[int, ...]) -> bool:
    permissions = getattr(member, "guild_permissions", None)
    if permissions is not None and bool(getattr(permissions, "manage_guild", False)):
        return True
    return any(
        getattr(role, "id", None) in manager_role_ids
        for role in getattr(member, "roles", ())
    )


def mention_payload(
    mention_type: MentionType,
    eventos_role: discord.Role | None = None,
) -> tuple[str | None, discord.AllowedMentions]:
    if mention_type is MentionType.NONE:
        return None, discord.AllowedMentions.none()
    if mention_type is MentionType.EVENTS:
        if eventos_role is None:
            raise BulletinValidationError("O cargo Eventos não foi encontrado.")
        return eventos_role.mention, discord.AllowedMentions(
            everyone=False, users=False, roles=[eventos_role], replied_user=False
        )
    return "@everyone", discord.AllowedMentions(
        everyone=True, users=False, roles=False, replied_user=False
    )


async def report_bulletin_error(
    interaction: discord.Interaction,
    audit: AuditService,
    error: Exception,
    action: str,
) -> None:
    incident_id = create_incident_id()
    logger.exception(
        "Falha inesperada no fluxo de boletim.",
        exc_info=(type(error), error, error.__traceback__),
        extra={
            "incident_id": incident_id,
            "user_id": interaction.user.id,
            "channel_id": interaction.channel_id,
            "action": action,
        },
    )
    await audit.send(
        "Falha inesperada em boletim",
        {
            "User ID": interaction.user.id,
            "Channel ID": interaction.channel_id or "indisponível",
            "Ação": action,
            "Incident ID": incident_id,
            "Horário UTC": discord.utils.utcnow().isoformat(),
        },
        level=logging.ERROR,
    )
    await send_ephemeral(
        interaction,
        f"Não foi possível concluir esta ação. Incidente: `{incident_id}`",
    )


class BulletinPreviewView(discord.ui.View):
    def __init__(
        self,
        config: ElysiumConfig,
        audit: AuditService,
        owner_id: int,
        channel: discord.TextChannel,
        mention_type: MentionType,
        draft: BulletinDraft,
    ) -> None:
        super().__init__(timeout=180)
        self._config = config
        self._audit = audit
        self._owner_id = owner_id
        self._channel = channel
        self._mention_type = mention_type
        self._draft = draft
        self._published = False
        self.message: discord.InteractionMessage | None = None

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self._owner_id:
            return True
        await interaction.response.send_message(
            "Somente quem criou esta prévia pode utilizar os botões.", ephemeral=True
        )
        return False

    @discord.ui.button(label="Publicar", style=discord.ButtonStyle.primary)
    async def publish(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        if self._published:
            await interaction.response.send_message("Este boletim já foi publicado.", ephemeral=True)
            return
        if not is_bulletin_manager(interaction.user, self._config.boletim_manager_role_ids):
            await interaction.response.send_message("Você não possui autorização para publicar boletins.", ephemeral=True)
            return
        bot_member = self._channel.guild.me
        if bot_member is None:
            await interaction.response.send_message("Não foi possível validar as permissões do bot.", ephemeral=True)
            return
        permissions = self._channel.permissions_for(bot_member)
        missing = [
            label
            for attribute, label in (
                ("view_channel", "Ver canal"),
                ("send_messages", "Enviar mensagens"),
                ("embed_links", "Inserir links"),
            )
            if not getattr(permissions, attribute, False)
        ]
        if self._mention_type is not MentionType.NONE and not permissions.mention_everyone:
            missing.append("Mencionar @everyone, @here e todos os cargos")
        if missing:
            await interaction.response.send_message(
                "O bot não possui estas permissões no canal de destino: " + ", ".join(missing) + ".",
                ephemeral=True,
            )
            return
        eventos_role = None
        if self._mention_type is MentionType.EVENTS:
            eventos_role = self._channel.guild.get_role(self._config.eventos_role_id or 0)
            if eventos_role is None:
                await interaction.response.send_message("O cargo Eventos não foi encontrado.", ephemeral=True)
                return
        content, allowed_mentions = mention_payload(self._mention_type, eventos_role)
        self._published = True
        await interaction.response.defer(ephemeral=True)
        try:
            published = await self._channel.send(
                content=content,
                embed=build_bulletin_embed(self._draft),
                allowed_mentions=allowed_mentions,
            )
        except (discord.Forbidden, discord.NotFound, discord.HTTPException) as error:
            incident_id = create_incident_id()
            logger.exception(
                "Falha ao publicar boletim.",
                exc_info=(type(error), error, error.__traceback__),
                extra={"incident_id": incident_id, "user_id": interaction.user.id, "channel_id": self._channel.id},
            )
            await self._audit.send(
                "Falha na publicação de boletim",
                {
                    "User ID": interaction.user.id,
                    "Channel ID": self._channel.id,
                    "Tipo de menção": self._mention_type.value,
                    "Incident ID": incident_id,
                    "Horário UTC": discord.utils.utcnow().isoformat(),
                },
                level=logging.ERROR,
            )
            await interaction.edit_original_response(
                content=f"Não foi possível publicar o boletim. Incidente: `{incident_id}`",
                embed=None,
                view=None,
            )
            self.stop()
            return
        for item in self.children:
            item.disabled = True
        correlation_id = create_incident_id()
        await self._audit.send(
            "BOLETIM_PUBLICADO",
            {
                "Ação": "BOLETIM_PUBLICADO",
                "Responsável": getattr(interaction.user, "display_name", str(interaction.user)),
                "User ID": interaction.user.id,
                "Título": self._draft.title,
                "Canal": self._channel.name,
                "Channel ID": self._channel.id,
                "Tipo de menção": self._mention_type.value,
                "Message ID": published.id,
                "Horário UTC": discord.utils.utcnow().isoformat(),
                "Correlation ID": correlation_id,
            },
        )
        await interaction.edit_original_response(
            content=f"Boletim publicado.\n\n[Ver boletim]({published.jump_url})",
            embed=None,
            view=self,
        )
        self.stop()

    @discord.ui.button(label="Cancelar", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        del button
        for item in self.children:
            item.disabled = True
        await interaction.response.edit_message(content="Publicação cancelada.", embed=None, view=self)
        self.stop()

    async def on_timeout(self) -> None:
        for item in self.children:
            item.disabled = True
        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except discord.HTTPException:
                logger.warning("Não foi possível desativar uma prévia expirada de boletim.")

    async def on_error(
        self,
        interaction: discord.Interaction,
        error: Exception,
        item: discord.ui.Item[discord.ui.View],
    ) -> None:
        await report_bulletin_error(
            interaction, self._audit, error, getattr(item, "custom_id", "prévia") or "prévia"
        )


class BulletinModal(discord.ui.Modal, title="Criar boletim"):
    def __init__(
        self,
        config: ElysiumConfig,
        audit: AuditService,
        channel: discord.TextChannel,
        mention_type: MentionType,
        owner_id: int,
    ) -> None:
        super().__init__()
        self._config = config
        self._audit = audit
        self._channel = channel
        self._mention_type = mention_type
        self._owner_id = owner_id
        self.title_input = discord.ui.TextInput(label="Título", required=True, max_length=200)
        self.subtitle = discord.ui.TextInput(label="Subtítulo", required=False, max_length=300)
        self.body = discord.ui.TextInput(
            label="Texto principal", style=discord.TextStyle.paragraph, required=True, max_length=4000
        )
        self.call_to_action = discord.ui.TextInput(
            label="Chamada final", style=discord.TextStyle.paragraph, required=False, max_length=500,
            placeholder="Acesse #expedições e encontre sua próxima jornada.",
        )
        self.image_url = discord.ui.TextInput(label="URL da imagem", required=False, max_length=1000)
        for item in (self.title_input, self.subtitle, self.body, self.call_to_action, self.image_url):
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self._owner_id or not is_bulletin_manager(
            interaction.user, self._config.boletim_manager_role_ids
        ):
            await interaction.response.send_message("Você não possui autorização para criar boletins.", ephemeral=True)
            return
        try:
            draft = validate_draft(
                BulletinDraft(
                    title=str(self.title_input),
                    subtitle=str(self.subtitle),
                    body=str(self.body),
                    call_to_action=str(self.call_to_action),
                    image_url=str(self.image_url),
                )
            )
        except BulletinValidationError as error:
            await interaction.response.send_message(str(error), ephemeral=True)
            return
        view = BulletinPreviewView(
            self._config, self._audit, interaction.user.id, self._channel, self._mention_type, draft
        )
        await interaction.response.send_message(
            f"Canal de destino: {self._channel.mention}\nTipo de menção: {self._mention_type.display_name}",
            embed=build_bulletin_embed(draft),
            view=view,
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )
        view.message = await interaction.original_response()

    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        await report_bulletin_error(interaction, self._audit, error, "modal")


class BoletimCog(commands.Cog):
    boletim = app_commands.Group(name="boletim", description="Gerencia o boletim oficial do Elysium.")

    def __init__(self, bot: commands.Bot, config: ElysiumConfig, audit: AuditService) -> None:
        self._bot = bot
        self._config = config
        self._audit = audit

    @boletim.command(name="criar", description="Cria uma publicação para o boletim do Elysium.")
    @app_commands.describe(mencao="Menção acima do boletim.", canal="Canal de destino opcional.")
    @app_commands.choices(
        mencao=[
            app_commands.Choice(name="nenhuma", value="nenhuma"),
            app_commands.Choice(name="eventos", value="eventos"),
            app_commands.Choice(name="everyone", value="everyone"),
        ]
    )
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def criar(
        self,
        interaction: discord.Interaction,
        mencao: app_commands.Choice[str],
        canal: discord.TextChannel | None = None,
    ) -> None:
        if interaction.guild_id != self._config.guild_id or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message("Este comando só está disponível no servidor configurado.", ephemeral=True)
            return
        if not is_bulletin_manager(interaction.user, self._config.boletim_manager_role_ids):
            await interaction.response.send_message("Você não possui autorização para criar boletins.", ephemeral=True)
            return
        destination = canal
        if destination is None:
            if self._config.boletim_channel_id is None:
                await interaction.response.send_message("O canal padrão de boletim não está configurado.", ephemeral=True)
                return
            resolved = interaction.guild.get_channel(self._config.boletim_channel_id)
            if not isinstance(resolved, discord.TextChannel):
                await interaction.response.send_message("O canal padrão de boletim não foi encontrado.", ephemeral=True)
                return
            destination = resolved
        if destination.guild.id != self._config.guild_id:
            await interaction.response.send_message(
                "O canal de destino precisa pertencer ao servidor configurado.", ephemeral=True
            )
            return
        await interaction.response.send_modal(
            BulletinModal(
                self._config,
                self._audit,
                destination,
                MentionType(mencao.value),
                interaction.user.id,
            )
        )
