from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from time import perf_counter
from typing import Callable


@dataclass(slots=True)
class RuntimeState:
    """Estado operacional do processo, sem depender de uma conexão Discord."""

    clock: Callable[[], float] = perf_counter
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    disconnected_at: datetime | None = None
    last_resumed_at: datetime | None = None
    command_count: int = 0
    initial_ready_logged: bool = False
    log_channel_available: bool | None = None
    _started_monotonic: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._started_monotonic = self.clock()

    @property
    def uptime_seconds(self) -> int:
        return max(0, int(self.clock() - self._started_monotonic))

    def mark_disconnected(self, when: datetime | None = None) -> None:
        if self.disconnected_at is None:
            self.disconnected_at = when or datetime.now(UTC)

    def mark_resumed(self, when: datetime | None = None) -> float | None:
        resumed_at = when or datetime.now(UTC)
        interruption = None
        if self.disconnected_at is not None:
            interruption = max(
                0.0,
                (resumed_at - self.disconnected_at).total_seconds(),
            )
        self.disconnected_at = None
        self.last_resumed_at = resumed_at
        return interruption
