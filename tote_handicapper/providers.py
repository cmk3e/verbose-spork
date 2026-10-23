"""Tote data providers.

Every provider answers two questions:
  list_races()        -> upcoming races with post times
  get_tote(race_id)   -> the current tote (win odds, scratches, probables)

Feeds that speak the JSON schema below plug in through ``FileProvider`` or
``HttpJsonProvider`` directly. Feeds with their own shape plug in by naming an
adapter module in the config (see README "Connecting a real tote feed").

Race list schema::

    {"races": [{"race_id": "AQU-2026-10-23-5", "track": "AQU",
                "race_number": 5, "post_time": "2026-10-23T15:47:00-04:00"}]}

Tote schema::

    {"race_id": "AQU-2026-10-23-5",
     "post_time": "2026-10-23T15:49:00-04:00",      # optional, revised post
     "win_pool": 182340,                             # optional
     "runners": [{"program_num": "1", "name": "Alpha", "odds": "5-2"},
                 {"program_num": "2", "name": "Bravo", "odds": "SCR",
                  "scratched": true}],
     "exacta_probables": {"1-3": 24.60},             # optional
     "probables_base": 2}                            # $ base of probables
"""

import importlib
import json
import math
import random
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .models import Race, ToteRunner, ToteSnapshot, parse_time
from .odds import parse_odds, round_to_tote


def races_from_dict(raw) -> List[Race]:
    items = raw.get("races", []) if isinstance(raw, dict) else raw
    return [
        Race(
            race_id=str(r["race_id"]),
            track=str(r.get("track", "")),
            race_number=int(r.get("race_number", 0)),
            post_time=parse_time(r["post_time"]),
        )
        for r in items
    ]


def snapshot_from_dict(raw: dict, numeric_format: str = "to1", now: Optional[datetime] = None) -> ToteSnapshot:
    runners = []
    for r in raw.get("runners", []):
        odds = parse_odds(r.get("odds"), numeric_format)
        runners.append(ToteRunner(
            program_num=str(r["program_num"]),
            name=str(r.get("name", "")),
            odds=odds,
            scratched=bool(r.get("scratched", False)) or odds is None,
        ))
    base = float(raw.get("probables_base", 2.0)) or 2.0
    probables = {}
    for key, payout in (raw.get("exacta_probables") or {}).items():
        first, second = str(key).replace("/", "-").split("-")
        probables[(first.strip(), second.strip())] = float(payout) / base
    return ToteSnapshot(
        race_id=str(raw["race_id"]),
        fetched_at=now or datetime.now(timezone.utc),
        runners=runners,
        win_pool=raw.get("win_pool"),
        exacta_probables=probables,
        post_time=parse_time(raw["post_time"]) if raw.get("post_time") else None,
    )


class ToteProvider:
    def list_races(self) -> List[Race]:
        raise NotImplementedError

    def get_tote(self, race_id: str) -> ToteSnapshot:
        raise NotImplementedError

    def get_card(self, race_id: str) -> Optional[dict]:
        """Providers that also know fundamentals (the demo does) return a card."""
        return None


class FileProvider(ToteProvider):
    """Reads ``races.json`` and ``tote/<race_id>.json`` from a directory.

    Useful when a separate scraper or a person keeps those files current.
    """

    def __init__(self, directory: str, numeric_format: str = "to1"):
        self.dir = Path(directory)
        self.numeric_format = numeric_format

    def list_races(self) -> List[Race]:
        return races_from_dict(json.loads((self.dir / "races.json").read_text()))

    def get_tote(self, race_id: str) -> ToteSnapshot:
        raw = json.loads((self.dir / "tote" / f"{race_id}.json").read_text())
        return snapshot_from_dict(raw, self.numeric_format)


class HttpJsonProvider(ToteProvider):
    """Polls an HTTP JSON feed.

    ``tote_url`` may contain ``{race_id}``, ``{track}`` and ``{race_number}``.
    ``adapter`` names an importable module exposing ``adapt_races(raw)`` and/or
    ``adapt_tote(raw, race)`` that convert the feed's JSON into the schemas
    above.
    """

    def __init__(self, races_url: str, tote_url: str, headers: Optional[Dict[str, str]] = None,
                 adapter: Optional[str] = None, numeric_format: str = "to1", timeout: float = 10.0):
        self.races_url = races_url
        self.tote_url = tote_url
        self.headers = headers or {}
        self.numeric_format = numeric_format
        self.timeout = timeout
        self.adapter = importlib.import_module(adapter) if adapter else None
        self._races: Dict[str, Race] = {}

    def _get(self, url: str):
        req = urllib.request.Request(url, headers={"Accept": "application/json", **self.headers})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def list_races(self) -> List[Race]:
        raw = self._get(self.races_url)
        if self.adapter and hasattr(self.adapter, "adapt_races"):
            raw = self.adapter.adapt_races(raw)
        races = races_from_dict(raw)
        self._races = {r.race_id: r for r in races}
        return races

    def get_tote(self, race_id: str) -> ToteSnapshot:
        race = self._races.get(race_id)
        url = self.tote_url.format(
            race_id=race_id,
            track=race.track if race else "",
            race_number=race.race_number if race else "",
        )
        raw = self._get(url)
        if self.adapter and hasattr(self.adapter, "adapt_tote"):
            raw = self.adapter.adapt_tote(raw, race)
        raw.setdefault("race_id", race_id)
        return snapshot_from_dict(raw, self.numeric_format)


