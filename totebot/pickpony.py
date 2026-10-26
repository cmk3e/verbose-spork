"""Read race cards out of PickPony PP PDFs.

Same output as totebot.brisnet: per runner the program number, name, run style + Quirin points,
morning line, Prime Power (as `rating`), last-3 E1/E2/LP pace averages (for the engine's %-early)
and a `stats` record that uses Brisnet's names wherever the meaning matches.
"""
import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from .brisnet import BRISNET_TZ, TRACK_CODES, BrisnetError, _post_times, gap_warnings

MARKER = "PickPony PPs"
HEADER = re.compile(r"PickPony PPs (?P<track>.+?) Race (?P<race>\d+) (?P<rest>.*?)"
                    r"(?P<date>[A-Z][a-z]+ \d{1,2}, \d{4})")
POST = re.compile(r"\(\s*(\d{1,2}):(\d{2})\s*\)")
PARS = re.compile(r"Pars:\s*(\d+)\s+(\d+)/(\d+)\s+Spd:\s*(\d+)")
HORSE = re.compile(r"^(?P<num>\d{1,2}[A-Z]?)\n(?P<ml>\S+)\n(?P<name>[^\n]+)\n(?P<pp>\d+(?:\.\d+)?)\n"
                   r"Style: (?P<style>E/P|E|P|S|NA)(?P<qsp>\d)?\s+Weight: (?P<weight>\d+)", re.M)
SUMMARY = {
    "Avg Speed": "avg_speed", "Speed Lst 3": "avg_speed_3", "Best Spd Dirt": "best_speed_dirt",
    "Best Spd Turf": "best_speed_turf", "Best Spd Dist": "best_speed_dist", "Prime Power": "prime_power_rounded",
    "Odds": "ml_decimal_to1", "E1 Pace Avg": "avg_e1_all", "E2 Pace Avg": "avg_e2_all", "LP Pace Avg": "avg_lp_all",
    "Days Btwn Avg": "days_between_avg", "PPP Rating [A]": "ppp_rating", "E1 Pace Lst 3": "avg_e1",
    "E2 Pace Lst 3": "avg_e2", "LP Pace Lst 3": "avg_lp", "Days Snce Lst": "days_off", "Trnr/Jcky ROI": "trainer_jockey_roi",
}
SUMMARY_RE = re.compile(r"^(" + "|".join(re.escape(k) for k in SUMMARY) + r"):\s*(-?[\d.]+)(?:\s*\((\d+)/(\d+)\))?", re.M)
RECORD = re.compile(r"^(Life|Fast|Wet|Dist|Turf|AllW)\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\$[\d,]+"
                    r"(?:[ \t]+(\d+))?(?:[ \t]+(\d+))?", re.M)
PERSON_YEAR = re.compile(r"^\d{4}:\s*(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+%", re.M)
ALERT = re.compile(r"^[^\n:]+:\s*(\d+)\s+(\d+)%\s+\d+%\s+(-?[\d.]+)$", re.M)
SPD_PAR = re.compile(r"(?<![\d/])(\d{1,3})/(\d{2,3})(?![\d/])")
PP_START = re.compile(r"^\d{2}[A-Z][a-z]{2}\d{2} [A-Z]", re.M)
RACE_TYPE = re.compile(r"(Clm|Alw|Mdn|Msw|Mcl|Moc|Aoc|OC\d|Stk|Hcp|Str|Fut|Dby|Oaks|G[123])")


def detect(pages: List[str]) -> bool:
    return any(MARKER in p for p in pages[:5])


def _section(block: str, title: str, end_titles: Tuple[str, ...]) -> str:
    """Text from a heading line (e.g. 'Jockey S W P S % ROI') to the next known heading."""
    start = block.find(title)
    if start < 0:
        return ""
    rest = block[start + len(title):]
    ends = [rest.find(t) for t in end_titles if rest.find(t) >= 0]
    return rest[:min(ends)] if ends else rest


