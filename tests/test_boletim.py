from __future__ import annotations

import unittest

import discord

from elysium.cogs.boletim import (
    BOLETIM_FOOTER,
    MAX_EMBED_CHARACTERS,
    BulletinDraft,
    BulletinPreviewView,
    BulletinValidationError,
    MentionType,
    build_bulletin_embed,
    embed_character_count,
    is_bulletin_manager,
    is_valid_http_url,
    mention_payload,
    validate_draft,
)
from elysium.config import ConfigError, ElysiumConfig
from tests.test_config import BASE_ENVIRONMENT


def draft(**changes: str) -> BulletinDraft:
    values = {
        "title": "Uma nova jornada",
        "subtitle": "Notícias da comunidade",
        "body": "O Elysium abre novas possibilidades.",
        "call_to_action": "Participe desta história.",
        "image_url": "https://example.com/banner.png",
    }
    values.update(changes)
    return BulletinDraft(**values)


class BulletinTests(unittest.TestCase):
    def test_embed_layout(self) -> None:
        embed = build_bulletin_embed(draft())
        self.assertEqual(embed.title, "✦ UMA NOVA JORNADA")
        self.assertEqual(
            embed.description,
            "*Notícias da comunidade*\n\nO Elysium abre novas possibilidades.\n\n**Participe desta história.**",
        )
        self.assertEqual(embed.footer.text, BOLETIM_FOOTER)
        self.assertIsNotNone(embed.timestamp)
        self.assertFalse(embed.author.name)
        self.assertFalse(embed.thumbnail.url)

    def test_optional_subtitle_and_call(self) -> None:
        embed = build_bulletin_embed(draft(subtitle="", call_to_action=""))
        self.assertEqual(embed.description, "O Elysium abre novas possibilidades.")

    def test_url_validation(self) -> None:
        for value in ("", "http://example.com/a.png", "https://example.com/a.png"):
            self.assertTrue(is_valid_http_url(value))
        for value in ("ftp://example.com/a.png", "https://", "example.com/a.png"):
            self.assertFalse(is_valid_http_url(value))
            with self.assertRaises(BulletinValidationError):
                validate_draft(draft(image_url=value))

    def test_embed_limits_and_empty_fields(self) -> None:
        embed = build_bulletin_embed(draft())
        self.assertLessEqual(embed_character_count(embed), MAX_EMBED_CHARACTERS)
        for changes in ({"title": ""}, {"body": ""}, {"body": "x" * 4097}):
            with self.subTest(changes=changes), self.assertRaises(BulletinValidationError):
                validate_draft(draft(**changes))

    def test_manager_role_parsing(self) -> None:
        config = ElysiumConfig.from_env(
            {**BASE_ENVIRONMENT, "BOLETIM_MANAGER_ROLE_IDS": "123, 987,123"},
            load_dotenv_file=False,
        )
        self.assertEqual(config.boletim_manager_role_ids, (123, 987))
        with self.assertRaises(ConfigError):
            ElysiumConfig.from_env(
                {**BASE_ENVIRONMENT, "BOLETIM_MANAGER_ROLE_IDS": "123,invalid"},
                load_dotenv_file=False,
            )

    def test_authorization_by_permission_or_role(self) -> None:
        permissions = type("Permissions", (), {"manage_guild": True})()
        manager = type("Member", (), {"guild_permissions": permissions, "roles": ()})()
        self.assertTrue(is_bulletin_manager(manager, (123,)))
        permissions = type("Permissions", (), {"manage_guild": False})()
        role_manager = type(
            "Member", (), {"guild_permissions": permissions, "roles": (discord.Object(id=123),)}
        )()
        self.assertTrue(is_bulletin_manager(role_manager, (123,)))
        self.assertFalse(is_bulletin_manager(role_manager, (987,)))

    def test_mention_selections_are_restricted(self) -> None:
        content, allowed = mention_payload(MentionType.NONE)
        self.assertIsNone(content)
        self.assertEqual(allowed.to_dict(), {"parse": []})

        role = type("Role", (), {"id": 123, "mention": "<@&123>"})()
        content, allowed = mention_payload(MentionType.EVENTS, role)
        self.assertEqual(content, "<@&123>")
        self.assertEqual(allowed.to_dict(), {"roles": [123], "parse": []})

        content, allowed = mention_payload(MentionType.EVERYONE)
        self.assertEqual(content, "@everyone")
        self.assertEqual(allowed.to_dict(), {"parse": ["everyone"]})

    def test_preview_uses_safe_label_and_duplicate_flag(self) -> None:
        self.assertEqual(MentionType.EVENTS.display_name, "@Eventos")
        view = BulletinPreviewView(None, None, 1, None, MentionType.NONE, draft())
        self.assertFalse(view._published)
        view._published = True
        self.assertTrue(view._published)
        view.stop()