_DEMO_NAMES = [
    "Midnight Ledger", "Quarter Pole Kate", "Tote Board Tom", "Steady Eddie",
    "Paceline", "Late Money", "Overlay Queen", "Bounce Back", "Wire To Wire",
    "Closing Kick", "Saratoga Sun", "Iron Fractions", "Dirt Road Dan", "Blinkers On",
]


class DemoProvider(ToteProvider):
    """Simulated races so the whole pipeline can be watched end to end.

    Races post every ``spacing_min`` minutes starting ``first_post_min`` from
    launch. Odds random-walk and swing harder as post approaches, the way late
    money moves a real board. Fundamentals cards are generated to match.
    """

    def __init__(self, n_races: int = 6, first_post_min: float = 4.0, spacing_min: float = 5.0,
                 seed: int = 7, clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self.clock = clock
        self.rng = random.Random(seed)
        start = clock().replace(microsecond=0)
        self.races: Dict[str, Race] = {}
        self.cards: Dict[str, dict] = {}
        self._true_strength: Dict[str, List[float]] = {}
        self._ml: Dict[str, List[float]] = {}
        for i in range(n_races):
            rid = f"DEMO-R{i + 1}"
            self.races[rid] = Race(rid, "DEMO", i + 1, start + timedelta(minutes=first_post_min + i * spacing_min))
            self._build_field(rid)

    def _build_field(self, rid: str) -> None:
        n = self.rng.randint(6, 10)
        names = self.rng.sample(_DEMO_NAMES, n)
        strength = [self.rng.gauss(0, 1) for _ in range(n)]
        self._true_strength[rid] = strength
        total = sum(math.exp(s) for s in strength)
        runners = []
        ml = []
        for i, (name, s) in enumerate(zip(names, strength)):
            p = math.exp(s) / total
            # Morning line: the true chance blurred plus a 20% takeout.
            ml_dec = round_to_tote(max(1.4, 0.8 / max(0.015, p * math.exp(self.rng.gauss(0, 0.2)))))
            ml.append(ml_dec)
            style = self.rng.choice(["E", "E/P", "P", "P", "S"])
            qsp = {"E": self.rng.randint(6, 8), "E/P": self.rng.randint(4, 7),
                   "P": self.rng.randint(2, 5), "S": self.rng.randint(0, 2)}[style]
            runners.append({
                "program_num": str(i + 1),
                "name": name,
                "style": style,
                "qsp": qsp,
                "call1_fps": round(55 + 3 * s + self.rng.gauss(0, 2), 1),
                "call2_fps": round(54 + 3 * s + self.rng.gauss(0, 2), 1),
                "final_fps": round(50 + 3 * s + self.rng.gauss(0, 2), 1),
                # A handicapper's own line: the truth seen through some noise.
                "p_fund": round(p * math.exp(self.rng.gauss(0, 0.25)), 4),
                "ml_odds": round(ml_dec - 1.0, 1),
            })
        self._ml[rid] = ml
        self.cards[rid] = {"race_id": rid, "runners": runners}

    def list_races(self) -> List[Race]:
        return list(self.races.values())

    def get_card(self, race_id: str) -> Optional[dict]:
        return self.cards.get(race_id)

    def get_tote(self, race_id: str) -> ToteSnapshot:
        race = self.races[race_id]
        now = self.clock()
        mtp = (race.post_time - now).total_seconds() / 60.0
        card = self.cards[race_id]["runners"]
        # Deterministic per (race, 15-second tick) so repeated polls are stable.
        tick = int(now.timestamp() // 15)
        rng = random.Random(f"{race_id}-{tick}")
        volatility = 0.08 + 0.25 * max(0.0, 1.0 - max(mtp, 0.0) / 10.0)
        weights = []
        for ml in self._ml[race_id]:
            weights.append((1.0 / ml) * math.exp(rng.gauss(0, volatility)))
        total = sum(weights)
        runners = []
        for r, w in zip(card, weights):
            scratched = r["program_num"] == "4" and len(card) > 8
            dec = None if scratched else round_to_tote(max(1.1, 0.83 / (w / total)))
            runners.append(ToteRunner(r["program_num"], r["name"], dec, scratched))
        return ToteSnapshot(race_id, now, runners, win_pool=round(40000 + 120000 * rng.random(), -2))


def build_provider(cfg: dict, clock=None) -> ToteProvider:
    kind = cfg.get("type", "demo")
    if kind == "demo":
        kwargs = {k: cfg[k] for k in ("n_races", "first_post_min", "spacing_min", "seed") if k in cfg}
        if clock:
            kwargs["clock"] = clock
        return DemoProvider(**kwargs)
    if kind == "file":
        return FileProvider(cfg["directory"], cfg.get("numeric_format", "to1"))
    if kind == "http":
        return HttpJsonProvider(
            cfg["races_url"], cfg["tote_url"], cfg.get("headers"), cfg.get("adapter"),
            cfg.get("numeric_format", "to1"), cfg.get("timeout", 10.0),
        )
    raise ValueError(f"Unknown provider type: {kind!r} (use demo, file or http)")
