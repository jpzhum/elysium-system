from __future__ import annotations

import logging
from collections.abc import Callable

from aiohttp import web

from elysium.constants import SERVICE_NAME

logger = logging.getLogger("elysium.health")


def create_health_application(is_discord_ready: Callable[[], bool]) -> web.Application:
    async def health_check(request: web.Request) -> web.Response:
        del request
        return web.json_response(
            {
                "status": "ok",
                "service": SERVICE_NAME,
                "discord_ready": is_discord_ready(),
            }
        )

    application = web.Application()
    application.router.add_get("/", health_check)
    application.router.add_get("/health", health_check)
    return application


class HealthServer:
    def __init__(self, port: int, is_discord_ready: Callable[[], bool]) -> None:
        self._port = port
        self._application = create_health_application(is_discord_ready)
        self._runner: web.AppRunner | None = None

    async def start(self) -> None:
        if self._runner is not None:
            return
        runner = web.AppRunner(self._application)
        await runner.setup()
        try:
            await web.TCPSite(runner, host="0.0.0.0", port=self._port).start()
        except Exception:
            await runner.cleanup()
            raise
        self._runner = runner
        logger.info("Servidor de saúde ativo em 0.0.0.0:%s.", self._port)

    async def close(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
