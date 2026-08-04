from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class ExpeditionStatus(Enum):
    ACTIVE = "ACTIVE"
    CLOSED = "CLOSED"


@dataclass(frozen=True, slots=True)
class Expedition:
    expedition_id: str
    owner_user_id: int
    game: str
    scheduled_for: str
    platform: str
    capacity: int
    details: str
    participant_user_ids: tuple[int, ...]
    created_at: datetime
    status: ExpeditionStatus = ExpeditionStatus.ACTIVE
    voice_channel_id: int | None = None
