from __future__ import annotations

import asyncio
import logging
import re
import secrets
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import Enum, auto
from typing import Any

import discord

from elysium.constants import BRAND_COLOR, EXPEDITION_ID_PATTERN
from elysium.models.expedition import Expedition, ExpeditionStatus
from elysium.services.audit_service import AuditService
from elysium.utils.content_validation import contains_forbidden_content, normalize_text

logger = logging.getLogger("elysium.expeditions")

_OWNER_URL = re.compile(r"https://discord\.com/users/(\d+)$")
_FOOTER = re.compile(rf"Elysium • Expedição ({EXPEDITION_ID_PATTERN})$")
_PARTICIPANT = re.compile(r"<@(\d+)>")
_VOICE_CHANNEL = re.compile(r"<#(\d+)>")
INVALID_CONTENT_MESSAGE = "Os detalhes da expedição não podem conter links, convites ou menções."


class ExpeditionValidationError(ValueError):
    pass


class ExpeditionOutcome(Enum):
    SUCCESS = auto()
    NOT_FOUND = auto()
    DUPLICATE = auto()
    INVALID_CONTENT = auto()
    INVALID_CAPACITY = auto()
    CHANNEL_UNAVAILABLE = auto()
    CLOSED = auto()
    ALREADY_JOINED = auto()
    FULL = auto()
    NOT_JOINED = auto()
    OWNER_CANNOT_LEAVE = auto()


@dataclass(frozen=True, slots=True)
class ExpeditionResult:
    outcome: ExpeditionOutcome
    message: Any | None = None
    expedition: Expedition | None = None


def new_expedition_id() -> str:
    return secrets.token_hex(4)


def validate_capacity(value: int, participant_count: int = 1) -> int:
    if not 2 <= value <= 12 or value < participant_count:
        raise ExpeditionValidationError("Capacidade inválida.")
    return value


def validate_expedition(expedition: Expedition) -> Expedition:
    limits = {
        "game": (expedition.game, 2, 60),
        "scheduled_for": (expedition.scheduled_for, 2, 80),
        "platform": (expedition.platform, 2, 40),
        "details": (expedition.details, 10, 400),
    }
    cleaned: dict[str, str] = {}
    for name, (raw, minimum, maximum) in limits.items():
        value = normalize_text(raw)
        if not minimum <= len(value) <= maximum:
            raise ExpeditionValidationError("Campos fora dos limites permitidos.")
        if contains_forbidden_content(value):
            raise ExpeditionValidationError(INVALID_CONTENT_MESSAGE)
        cleaned[name] = value
    validate_capacity(expedition.capacity, len(expedition.participant_user_ids))
    if not re.fullmatch(EXPEDITION_ID_PATTERN, expedition.expedition_id):
        raise ExpeditionValidationError("Identificador inválido.")
    if not expedition.participant_user_ids or expedition.participant_user_ids[0] != expedition.owner_user_id:
        raise ExpeditionValidationError("O organizador deve ser o primeiro participante.")
    if len(set(expedition.participant_user_ids)) != len(expedition.participant_user_ids):
        raise ExpeditionValidationError("Participantes duplicados.")
    return replace(expedition, **cleaned)


def owner_user_id_from_embed(embed: discord.Embed) -> int | None:
    if not embed.author.url:
        return None
    match = _OWNER_URL.fullmatch(embed.author.url)
    return int(match.group(1)) if match else None


def expedition_id_from_embed(embed: discord.Embed) -> str | None:
    match = _FOOTER.fullmatch(embed.footer.text or "")
    return match.group(1) if match else None


def participant_user_ids_from_embed(embed: discord.Embed) -> tuple[int, ...]:
    field = next((item for item in embed.fields if item.name == "Participantes"), None)
    return tuple(int(value) for value in _PARTICIPANT.findall(field.value)) if field else ()


def voice_channel_id_from_embed(embed: discord.Embed) -> int | None:
    fields = [item for item in embed.fields if item.name == "Sala de voz"]
    if len(fields) != 1:
        return None
    match = _VOICE_CHANNEL.fullmatch(fields[0].value)
    return int(match.group(1)) if match else None


