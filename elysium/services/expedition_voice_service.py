from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from enum import Enum, auto
from typing import Any

import discord

from elysium.config import ElysiumConfig
from elysium.errors import create_incident_id, send_ephemeral
from elysium.models.expedition import Expedition, ExpeditionStatus
from elysium.services.audit_service import AuditService
from elysium.services.expedition_service import ExpeditionOutcome, ExpeditionService
from elysium.utils.channel_name import expedition_voice_channel_name, limited_bitrate

logger = logging.getLogger("elysium.expedition_voice")
_ORPHAN_NAME = re.compile(r"-([a-f0-9]{8})$")
REQUIRED_VOICE_PERMISSIONS = (
    "view_channel",
    "manage_channels",
    "manage_roles",
    "connect",
    "speak",
    "stream",
    "use_voice_activation",
    "move_members",
)
PERMISSION_LABELS = {
    "view_channel": "Visualizar canal",
    "manage_channels": "Gerenciar canais",
    "manage_roles": "Gerenciar cargos",
    "connect": "Conectar",
    "speak": "Falar",
    "stream": "Vídeo",
    "use_voice_activation": "Usar detecção de voz",
    "move_members": "Mover membros",
}


class VoiceRoomOutcome(Enum):
    SUCCESS = auto()
    NOT_FOUND = auto()
    CATEGORY_UNAVAILABLE = auto()
    CATEGORY_PUBLIC = auto()
    PERMISSIONS_MISSING = auto()
    CREATE_FAILED = auto()
    OVERWRITE_FAILED = auto()


@dataclass(frozen=True, slots=True)
class PermissionPreflight:
    category_found: bool
    category_private: bool
    missing_permissions: tuple[str, ...] = ()

    @property
    def operational(self) -> bool:
        return self.category_found and self.category_private and not self.missing_permissions


@dataclass(frozen=True, slots=True)
class VoiceRoomResult:
    outcome: VoiceRoomOutcome
    channel: Any | None = None
    missing_permissions: tuple[str, ...] = ()
    incident_id: str | None = None


def missing_voice_permissions(permissions: Any) -> tuple[str, ...]:
    return tuple(
        name for name in REQUIRED_VOICE_PERMISSIONS if not bool(getattr(permissions, name, False))
    )


