from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum, auto
from typing import Any

import discord

from elysium.constants import BRAND_COLOR, PRESENTATION_EMBED_TITLE
from elysium.models.presentation import Presentation
from elysium.services.audit_service import AuditService

logger = logging.getLogger("elysium.presentations")

_OWNER_URL = re.compile(r"https://discord\.com/users/(\d+)$")
_FORBIDDEN = re.compile(
    r"discord\.gg/|discord\.com/invite/|https?://|www\.|@everyone|@here|"
    r"<@!?\d+>|<@&\d+>|<#\d+>",
    re.IGNORECASE,
)
_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class PresentationOutcome(Enum):
    SUCCESS = auto()
    NOT_FOUND = auto()
    DUPLICATE = auto()
    INVALID_CONTENT = auto()
    CHANNEL_UNAVAILABLE = auto()
    NOT_OWNER = auto()


@dataclass(frozen=True, slots=True)
class PresentationResult:
    outcome: PresentationOutcome
    message: Any | None = None
    presentation: Presentation | None = None


class PresentationValidationError(ValueError):
    pass


def normalize_text(value: str) -> str:
    value = _CONTROLS.sub("", value).strip()
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines()]
    normalized: list[str] = []
    for line in lines:
        if line or (normalized and normalized[-1]):
            normalized.append(line)
    while normalized and not normalized[-1]:
        normalized.pop()
    return "\n".join(normalized)


def validate_presentation(presentation: Presentation) -> Presentation:
    values = {
        "preferred_name": (presentation.preferred_name, 2, 32, True),
        "about": (presentation.about, 10, 300, True),
        "interests": (presentation.interests, 2, 180, True),
        "current_activity": (presentation.current_activity, 0, 180, False),
        "expectations": (presentation.expectations, 2, 240, True),
    }
    cleaned: dict[str, str] = {}
    for name, (raw, minimum, maximum, required) in values.items():
        value = normalize_text(raw)
        if (required and len(value) < minimum) or len(value) > maximum:
            raise PresentationValidationError("Campos fora dos limites permitidos.")
        if value and _FORBIDDEN.search(value):
            raise PresentationValidationError(
                "Sua apresentação não pode conter links, convites ou menções."
            )
        cleaned[name] = value
    return Presentation(
        user_id=presentation.user_id,
        created_at=presentation.created_at,
        **cleaned,
    )


def owner_id_from_embed(embed: discord.Embed) -> int | None:
    if embed.title != PRESENTATION_EMBED_TITLE or not embed.author.url:
        return None
    match = _OWNER_URL.fullmatch(embed.author.url)
    return int(match.group(1)) if match else None


def presentation_from_embed(embed: discord.Embed, user_id: int) -> Presentation | None:
    if owner_id_from_embed(embed) != user_id:
        return None
    fields = {field.name: field.value for field in embed.fields}
    if "Interesses" not in fields or "No Elysium" not in fields:
        return None
    return Presentation(
        user_id=user_id,
        preferred_name=embed.author.name or "",
        about=embed.description or "",
        interests=fields["Interesses"],
        current_activity=fields.get("No momento", ""),
        expectations=fields["No Elysium"],
        created_at=embed.timestamp or datetime.now(UTC),
    )


def build_presentation_embed(
    presentation: Presentation, avatar_url: str | None = None
) -> discord.Embed:
    embed = discord.Embed(
        title=PRESENTATION_EMBED_TITLE,
        description=presentation.about,
        color=BRAND_COLOR,
        timestamp=presentation.created_at,
    )
    embed.set_author(
        name=presentation.preferred_name,
        icon_url=avatar_url or None,
        url=f"https://discord.com/users/{presentation.user_id}",
    )
    embed.add_field(name="Interesses", value=presentation.interests, inline=False)
    if presentation.current_activity:
        embed.add_field(name="No momento", value=presentation.current_activity, inline=False)
    embed.add_field(name="No Elysium", value=presentation.expectations, inline=False)
    embed.set_footer(text="Elysium • A place worth remembering.")
    return embed


