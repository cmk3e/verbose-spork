import json
import logging
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional

from .models import Race

log = logging.getLogger(__name__)


class RaceStore:
    """Races held in memory and mirrored to one JSON file each, so restarts lose nothing."""

    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir) / "races"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._races: Dict[str, Race] = {}
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        for path in sorted(self.dir.glob("*.json")):
            try:
                race = Race.from_dict(json.loads(path.read_text()))
                self._races[race.id] = race
            except Exception:
                log.exception("Skipping unreadable race file %s", path)

    def all(self) -> List[Race]:
        with self._lock:
            return sorted(self._races.values(), key=lambda r: r.post_time)

    def get(self, race_id: str) -> Optional[Race]:
        with self._lock:
            return self._races.get(race_id)

    def save(self, race: Race) -> None:
        with self._lock:
            self._races[race.id] = race
            path = self.dir / f"{race.id}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(race.to_dict(), indent=2))
            os.replace(tmp, path)

    def delete(self, race_id: str) -> bool:
        with self._lock:
            race = self._races.pop(race_id, None)
            (self.dir / f"{race_id}.json").unlink(missing_ok=True)
            return race is not None
