"""Parse race cards (your handicapping inputs) from JSON or CSV."""
import csv
import io
import re
from datetime import date, datetime, time, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from .models import Race, Runner, make_race_id


class CardError(ValueError):
    pass


def parse_post_time(value: str, day: Optional[str], tz_name: str) -> datetime:
    """Accept an ISO datetime, or a clock time ("13:45", "1:45 PM") on `day` in the track's timezone."""
    text = str(value).strip()
    if not text:
        raise CardError("post_time is required")
    if "T" in text or re.match(r"\d{4}-\d{2}-\d{2} ", text):
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo(tz_name))
    m = re.fullmatch(r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])?", text)
    if not m:
        raise CardError(f"Unrecognized post time {value!r}")
    hour, minute = int(m.group(1)), int(m.group(2))
    ampm = (m.group(3) or "").upper()
    if ampm == "PM" and hour < 12:
        hour += 12
    elif ampm == "AM" and hour == 12:
        hour = 0
    d = date.fromisoformat(day) if day else datetime.now(ZoneInfo(tz_name)).date()
    return datetime.combine(d, time(hour, minute), tzinfo=ZoneInfo(tz_name))


def race_from_dict(d: Dict[str, Any], tz_name: str, default_day: Optional[str] = None) -> Race:
    try:
        track = str(d["track"]).strip()
        number = int(d["race_number"])
        runners = [r if isinstance(r, Runner) else Runner.from_dict(r) for r in d["runners"]]
    except KeyError as e:
        raise CardError(f"Race is missing {e.args[0]!r}") from None
    if len(runners) < 2:
        raise CardError(f"{track} R{number}: need at least 2 runners")
    nums = [r.program_num for r in runners]
    if len(set(nums)) != len(nums):
        raise CardError(f"{track} R{number}: duplicate program numbers")
    post = parse_post_time(d.get("post_time", ""), d.get("date") or default_day, tz_name).astimezone(timezone.utc)
    return Race(
        id=make_race_id(track, post, number, tz_name),
        track=track,
        race_number=number,
        post_time=post,
        runners=runners,
        source_ref=(str(d["source_ref"]) if d.get("source_ref") else None),
    )


def races_from_json(payload: Any, tz_name: str, default_day: Optional[str] = None) -> List[Race]:
    """A single race object, a list of races, or {"date": ..., "races": [...]}."""
    if isinstance(payload, dict) and "races" in payload:
        day = payload.get("date") or default_day
        shared = {k: v for k, v in payload.items() if k in ("track", "date")}
        return [race_from_dict({**shared, **r}, tz_name, day) for r in payload["races"]]
    if isinstance(payload, list):
        return [race_from_dict(r, tz_name, default_day) for r in payload]
    if isinstance(payload, dict):
        return [race_from_dict(payload, tz_name, default_day)]
    raise CardError("Card JSON must be a race, a list of races, or {races: [...]}")


def races_from_csv(text: str, tz_name: str, track: str = "", race_number: Optional[int] = None,
                   post_time: str = "", day: Optional[str] = None) -> List[Race]:
    """One row per runner. Race columns (track, race_number, post_time) may be in the CSV
    (a whole day in one file) or given once via the form fields."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames:
        raise CardError("CSV is empty")
    reader.fieldnames = [f.strip().lower() for f in reader.fieldnames]
    groups: Dict[tuple, Dict[str, Any]] = {}
    for row in reader:
        row = {k: (v.strip() if isinstance(v, str) else v) for k, v in row.items() if k}
        if not any(row.values()):
            continue
        t = row.pop("track", "") or track
        n = row.pop("race_number", "") or race_number
        p = row.pop("post_time", "") or post_time
        ref = row.pop("source_ref", "")
        if not t or not n:
            raise CardError("Each row needs track and race_number (in the CSV or the form)")
        key = (t, int(n))
        g = groups.setdefault(key, {"track": t, "race_number": int(n), "post_time": p, "runners": []})
        if ref:
            g["source_ref"] = ref
        g["runners"].append(row)
    if not groups:
        raise CardError("CSV has no runner rows")
    return [race_from_dict(g, tz_name, day) for g in groups.values()]
