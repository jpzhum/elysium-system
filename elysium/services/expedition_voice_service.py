from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

import discord

from elysium.config import ElysiumConfig
from elysium.errors import send_ephemeral
from elysium.models.expedition import Expedition, ExpeditionStatus
from elysium.services.audit_service import AuditService
from elysium.services.expedition_service import ExpeditionOutcome, ExpeditionService
from elysium.utils.channel_name import expedition_voice_channel_name, limited_bitrate

logger = logging.getLogger("elysium.expedition_voice")
_ORPHAN_NAME = re.compile(r"-([a-f0-9]{8})$")


@dataclass(frozen=True, slots=True)
class ReconciliationSummary:
    expeditions_checked: int = 0
    active_rooms: int = 0
    invalid_references: int = 0
    orphan_rooms: int = 0
    cleanups_scheduled: int = 0


def can_create_voice_room(
    actor_id: int, owner_id: int, *, administrator: bool, has_host_role: bool
) -> bool:
    return actor_id == owner_id or administrator or has_host_role


def can_access_voice_room(
    actor_id: int,
    owner_id: int,
    participant_ids: tuple[int, ...],
    *,
    administrator: bool,
    has_host_role: bool,
) -> bool:
    return (
        actor_id == owner_id
        or actor_id in participant_ids
        or administrator
        or has_host_role
    )


