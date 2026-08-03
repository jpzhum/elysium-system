from __future__ import annotations

import unittest
from datetime import UTC, datetime
from unittest.mock import AsyncMock

from elysium.constants import PRESENTATION_EMBED_TITLE, VERSION
from elysium.modals.presentation import PresentationModal
from elysium.models.presentation import Presentation
from elysium.services.presentation_service import (
    PresentationOutcome,
    PresentationService,
    PresentationValidationError,
    build_presentation_embed,
    normalize_text,
    owner_id_from_embed,
    presentation_from_embed,
    validate_presentation,
)


def sample(**changes: object) -> Presentation:
    values = {
        "user_id": 123456789,
        "preferred_name": "Ely",
        "about": "Uma descrição confortável.",
        "interests": "Jogos e música",
        "current_activity": "Um projeto",
        "expectations": "Boas conversas",
        "created_at": datetime(2026, 1, 2, tzinfo=UTC),
    }
    values.update(changes)
    return Presentation(**values)


class PresentationTests(unittest.IsolatedAsyncioTestCase):
    def test_version_and_normalization(self) -> None:
        self.assertEqual(VERSION, "1.3.0")
        self.assertEqual(normalize_text("  Olá   mundo\n\n\n teste\x00  "), "Olá mundo\n\nteste")

    def test_rejects_links_invites_and_mentions(self) -> None:
        forbidden = ("https://example.com", "discord.gg/teste", "<@123456>", "@everyone")
        for value in forbidden:
            with self.subTest(value=value), self.assertRaises(PresentationValidationError):
                validate_presentation(sample(about=f"Descrição válida {value}"))

    def test_embed_contract_and_round_trip(self) -> None:
        presentation = sample(current_activity="")
        embed = build_presentation_embed(presentation, "https://example.com/avatar.png")
        self.assertEqual(embed.title, PRESENTATION_EMBED_TITLE)
        self.assertEqual(embed.author.url, "https://discord.com/users/123456789")
        self.assertEqual(owner_id_from_embed(embed), 123456789)
        self.assertNotIn("No momento", {field.name for field in embed.fields})
        self.assertEqual(presentation_from_embed(embed, 123456789), presentation)
        self.assertIsNone(presentation_from_embed(embed, 987654321))

    async def test_modal_has_five_specified_fields(self) -> None:
        modal = PresentationModal(AsyncMock(), AsyncMock())
        self.assertEqual(len(modal.children), 5)
        self.assertEqual(
            [(item.min_length, item.max_length, item.required) for item in modal.children],
            [(2, 32, True), (10, 300, True), (2, 180, True), (None, 180, False), (2, 240, True)],
        )

    async def test_structured_duplicate_and_ownership_guards(self) -> None:
        client = AsyncMock()
        audit = AsyncMock()
        service = PresentationService(client, None, audit)
        service.find = AsyncMock(return_value=type("Found", (), {"outcome": PresentationOutcome.SUCCESS, "message": object()})())
        result = await service.create(sample(), None, "Ely")
        self.assertEqual(result.outcome, PresentationOutcome.DUPLICATE)
        result = await service.update(2, sample(user_id=1), None, "Ely")
        self.assertEqual(result.outcome, PresentationOutcome.NOT_OWNER)
        result = await service.delete(2, 1, "Ely")
        self.assertEqual(result.outcome, PresentationOutcome.NOT_OWNER)
