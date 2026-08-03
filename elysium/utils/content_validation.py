from __future__ import annotations

import re

_FORBIDDEN = re.compile(
    r"discord\.gg/|discord\.com/invite/|https?://|www\.|@everyone|@here|"
    r"<@!?\d+>|<@&\d+>|<#\d+>",
    re.IGNORECASE,
)
_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def normalize_text(value: str) -> str:
    value = _CONTROLS.sub("", value).strip()
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines()]
    normalized: list[str] = []
    for line in lines:
        if line or (normalized and normalized[-1]):
            normalized.append(line)
    while normalized and not normalized[-1]:
        normalized.pop()
    return "\n".join(normalized)


def contains_forbidden_content(value: str) -> bool:
    return bool(_FORBIDDEN.search(value))