class ExpeditionVoiceService:
    def __init__(
        self,
        client: discord.Client,
        config: ElysiumConfig,
        expeditions: ExpeditionService,
        audit: AuditService,
    ) -> None:
        self._client = client
        self._config = config
        self._expeditions = expeditions
        self._audit = audit
        self._voice_by_expedition: dict[str, int] = {}
        self._expedition_by_voice: dict[int, str] = {}
        self._cleanup_tasks: dict[int, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.degraded = False

    @property
    def configured(self) -> bool:
        return self._config.expedition_voice_category_id is not None

    @property
    def active_room_count(self) -> int:
        return len(self._expedition_by_voice)

    @property
    def cleanup_task_count(self) -> int:
        return len(self._cleanup_tasks)

    def voice_channel_id(self, expedition_id: str) -> int | None:
        return self._voice_by_expedition.get(expedition_id)

    def _index(self, expedition_id: str, channel_id: int) -> None:
        old = self._voice_by_expedition.get(expedition_id)
        if old is not None:
            self._expedition_by_voice.pop(old, None)
        self._voice_by_expedition[expedition_id] = channel_id
        self._expedition_by_voice[channel_id] = expedition_id

    def _unindex(self, channel_id: int) -> str | None:
        expedition_id = self._expedition_by_voice.pop(channel_id, None)
        if expedition_id is not None:
            self._voice_by_expedition.pop(expedition_id, None)
        return expedition_id

    def resolve_category(self, guild: Any) -> Any | None:
        category_id = self._config.expedition_voice_category_id
        if category_id is None:
            return None
        category = guild.get_channel(category_id)
        return category if isinstance(category, discord.CategoryChannel) else None

    def resolve_voice_channel(self, channel_id: int | None) -> Any | None:
        if channel_id is None:
            return None
        channel = self._client.get_channel(channel_id)
        return channel if isinstance(channel, discord.VoiceChannel) else None

    async def build_overwrites(
        self, guild: Any, expedition: Expedition
    ) -> dict[Any, discord.PermissionOverwrite]:
        deny = discord.PermissionOverwrite(view_channel=False, connect=False)
        bot = guild.me
        overwrites: dict[Any, discord.PermissionOverwrite] = {guild.default_role: deny}
        if bot is not None:
            overwrites[bot] = discord.PermissionOverwrite(
                view_channel=True, connect=True, manage_channels=True, move_members=True
            )
        access = discord.PermissionOverwrite(
            view_channel=True,
            connect=True,
            speak=True,
            stream=True,
            use_voice_activation=True,
        )
        for user_id in expedition.participant_user_ids:
            member = guild.get_member(user_id)
            if member is None:
                try:
                    member = await guild.fetch_member(user_id)
                except (discord.Forbidden, discord.NotFound, discord.HTTPException):
                    logger.warning(
                        "Participante indisponível para overwrite da sala.",
                        extra={
                            "event": "voice_participant_resolution_failed",
                            "expedition_id": expedition.expedition_id,
                            "user_id": user_id,
                        },
                    )
            if member is not None:
                overwrites[member] = access
        host_id = self._config.host_role_id
        host = guild.get_role(host_id) if host_id is not None else None
        if host is not None:
            overwrites[host] = discord.PermissionOverwrite(
                view_channel=True, connect=True, move_members=True
            )
        return overwrites

    async def handle_button(self, interaction: discord.Interaction, expedition_id: str) -> None:
        if not self.configured:
            await send_ephemeral(interaction, "As salas de voz não estão configuradas.")
            return
        if interaction.guild is None or interaction.guild_id != self._config.guild_id:
            await send_ephemeral(interaction, "Esta expedição não está disponível neste contexto.")
            return
        found = await self._expeditions.find(expedition_id)
        if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
            await send_ephemeral(interaction, "Esta expedição não foi encontrada.")
            return
        model = found.expedition
        if model.status is ExpeditionStatus.CLOSED:
            await send_ephemeral(interaction, "Esta expedição está encerrada.")
            return
        member = interaction.user
        administrator = bool(getattr(member.guild_permissions, "administrator", False))
        has_host = self._config.host_role_id is not None and any(
            role.id == self._config.host_role_id for role in getattr(member, "roles", ())
        )
        channel_id = self.voice_channel_id(expedition_id) or model.voice_channel_id
        if channel_id is not None:
            channel = self.resolve_voice_channel(channel_id)
            if channel is None:
                self._unindex(channel_id)
                await self._expeditions.update_voice_reference(expedition_id, None)
                await send_ephemeral(
                    interaction,
                    "A antiga sala não existe mais.\n\nO organizador pode criar uma nova sala.",
                )
                return
            if not can_access_voice_room(
                member.id,
                model.owner_user_id,
                model.participant_user_ids,
                administrator=administrator,
                has_host_role=has_host,
            ):
                await send_ephemeral(
                    interaction, "Você precisa participar da expedição para acessar esta sala."
                )
                return
            await interaction.response.send_message(
                f"Sala de voz da expedição:\n\n[Acessar sala]({channel.jump_url})",
                ephemeral=True,
                allowed_mentions=discord.AllowedMentions.none(),
            )
            return
        if not can_create_voice_room(
            member.id,
            model.owner_user_id,
            administrator=administrator,
            has_host_role=has_host,
        ):
            await send_ephemeral(
                interaction,
                "A sala ainda não foi criada.\n\nPeça ao organizador para abrir a sala de voz.",
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        channel = await self.create_room(interaction.guild, expedition_id, member.id)
        if channel is None:
            await interaction.followup.send(
                "Não foi possível criar a sala de voz.", ephemeral=True
            )
            return
        await interaction.followup.send(
            f"Sala de voz criada.\n\n[Acessar sala]({channel.jump_url})",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )

    async def create_room(self, guild: Any, expedition_id: str, actor_id: int) -> Any | None:
        async with self._locks.setdefault(expedition_id, asyncio.Lock()):
            found = await self._expeditions.find(expedition_id)
            if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
                return None
            model = found.expedition
            existing_id = self.voice_channel_id(expedition_id) or model.voice_channel_id
            existing = self.resolve_voice_channel(existing_id)
            if existing is not None:
                self._index(expedition_id, existing.id)
                return existing
            category = self.resolve_category(guild)
            if category is None or guild.me is None:
                self.degraded = True
                return None
            permissions = category.permissions_for(guild.me)
            if not (permissions.manage_channels and permissions.view_channel and permissions.connect):
                self.degraded = True
                return None
            channel = await guild.create_voice_channel(
                expedition_voice_channel_name(model.game, expedition_id),
                category=category,
                overwrites=await self.build_overwrites(guild, model),
                user_limit=model.capacity,
                bitrate=limited_bitrate(
                    self._config.temp_voice_bitrate_kbps, guild.bitrate_limit
                ),
                reason=f"Sala temporária da expedição {expedition_id}",
            )
            self._index(expedition_id, channel.id)
            await self._expeditions.update_voice_reference(expedition_id, channel.id)
            await self._audit_event("Sala de expedição criada", model, channel.id, actor_id)
            return channel

    async def on_expedition_mutation(
        self, action: str, before: Expedition, after: Expedition, actor_id: int
    ) -> None:
        channel_id = self.voice_channel_id(after.expedition_id) or after.voice_channel_id
        channel = self.resolve_voice_channel(channel_id)
        if channel is None:
            if channel_id is not None:
                self._unindex(channel_id)
                await self._expeditions.update_voice_reference_locked(
                    after.expedition_id, None
                )
                await self._audit_event(
                    "Referência de sala inválida",
                    after,
                    channel_id,
                    actor_id,
                    level=logging.WARNING,
                )
            return
        if action == "join":
            member = channel.guild.get_member(actor_id)
            if member is not None:
                await channel.set_permissions(
                    member,
                    overwrite=discord.PermissionOverwrite(
                        view_channel=True, connect=True, speak=True, stream=True,
                        use_voice_activation=True,
                    ),
                    reason=f"Participante da expedição {after.expedition_id}",
                )
                await self._audit_event("Participante autorizado na sala", after, channel.id, actor_id)
        elif action == "leave":
            member = channel.guild.get_member(actor_id)
            if member is not None:
                await channel.set_permissions(member, overwrite=None)
                if getattr(getattr(member, "voice", None), "channel", None) == channel:
                    try:
                        await member.move_to(None, reason="Saída da expedição")
                    except discord.Forbidden:
                        logger.warning(
                            "Sem permissão para desconectar participante.",
                            extra={"event": "voice_disconnect_forbidden", "expedition_id": after.expedition_id},
                        )
                await self._audit_event("Participante removido da sala", after, channel.id, actor_id)
        elif action == "edit":
            await channel.edit(user_limit=after.capacity)
        elif action == "close":
            if channel.members:
                await self.schedule_cleanup(channel.id, reason="expedição encerrada")
            else:
                if await self.delete_room(
                    channel.id,
                    reason="expedição encerrada",
                    update_card=False,
                ):
                    await self._expeditions.update_voice_reference_locked(
                        after.expedition_id, None
                    )

    async def schedule_cleanup(self, channel_id: int, *, reason: str = "sala vazia") -> bool:
        task = self._cleanup_tasks.get(channel_id)
        if task is not None and not task.done():
            return False
        self._cleanup_tasks[channel_id] = asyncio.create_task(
            self._cleanup_after_timeout(channel_id),
            name=f"elysium-voice-cleanup-{channel_id}",
        )
        await self._audit_event("Exclusão automática agendada", None, channel_id, reason=reason)
        return True

    async def cancel_cleanup(self, channel_id: int) -> bool:
        task = self._cleanup_tasks.pop(channel_id, None)
        if task is None or task.done():
            return False
        task.cancel()
        await self._audit_event("Exclusão automática cancelada", None, channel_id)
        return True

    async def _cleanup_after_timeout(self, channel_id: int) -> None:
        try:
            await asyncio.sleep(self._config.temp_voice_empty_timeout_seconds)
            channel = self.resolve_voice_channel(channel_id)
            if channel is not None and not channel.members and channel_id in self._expedition_by_voice:
                await self.delete_room(channel_id, reason="timeout de sala vazia")
        except asyncio.CancelledError:
            raise
        finally:
            if self._cleanup_tasks.get(channel_id) is asyncio.current_task():
                self._cleanup_tasks.pop(channel_id, None)

    async def delete_room(
        self, channel_id: int, *, reason: str, update_card: bool = True
    ) -> bool:
        channel = self.resolve_voice_channel(channel_id)
        if channel is not None and channel.members:
            return False
        expedition_id = self._expedition_by_voice.get(channel_id)
        if channel is not None:
            try:
                await channel.delete(reason=reason)
            except (discord.Forbidden, discord.HTTPException):
                self.degraded = True
                logger.warning(
                    "Falha ao excluir sala temporária.",
                    extra={"event": "voice_delete_failed", "expedition_id": expedition_id},
                    exc_info=True,
                )
                return False
        self._unindex(channel_id)
        if expedition_id is not None and update_card:
            await self._expeditions.update_voice_reference(expedition_id, None)
        await self._audit_event("Sala de expedição excluída", None, channel_id, reason=reason)
        return True

    async def on_voice_state_update(self, before: Any, after: Any) -> None:
        before_id = getattr(getattr(before, "channel", None), "id", None)
        after_id = getattr(getattr(after, "channel", None), "id", None)
        if after_id in self._expedition_by_voice:
            await self.cancel_cleanup(after_id)
        if before_id in self._expedition_by_voice and before_id != after_id:
            channel = self.resolve_voice_channel(before_id)
            if channel is not None and not channel.members:
                await self.schedule_cleanup(before_id)

    async def on_channel_delete(self, channel: Any) -> None:
        if channel.id not in self._expedition_by_voice:
            return
        await self.cancel_cleanup(channel.id)
        expedition_id = self._unindex(channel.id)
        if expedition_id is not None:
            await self._expeditions.update_voice_reference(expedition_id, None)
        await self._audit_event("Sala de expedição excluída", None, channel.id, reason="exclusão manual")

    async def reconcile(
        self,
        guild: Any,
        *,
        schedule_orphans: bool = True,
        repair_cards: bool = False,
    ) -> ReconciliationSummary:
        await self._expeditions.rebuild_index()
        category = self.resolve_category(guild)
        if category is None:
            self.degraded = self.configured
            return ReconciliationSummary()
        self._voice_by_expedition.clear()
        self._expedition_by_voice.clear()
        checked = invalid = orphans = scheduled = 0
        known_active: set[str] = set()
        channel = await self._expeditions.resolve_channel()
        if channel is not None:
            async for message in channel.history(limit=1000, oldest_first=False):
                if self._client.user is None or message.author.id != self._client.user.id:
                    continue
                for embed in message.embeds:
                    from elysium.services.expedition_service import expedition_from_embed
                    model = expedition_from_embed(embed)
                    if model is None:
                        continue
                    checked += 1
                    if model.status is ExpeditionStatus.ACTIVE:
                        known_active.add(model.expedition_id)
                    if model.voice_channel_id is None:
                        continue
                    voice = guild.get_channel(model.voice_channel_id)
                    valid = (
                        model.status is ExpeditionStatus.ACTIVE
                        and isinstance(voice, discord.VoiceChannel)
                        and voice.category_id == category.id
                        and voice.name.endswith(model.expedition_id)
                    )
                    if valid:
                        self._index(model.expedition_id, voice.id)
                        if not voice.members and await self.schedule_cleanup(voice.id, reason="restart"):
                            scheduled += 1
                    else:
                        invalid += 1
                        await self._audit_event("Referência de sala inválida", model, model.voice_channel_id, level=logging.WARNING)
                        if repair_cards:
                            await self._expeditions.update_voice_reference(
                                model.expedition_id, None
                            )
        for voice in category.voice_channels:
            match = _ORPHAN_NAME.search(voice.name)
            if match and match.group(1) not in known_active and voice.id not in self._expedition_by_voice:
                orphans += 1
                await self._audit_event("Sala órfã encontrada", None, voice.id, level=logging.WARNING)
                self._expedition_by_voice[voice.id] = match.group(1)
                self._voice_by_expedition[match.group(1)] = voice.id
                if schedule_orphans and not voice.members:
                    if await self.schedule_cleanup(voice.id, reason="sala órfã"):
                        scheduled += 1
        self.degraded = invalid > 0
        return ReconciliationSummary(checked, self.active_room_count, invalid, orphans, scheduled)

    async def shutdown(self) -> None:
        tasks = list(self._cleanup_tasks.values())
        self._cleanup_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _audit_event(
        self,
        title: str,
        expedition: Expedition | None,
        channel_id: int,
        actor_id: int | None = None,
        *,
        reason: str = "indisponível",
        level: int = logging.INFO,
    ) -> None:
        await self._audit.send(
            title,
            {
                "Expedition ID": expedition.expedition_id if expedition else self._expedition_by_voice.get(channel_id, "indisponível"),
                "Voice Channel ID": channel_id,
                "Owner User ID": expedition.owner_user_id if expedition else "indisponível",
                "Actor User ID": actor_id or "indisponível",
                "Quantidade de participantes": len(expedition.participant_user_ids) if expedition else "indisponível",
                "Motivo": reason,
                "Horário UTC": discord.utils.utcnow().isoformat(),
            },
            level=level,
        )
