from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from elysium.config import ElysiumConfig
from elysium.services.expedition_voice_service import (
    ExpeditionVoiceService,
    can_access_voice_room,
    can_create_voice_room,
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
        return ExpeditionVoiceService(AsyncMock(), config(), AsyncMock(), AsyncMock())

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