def horse_stats(block: str, surface: str) -> Dict[str, float]:
    stats: Dict[str, float] = {}
    for m in SUMMARY_RE.finditer(block):
        key = SUMMARY[m.group(1)]
        stats[key] = float(m.group(2))
        if m.group(3):
            stats[f"{key}_rank"] = int(m.group(3))
    surface_label = {"Trf": "Turf", "AW": "AllW"}.get(surface, "Fast")
    for m in RECORD.finditer(block):
        kind, starts, wins = m.group(1), int(m.group(2)), int(m.group(3))
        best, ped = m.group(6), m.group(7)
        if kind == "Life":
            stats.update(life_starts=starts, life_wins=wins, life_win_pct=round(wins / starts, 3) if starts else 0.0)
            if best:
                stats["life_best_speed"] = int(best)
        elif kind in (surface_label, "Dist"):
            prefix = "dist" if kind == "Dist" else "surface"
            stats[f"{prefix}_starts"], stats[f"{prefix}_wins"] = starts, wins
            if best:
                stats[f"{prefix}_best_speed"] = int(best)
            if ped:
                stats[f"{prefix}_pedigree"] = int(ped)
    headings = ("Jockey S W P S", "Trainer S W P S", "Trainer Alert", "Date Trk Dist")
    for who, title in (("jockey", "Jockey S W P S"), ("trainer", "Trainer S W P S")):
        year = PERSON_YEAR.search(_section(block, title, tuple(h for h in headings if h != title)))
        if year:
            starts, wins = int(year.group(1)), int(year.group(2))
            stats[f"{who}_starts"] = starts
            stats[f"{who}_win_pct"] = round(100 * wins / starts) if starts else 0
    alerts = [(int(a.group(1)), int(a.group(2)), float(a.group(3)))
              for a in ALERT.finditer(_section(block, "Trainer Alert", ("Date Trk Dist",)))]
    if alerts:
        stats.update(trainer_alerts=len(alerts), trainer_alert_best_roi=max(a[2] for a in alerts),
                     trainer_alert_worst_roi=min(a[2] for a in alerts))
    if "Meds: Lasix" in block or "Meds: L" in block:
        stats["lasix"] = 1
    # Speed figures race by race ("Spd/Par" column), most recent first.
    pps = block.split("Date Trk Dist", 1)[1] if "Date Trk Dist" in block else ""
    starts = [m.start() for m in PP_START.finditer(pps)] + [len(pps)]
    speeds = []
    for a, b in zip(starts, starts[1:]):
        chunk = pps[a:b].replace("\n", " ")
        m = SPD_PAR.search(chunk)
        if m and RACE_TYPE.search(chunk):  # workout lines ("4f ft :49 3/17 Breezing") have no race type
            speeds.append(int(m.group(1)))
    if speeds:
        stats.update(last_speed=speeds[0], best_speed_3=max(speeds[:3]), races_with_figs=len(speeds))
    return stats


def parse_pages(pages: List[str], skipped: Optional[List[str]] = None) -> List[dict]:
    races: Dict[tuple, dict] = {}
    times: Dict[tuple, Dict[int, tuple]] = {}
    current: Optional[tuple] = None
    for text in pages:
        header = HEADER.search(text)
        if header:
            name = header.group("track").strip()
            num = int(header.group("race"))
            day = datetime.strptime(header.group("date"), "%B %d, %Y").replace(tzinfo=ZoneInfo(BRISNET_TZ))
            rest = header.group("rest")
            surface = "Trf" if re.search(r"\bTurf\b", rest) else "AW" if re.search(r"All Weather|Synthetic|Tapeta", rest) else "Fst"
            current = (name, day, num)
            race = races.setdefault(current, {
                "track": TRACK_CODES.get(name.lower(), name), "track_name": name,
                "race_number": num, "runners": [], "pars": {}, "surface": surface,
            })
            post = POST.search(text[header.end():header.end() + 40]) or POST.search(text)
            if post:
                times.setdefault((name, day), {})[num] = (int(post.group(1)), int(post.group(2)))
            if (pars := PARS.search(text)):
                race["pars"] = dict(zip(("par_e1", "par_e2", "par_lp", "par_speed"), map(int, pars.groups())))
        if current is None:
            continue  # cover pages before the first race
        race = races[current]
        horses = list(HORSE.finditer(text))
        for i, h in enumerate(horses):
            block = text[h.end(): horses[i + 1].start() if i + 1 < len(horses) else len(text)]
            stats = horse_stats(block, race["surface"])
            style = h.group("style")
            pace = {}
            if {"avg_e1", "avg_e2", "avg_lp"} <= stats.keys():
                pace = {"call1_fps": stats["avg_e1"], "call2_fps": stats["avg_e2"], "final_fps": stats["avg_lp"]}
            stats["prime_power"] = float(h.group("pp"))
            stats["weight"] = int(h.group("weight"))
            ml = h.group("ml")
            race["runners"].append({
                "program_num": h.group("num"),
                "name": h.group("name").strip().title(),
                "style": "P" if style == "NA" else style,
                "brisnet_style": style,
                "qsp": int(h.group("qsp") or 0),
                "ml_odds": ml.replace("/", "-") if re.fullmatch(r"\d+/\d+", ml) else "",
                "rating": float(h.group("pp")),
                **pace,
                "stats": stats,
            })
    if not races:
        raise BrisnetError("No PickPony races found in this PDF")
    posts = {card: _post_times(t, card[1]) for card, t in times.items()}
    out = []
    for (name, day, num), race in sorted(races.items(), key=lambda kv: (kv[0][1], kv[0][0], kv[0][2])):
        post = posts.get((name, day), {}).get(num)
        if post is None or not race["runners"]:
            problem = "no post time found" if post is None else "no runners found"
            if skipped is None:
                raise BrisnetError(f"{name} race {num}: {problem}")
            skipped.append(f"{name} R{num}: {problem}")
            continue
        seen = set()
        race["runners"] = [r for r in race["runners"] if not (r["program_num"] in seen or seen.add(r["program_num"]))]
        race["post_time"] = post.isoformat()
        for r in race["runners"]:
            r["stats"].update(race["pars"], turf=int(race["surface"] == "Trf"))
            if "best_speed_3" in r["stats"] and "par_speed" in race["pars"]:
                r["stats"]["speed_vs_par"] = r["stats"]["best_speed_3"] - race["pars"]["par_speed"]
        out.append(race)
    if not out:
        raise BrisnetError("No usable PickPony races in this PDF: " + "; ".join(skipped or []))
    out.sort(key=lambda r: r["post_time"])
    return out


def load_pages(pages: List[str]) -> Tuple[List[dict], List[str]]:
    skipped: List[str] = []
    races = parse_pages(pages, skipped)
    return races, skipped + gap_warnings(races)
