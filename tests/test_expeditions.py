from __future__ import annotations

import re
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import AsyncMock

from elysium.constants import VERSION
from elysium.models.expedition import Expedition, ExpeditionStatus
from elysium.modals.expedition import ExpeditionModal
from elysium.services.expedition_service import (
    ExpeditionValidationError,
    ExpeditionOutcome,
    ExpeditionResult,
    ExpeditionService,
    build_expedition_embed,
    can_close_expedition,
    expedition_from_embed,
    expedition_id_from_embed,
    owner_user_id_from_embed,
    participant_user_ids_from_embed,
    voice_channel_id_from_embed,
    validate_capacity,
    validate_expedition,
)
from elysium.utils.content_validation import normalize_text
from elysium.views.expedition_items import DYNAMIC_EXPEDITION_ITEMS, build_expedition_card_view


def sample(**changes: object) -> Expedition:
    values = {
        "expedition_id": "a84f19c2",
        "owner_user_id": 123456789,
        "game": "Minecraft",
        "scheduled_for": "Hoje às 21h",
        "platform": "PC",
        "capacity": 4,
        "details": "Sessão casual para construir uma vila.",
        "participant_user_ids": (123456789,),
        "created_at": datetime(2026, 8, 3, tzinfo=UTC),
        "status": ExpeditionStatus.ACTIVE,
    }
    values.update(changes)
    return Expedition(**values)


class ExpeditionTests(unittest.TestCase):
    def test_version_model_and_validation(self) -> None:
        self.assertEqual(VERSION, "1.3.1")
        model = validate_expedition(sample())
        self.assertEqual(model.participant_user_ids[0], model.owner_user_id)
        self.assertEqual(normalize_text("  Olá   mundo\n\n\n teste\x00 "), "Olá mundo\n\nteste")

    def test_capacity_bounds_and_occupancy(self) -> None:
        for capacity in (2, 12):
            self.assertEqual(validate_capacity(capacity), capacity)
        for capacity, occupied in ((1, 1), (13, 1), (2, 3)):
            with self.subTest(capacity=capacity), self.assertRaises(ExpeditionValidationError):
                validate_capacity(capacity, occupied)

    def test_forbidden_content_and_duplicate_participants(self) -> None:
        for value in ("https://example.com", "discord.gg/teste", "<@123456>", "@here"):
            with self.subTest(value=value), self.assertRaises(ExpeditionValidationError):
                validate_expedition(sample(details=f"Detalhes permitidos {value}"))
        with self.assertRaises(ExpeditionValidationError):
            validate_expedition(sample(participant_user_ids=(123456789, 123456789)))

    def test_active_embed_and_round_trip(self) -> None:
        model = sample(participant_user_ids=(123456789, 987654321))
        embed = build_expedition_embed(model, "Ely", "https://example.com/avatar.png")
        self.assertEqual(embed.title, "Expedição — Minecraft")
        self.assertEqual(owner_user_id_from_embed(embed), 123456789)
        self.assertEqual(expedition_id_from_embed(embed), "a84f19c2")
        self.assertEqual(participant_user_ids_from_embed(embed), (123456789, 987654321))
        self.assertEqual(expedition_from_embed(embed), model)

    def test_voice_field_and_round_trip(self) -> None:
        model = sample(voice_channel_id=987654321)
        embed = build_expedition_embed(model, "Ely")
        field = next(item for item in embed.fields if item.name == "Sala de voz")
        self.assertEqual(field.value, "<#987654321>")
        self.assertFalse(field.inline)
        self.assertEqual(voice_channel_id_from_embed(embed), 987654321)
        self.assertEqual(expedition_from_embed(embed), model)

    def test_invalid_voice_reference_is_rejected(self) -> None:
        embed = build_expedition_embed(sample(), "Ely")
        embed.add_field(name="Sala de voz", value="canal 123", inline=False)
        self.assertIsNone(voice_channel_id_from_embed(embed))

    def test_closed_embed_and_buttons(self) -> None:
        model = replace(sample(), status=ExpeditionStatus.CLOSED)
        embed = build_expedition_embed(model, "Ely")
        self.assertEqual(embed.title, "Expedição encerrada — Minecraft")
        view = build_expedition_card_view(None, None, model)
        self.assertTrue(all(item.item.disabled for item in view.children))
        view.stop()

    def test_full_disables_only_join(self) -> None:
        model = sample(capacity=2, participant_user_ids=(123456789, 987654321))
        view = build_expedition_card_view(None, None, model)
        self.assertEqual([item.item.disabled for item in view.children], [True, False, False, False, False])
        self.assertEqual(view.children[4].item.custom_id, "elysium:expedition:voice:a84f19c2")
        view.stop()

    def test_dynamic_templates_are_strict(self) -> None:
        valid = "a84f19c2"
        for item_class in DYNAMIC_EXPEDITION_ITEMS:
            pattern = item_class.__discord_ui_compiled_template__
            self.assertIsNotNone(pattern.fullmatch(f"elysium:expedition:{item_class.action}:{valid}"))
            for invalid in ("A84f19c2", "a84f19c", "a84f19c22", "zzzzzzzz"):
                self.assertIsNone(pattern.fullmatch(f"elysium:expedition:{item_class.action}:{invalid}"))

    def test_close_permission(self) -> None:
        self.assertTrue(can_close_expedition(1, 1, administrator=False, has_host_role=False))
        self.assertTrue(can_close_expedition(2, 1, administrator=True, has_host_role=False))
        self.assertTrue(can_close_expedition(2, 1, administrator=False, has_host_role=True))
        self.assertFalse(can_close_expedition(2, 1, administrator=False, has_host_role=False))

    def test_modal_has_exact_fields(self) -> None:
        modal = ExpeditionModal(None, None)
        self.assertEqual(len(modal.children), 5)
        self.assertEqual(
            [(item.min_length, item.max_length) for item in modal.children],
            [(2, 60), (2, 80), (2, 40), (1, 2), (10, 400)],
        )


class ExpeditionMutationTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, model: Expedition) -> tuple[ExpeditionService, object]:
        client = AsyncMock()
        audit = AsyncMock()
        service = ExpeditionService(client, 100, audit)
        message = type("Message", (), {})()
        message.id = 200
        message.jump_url = "https://discord.com/channels/1/100/200"
        message.embeds = [build_expedition_embed(model, "Ely")]
        message.edit = AsyncMock()
        service.find = AsyncMock(
            return_value=ExpeditionResult(ExpeditionOutcome.SUCCESS, message, model)
        )
        return service, message

    async def test_duplicate_join_and_capacity_are_respected(self) -> None:
        service, message = self.make_service(sample())
        result = await service.mutate("a84f19c2", 123456789, "join")
        self.assertIs(result.outcome, ExpeditionOutcome.ALREADY_JOINED)
        message.edit.assert_not_awaited()

        full = sample(capacity=2, participant_user_ids=(123456789, 987654321))
        service, message = self.make_service(full)
        result = await service.mutate("a84f19c2", 555555555, "join")
        self.assertIs(result.outcome, ExpeditionOutcome.FULL)
        message.edit.assert_not_awaited()

    async def test_owner_cannot_leave(self) -> None:
        service, message = self.make_service(sample())
        result = await service.mutate("a84f19c2", 123456789, "leave")
        self.assertIs(result.outcome, ExpeditionOutcome.OWNER_CANNOT_LEAVE)
        message.edit.assert_not_awaited()

    async def test_edit_capacity_cannot_drop_below_occupancy(self) -> None:
        occupied = sample(capacity=3, participant_user_ids=(123456789, 987654321, 555555555))
        service, message = self.make_service(occupied)
        result = await service.mutate("a84f19c2", 123456789, "edit", capacity=2)
        self.assertIs(result.outcome, ExpeditionOutcome.INVALID_CAPACITY)
        message.edit.assert_not_awaited()