def expedition_from_embed(embed: discord.Embed) -> Expedition | None:
    owner_id = owner_user_id_from_embed(embed)
    expedition_id = expedition_id_from_embed(embed)
    title = embed.title or ""
    active_prefix, closed_prefix = "Expedição — ", "Expedição encerrada — "
    if title.startswith(active_prefix):
        status, game = ExpeditionStatus.ACTIVE, title[len(active_prefix):]
    elif title.startswith(closed_prefix):
        status, game = ExpeditionStatus.CLOSED, title[len(closed_prefix):]
    else:
        return None
    fields = {field.name: field.value for field in embed.fields}
    vacancy = re.fullmatch(r"(\d+) de (\d+)", fields.get("Vagas", ""))
    participants = participant_user_ids_from_embed(embed)
    if owner_id is None or expedition_id is None or vacancy is None:
        return None
    try:
        model = Expedition(
            expedition_id=expedition_id,
            owner_user_id=owner_id,
            game=game,
            scheduled_for=fields["Quando"],
            platform=fields["Plataforma"],
            capacity=int(vacancy.group(2)),
            details=embed.description or "",
            participant_user_ids=participants,
            created_at=embed.timestamp or datetime.now(UTC),
            status=status,
            voice_channel_id=voice_channel_id_from_embed(embed),
        )
        if int(vacancy.group(1)) != len(participants):
            return None
        return validate_expedition(model)
    except (KeyError, ExpeditionValidationError, ValueError):
        return None


def is_valid_expedition_card(embed: discord.Embed) -> bool:
    return expedition_from_embed(embed) is not None


def build_expedition_embed(
    expedition: Expedition,
    owner_display_name: str,
    owner_avatar_url: str | None = None,
) -> discord.Embed:
    expedition = validate_expedition(expedition)
    closed = expedition.status is ExpeditionStatus.CLOSED
    embed = discord.Embed(
        title=("Expedição encerrada — " if closed else "Expedição — ") + expedition.game,
        description=expedition.details,
        color=discord.Color.from_str("#7C8496") if closed else BRAND_COLOR,
        timestamp=expedition.created_at,
    )
    embed.set_author(
        name=owner_display_name,
        icon_url=owner_avatar_url or None,
        url=f"https://discord.com/users/{expedition.owner_user_id}",
    )
    embed.add_field(name="Quando", value=expedition.scheduled_for, inline=True)
    embed.add_field(name="Plataforma", value=expedition.platform, inline=True)
    embed.add_field(
        name="Vagas",
        value=f"{len(expedition.participant_user_ids)} de {expedition.capacity}",
        inline=True,
    )
    participants = "\n".join(f"<@{user_id}>" for user_id in expedition.participant_user_ids)
    embed.add_field(name="Participantes", value=participants or "Nenhum participante.", inline=False)
    if expedition.voice_channel_id is not None:
        embed.add_field(
            name="Sala de voz", value=f"<#{expedition.voice_channel_id}>", inline=False
        )
    embed.set_footer(text=f"Elysium • Expedição {expedition.expedition_id}")
    return embed


def can_close_expedition(
    actor_id: int, owner_id: int, *, administrator: bool, has_host_role: bool
) -> bool:
    return actor_id == owner_id or administrator or has_host_role


