from __future__ import annotations

import unittest

from aiohttp.test_utils import TestClient, TestServer

from elysium.constants import SERVICE_NAME, VERSION
from elysium.web.health import build_health_payload, create_health_application


class HealthPayloadTests(unittest.TestCase):
    def test_payload_exposes_only_public_service_identity(self) -> None:
        payload = build_health_payload()
        self.assertEqual(
            payload,
            {
                "status": "ok",
                "service": SERVICE_NAME,
                "version": VERSION,
            },
        )


class HealthEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = TestClient(TestServer(create_health_application()))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()

    async def test_public_routes_return_the_minimal_payload(self) -> None:
        expected = build_health_payload()
        for path in ("/", "/health"):
            with self.subTest(path=path):
                response = await self.client.get(path)
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), expected)
