from __future__ import annotations

import unittest

from elysium.constants import SERVICE_NAME, VERSION
from elysium.web.health import build_health_payload


class HealthPayloadTests(unittest.TestCase):
    def test_payload_before_ready(self) -> None:
        payload = build_health_payload(
            is_discord_ready=lambda: False,
            uptime_seconds=lambda: 0,
            latency_ms=lambda: None,
            is_guild_ready=lambda: False,
            log_channel_configured=False,
            presentations_configured=False,
        )
        self.assertFalse(payload["discord_ready"])
        self.assertIsNone(payload["latency_ms"])
        self.assertEqual(payload["version"], VERSION)
        self.assertTrue({"status", "service", "discord_ready"} <= payload.keys())
        self.assertEqual(payload["service"], SERVICE_NAME)

    def test_payload_after_ready(self) -> None:
        payload = build_health_payload(
            is_discord_ready=lambda: True,
            uptime_seconds=lambda: 842,
            latency_ms=lambda: 74,
            is_guild_ready=lambda: True,
            log_channel_configured=True,
            presentations_configured=True,
        )
        self.assertEqual(
            payload,
            {
                "status": "ok",
                "service": SERVICE_NAME,
                "discord_ready": True,
                "version": VERSION,
                "uptime_seconds": 842,
                "latency_ms": 74,
                "guild_ready": True,
                "log_channel_configured": True,
                "presentations_configured": True,
            },
        )
