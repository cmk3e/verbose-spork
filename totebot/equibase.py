"""Read race cards out of Equibase program PDFs (the official Breeders' Cup PPs, track programs and
the Equibase pages inside daily free-PP files).

Equibase has no run styles, Quirin points or Prime Power, so the engine's pace adjustment stays
off. The fundamental `rating` is the Equibase speed figure averaged over the last 3 races (the
last one if that's all there is); horses without figures get the field median in handicap.py.
Everything else goes into `stats`.

A file has, per day, a "Speed Figure Analysis" table (one row per horse: class rating, last /
average-of-3 / highest pace and speed figures, jockey and trainer in-the-money %), then each
race's past performances, which give the program number, morning line, weight, records and
trainer stats. The two are joined on the horse's name.
"""
import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from .brisnet import BRISNET_TZ, BrisnetError, gap_warnings

MARKER = "EQUIBASE Company LLC"
RACE_START = re.compile(r"^(?P<date>\d{1,2}/\d{1,2}/\d{2}) APPROX\. POST: (?P<h>\d{1,2}):(?P<m>\d{2}) ?(?P<ap>[AP]M)", re.M)
RACE_NUMBER = re.compile(r"^(\d{1,2})\nequibase\.com/QR", re.M)
CONTINUED = re.compile(r"^RACE \d{1,2} CONTINUED (.+)$", re.M)
TRACK_CODE = re.compile(r"\b([A-Z]{2,4}) ?- ?\d{1,2}/\d{1,2}/\d{4}")
TRACK_NAME = re.compile(r"Speed Figure Analysis for ([A-Z][A-Z .'&-]+)")
HORSE = re.compile(r"^(?P<num>E?\d{1,2}[A-Z]?)\n(?P<color>[A-Za-z][^\n]*)\n(?P<ml>\d+-\d+)\n"
                   r"(?:Clm Prc\n\$(?P<claim>[\d,]+)\n)?Owner:", re.M)
CLASS = re.compile(r"(\d+|N/A)\nSilks:")
NAME_LINE = re.compile(r"^([^\n]*)\n[A-Za-z][A-Za-z/ ]{0,10}\.[cfghmr]\.\d{1,2} ", re.M)  # line above "B.c.3 Sire ..."
RECORD = re.compile(r"(Life|Dirt|Wet Dirt|Turf|Wet Turf|AllWeather|Distance|Dist|[A-Z]{2,4}): "
                    r"(\d+) (\d+) (\d+) (\d+) (\d+|na) \$[\d,]+")
PP_DATE = re.compile(r"^(?:[A-Z] )?(\d{2}[A-Z][a-z]{2}\d{2}) [A-Z]", re.M)
TRAINER_365 = re.compile(r"Trainer \(Last 365 days\): All: (\d+) (\d+)% \$([\d.]+)")
WITH_JOCKEY = re.compile(r"With Jockey: (\d+) (\d+)% \$([\d.]+)")
# Speed Figure Analysis: Pgm, Post (post win%), Horse, Class, pace last/avg3/high, speed last/avg3/high,
# Jockey / Trainer, ITM% jockey/trainer/together
SUMMARY_ROW = re.compile(r"^(?P<num>\d{1,2}[A-Z]?) (?P<post>\d{1,2}) ?\((?P<postpct>\d+)%\) (?P<name>.+?)"
                         r"((?: (?:NA|\d+)){7}) (?P<jt>.+?) (?P<jitm>\d+)% (?P<titm>\d+)% (?P<jtitm>\d+)%$", re.M)
SUMMARY_RACE = re.compile(r"^(\d{1,2})\n(?:[^\n]*\n)?[^\n]*Exacta", re.M)
SUMMARY_DATE = re.compile(r"[A-Z]{2,4} - (\d{1,2}/\d{1,2}/\d{4}) Copyright")
SUMMARY_COLS = ("eqb_class", "eqb_last_pace", "eqb_avg_pace_3", "eqb_high_pace",
                "eqb_last_speed", "eqb_avg_speed_3", "eqb_high_speed")
SURFACE_RECORD = {"Dirt": "Dirt", "Trf": "Turf", "AW": "AllWeather"}


def detect(pages: List[str]) -> bool:
    return any(MARKER in p and RACE_START.search(p) for p in pages)


