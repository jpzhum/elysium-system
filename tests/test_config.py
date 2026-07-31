from __future__ import annotations

import unittest

from elysium.config import ConfigError, ElysiumConfig


BASE_ENVIRONMENT = {
    "DISCORD_TOKEN": "token-ficticio",
    "GUILD_ID": "100000000000000001",
    "HABITANTE_ROLE_ID": "100000000000000002",
    "VISITANTE_ROLE_ID": "100000000000000003",
    "PANEL_CHANNEL_ID": "100000000000000004",
}


class ConfigTests(unittest.TestCase):
    def test_valid_presentation_settings(self) -> None:
        environment = {
            **BASE_ENVIRONMENT,
            "PRESENTATION_CHANNEL_ID": "100000000000000006",
            "PRESENTATION_BANNER_URL": "https://example.com/banner.png",
        }
        config = ElysiumConfig.from_env(environment, load_dotenv_file=False)
        self.assertEqual(config.presentation_channel_id, 100000000000000006)
        self.assertEqual(config.presentation_banner_url, "https://example.com/banner.png")

    def test_missing_presentation_channel_and_empty_url_are_allowed(self) -> None:
        config = ElysiumConfig.from_env(BASE_ENVIRONMENT, load_dotenv_file=False)
        self.assertIsNone(config.presentation_channel_id)
        self.assertEqual(config.presentation_banner_url, "")

    def test_invalid_presentation_channel_is_rejected(self) -> None:
        with self.assertRaises(ConfigError):
            ElysiumConfig.from_env(
                {**BASE_ENVIRONMENT, "PRESENTATION_CHANNEL_ID": "invalid"},
                load_dotenv_file=False,
            )

    def test_invalid_presentation_url_is_rejected(self) -> None:
        with self.assertRaises(ConfigError):
            ElysiumConfig.from_env(
                {**BASE_ENVIRONMENT, "PRESENTATION_BANNER_URL": "ftp://example.com"},
                load_dotenv_file=False,
            )
    def test_valid_log_channel(self) -> None:
        environment = {**BASE_ENVIRONMENT, "LOG_CHANNEL_ID": "100000000000000005"}
        config = ElysiumConfig.from_env(environment, load_dotenv_file=False)
        self.assertEqual(config.log_channel_id, 100000000000000005)

    def test_missing_log_channel_is_optional(self) -> None:
        config = ElysiumConfig.from_env(BASE_ENVIRONMENT, load_dotenv_file=False)
        self.assertIsNone(config.log_channel_id)

    def test_invalid_log_channel_is_rejected(self) -> None:
        environment = {**BASE_ENVIRONMENT, "LOG_CHANNEL_ID": "canal"}
        with self.assertRaises(ConfigError):
            ElysiumConfig.from_env(environment, load_dotenv_file=False)
