from __future__ import annotations

import asyncio
import unittest
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import discord

from elysium.config import ElysiumConfig
from elysium.models.expedition import Expedition, ExpeditionStatus
from elysium.services.expedition_service import (
    ExpeditionOutcome,
    ExpeditionResult,
    build_expedition_embed,
)
from elysium.services.expedition_voice_service import (
    ExpeditionVoiceService,
    VoiceRoomOutcome,
    can_access_voice_room,
    can_create_voice_room,
    category_is_private,
    missing_voice_permissions,
)
from elysium.utils.channel_name import expedition_voice_channel_name, limited_bitrate


def config() -> ElysiumConfig:
    return ElysiumConfig(
        discord_token="ficticio",
        guild_id=1,
        habitante_role_id=2,
        visitante_role_id=3,
        panel_channel_id=4,
        port=10000,
        expedition_voice_category_id=10,
        temp_voice_empty_timeout_seconds=60,
    )


class VoicePureTests(unittest.TestCase):
    def test_permission_preflight(self) -> None:
        complete = SimpleNamespace(**{
            name: True for name in (
                "view_channel", "manage_channels", "manage_roles", "connect",
                "speak", "stream", "use_voice_activation", "move_members",
            )
        })
        self.assertEqual(missing_voice_permissions(complete), ())
        for permission in (
            "manage_channels", "manage_roles", "stream", "use_voice_activation"
        ):
            values = vars(complete).copy()
            values[permission] = False
            self.assertIn(permission, missing_voice_permissions(SimpleNamespace(**values)))

    def test_category_privacy(self) -> None:
        category = SimpleNamespace(
            permissions_for=lambda role: SimpleNamespace(view_channel=False, connect=False)
        )
        self.assertTrue(category_is_private(category, object()))
        category.permissions_for = lambda role: SimpleNamespace(view_channel=True, connect=False)
        self.assertFalse(category_is_private(category, object()))

    def test_channel_name_slug_accents_fallback_and_limit(self) -> None:
        self.assertEqual(
            expedition_voice_channel_name("Dying Light", "a84f19c2"),
            "🔊・dying-light-a84f19c2",
        )
        self.assertIn("acao-cooperacao", expedition_voice_channel_name("Ação Cooperação", "a84f19c2"))
        fallback = expedition_voice_channel_name("!!!", "a84f19c2")
        self.assertEqual(fallback, "🔊・expedicao-a84f19c2")
        limited = expedition_voice_channel_name("jogo " * 100, "a84f19c2")
        self.assertLessEqual(len(limited), 100)
        self.assertTrue(limited.endswith("a84f19c2"))

    def test_bitrate_is_converted_and_limited(self) -> None:
        self.assertEqual(limited_bitrate(384, 96000), 96000)
        self.assertEqual(limited_bitrate(64, 96000), 64000)

    def test_authorization(self) -> None:
        self.assertTrue(can_create_voice_room(1, 1, administrator=False, has_host_role=False))
        self.assertTrue(can_create_voice_room(2, 1, administrator=True, has_host_role=False))
        self.assertTrue(can_create_voice_room(2, 1, administrator=False, has_host_role=True))
        self.assertFalse(can_create_voice_room(2, 1, administrator=False, has_host_role=False))
        self.assertTrue(can_access_voice_room(2, 1, (1, 2), administrator=False, has_host_role=False))
        self.assertFalse(can_access_voice_room(3, 1, (1, 2), administrator=False, has_host_role=False))


class VoiceLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self) -> ExpeditionVoiceService:
        return ExpeditionVoiceService(MagicMock(spec=discord.Client), config(), AsyncMock(), AsyncMock())

    async def test_bidirectional_index_and_manual_delete(self) -> None:
        service = self.make_service()
        service._index("a84f19c2", 20)
        self.assertEqual(service.voice_channel_id("a84f19c2"), 20)
        service._expeditions.update_voice_reference = AsyncMock()
        await service.on_channel_delete(type("Channel", (), {"id": 20})())
        self.assertEqual(service.active_room_count, 0)
        service._expeditions.update_voice_reference.assert_awaited_once_with("a84f19c2", None)

    async def test_duplicate_cleanup_and_entry_cancels_it(self) -> None:
        service = self.make_service()
        service._index("a84f19c2", 20)
        self.assertTrue(await service.schedule_cleanup(20))
        self.assertFalse(await service.schedule_cleanup(20))
        after = type("State", (), {"channel": type("Channel", (), {"id": 20})()})()
        before = type("State", (), {"channel": None})()
        await service.on_voice_state_update(before, after)
        self.assertEqual(service.cleanup_task_count, 0)

    async def test_empty_timeout_deletes_and_occupied_room_survives(self) -> None:
        service = self.make_service()
        empty = type("Voice", (), {"id": 20, "members": [], "delete": AsyncMock()})()
        service._index("a84f19c2", 20)
        service.resolve_voice_channel = lambda channel_id: empty
        service._expeditions.update_voice_reference = AsyncMock()
        with patch("elysium.services.expedition_voice_service.asyncio.sleep", AsyncMock()):
            await service._cleanup_after_timeout(20)
        empty.delete.assert_awaited_once()

        occupied = type("Voice", (), {"id": 21, "members": [object()], "delete": AsyncMock()})()
        service._index("b84f19c2", 21)
        service.resolve_voice_channel = lambda channel_id: occupied
        with patch("elysium.services.expedition_voice_service.asyncio.sleep", AsyncMock()):
            await service._cleanup_after_timeout(21)
        occupied.delete.assert_not_awaited()
        await service.shutdown()