class ExpeditionService:
    def __init__(self, client: discord.Client, channel_id: int | None, audit: AuditService) -> None:
        self._client = client
        self._channel_id = channel_id
        self._audit = audit
        self._channel: Any | None = None
        self._message_by_expedition: dict[str, int] = {}
        self._active_by_owner: dict[int, str] = {}
        self._index_ready = False
        self._index_lock = asyncio.Lock()
        self._user_locks: dict[int, asyncio.Lock] = {}
        self._expedition_locks: dict[str, asyncio.Lock] = {}
        self._mutation_callback: Any | None = None

    def set_mutation_callback(self, callback: Any) -> None:
        self._mutation_callback = callback

    async def rebuild_index(self) -> bool:
        self._index_ready = False
        return await self.ensure_index()

    async def update_voice_reference(
        self, expedition_id: str, voice_channel_id: int | None
    ) -> ExpeditionResult:
        async with self._expedition_locks.setdefault(expedition_id, asyncio.Lock()):
            return await self.update_voice_reference_locked(
                expedition_id, voice_channel_id
            )

    async def update_voice_reference_locked(
        self, expedition_id: str, voice_channel_id: int | None
    ) -> ExpeditionResult:
        """Atualiza o embed quando o chamador já detém o lock da expedição."""
        found = await self.find(expedition_id)
        if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
            return found
        model = replace(found.expedition, voice_channel_id=voice_channel_id)
        author = found.message.embeds[0].author
        await found.message.edit(
            embed=build_expedition_embed(model, author.name or "Organizador", author.icon_url),
            view=self.build_card_view(model),
            allowed_mentions=discord.AllowedMentions.none(),
        )
        return ExpeditionResult(ExpeditionOutcome.SUCCESS, found.message, model)

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
            by_expedition: dict[str, int] = {}
            by_owner: dict[int, str] = {}
            async for message in channel.history(limit=1000, oldest_first=False):
                if self._client.user is None or message.author.id != self._client.user.id:
                    continue
                for embed in message.embeds:
                    model = expedition_from_embed(embed)
                    if model is None:
                        if expedition_id_from_embed(embed):
                            await self._audit_event("Cartão inválido", message=message)
                        continue
                    if model.expedition_id in by_expedition:
                        await self._audit_event("Duplicata encontrada", model, message, logging.WARNING)
                        continue
                    by_expedition[model.expedition_id] = message.id
                    if model.status is ExpeditionStatus.ACTIVE:
                        if model.owner_user_id in by_owner:
                            await self._audit_event("Duplicata encontrada", model, message, logging.WARNING)
                            continue
                        by_owner[model.owner_user_id] = model.expedition_id
            self._message_by_expedition = by_expedition
            self._active_by_owner = by_owner
            self._index_ready = True
            await self._audit_event("Índice reconstruído")
            return True

    async def find_owner(self, owner_id: int) -> ExpeditionResult:
        if not await self.ensure_index():
            return ExpeditionResult(ExpeditionOutcome.CHANNEL_UNAVAILABLE)
        expedition_id = self._active_by_owner.get(owner_id)
        return await self.find(expedition_id) if expedition_id else ExpeditionResult(ExpeditionOutcome.NOT_FOUND)

    async def find(self, expedition_id: str | None) -> ExpeditionResult:
        if not expedition_id or not await self.ensure_index():
            return ExpeditionResult(ExpeditionOutcome.NOT_FOUND)
        message = await self._fetch_indexed(expedition_id)
        if message is None:
            return ExpeditionResult(ExpeditionOutcome.NOT_FOUND)
        model = next((expedition_from_embed(embed) for embed in message.embeds if expedition_from_embed(embed)), None)
        return ExpeditionResult(ExpeditionOutcome.SUCCESS, message, model)

    async def create(
        self, expedition: Expedition, owner_display_name: str, avatar_url: str | None
    ) -> ExpeditionResult:
        try:
            expedition = validate_expedition(expedition)
        except ExpeditionValidationError as error:
            outcome = ExpeditionOutcome.INVALID_CONTENT if str(error) == INVALID_CONTENT_MESSAGE else ExpeditionOutcome.INVALID_CAPACITY
            return ExpeditionResult(outcome)
        async with self._user_locks.setdefault(expedition.owner_user_id, asyncio.Lock()):
            existing = await self.find_owner(expedition.owner_user_id)
            if existing.outcome is ExpeditionOutcome.SUCCESS:
                return ExpeditionResult(ExpeditionOutcome.DUPLICATE, existing.message, existing.expedition)
            channel = await self.resolve_channel()
            if channel is None:
                return ExpeditionResult(ExpeditionOutcome.CHANNEL_UNAVAILABLE)
            message = await channel.send(
                embed=build_expedition_embed(expedition, owner_display_name, avatar_url),
                view=self.build_card_view(expedition),
                allowed_mentions=discord.AllowedMentions.none(),
            )
            self._message_by_expedition[expedition.expedition_id] = message.id
            self._active_by_owner[expedition.owner_user_id] = expedition.expedition_id
            await self._audit_event("Expedição criada", expedition, message, actor_id=expedition.owner_user_id)
            return ExpeditionResult(ExpeditionOutcome.SUCCESS, message, expedition)

    async def mutate(self, expedition_id: str, actor_id: int, action: str, **changes: Any) -> ExpeditionResult:
        async with self._expedition_locks.setdefault(expedition_id, asyncio.Lock()):
            found = await self.find(expedition_id)
            if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
                return found
            model = found.expedition
            if model.status is ExpeditionStatus.CLOSED:
                return ExpeditionResult(ExpeditionOutcome.CLOSED, found.message, model)
            participants = list(model.participant_user_ids)
            if action == "join":
                if actor_id in participants:
                    return ExpeditionResult(ExpeditionOutcome.ALREADY_JOINED, found.message, model)
                if len(participants) >= model.capacity:
                    return ExpeditionResult(ExpeditionOutcome.FULL, found.message, model)
                participants.append(actor_id)
                model = replace(model, participant_user_ids=tuple(participants))
                audit_title = "Participante entrou"
            elif action == "leave":
                if actor_id == model.owner_user_id:
                    return ExpeditionResult(ExpeditionOutcome.OWNER_CANNOT_LEAVE, found.message, model)
                if actor_id not in participants:
                    return ExpeditionResult(ExpeditionOutcome.NOT_JOINED, found.message, model)
                participants.remove(actor_id)
                model = replace(model, participant_user_ids=tuple(participants))
                audit_title = "Participante saiu"
            elif action == "edit":
                model = replace(model, **changes)
                try:
                    model = validate_expedition(model)
                except ExpeditionValidationError as error:
                    outcome = ExpeditionOutcome.INVALID_CONTENT if str(error) == INVALID_CONTENT_MESSAGE else ExpeditionOutcome.INVALID_CAPACITY
                    return ExpeditionResult(outcome, found.message, found.expedition)
                audit_title = "Expedição atualizada"
            elif action == "close":
                model = replace(model, status=ExpeditionStatus.CLOSED)
                audit_title = "Expedição encerrada"
                self._active_by_owner.pop(model.owner_user_id, None)
            else:
                raise ValueError("Ação desconhecida.")
            author = found.message.embeds[0].author
            await found.message.edit(
                embed=build_expedition_embed(model, author.name or "Organizador", author.icon_url),
                view=self.build_card_view(model),
                allowed_mentions=discord.AllowedMentions.none(),
            )
            await self._audit_event(audit_title, model, found.message, actor_id=actor_id)
            if self._mutation_callback is not None:
                try:
                    await self._mutation_callback(action, found.expedition, model, actor_id)
                except Exception:
                    logger.exception(
                        "Falha na sincronização da sala da expedição.",
                        extra={"event": "expedition_voice_sync_failed", "expedition_id": expedition_id},
                    )
            return ExpeditionResult(ExpeditionOutcome.SUCCESS, found.message, model)

    def build_card_view(self, expedition: Expedition) -> discord.ui.View:
        from elysium.views.expedition_items import build_expedition_card_view

        return build_expedition_card_view(self, self._audit, expedition)

    def invalidate_message(self, message_id: int) -> None:
        ids = [key for key, value in self._message_by_expedition.items() if value == message_id]
        for expedition_id in ids:
            self._message_by_expedition.pop(expedition_id, None)
            owners = [key for key, value in self._active_by_owner.items() if value == expedition_id]
            for owner_id in owners:
                self._active_by_owner.pop(owner_id, None)

    async def _fetch_indexed(self, expedition_id: str) -> Any | None:
        channel = await self.resolve_channel()
        message_id = self._message_by_expedition.get(expedition_id)
        if channel is None or message_id is None:
            return None
        try:
            return await channel.fetch_message(message_id)
        except discord.NotFound:
            self.invalidate_message(message_id)
            async for message in channel.history(limit=1000, oldest_first=False):
                if self._client.user is not None and message.author.id == self._client.user.id:
                    if any(expedition_id_from_embed(embed) == expedition_id for embed in message.embeds):
                        self._message_by_expedition[expedition_id] = message.id
                        return message
            return None

    async def _audit_event(
        self,
        title: str,
        expedition: Expedition | None = None,
        message: Any | None = None,
        level: int = logging.INFO,
        actor_id: int | None = None,
    ) -> None:
        await self._audit.send(
            title,
            {
                "Expedition ID": expedition.expedition_id if expedition else "indisponível",
                "Owner User ID": expedition.owner_user_id if expedition else "indisponível",
                "Actor User ID": actor_id or "indisponível",
                "Message ID": getattr(message, "id", "indisponível"),
                "Channel ID": self._channel_id or "indisponível",
                "Participantes": len(expedition.participant_user_ids) if expedition else "indisponível",
                "Ação": title,
                "Horário UTC": discord.utils.utcnow().isoformat(),
            },
            level=level,
        )