class PresentationService:
    def __init__(
        self,
        client: discord.Client,
        channel_id: int | None,
        audit_service: AuditService,
    ) -> None:
        self._client = client
        self._channel_id = channel_id
        self._audit = audit_service
        self._channel: Any | None = None
        self._index: dict[int, int] = {}
        self._index_ready = False
        self._index_lock = asyncio.Lock()
        self._user_locks: dict[int, asyncio.Lock] = {}

    @property
    def configured(self) -> bool:
        return self._channel_id is not None

    async def resolve_channel(self) -> Any | None:
        if self._channel_id is None:
            return None
        if self._channel is not None:
            return self._channel
        channel = self._client.get_channel(self._channel_id)
        if channel is None:
            try:
                channel = await self._client.fetch_channel(self._channel_id)
            except (discord.Forbidden, discord.NotFound, discord.HTTPException):
                logger.warning("Canal de apresentações indisponível.")
                return None
        if not callable(getattr(channel, "history", None)):
            return None
        self._channel = channel
        return channel

    async def ensure_index(self) -> bool:
        if self._index_ready:
            return True
        async with self._index_lock:
            if self._index_ready:
                return True
            channel = await self.resolve_channel()
            if channel is None:
                return False
            newest: dict[int, Any] = {}
            duplicate_count = 0
            async for message in channel.history(limit=None, oldest_first=False):
                if self._client.user is None or message.author.id != self._client.user.id:
                    continue
                for embed in message.embeds:
                    user_id = owner_id_from_embed(embed)
                    if user_id is None:
                        continue
                    if user_id in newest:
                        duplicate_count += 1
                        logger.warning(
                            "Duplicata de apresentação encontrada.",
                            extra={"user_id": user_id, "message_id": message.id},
                        )
                        await self._audit_event(
                            "Duplicata encontrada durante reconstrução", user_id, message.id
                        )
                    else:
                        newest[user_id] = message
            self._index = {user_id: message.id for user_id, message in newest.items()}
            self._index_ready = True
            await self._audit.send(
                "Índice de apresentações reconstruído",
                {
                    "Ação": "reconstrução",
                    "Channel ID": self._channel_id or "indisponível",
                    "Horário UTC": discord.utils.utcnow().isoformat(),
                },
            )
            return True

    async def find(self, user_id: int) -> PresentationResult:
        if not await self.ensure_index():
            return PresentationResult(PresentationOutcome.CHANNEL_UNAVAILABLE)
        message = await self._fetch_indexed(user_id)
        if message is None:
            return PresentationResult(PresentationOutcome.NOT_FOUND)
        embed = next((item for item in message.embeds if owner_id_from_embed(item) == user_id), None)
        presentation = presentation_from_embed(embed, user_id) if embed else None
        if presentation is None:
            self._index.pop(user_id, None)
            return PresentationResult(PresentationOutcome.NOT_FOUND)
        return PresentationResult(PresentationOutcome.SUCCESS, message, presentation)

    async def create(
        self, presentation: Presentation, avatar_url: str | None, display_name: str
    ) -> PresentationResult:
        try:
            presentation = validate_presentation(presentation)
        except PresentationValidationError:
            return PresentationResult(PresentationOutcome.INVALID_CONTENT)
        async with self._user_locks.setdefault(presentation.user_id, asyncio.Lock()):
            existing = await self.find(presentation.user_id)
            if existing.outcome is PresentationOutcome.SUCCESS:
                return PresentationResult(PresentationOutcome.DUPLICATE, existing.message)
            channel = await self.resolve_channel()
            if channel is None:
                return PresentationResult(PresentationOutcome.CHANNEL_UNAVAILABLE)
            message = await channel.send(
                embed=build_presentation_embed(presentation, avatar_url),
                allowed_mentions=discord.AllowedMentions.none(),
            )
            self._index[presentation.user_id] = message.id
            await self._audit_event("Apresentação criada", presentation.user_id, message.id, display_name)
            return PresentationResult(PresentationOutcome.SUCCESS, message, presentation)

    async def update(
        self, actor_id: int, presentation: Presentation, avatar_url: str | None, display_name: str
    ) -> PresentationResult:
        if actor_id != presentation.user_id:
            return PresentationResult(PresentationOutcome.NOT_OWNER)
        try:
            presentation = validate_presentation(presentation)
        except PresentationValidationError:
            return PresentationResult(PresentationOutcome.INVALID_CONTENT)
        async with self._user_locks.setdefault(actor_id, asyncio.Lock()):
            found = await self.find(actor_id)
            if found.outcome is not PresentationOutcome.SUCCESS:
                return found
            await found.message.edit(
                embed=build_presentation_embed(presentation, avatar_url),
                allowed_mentions=discord.AllowedMentions.none(),
            )
            self._index[actor_id] = found.message.id
            await self._audit_event("Apresentação atualizada", actor_id, found.message.id, display_name)
            return PresentationResult(PresentationOutcome.SUCCESS, found.message, presentation)

    async def delete(self, actor_id: int, owner_id: int, display_name: str) -> PresentationResult:
        if actor_id != owner_id:
            return PresentationResult(PresentationOutcome.NOT_OWNER)
        async with self._user_locks.setdefault(actor_id, asyncio.Lock()):
            found = await self.find(owner_id)
            if found.outcome is not PresentationOutcome.SUCCESS:
                return found
            await found.message.delete()
            self._index.pop(owner_id, None)
            await self._audit_event("Apresentação excluída", owner_id, found.message.id, display_name)
            return PresentationResult(PresentationOutcome.SUCCESS, found.message)

    async def _fetch_indexed(self, user_id: int) -> Any | None:
        channel = await self.resolve_channel()
        message_id = self._index.get(user_id)
        if channel is None or message_id is None:
            return None
        try:
            return await channel.fetch_message(message_id)
        except discord.NotFound:
            self._index.pop(user_id, None)
            async for message in channel.history(limit=None, oldest_first=False):
                if (
                    self._client.user is not None
                    and message.author.id == self._client.user.id
                    and any(owner_id_from_embed(embed) == user_id for embed in message.embeds)
                ):
                    self._index[user_id] = message.id
                    return message
            return None

    async def _audit_event(
        self, title: str, user_id: int, message_id: int, display_name: str = "indisponível"
    ) -> None:
        await self._audit.send(
            title,
            {
                "User ID": user_id,
                "Nome de exibição": display_name,
                "Message ID": message_id,
                "Channel ID": self._channel_id or "indisponível",
                "Ação": title,
                "Horário UTC": discord.utils.utcnow().isoformat(),
            },
            level=logging.WARNING if title.startswith("Duplicata") else logging.INFO,
        )