class VoiceCreationTests(unittest.IsolatedAsyncioTestCase):
    def model(self) -> Expedition:
        return Expedition(
            expedition_id="a84f19c2",
            owner_user_id=1,
            game="Jogo",
            scheduled_for="Hoje",
            platform="PC",
            capacity=4,
            details="Detalhes suficientes",
            participant_user_ids=(1, 2),
            created_at=datetime.now(UTC),
        )

    def forbidden(self) -> discord.Forbidden:
        response = SimpleNamespace(status=403, reason="Forbidden")
        return discord.Forbidden(response, {"code": 50013, "message": "Missing Permissions"})

    def setup_creation(self) -> tuple[ExpeditionVoiceService, object, object]:
        model = self.model()
        expeditions = AsyncMock()
        expeditions.find.return_value = ExpeditionResult(
            ExpeditionOutcome.SUCCESS, object(), model
        )
        guild = SimpleNamespace()
        guild.me = object()
        guild.default_role = object()
        guild.bitrate_limit = 96000
        guild.get_member = lambda user_id: {1: "owner", 2: "participant"}.get(user_id)
        guild.fetch_member = AsyncMock()
        guild.get_role = lambda role_id: None
        category = SimpleNamespace()
        full = SimpleNamespace(**{
            name: True for name in (
                "view_channel", "manage_channels", "manage_roles", "connect",
                "speak", "stream", "use_voice_activation", "move_members",
            )
        })
        category.permissions_for = lambda target: (
            SimpleNamespace(view_channel=False, connect=False)
            if target is guild.default_role else full
        )
        channel = SimpleNamespace(id=20, jump_url="https://discord/channels/1/20")
        channel.set_permissions = AsyncMock()
        channel.delete = AsyncMock()
        guild.create_voice_channel = AsyncMock(return_value=channel)
        service = ExpeditionVoiceService(AsyncMock(), config(), expeditions, AsyncMock())
        service.resolve_category = lambda current_guild: category
        service.resolve_voice_channel = lambda channel_id: None
        return service, guild, channel

    async def test_creation_has_no_custom_overwrites_and_applies_stages(self) -> None:
        service, guild, channel = self.setup_creation()
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.SUCCESS)
        kwargs = guild.create_voice_channel.await_args.kwargs
        self.assertNotIn("overwrites", kwargs)
        self.assertEqual(kwargs["user_limit"], self.model().capacity)
        self.assertEqual(channel.set_permissions.await_count, 3)
        self.assertEqual(
            [call.args[0] for call in channel.set_permissions.await_args_list],
            [guild.me, "owner", "participant"],
        )

    async def test_public_category_is_rejected_before_creation(self) -> None:
        service, guild, channel = self.setup_creation()
        category = service.resolve_category(guild)
        category.permissions_for = lambda target: SimpleNamespace(
            view_channel=True, connect=True,
            manage_channels=True, manage_roles=True, speak=True, stream=True,
            use_voice_activation=True, move_members=True,
        )
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.CATEGORY_PUBLIC)
        self.assertIsNotNone(result.incident_id)
        guild.create_voice_channel.assert_not_awaited()
        channel.delete.assert_not_awaited()

    async def test_missing_permission_returns_structured_result(self) -> None:
        service, guild, _ = self.setup_creation()
        category = service.resolve_category(guild)
        original = category.permissions_for
        category.permissions_for = lambda target: (
            original(target) if target is guild.default_role else
            SimpleNamespace(
                view_channel=True, manage_channels=False, manage_roles=True,
                connect=True, speak=True, stream=True,
                use_voice_activation=True, move_members=True,
            )
        )
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.PERMISSIONS_MISSING)
        self.assertEqual(result.missing_permissions, ("manage_channels",))
        self.assertRegex(result.incident_id or "", r"^[A-F0-9]{8}$")

    async def test_owner_and_participant_failures_roll_back(self) -> None:
        for failure_index in (1, 2):
            with self.subTest(failure_index=failure_index):
                service, guild, channel = self.setup_creation()
                effects = [None, None, None]
                effects[failure_index] = self.forbidden()
                channel.set_permissions.side_effect = effects
                result = await service.create_room(guild, "a84f19c2", 1)
                self.assertIs(result.outcome, VoiceRoomOutcome.OVERWRITE_FAILED)
                channel.delete.assert_awaited_once()
                service._expeditions.update_voice_reference.assert_not_awaited()
                self.assertEqual(service.active_room_count, 0)

    async def test_rollback_failure_is_audited_with_incident(self) -> None:
        service, guild, channel = self.setup_creation()
        channel.set_permissions.side_effect = [None, self.forbidden()]
        channel.delete.side_effect = self.forbidden()
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.OVERWRITE_FAILED)
        self.assertIsNotNone(result.incident_id)
        self.assertGreaterEqual(service._audit.send.await_count, 2)

    async def test_jarvis_gets_only_voice_permissions_and_one_extra_slot(self) -> None:
        service, guild, channel = self.setup_creation()
        service._config = replace(config(), jarvis_bot_user_id=30)
        jarvis = SimpleNamespace(id=30, bot=True)
        original = guild.get_member
        guild.get_member = lambda user_id: jarvis if user_id == 30 else original(user_id)
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.SUCCESS)
        self.assertEqual(guild.create_voice_channel.await_args.kwargs["user_limit"], 5)
        jarvis_call = channel.set_permissions.await_args_list[-1]
        self.assertIs(jarvis_call.args[0], jarvis)
        overwrite = jarvis_call.kwargs["overwrite"]
        allowed, denied = overwrite.pair()
        self.assertEqual(
            allowed.value,
            discord.Permissions(view_channel=True, connect=True, speak=True).value,
        )
        self.assertEqual(denied.value, 0)

    async def test_uncached_jarvis_is_resolved_without_members_intent(self) -> None:
        service, guild, channel = self.setup_creation()
        service._config = replace(config(), jarvis_bot_user_id=30)
        jarvis = SimpleNamespace(id=30, bot=True)
        guild.fetch_member.return_value = jarvis
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.SUCCESS)
        guild.fetch_member.assert_awaited_once_with(30)
        self.assertIs(channel.set_permissions.await_args_list[-1].args[0], jarvis)

    async def test_jarvis_human_or_unavailable_never_receives_access_or_slot(self) -> None:
        for member, failure in (
            (SimpleNamespace(id=30, bot=False), None),
            (SimpleNamespace(id=31, bot=True), None),
            (None, self.forbidden()),
        ):
            with self.subTest(member=member, failure=type(failure)):
                service, guild, channel = self.setup_creation()
                service._config = replace(config(), jarvis_bot_user_id=30)
                original = guild.get_member
                guild.get_member = lambda user_id: member if user_id == 30 else original(user_id)
                guild.fetch_member.side_effect = failure
                result = await service.create_room(guild, "a84f19c2", 1)
                self.assertIs(result.outcome, VoiceRoomOutcome.SUCCESS)
                self.assertEqual(channel.set_permissions.await_count, 3)
                self.assertEqual(guild.create_voice_channel.await_args.kwargs["user_limit"], 4)

    async def test_failed_jarvis_overwrite_rolls_back_incomplete_room(self) -> None:
        service, guild, channel = self.setup_creation()
        service._config = replace(config(), jarvis_bot_user_id=30)
        original = guild.get_member
        guild.get_member = lambda user_id: (
            SimpleNamespace(id=30, bot=True) if user_id == 30 else original(user_id)
        )
        channel.set_permissions.side_effect = [None, None, None, self.forbidden()]
        result = await service.create_room(guild, "a84f19c2", 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.OVERWRITE_FAILED)
        channel.delete.assert_awaited_once()
        self.assertEqual(service.active_room_count, 0)

    async def test_maximum_expedition_capacity_stays_under_discord_voice_limit(self) -> None:
        service, guild, _ = self.setup_creation()
        maximum = replace(self.model(), capacity=12)
        service._expeditions.find.return_value = ExpeditionResult(
            ExpeditionOutcome.SUCCESS, object(), maximum
        )
        service._config = replace(config(), jarvis_bot_user_id=30)
        original = guild.get_member
        guild.get_member = lambda user_id: (
            SimpleNamespace(id=30, bot=True) if user_id == 30 else original(user_id)
        )
        result = await service.create_room(guild, maximum.expedition_id, 1)
        self.assertIs(result.outcome, VoiceRoomOutcome.SUCCESS)
        user_limit = guild.create_voice_channel.await_args.kwargs["user_limit"]
        self.assertEqual(user_limit, 13)
        self.assertLessEqual(user_limit, 99)

    async def test_concurrent_creation_keeps_one_room_and_jarvis_overwrite(self) -> None:
        service, guild, channel = self.setup_creation()
        service._config = replace(config(), jarvis_bot_user_id=30)
        original = guild.get_member
        guild.get_member = lambda user_id: (
            SimpleNamespace(id=30, bot=True) if user_id == 30 else original(user_id)
        )
        service.resolve_voice_channel = lambda channel_id: channel if channel_id == 20 else None
        creation_started = asyncio.Event()
        release_creation = asyncio.Event()

        async def delayed_creation(*args: object, **kwargs: object) -> SimpleNamespace:
            creation_started.set()
            await release_creation.wait()
            return channel

        guild.create_voice_channel.side_effect = delayed_creation
        first = asyncio.create_task(service.create_room(guild, "a84f19c2", 1))
        await creation_started.wait()
        second = asyncio.create_task(service.create_room(guild, "a84f19c2", 1))
        release_creation.set()
        results = await asyncio.gather(first, second)
        self.assertTrue(all(result.outcome is VoiceRoomOutcome.SUCCESS for result in results))
        self.assertTrue(all(result.channel is channel for result in results))
        guild.create_voice_channel.assert_awaited_once()
        self.assertEqual(channel.set_permissions.await_count, 4)
        self.assertEqual(service.active_room_count, 1)
        self.assertEqual(guild.create_voice_channel.await_args.kwargs["user_limit"], 5)


class JarvisVoiceLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, *, enabled: bool = True) -> ExpeditionVoiceService:
        return ExpeditionVoiceService(
            AsyncMock(), replace(config(), jarvis_bot_user_id=30 if enabled else None),
            AsyncMock(), AsyncMock(),
        )

    def voice(self, members: list[object]) -> SimpleNamespace:
        return SimpleNamespace(id=20, members=members, delete=AsyncMock())

    async def test_cleanup_only_ignores_the_configured_confirmed_bot(self) -> None:
        jarvis = SimpleNamespace(id=30, bot=True)
        for enabled, members, expected_deleted in (
            (True, [jarvis], True),
            (False, [jarvis], False),
            (True, [SimpleNamespace(id=30, bot=False)], False),
            (True, [SimpleNamespace(id=31, bot=True)], False),
            (True, [jarvis, SimpleNamespace(id=1, bot=False)], False),
            (True, [jarvis, SimpleNamespace(id=31, bot=True)], False),
        ):
            with self.subTest(enabled=enabled, members=members):
                service = self.make_service(enabled=enabled)
                voice = self.voice(members)
                service._index("a84f19c2", voice.id)
                service.resolve_voice_channel = lambda channel_id: voice
                with patch("elysium.services.expedition_voice_service.asyncio.sleep", AsyncMock()):
                    await service._cleanup_after_timeout(voice.id)
                self.assertEqual(voice.delete.await_count, int(expected_deleted))
                self.assertEqual(service.active_room_count, int(not expected_deleted))
                await service.shutdown()

    async def test_direct_delete_rechecks_humans_even_after_cleanup_was_scheduled(self) -> None:
        service = self.make_service()
        voice = self.voice([SimpleNamespace(id=30, bot=True)])
        service._index("a84f19c2", voice.id)
        service.resolve_voice_channel = lambda channel_id: voice
        await service.schedule_cleanup(voice.id)
        voice.members.append(SimpleNamespace(id=1, bot=False))
        self.assertFalse(await service.delete_room(voice.id, reason="teste"))
        voice.delete.assert_not_awaited()
        await service.shutdown()
        self.assertEqual(service.cleanup_task_count, 0)

    async def test_last_human_leaves_and_jarvis_alone_does_not_cancel_cleanup(self) -> None:
        service = self.make_service()
        voice = self.voice([SimpleNamespace(id=30, bot=True)])
        service._index("a84f19c2", voice.id)
        service.resolve_voice_channel = lambda channel_id: voice
        outside = SimpleNamespace(channel=None)
        inside = SimpleNamespace(channel=voice)
        await service.on_voice_state_update(inside, outside)
        self.assertEqual(service.cleanup_task_count, 1)
        first_task = service._cleanup_tasks[voice.id]
        await service.on_voice_state_update(outside, inside)
        self.assertIs(service._cleanup_tasks[voice.id], first_task)
        voice.members.append(SimpleNamespace(id=1, bot=False))
        await service.on_voice_state_update(outside, inside)
        self.assertEqual(service.cleanup_task_count, 0)
        await service.shutdown()

    async def test_jarvis_entering_empty_indexed_room_starts_cleanup(self) -> None:
        service = self.make_service()
        voice = self.voice([SimpleNamespace(id=30, bot=True)])
        service._index("a84f19c2", voice.id)
        service.resolve_voice_channel = lambda channel_id: voice
        await service.on_voice_state_update(
            SimpleNamespace(channel=None), SimpleNamespace(channel=voice)
        )
        self.assertEqual(service.cleanup_task_count, 1)
        await service.shutdown()

    async def test_close_with_only_jarvis_deletes_but_never_with_humans(self) -> None:
        for has_human in (False, True):
            with self.subTest(has_human=has_human):
                service = self.make_service()
                members = [SimpleNamespace(id=30, bot=True)]
                if has_human:
                    members.append(SimpleNamespace(id=1, bot=False))
                voice = self.voice(members)
                service._index("a84f19c2", voice.id)
                service.resolve_voice_channel = lambda channel_id: voice
                before = replace(VoiceCreationTests().model(), voice_channel_id=voice.id)
                after = replace(before, status=ExpeditionStatus.CLOSED)
                await service.on_expedition_mutation("close", before, after, 1)
                self.assertEqual(voice.delete.await_count, int(not has_human))
                self.assertEqual(service.cleanup_task_count, int(has_human))
                await service.shutdown()

    async def test_edit_reserves_slot_only_for_confirmed_jarvis(self) -> None:
        for member, expected in (
            (SimpleNamespace(id=30, bot=True), 5),
            (SimpleNamespace(id=30, bot=False), 4),
        ):
            with self.subTest(member=member):
                service = self.make_service()
                voice = self.voice([])
                voice.guild = SimpleNamespace(get_member=lambda user_id: member)
                voice.edit = AsyncMock()
                service.resolve_voice_channel = lambda channel_id: voice
                before = replace(VoiceCreationTests().model(), voice_channel_id=voice.id)
                await service.on_expedition_mutation("edit", before, before, 1)
                voice.edit.assert_awaited_once_with(user_limit=expected)

    async def test_startup_indexes_occupied_rooms_and_schedules_only_jarvis_or_empty(self) -> None:
        for active in (True, False):
            for members, expected_scheduled in (
                ([], 1),
                ([SimpleNamespace(id=30, bot=True)], 1),
                ([SimpleNamespace(id=30, bot=False)], 0),
                ([SimpleNamespace(id=31, bot=True)], 0),
                ([SimpleNamespace(id=30, bot=True), SimpleNamespace(id=1, bot=False)], 0),
            ):
                with self.subTest(active=active, members=members):
                    service = self.make_service()
                    voice = MagicMock(spec=discord.VoiceChannel)
                    voice.id = 20
                    voice.name = "expedicao-a84f19c2"
                    voice.category_id = 10
                    voice.members = members
                    voice.delete = AsyncMock()
                    category = SimpleNamespace(id=10, voice_channels=[voice])
                    guild = SimpleNamespace(get_channel=lambda channel_id: voice)
                    service.resolve_category = lambda guild: category
                    service._client.user = SimpleNamespace(id=99)
                    model = replace(VoiceCreationTests().model(), voice_channel_id=voice.id)
                    message = SimpleNamespace(
                        author=SimpleNamespace(id=99),
                        embeds=[build_expedition_embed(model, "Organizador")],
                    )

                    async def history(**kwargs: object) -> AsyncIterator[SimpleNamespace]:
                        if active:
                            yield message

                    service._expeditions.resolve_channel.return_value = SimpleNamespace(history=history)
                    summary = await service.reconcile(guild)
                    self.assertEqual(summary.cleanups_scheduled, expected_scheduled)
                    self.assertEqual(service.voice_channel_id("a84f19c2"), 20)
                    voice.delete.assert_not_awaited()
                    await service.shutdown()