def _key(name: str) -> str:
    """Name for joining the summary table to the PPs: no country suffix, case or punctuation."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\([A-Z]{2,3}\)", "", name).lower())


def summary_tables(pages: List[str]) -> Dict[tuple, Dict[str, dict]]:
    """{(date, race): {name key: stats}} from the Speed Figure Analysis pages."""
    out: Dict[tuple, Dict[str, dict]] = {}
    for text in pages:
        if "Speed Figure Analysis" not in text or not (d := SUMMARY_DATE.search(text)):
            continue
        day = datetime.strptime(d.group(1), "%m/%d/%Y").date()
        heads = list(SUMMARY_RACE.finditer(text))
        for i, head in enumerate(heads):
            section = text[head.end(): heads[i + 1].start() if i + 1 < len(heads) else len(text)]
            rows = out.setdefault((day, int(head.group(1))), {})
            for row in SUMMARY_ROW.finditer(section):
                stats = {"post_win_pct": int(row.group("postpct")), "jockey_itm_pct": int(row.group("jitm")),
                         "trainer_itm_pct": int(row.group("titm")), "jockey_trainer_itm_pct": int(row.group("jtitm"))}
                for col, value in zip(SUMMARY_COLS, row.group(5).split()):
                    if value != "NA" and int(value) > 0:  # 0 = no US figures yet (shippers, unraced)
                        stats[col] = int(value)
                rows[_key(row.group("name"))] = stats
    return out


def horse_stats(block: str, race_day: datetime, surface: str, track: str) -> Dict[str, float]:
    stats: Dict[str, float] = {}
    if (c := CLASS.search(block)) and c.group(1).isdigit():
        stats["eqb_class"] = int(c.group(1))
    surface_label = SURFACE_RECORD.get(surface)
    for rec in RECORD.finditer(block):
        label = rec.group(1)
        prefix = {"Life": "life", "Distance": "dist", "Dist": "dist", track: "track"}.get(label)
        if label == surface_label:
            prefix = "surface"
        if not prefix:
            continue
        starts, wins = int(rec.group(2)), int(rec.group(3))
        stats[f"{prefix}_starts"], stats[f"{prefix}_wins"] = starts, wins
        if rec.group(6) != "na":
            stats[f"{prefix}_best_speed"] = int(rec.group(6))
    if "life_starts" in stats:
        stats["life_win_pct"] = round(stats["life_wins"] / stats["life_starts"], 3) if stats["life_starts"] else 0.0
    if (pp := PP_DATE.search(block)):
        stats["days_off"] = (race_day.date() - datetime.strptime(pp.group(1), "%d%b%y").date()).days
    if (t := TRAINER_365.search(block)):
        stats.update(trainer_starts_365=int(t.group(1)), trainer_win_pct_365=int(t.group(2)),
                     trainer_roi_365=float(t.group(3)))
    if (j := WITH_JOCKEY.search(block)) and int(j.group(1)):
        stats.update(trainer_jockey_starts=int(j.group(1)), trainer_jockey_win_pct=int(j.group(2)),
                     trainer_jockey_roi=float(j.group(3)))
    return stats


def parse_pages(pages: List[str], skipped: Optional[List[str]] = None) -> List[dict]:
    summary = summary_tables(pages)
    file_name = next((m.group(1).strip().title() for p in pages if (m := TRACK_NAME.search(p))), None)
    races: List[dict] = []
    race: Optional[dict] = None
    for i, text in enumerate(pages):
        start = RACE_START.search(text)
        if start:
            num = RACE_NUMBER.search(text)
            if not num:
                if skipped is not None:
                    skipped.append(f"Equibase page at {start.group(0)}: no race number found")
                race = None
                continue
            day = datetime.strptime(start.group("date"), "%m/%d/%y")
            hour = int(start.group("h")) % 12 + (12 if start.group("ap") == "PM" else 0)
            post = day.replace(hour=hour, minute=int(start.group("m")), tzinfo=ZoneInfo(BRISNET_TZ))
            conditions = text[start.end(): text.find("Track Record:") if "Track Record:" in text else len(text)]
            surface = "Trf" if "(Turf)" in conditions else "AW" if re.search(r"All Weather|Synthetic|Tapeta", conditions) else "Dirt"
            # a file can hold several tracks: take this race's from its own pages (footer, "RACE n CONTINUED X")
            own = "\n".join(pages[i:i + 2])
            code = (m.group(1) if (m := TRACK_CODE.search(own)) else "")
            name = (m.group(1).strip() if (m := CONTINUED.search(own)) else file_name)
            race = {"track": code or name, "track_name": name or code, "race_number": int(num.group(1)),
                    "post_time": post.isoformat(), "surface": surface, "runners": [], "_day": post}
            races.append(race)
        if race is None:
            continue  # cover and summary pages
        horses = list(HORSE.finditer(text))
        for j, h in enumerate(horses):
            block = text[h.end(): horses[j + 1].start() if j + 1 < len(horses) else len(text)]
            line = NAME_LINE.search(block)
            if not line:
                continue
            raw = re.split(r"\$[\d,]+", line.group(1))[-1].replace("\x04", "")
            weight = re.search(r"\s(\d{3})\S*\s*$", raw)
            horse = (raw[:weight.start()] if weight else raw).strip()
            stats = horse_stats(block, race["_day"], race["surface"], race["track"])
            stats.update(summary.get((race["_day"].date(), race["race_number"]), {}).get(_key(horse), {}))
            if weight:
                stats["weight"] = int(weight.group(1))
            if h.group("claim"):
                stats["claim_price"] = int(h.group("claim").replace(",", ""))
            stats["also_eligible"] = int(h.group("num").startswith("E"))
            stats["turf"] = int(race["surface"] == "Trf")
            if "eqb_avg_speed_3" in stats:
                stats["avg_speed_3"] = stats["eqb_avg_speed_3"]
            if "eqb_last_speed" in stats:
                stats["last_speed"] = stats["eqb_last_speed"]
            rating = stats.get("eqb_avg_speed_3", stats.get("eqb_last_speed"))
            race["runners"].append({
                "program_num": h.group("num"),
                "name": horse,
                "ml_odds": h.group("ml"),
                **({"rating": float(rating)} if rating is not None else {}),
                "stats": stats,
            })
    out = []
    for race in races:
        race.pop("_day")
        if not race["runners"]:
            problem = f"{race['track']} R{race['race_number']}: no runners found"
            if skipped is None:
                raise BrisnetError(problem)
            skipped.append(problem)
            continue
        seen = set()
        race["runners"] = [r for r in race["runners"] if not (r["program_num"] in seen or seen.add(r["program_num"]))]
        out.append(race)
    if not out:
        raise BrisnetError("No Equibase races found in this PDF")
    out.sort(key=lambda r: r["post_time"])
    return out


def load_pages(pages: List[str]) -> Tuple[List[dict], List[str]]:
    skipped: List[str] = []
    races = parse_pages(pages, skipped)
    return races, skipped + gap_warnings(races)
