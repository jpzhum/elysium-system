from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import discord

from elysium.constants import BRAND_COLOR, ERROR_COLOR, WARNING_COLOR

logger = logging.getLogger("elysium.audit")

_MAX_FIELD_VALUE = 1024


def _safe_text(value: object, limit: int = _MAX_FIELD_VALUE) -> str:
    text = discord.utils.escape_mentions(str(value))
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


class AuditService:
    """Envia auditoria ao Discord sem tornar o canal uma dependência crítica."""

    def __init__(self, client: discord.Client, channel_id: int | None) -> None:
        self._client = client
        self._channel_id = channel_id
        self._channel: Any | None = None
        self._resolution_attempted = False
        self.available: bool | None = None

    @property
    def configured(self) -> bool:
        return self._channel_id is not None

    async def resolve_channel(self) -> Any | None:
        if self._channel_id is None:
            self.available = False
            return None
        if self._channel is not None:
            return self._channel
        if self._resolution_attempted:
            return None

        self._resolution_attempted = True
        channel = self._client.get_channel(self._channel_id)
        if channel is None:
            try:
                channel = await self._client.fetch_channel(self._channel_id)
            except (discord.Forbidden, discord.NotFound, discord.HTTPException):
                self.available = False
                logger.warning(
                    "Canal de auditoria indisponível.",
                    extra={"event": "audit_channel_unavailable"},
                )
                return None
            except Exception:
                self.available = False
                logger.exception(
                    "Falha inesperada ao resolver o canal de auditoria.",
                    extra={"event": "audit_channel_resolution_error"},
                )
                return None
        if not callable(getattr(channel, "send", None)):
            self.available = False
            logger.warning(
                "Canal configurado não aceita mensagens.",
                extra={"event": "audit_channel_invalid"},
            )
            return None
        self._channel = channel
        self.available = True
        return channel

    async def send(
        self,
        title: str,
        fields: dict[str, object],
        *,
        level: int = logging.INFO,
    ) -> bool:
        logger.log(
            level,
            "%s | %s",
            title,
            " | ".join(f"{key}={_safe_text(value, 200)}" for key, value in fields.items()),
            extra={"event": title.lower().replace(" ", "_")},
        )
        channel = await self.resolve_channel()
        if channel is None:
            return False

        color = ERROR_COLOR if level >= logging.ERROR else WARNING_COLOR if level >= logging.WARNING else BRAND_COLOR
        embed = discord.Embed(title=_safe_text(title, 256), color=color)
        for name, value in fields.items():
            embed.add_field(name=_safe_text(name, 256), value=_safe_text(value), inline=False)
        embed.timestamp = datetime.now(UTC)
        try:
            await channel.send(
                embed=embed,
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except (discord.Forbidden, discord.NotFound, discord.HTTPException):
            self.available = False
            self._channel = None
            logger.warning(
                "Falha ao enviar auditoria ao Discord; mantendo somente stdout.",
                extra={"event": "audit_send_failed"},
                exc_info=True,
            )
            return False
        except Exception:
            self.available = False
            self._channel = None
            logger.exception(
                "Falha inesperada ao enviar auditoria; mantendo somente stdout.",
                extra={"event": "audit_send_unexpected_error"},
            )
            return False
        self.available = True
        return True
