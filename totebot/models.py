import re
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Race lifecycle:
#   scheduled -> ready (tote pulled, tickets computed) -> published (tickets released)
#   scheduled -> preview (manual early run; still pulled again at FETCH_MTP) -> ready -> published
#   any -> error | missed
STATUSES = ("scheduled", "preview", "ready", "published", "error", "missed")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def _parse_dt(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError(f"Datetime must include a timezone: {value!r}")
    return dt.astimezone(timezone.utc)


@dataclass
class Runner:
    program_num: str
    name: str = ""
    style: Optional[str] = None          # E, E/P, P, S
    qsp: Optional[float] = None          # Quirin speed points
    call1_fps: Optional[float] = None
    call2_fps: Optional[float] = None
    final_fps: Optional[float] = None
    p_fund: Optional[float] = None       # your fundamental win probability (any scale; normalized)
    rating: Optional[float] = None       # alternative: a power rating, turned into probs by softmax
    features: Optional[List[float]] = None  # alternative: features for the ConditionalLogitModel
    ml_odds: Optional[str] = None        # morning line, e.g. "5-2"
    scratched: bool = False
    stats: Optional[Dict[str, float]] = None  # extra handicapping numbers (recorded for model fitting)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Runner":
        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in d.items() if k in known and v not in ("", None)}
        if "program_num" not in data:
            raise ValueError(f"Runner missing program_num: {d!r}")
        data["program_num"] = str(data["program_num"]).strip()
        for k in ("qsp", "call1_fps", "call2_fps", "final_fps", "p_fund", "rating"):
            if k in data:
                data[k] = float(data[k])
        if "style" in data:
            data["style"] = str(data["style"]).strip().upper()
        if "features" in data and isinstance(data["features"], str):
            data["features"] = [float(x) for x in re.split(r"[;|]", data["features"]) if x.strip()]
        if "ml_odds" in data:
            data["ml_odds"] = str(data["ml_odds"])
        if "scratched" in data:
            data["scratched"] = str(data["scratched"]).strip().lower() in ("1", "true", "yes", "y", "scr")
        if "stats" in data and not isinstance(data["stats"], dict):
            del data["stats"]
        return cls(**data)


@dataclass
class ToteSnapshot:
    taken_at: datetime
    win_odds: Dict[str, float]                 # program_num -> decimal odds
    scratched: List[str] = field(default_factory=list)
    post_time: Optional[datetime] = None       # source's current post time, if it reports one
    exacta_probables: Dict[str, float] = field(default_factory=dict)  # "1-2" -> payout per $1
    source: str = ""
    # Optional extras from the source: {"runners": {num: {stat: value}}, "pools": {"win": amount},
    #   "late_changes": [text], "surface_change": text or None}
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["taken_at"] = _iso(self.taken_at)
        d["post_time"] = _iso(self.post_time)
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToteSnapshot":
        return cls(
            taken_at=_parse_dt(d["taken_at"]),
            win_odds={str(k): float(v) for k, v in d.get("win_odds", {}).items()},
            scratched=[str(s) for s in d.get("scratched", [])],
            post_time=_parse_dt(d.get("post_time")),
            exacta_probables={str(k): float(v) for k, v in d.get("exacta_probables", {}).items()},
            source=d.get("source", ""),
            extras=d.get("extras") or {},
        )


def make_race_id(track: str, post_time: datetime, race_number: int, tz_name: str) -> str:
    from zoneinfo import ZoneInfo

    day = post_time.astimezone(ZoneInfo(tz_name)).strftime("%Y%m%d")
    slug = re.sub(r"[^A-Za-z0-9]+", "", track).upper() or "TRACK"
    return f"{slug}-{day}-R{race_number}"


@dataclass
class Race:
    id: str
    track: str
    race_number: int
    post_time: datetime
    runners: List[Runner]
    source_ref: Optional[str] = None     # provider-specific race id, used by the HTTP source
    status: str = "scheduled"
    snapshot: Optional[ToteSnapshot] = None
    manual_tote: Optional[ToteSnapshot] = None
    tickets: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    last_prepoll: Optional[datetime] = None
    # After the race: official result and how the tickets did (see totebot/performance.py).
    #   result = {"finish": [...], "final_odds": {num: decimal}, "scratched": [...],
    #             "payoffs": {"win"|"exacta"|"trifecta"|"superfecta": {"4-6": per $1}}, "official_at", "source"}
    result: Optional[Dict[str, Any]] = None
    settlement: Optional[Dict[str, Any]] = None
    result_status: Optional[str] = None      # None | "pending" | "official" | "unavailable"
    last_result_check: Optional[datetime] = None
    odds_history: List[Dict[str, Any]] = field(default_factory=list)  # [{"t", "mtp", "odds": {num: decimal}}]
    log: List[str] = field(default_factory=list)

    def mtp(self, now: Optional[datetime] = None) -> float:
        return ((self.post_time - (now or utcnow())).total_seconds()) / 60.0

    def note(self, msg: str, now: Optional[datetime] = None) -> None:
        stamp = (now or utcnow()).strftime("%H:%M:%S")
        self.log.append(f"{stamp}Z {msg}")
        del self.log[:-50]

    def to_dict(self, now: Optional[datetime] = None) -> dict:
        return {
            "id": self.id,
            "track": self.track,
            "race_number": self.race_number,
            "post_time": _iso(self.post_time),
            "mtp": round(self.mtp(now), 2),
            "runners": [asdict(r) for r in self.runners],
            "source_ref": self.source_ref,
            "status": self.status,
            "snapshot": self.snapshot.to_dict() if self.snapshot else None,
            "manual_tote": self.manual_tote.to_dict() if self.manual_tote else None,
            "tickets": self.tickets,
            "error": self.error,
            "last_prepoll": _iso(self.last_prepoll),
            "result": self.result,
            "settlement": self.settlement,
            "result_status": self.result_status,
            "last_result_check": _iso(self.last_result_check),
            "odds_history": self.odds_history,
            "log": self.log,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Race":
        return cls(
            id=d["id"],
            track=d["track"],
            race_number=int(d["race_number"]),
            post_time=_parse_dt(d["post_time"]),
            runners=[Runner.from_dict(r) for r in d["runners"]],
            source_ref=d.get("source_ref"),
            status=d.get("status", "scheduled"),
            snapshot=ToteSnapshot.from_dict(d["snapshot"]) if d.get("snapshot") else None,
            manual_tote=ToteSnapshot.from_dict(d["manual_tote"]) if d.get("manual_tote") else None,
            tickets=d.get("tickets"),
            error=d.get("error"),
            last_prepoll=_parse_dt(d.get("last_prepoll")),
            result=d.get("result"),
            settlement=d.get("settlement"),
            result_status=d.get("result_status"),
            last_result_check=_parse_dt(d.get("last_result_check")),
            odds_history=list(d.get("odds_history") or []),
            log=list(d.get("log", [])),
        )
