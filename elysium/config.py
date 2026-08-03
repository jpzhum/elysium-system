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


def _snowflake(environment: Mapping[str, str], name: str, *, required: bool) -> int | None:
    raw_value = environment.get(name, "").strip()
    if not raw_value and not required:
        return None
    if not raw_value:
        raise ConfigError(f"A variável {name} não foi preenchida.")
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ConfigError(f"A variável {name} precisa conter um snowflake válido.") from error
    if not 0 < value < 2**64:
        raise ConfigError(f"A variável {name} precisa conter um snowflake válido.")
    return value


def _port(environment: Mapping[str, str]) -> int:
    value = environment.get("PORT", "10000").strip()
    try:
        port = int(value)
    except ValueError as error:
        raise ConfigError("A variável PORT precisa conter somente números.") from error
    if not 1 <= port <= 65535:
        raise ConfigError("A variável PORT precisa estar entre 1 e 65535.")
    return port


def _optional_url(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if value and not value.startswith(("http://", "https://")):
        raise ConfigError(f"A variável {name} precisa começar com http:// ou https://.")
    return value


def _snowflake_list(environment: Mapping[str, str], name: str) -> tuple[int, ...]:
    raw_value = environment.get(name, "").strip()
    if not raw_value:
        return ()
    values: list[int] = []
    for part in raw_value.split(","):
        item = part.strip()
        try:
            value = int(item)
        except ValueError as error:
            raise ConfigError(
                f"A variável {name} precisa conter snowflakes válidos separados por vírgula."
            ) from error
        if not item or not 0 < value < 2**64:
            raise ConfigError(
                f"A variável {name} precisa conter snowflakes válidos separados por vírgula."
            )
        values.append(value)
    return tuple(dict.fromkeys(values))


@dataclass(frozen=True, slots=True)
class ElysiumConfig:
    discord_token: str
    guild_id: int
    habitante_role_id: int
    visitante_role_id: int
    panel_channel_id: int
    port: int
    log_channel_id: int | None = None
    presentation_channel_id: int | None = None
    presentation_banner_url: str = ""
    expedition_channel_id: int | None = None
    expedition_banner_url: str = ""
    host_role_id: int | None = None
    boletim_channel_id: int | None = None
    eventos_role_id: int | None = None
    boletim_manager_role_ids: tuple[int, ...] = ()
    expedicoes_channel_id: int | None = None

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
            guild_id=_snowflake(source, "GUILD_ID", required=True),
            habitante_role_id=_snowflake(source, "HABITANTE_ROLE_ID", required=True),
            visitante_role_id=_snowflake(source, "VISITANTE_ROLE_ID", required=True),
            panel_channel_id=_snowflake(source, "PANEL_CHANNEL_ID", required=True),
            port=_port(source),
            log_channel_id=_snowflake(source, "LOG_CHANNEL_ID", required=False),
            presentation_channel_id=_snowflake(
                source, "PRESENTATION_CHANNEL_ID", required=False
            ),
            presentation_banner_url=_optional_url(source, "PRESENTATION_BANNER_URL"),
            expedition_channel_id=_snowflake(source, "EXPEDITION_CHANNEL_ID", required=False),
            expedition_banner_url=_optional_url(source, "EXPEDITION_BANNER_URL"),
            host_role_id=_snowflake(source, "HOST_ROLE_ID", required=False),
            boletim_channel_id=_snowflake(source, "BOLETIM_CHANNEL_ID", required=False),
            eventos_role_id=_snowflake(source, "EVENTOS_ROLE_ID", required=False),
            boletim_manager_role_ids=_snowflake_list(source, "BOLETIM_MANAGER_ROLE_IDS"),
            expedicoes_channel_id=_snowflake(source, "EXPEDICOES_CHANNEL_ID", required=False),
        )
