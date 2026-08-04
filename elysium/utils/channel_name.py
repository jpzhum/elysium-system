from __future__ import annotations

import re
import unicodedata


def expedition_voice_channel_name(
    game: str, expedition_id: str, *, maximum: int = 100
) -> str:
    normalized = unicodedata.normalize("NFKD", game).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9-]", "-", normalized.lower())
    slug = re.sub(r"-+", "-", slug).strip("-") or "expedicao"
    suffix = f"-{expedition_id}"
    prefix = "🔊・"
    available = max(0, maximum - len(prefix) - len(suffix))
    slug = slug[:available].rstrip("-") or "expedicao"[:available]
    return f"{prefix}{slug}{suffix}"


def limited_bitrate(configured_kbps: int, guild_limit: int) -> int:
    return min(configured_kbps * 1000, guild_limit)
