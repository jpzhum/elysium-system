from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Presentation:
    user_id: int
    preferred_name: str
    about: str
    interests: str
    current_activity: str
    expectations: str
    created_at: datetime
