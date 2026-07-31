from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from aiohttp import web

from elysium.constants import SERVICE_NAME, VERSION

logger = logging.getLogger("elysium.health")


def build_health_payload(
    *,
    is_discord_ready: Callable[[], bool],
    uptime_seconds: Callable[[], int],
    latency_ms: Callable[[], int | None],
    is_guild_ready: Callable[[], bool],
    log_channel_configured: bool,
    presentations_configured: bool,
) -> dict[str, Any]:
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "discord_ready": is_discord_ready(),
        "version": VERSION,
        "uptime_seconds": max(0, uptime_seconds()),
        "latency_ms": latency_ms(),
        "guild_ready": is_guild_ready(),
        "log_channel_configured": log_channel_configured,
        "presentations_configured": presentations_configured,
    }


def create_health_application(
    is_discord_ready: Callable[[], bool],
    uptime_seconds: Callable[[], int],
    latency_ms: Callable[[], int | None],
    is_guild_ready: Callable[[], bool],
    log_channel_configured: bool,
    presentations_configured: bool,
) -> web.Application:
    async def health_check(request: web.Request) -> web.Response:
        del request
        return web.json_response(
            build_health_payload(
                is_discord_ready=is_discord_ready,
                uptime_seconds=uptime_seconds,
                latency_ms=latency_ms,
                is_guild_ready=is_guild_ready,
                log_channel_configured=log_channel_configured,
                presentations_configured=presentations_configured,
            )
        )

    application = web.Application()
    application.router.add_get("/", health_check)
    application.router.add_get("/health", health_check)
    return application


class HealthServer:
    def __init__(
        self,
        port: int,
        is_discord_ready: Callable[[], bool],
        uptime_seconds: Callable[[], int],
        latency_ms: Callable[[], int | None],
        is_guild_ready: Callable[[], bool],
        log_channel_configured: bool,
        presentations_configured: bool,
    ) -> None:
        self._port = port
        self._application = create_health_application(
            is_discord_ready,
            uptime_seconds,
            latency_ms,
            is_guild_ready,
            log_channel_configured,
            presentations_configured,
        )
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
