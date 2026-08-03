from __future__ import annotations

from typing import Final

import discord

BRAND_COLOR_HEX: Final[str] = "#6E7DFF"
BRAND_COLOR: Final[discord.Color] = discord.Color.from_str(BRAND_COLOR_HEX)
CONCLUIR_ENTRADA_CUSTOM_ID: Final[str] = "elysium:portal:concluir_entrada:v1"
PRESENTATION_CREATE_CUSTOM_ID: Final[str] = "elysium:presentation:create:v1"
PRESENTATION_EDIT_CUSTOM_ID: Final[str] = "elysium:presentation:edit:v1"
PRESENTATION_DELETE_CUSTOM_ID: Final[str] = "elysium:presentation:delete:v1"
PRESENTATION_EMBED_TITLE: Final[str] = "✦ Habitante do Elysium"
EXPEDITION_CREATE_CUSTOM_ID: Final[str] = "elysium:expedition:create:v1"
EXPEDITION_MINE_CUSTOM_ID: Final[str] = "elysium:expedition:mine:v1"
EXPEDITION_ID_PATTERN: Final[str] = r"[a-f0-9]{8}"
SERVICE_NAME: Final[str] = "elysium-system"
VERSION: Final[str] = "1.3.0"
WARNING_COLOR: Final[discord.Color] = discord.Color.from_str("#D4B978")
ERROR_COLOR: Final[discord.Color] = discord.Color.from_str("#E5484D")