def category_is_private(category: Any, default_role: Any) -> bool:
    permissions = category.permissions_for(default_role)
    return not permissions.view_channel and not permissions.connect


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

    def permission_preflight(self, guild: Any) -> PermissionPreflight:
        category = self.resolve_category(guild)
        bot_member = guild.me
        if category is None or bot_member is None:
            return PermissionPreflight(False, False, REQUIRED_VOICE_PERMISSIONS)
        return PermissionPreflight(
            True,
            category_is_private(category, guild.default_role),
            missing_voice_permissions(category.permissions_for(bot_member)),
        )

    async def build_overwrite_targets(
        self, guild: Any, expedition: Expedition
    ) -> list[tuple[str, Any, discord.PermissionOverwrite]]:
        bot = guild.me
        targets: list[tuple[str, Any, discord.PermissionOverwrite]] = []
        if bot is not None:
            targets.append(("bot", bot, discord.PermissionOverwrite(
                view_channel=True, connect=True, manage_channels=True, move_members=True
            )))
        access = discord.PermissionOverwrite(
            view_channel=True,
            connect=True,
            speak=True,
            stream=True,
            use_voice_activation=True,
        )
        resolved: dict[int, Any] = {}
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
                resolved[user_id] = member
        owner = resolved.get(expedition.owner_user_id)
        targets.append(("owner", owner, access))
        for user_id in expedition.participant_user_ids:
            if user_id != expedition.owner_user_id:
                targets.append(("participant", resolved.get(user_id), access))
        host_id = self._config.host_role_id
        host = guild.get_role(host_id) if host_id is not None else None
        if host is not None:
            targets.append(("host_role", host, discord.PermissionOverwrite(
                view_channel=True, connect=True, move_members=True
            )))
        return targets

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
        result = await self.create_room(interaction.guild, expedition_id, member.id)
        if result.outcome in {
            VoiceRoomOutcome.PERMISSIONS_MISSING,
            VoiceRoomOutcome.CATEGORY_PUBLIC,
        }:
            missing = result.missing_permissions
            permission_lines = "\n".join(
                f"• {PERMISSION_LABELS[name]}" for name in missing
            ) or "• Privacidade da categoria"
            await interaction.followup.send(
                "Não foi possível criar a sala de voz.\n\n"
                "O Elysium System não possui todas as permissões necessárias "
                "na categoria de salas temporárias.\n\n"
                f"Permissões ausentes:\n{permission_lines}\n\n"
                "O incidente foi registrado com o código:\n"
                f"`{result.incident_id}`",
                ephemeral=True,
            )
            return
        if result.outcome is not VoiceRoomOutcome.SUCCESS or result.channel is None:
            await interaction.followup.send(
                "Não foi possível criar a sala de voz."
                + (f"\n\nIncidente: `{result.incident_id}`" if result.incident_id else ""),
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            f"Sala de voz criada.\n\n[Acessar sala]({result.channel.jump_url})",
            ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none(),
        )

    async def create_room(
        self, guild: Any, expedition_id: str, actor_id: int
    ) -> VoiceRoomResult:
        async with self._locks.setdefault(expedition_id, asyncio.Lock()):
            found = await self._expeditions.find(expedition_id)
            if found.outcome is not ExpeditionOutcome.SUCCESS or found.expedition is None:
                return VoiceRoomResult(VoiceRoomOutcome.NOT_FOUND)
            model = found.expedition
            existing_id = self.voice_channel_id(expedition_id) or model.voice_channel_id
            existing = self.resolve_voice_channel(existing_id)
            if existing is not None:
                self._index(expedition_id, existing.id)
                return VoiceRoomResult(VoiceRoomOutcome.SUCCESS, existing)
            category = self.resolve_category(guild)
            if category is None or guild.me is None:
                self.degraded = True
                incident_id = create_incident_id()
                await self._audit_failure(
                    "Falha na criação da sala", model, actor_id, incident_id,
                    "categoria indisponível",
                )
                return VoiceRoomResult(
                    VoiceRoomOutcome.CATEGORY_UNAVAILABLE, incident_id=incident_id
                )
            preflight = self.permission_preflight(guild)
            if not preflight.category_private:
                self.degraded = True
                incident_id = create_incident_id()
                await self._audit_failure(
                    "Falha na criação da sala", model, actor_id, incident_id,
                    "categoria pública",
                )
                return VoiceRoomResult(
                    VoiceRoomOutcome.CATEGORY_PUBLIC, incident_id=incident_id
                )
            if preflight.missing_permissions:
                self.degraded = True
                incident_id = create_incident_id()
                await self._audit_failure(
                    "Falha na criação da sala", model, actor_id, incident_id,
                    "permissões efetivas ausentes",
                )
                return VoiceRoomResult(
                    VoiceRoomOutcome.PERMISSIONS_MISSING,
                    missing_permissions=preflight.missing_permissions,
                    incident_id=incident_id,
                )
            try:
                channel = await guild.create_voice_channel(
                    expedition_voice_channel_name(model.game, expedition_id),
                    category=category,
                    user_limit=model.capacity,
                    bitrate=limited_bitrate(
                        self._config.temp_voice_bitrate_kbps, guild.bitrate_limit
                    ),
                    reason=f"Sala temporária da expedição {expedition_id}",
                )
            except (discord.Forbidden, discord.HTTPException, discord.NotFound) as error:
                incident_id = create_incident_id()
                self.degraded = True
                logger.exception(
                    "Falha ao criar canal de voz temporário.",
                    exc_info=(type(error), error, error.__traceback__),
                    extra={"incident_id": incident_id, "expedition_id": expedition_id},
                )
                await self._audit_failure(
                    "Falha na criação da sala", model, actor_id, incident_id,
                    "Discord recusou a criação",
                )
                return VoiceRoomResult(
                    VoiceRoomOutcome.CREATE_FAILED, incident_id=incident_id
                )
            targets = await self.build_overwrite_targets(guild, model)
            failed_target = await self._apply_overwrites(channel, targets)
            if failed_target is not None:
                incident_id = create_incident_id()
                self.degraded = True
                await self._audit_failure(
                    "Falha na sincronização", model, actor_id, incident_id,
                    f"overwrite obrigatório: {failed_target}", channel.id,
                )
                await self._rollback_created_room(
                    channel, model, actor_id, incident_id
                )
                return VoiceRoomResult(
                    VoiceRoomOutcome.OVERWRITE_FAILED, incident_id=incident_id
                )
            self._index(expedition_id, channel.id)
            await self._expeditions.update_voice_reference(expedition_id, channel.id)
            await self._audit_event("Sala de expedição criada", model, channel.id, actor_id)
            self.degraded = False
            return VoiceRoomResult(VoiceRoomOutcome.SUCCESS, channel)

    async def _apply_overwrites(
        self,
        channel: Any,
        targets: list[tuple[str, Any, discord.PermissionOverwrite]],
    ) -> str | None:
        for target_name, target, overwrite in targets:
            if target is None:
                logger.warning(
                    "Alvo obrigatório indisponível para overwrite.",
                    extra={"event": "voice_overwrite_target_unavailable", "target": target_name},
                )
                return target_name
            try:
                await channel.set_permissions(
                    target,
                    overwrite=overwrite,
                    reason="Acesso à sala temporária de expedição",
                )
            except (discord.Forbidden, discord.HTTPException, discord.NotFound):
                logger.warning(
                    "Falha ao aplicar overwrite obrigatório da sala temporária.",
                    extra={
                        "event": "voice_overwrite_failed",
                        "target": target_name,
                        "voice_channel_id": channel.id,
                    },
                    exc_info=True,
                )
                return target_name
        return None

    async def _rollback_created_room(
        self,
        channel: Any,
        expedition: Expedition,
        actor_id: int,
        incident_id: str,
    ) -> None:
        self._unindex(channel.id)
        try:
            await channel.delete(reason="Rollback de sala temporária incompleta")
        except (discord.Forbidden, discord.HTTPException, discord.NotFound) as error:
            logger.warning(
                "Falha ao excluir canal durante rollback.",
                extra={
                    "event": "voice_rollback_failed",
                    "voice_channel_id": channel.id,
                    "incident_id": incident_id,
                },
                exc_info=True,
            )
            await self._audit_failure(
                "Falha no rollback da sala",
                expedition,
                actor_id,
                incident_id,
                "Discord recusou a exclusão de rollback",
                channel.id,
                level=logging.WARNING,
            )

    async def _audit_failure(
        self,
        title: str,
        expedition: Expedition,
        actor_id: int,
        incident_id: str,
        reason: str,
        channel_id: int | None = None,
        *,
        level: int = logging.WARNING,
    ) -> None:
        await self._audit.send(
            title,
            {
                "Expedition ID": expedition.expedition_id,
                "Voice Channel ID": channel_id or "indisponível",
                "Owner User ID": expedition.owner_user_id,
                "Actor User ID": actor_id,
                "Quantidade de participantes": len(expedition.participant_user_ids),
                "Motivo": reason,
                "Horário UTC": discord.utils.utcnow().isoformat(),
                "Incident ID": incident_id,
            },
            level=level,
        )

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
