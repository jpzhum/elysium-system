from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from dotenv import load_dotenv


class ConfigError(RuntimeError):
    """Indica uma configuração ausente ou inválida."""


def _required_string(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ConfigError(f"A variável {name} não foi preenchida.")
    return value


def _required_int(environment: Mapping[str, str], name: str) -> int:
    value = _required_string(environment, name)
    try:
        return int(value)
    except ValueError as error:
        raise ConfigError(f"A variável {name} precisa conter somente números.") from error


def _port(environment: Mapping[str, str]) -> int:
    value = environment.get("PORT", "10000").strip()
    try:
        port = int(value)
    except ValueError as error:
        raise ConfigError("A variável PORT precisa conter somente números.") from error
    if not 1 <= port <= 65535:
        raise ConfigError("A variável PORT precisa estar entre 1 e 65535.")
    return port


@dataclass(frozen=True, slots=True)
class ElysiumConfig:
    discord_token: str
    guild_id: int
    habitante_role_id: int
    visitante_role_id: int
    panel_channel_id: int
    port: int

    @classmethod
    def from_env(
        cls,
        environment: Mapping[str, str] | None = None,
        *,
        load_dotenv_file: bool = True,
    ) -> ElysiumConfig:
        if load_dotenv_file:
            load_dotenv()
        source = os.environ if environment is None else environment
        return cls(
            discord_token=_required_string(source, "DISCORD_TOKEN"),
            guild_id=_required_int(source, "GUILD_ID"),
            habitante_role_id=_required_int(source, "HABITANTE_ROLE_ID"),
            visitante_role_id=_required_int(source, "VISITANTE_ROLE_ID"),
            panel_channel_id=_required_int(source, "PANEL_CHANNEL_ID"),
            port=_port(source),
        )
