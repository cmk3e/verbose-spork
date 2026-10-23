"""Plain data types shared by providers, the scheduler and the handicapper."""

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple


def parse_time(value) -> datetime:
    """ISO-8601 string (or datetime) -> timezone-aware UTC datetime."""
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError(f"post_time must include a UTC offset: {value!r}")
    return dt.astimezone(timezone.utc)


@dataclass
class Race:
    race_id: str
    track: str
    race_number: int
    post_time: datetime

    def to_dict(self) -> dict:
        d = asdict(self)
        d["post_time"] = self.post_time.isoformat()
        return d


@dataclass
class ToteRunner:
    program_num: str
    name: str
    odds: Optional[float]  # decimal odds; None when scratched / no price
    scratched: bool = False

    @property
    def active(self) -> bool:
        return not self.scratched and self.odds is not None and self.odds > 1.0


@dataclass
class ToteSnapshot:
    race_id: str
    fetched_at: datetime
    runners: List[ToteRunner]
    win_pool: Optional[float] = None
    # Exacta probables: (first, second) program numbers -> payout per $1.
    exacta_probables: Dict[Tuple[str, str], float] = field(default_factory=dict)
    # Feeds that report a revised post time (track delays) set this.
    post_time: Optional[datetime] = None

    def to_dict(self) -> dict:
        return {
            "race_id": self.race_id,
            "fetched_at": self.fetched_at.isoformat(),
            "win_pool": self.win_pool,
            "runners": [asdict(r) for r in self.runners],
        }
