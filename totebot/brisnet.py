"""Read race cards out of Brisnet Ultimate PP PDFs.

Per runner it takes program number, name, Brisnet run style + Quirin points, morning line and
Prime Power (used as the `rating`), plus E1/E2/LP pace figures from recent races (fed to the
engine's %-early pace calculation) and a set of recorded `stats` for later model fitting.
Usage:  python -m totebot.brisnet card.pdf > card.csv
"""
import csv
import io
import re
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

# Brisnet prints post times in Eastern time first: "Post Time: ( 2:16)/ 1:16/12:16/11:16" (ET/CT/MT/PT).
BRISNET_TZ = "America/New_York"

TRACK_CODES = {
    "belmont park": "BEL", "belmont at the big a": "BAQ", "aqueduct": "AQU", "saratoga": "SAR",
    "churchill downs": "CD", "keeneland": "KEE", "gulfstream park": "GP", "santa anita": "SA",
    "del mar": "DMR", "oaklawn park": "OP", "fair grounds": "FG", "laurel park": "LRL",
    "pimlico": "PIM", "monmouth park": "MTH", "parx racing": "PRX", "penn national": "PEN",
    "tampa bay downs": "TAM", "woodbine": "WO", "kentucky downs": "KD", "ellis park": "ELP",
    "colonial downs": "CNL", "indiana grand": "IND", "horseshoe indianapolis": "IND",
    "turfway park": "TP", "golden gate fields": "GG", "los alamitos": "LA", "remington park": "RP",
    "lone star park": "LS", "arlington park": "AP", "canterbury park": "CBY", "delaware park": "DEL",
    "finger lakes": "FL", "finger lakes racetrack": "FL",
}
RACE_TYPES = {"alw", "mdn", "md", "mc", "clm", "oc", "stk", "hcp", "str", "msw", "moc", "aoc", "soc", "mcl", "wcl",
              "s", "g1", "g2", "g3", "spwt", "mdspwt", "mdsp", "mcl", "trl", "fut", "dby", "oaks"}
SMALL_WORDS = {"at", "the", "of", "de", "la", "a", "big"}

# Long track names are printed over "Comments", so the name can come out glued to it or on the next line.
HEADER = re.compile(r"Ultimate PP's w/ QuickPlay Comm?e?n?t?s?\s*(?P<rest>[A-Z].+?)\s+"
                    r"(?P<date>[A-Z][a-z]+ \d{1,2}, \d{4})\s+Race (?P<race>\d+)\s*$", re.M)
POST = re.compile(r"Post\s*Time:?\s*\(?\s*(\d{1,2})\s*:\s*(\d{2})")
TOC_RACE = re.compile(r"^Race (\d+)$")
TOC_LINE = re.compile(r"^Race \d+$", re.M)
# A symbol can follow the style (e.g. the trophy icon by a horse with a Breeders' Cup win)
HORSE = re.compile(r"^(?P<num>\d{1,2}[A-Z]?) (?P<name>.+?) \((?P<style>E/P|E|P|S|NA)\s*(?P<qsp>\d)?\)[^\n]{0,12}?\s*Own:", re.M)
ML = re.compile(r"^\s*(\d{1,3}/\d{1,2})\b", re.M)
PRIME = re.compile(r"Prime Power:\s*([\d.]+)")
PARS = re.compile(r"PARS:\s*(\d+)\s+(\d+)/\s*(\d+)\s+(\d+)")
PP_DATE = re.compile(r"^(\d{2})([A-Z][a-z]{2})(\d{2})")
# Past-performance figures: "E1 E2/ LP 1c 2c SPD PP " (E1 may be glued to the class-rating glyphs)...
FULL_FIGS = re.compile(r"(?<!\d)(\d{2,3}) (\d{2,3})/ (\d{2,3}) ([+-]?\d{1,2}) ([+-]?\d{1,2}) (\d{1,3}) (\d{1,2}) ")
# ...or, for short sprints, just "E2/ LP SPD PP ST ".
SHORT_FIGS = re.compile(r"(?<!\d)(\d{2,3})/ (\d{2,3}) (\d{1,3}) (\d{1,2}) (\d{1,2}) ")
JOCKEY = re.compile(r"^[A-Z][A-Z.,' -]+?\s+\(\s*(\d+)\s+(\d+)-(\d+)-(\d+)\s+(\d+)%\)", re.M)
TRAINER = re.compile(r"Trnr:.*?\(\s*(\d+)\s+(\d+)-(\d+)-(\d+)\s+(\d+)%\)")
LIFE = re.compile(r"Life:\s*(\d+)\s+(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\s+\$[\d,]+(?:[ \t]+(\d+))?")
RECORD = re.compile(r"^(Fst|Off|Dis|Trf|AW)\s*(?:\((\d+)\*?\)|\(\w+\))?\s+(\d+)\s+(\d+)\s*-\s*(\d+)\s*-\s*(\d+)"
                    r"\s+\$[\d,]+(?:[ \t]+(\d+))?", re.M)
WEIGHT = re.compile(r"^(L\s+)?(\d{3})\s*$", re.M)
MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jly", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
RECENT_RACES = 3


class BrisnetError(ValueError):
    pass


def _track_name(rest: str) -> str:
    words = []
    for w in rest.split():
        clean = w.strip("™‘’'\"").lower()
        bare = w.strip("™‘’'\"")
        # race-type codes like MC, OC, AOC, OClm (track names are capitalised words, never all caps or OClm)
        abbrev = len(clean) >= 2 and (bare.isupper() or any(c.isupper() for c in bare[1:]))
        if not w[:1].isalpha() or clean in RACE_TYPES or abbrev or not (w[:1].isupper() or clean in SMALL_WORDS):
            break
        words.append(w)
    return " ".join(words) or "TRACK"


def _post_times(times: Dict[int, tuple], day: datetime) -> Dict[int, datetime]:
    """Clock times without AM/PM -> datetimes. 12:xx-9:xx are afternoon/evening. 10:xx-11:xx are
    morning at the start of a card (an earlier race already in the afternoon makes them night; with
    no earlier race known, a race 1-4 or one followed by an afternoon race is morning). Later races
    never go before earlier ones. (TVG's post time corrects a wrong guess when the race is polled.)"""
    out: Dict[int, datetime] = {}
    prev: Optional[datetime] = None
    order = sorted(times)
    for i, race in enumerate(order):
        h, m = times[race]
        dt = day.replace(hour=(h % 12) + 12, minute=m)
        if h in (10, 11):
            morning = day.replace(hour=h, minute=m)
            if prev is not None:
                is_morning = prev <= morning
            else:
                following = times[order[i + 1]][0] if i + 1 < len(order) else None
                is_morning = race <= 4 or (following is not None and following not in (10, 11))
            if is_morning:
                dt = morning
        while prev and dt < prev:
            dt += timedelta(hours=12)
        out[race] = prev = dt
    return out


def _avg(xs: List[float]) -> Optional[float]:
    return round(sum(xs) / len(xs), 2) if xs else None


def horse_stats(block: str, race_day: datetime, surface: str) -> Dict[str, float]:
    """Numbers from one horse's PP block. Pace averages (avg_e1/avg_e2/avg_lp) and speed figures
    come from the most recent races that show figures."""
    stats: Dict[str, float] = {}
    head, _, pps = block.partition("DATE  TRK")
    figs = []
    last_date = None
    for line in pps.splitlines():
        line = line.strip()
        m = PP_DATE.match(line)
        if not m or m.group(2) not in MONTHS:
            continue
        if last_date is None:
            last_date = datetime(2000 + int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)), tzinfo=race_day.tzinfo)
        full = FULL_FIGS.search(line)
        short = None if full else SHORT_FIGS.search(line)
        if full:
            e1, e2, lp, spd = int(full.group(1)), int(full.group(2)), int(full.group(3)), int(full.group(6))
        elif short:
            e1, e2, lp, spd = None, int(short.group(1)), int(short.group(2)), int(short.group(3))
        else:
            continue
        if 0 < spd <= 130:
            figs.append((e1, e2, lp, spd))
    if last_date:
        stats["days_off"] = (race_day.date() - last_date.date()).days
    recent = figs[:RECENT_RACES]
    if recent:
        speeds = [f[3] for f in recent]
        stats.update(last_speed=speeds[0], best_speed_3=max(speeds), avg_speed_3=_avg(speeds), races_with_figs=len(figs))
        e1s = [f[0] for f in recent if f[0] is not None]
        if e1s:
            stats["avg_e1"] = _avg(e1s)
        stats["avg_e2"] = _avg([f[1] for f in recent])
        stats["avg_lp"] = _avg([f[2] for f in recent])

    if (j := JOCKEY.search(block)):
        stats["jockey_starts"], stats["jockey_win_pct"] = int(j.group(1)), int(j.group(5))
    if (t := TRAINER.search(block)):
        stats["trainer_starts"], stats["trainer_win_pct"] = int(t.group(1)), int(t.group(5))
    if (life := LIFE.search(block)):
        starts, wins = int(life.group(1)), int(life.group(2))
        stats.update(life_starts=starts, life_wins=wins, life_win_pct=round(wins / starts, 3) if starts else 0.0)
        if life.group(5):
            stats["life_best_speed"] = int(life.group(5))
    for rec in RECORD.finditer(block):
        kind = rec.group(1)
        if kind not in (surface, "Dis"):
            continue
        prefix = "dist" if kind == "Dis" else "surface"
        stats[f"{prefix}_starts"], stats[f"{prefix}_wins"] = int(rec.group(3)), int(rec.group(4))
        if rec.group(7):
            stats[f"{prefix}_best_speed"] = int(rec.group(7))
        if rec.group(2):
            stats[f"{prefix}_pedigree"] = int(rec.group(2))
    if (w := WEIGHT.search(block)):
        stats["lasix"], stats["weight"] = int(bool(w.group(1))), int(w.group(2))
    quick = [ln.strip() for ln in head.splitlines() if ln.strip()[:1] in ("ñ", "×")]
    stats["qp_positive"] = sum(ln.count("ñ") for ln in quick)
    stats["qp_negative"] = sum(ln.count("×") for ln in quick)
    return stats


def table_of_contents(pages: List[str]) -> List[Tuple[str, int]]:
    """(track name, race number) for each race listed on a 365horses-style cover page."""
    out: List[Tuple[str, int]] = []
    track = None
    for text in pages:
        if HEADER.search(text) or "APPROX. POST" in text:
            break  # past the cover pages
        for line in text.splitlines():
            line = line.strip()
            m = TOC_RACE.match(line)
            if m and track:
                out.append((track, int(m.group(1))))
            elif line and not line.isdigit() and not m and len(line) < 40:
                track = line
    return out


def parse_pages(pages: List[str], skipped: Optional[List[str]] = None) -> List[dict]:
    """Race dicts (track, race_number, post_time ISO, runners) from the text of each PDF page.
    One PDF may hold several tracks; races are kept apart by track and date. Races that can't be
    used are listed in `skipped` (when given) instead of failing the whole file."""
    races: Dict[tuple, dict] = {}                     # (track name, date, race number) -> race
    times: Dict[tuple, Dict[int, tuple]] = {}         # (track name, date) -> {race number: (h, m)}
    for text in pages:
        header = HEADER.search(text)
        if not header:
            continue
        num = int(header.group("race"))
        name = _track_name(header.group("rest"))
        day = datetime.strptime(header.group("date"), "%B %d, %Y").replace(tzinfo=ZoneInfo(BRISNET_TZ))
        card = (name, day)
        rest = header.group("rest")
        surface = "Trf" if re.search(r"\((?:t|T)\)", rest) else "AW" if re.search(r"\(A\)", rest) else "Fst"
        race = races.setdefault((name, day, num), {
            "track": TRACK_CODES.get(name.lower(), name), "track_name": name,
            "race_number": num, "runners": [], "pars": {}, "surface": surface,
        })
        if (pars := PARS.search(text)):
            race["pars"] = dict(zip(("par_e1", "par_e2", "par_lp", "par_speed"), map(int, pars.groups())))
        post = POST.search(text)
        if post:
            times.setdefault(card, {})[num] = (int(post.group(1)), int(post.group(2)))
        horses = list(HORSE.finditer(text))
        for i, h in enumerate(horses):
            block = text[h.end(): horses[i + 1].start() if i + 1 < len(horses) else len(text)]
            ml = ML.search("\n".join(block.splitlines()[:3]))
            prime = PRIME.search(block)
            style = h.group("style")
            stats = horse_stats(block, day, race["surface"])
            pace = {}
            if "avg_e2" in stats:
                # Brisnet pace figures stand in for the engine's call fps: it only uses their ratio.
                pace = {"call1_fps": stats.get("avg_e1", stats["avg_e2"]), "call2_fps": stats["avg_e2"],
                        "final_fps": stats["avg_lp"]}
            if prime:
                stats["prime_power"] = float(prime.group(1))
            race["runners"].append({
                "program_num": h.group("num"),
                "name": h.group("name").strip(),
                # The engine has no "NA" (unknown) style; treat those as pressers.
                "style": "P" if style == "NA" else style,
                "brisnet_style": style,
                "qsp": int(h.group("qsp") or 0),
                "ml_odds": ml.group(1).replace("/", "-") if ml else "",
                "rating": float(prime.group(1)) if prime else "",
                **pace,
                "stats": stats,
            })
    if not races:
        raise BrisnetError("No Brisnet Ultimate PP races found in this PDF")
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
        raise BrisnetError("No usable Brisnet races in this PDF: " + "; ".join(skipped or []))
    out.sort(key=lambda r: r["post_time"])
    return out


def pdf_pages(data: bytes) -> List[str]:
    from pypdf import PdfReader

    return [p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages]


def parse_pdf(data: bytes) -> List[dict]:
    return parse_pages(pdf_pages(data))


def gap_warnings(races: List[dict]) -> List[str]:
    """Races whose program numbers skip a number: a PP the reader probably missed."""
    out = []
    for r in races:
        nums = {int(x["program_num"]) for x in r["runners"] if x["program_num"].isdigit()}
        gaps = sorted(set(range(1, max(nums) + 1)) - nums) if nums else []
        if gaps:
            out.append(f"{r['track_name']} R{r['race_number']}: loaded, but no PP found for "
                       + ", ".join(f"#{g}" for g in gaps) + " (reader may have missed it; it will still be "
                       "included from the tote)")
    return out


def load_pages(pages: List[str]) -> Tuple[List[dict], List[str]]:
    """(usable races, notes on races left out). Races on the cover page that aren't Brisnet
    Ultimate PPs (e.g. Equineline PPs) are reported as skipped."""
    skipped: List[str] = []
    races = parse_pages(pages, skipped)
    found = {(r["track_name"].lower(), r["race_number"]) for r in races}
    noted = {s.split(":")[0].lower() for s in skipped}
    skipped += gap_warnings(races)
    for track, num in table_of_contents(pages):
        if (track.lower(), num) not in found and f"{track} r{num}".lower() not in noted:
            skipped.append(f"{track} R{num}: not a Brisnet Ultimate PP (probably Equineline)")
    return races, skipped


def diagnose_skipped(pages: List[str], skipped: List[str], limit: int = 4) -> str:
    """For races listed on the cover but not read: the start of the first page mentioning each
    track, so the reader can be fixed."""
    names = []
    for note in skipped:
        m = re.match(r"(.+?) R\d+: not a Brisnet", note)
        if m and m.group(1) not in names:
            names.append(m.group(1))
    lines = []
    for name in names[:limit]:
        mentions = [i for i, t in enumerate(pages) if name.lower() in t.lower() and not TOC_LINE.search(t)]
        idx = next((i for i in mentions if not HEADER.search(pages[i])), mentions[0] if mentions else None)
        if idx is None:
            lines.append(f"\n--- {name}: no page found that mentions it")
        else:
            lines.append(f"\n--- {name}: page {idx + 1}, first 1500 characters:\n{pages[idx][:1500]}")
    return "\n".join(lines)


def diagnose(pages: List[str]) -> str:
    """Plain-text report on a PDF the reader could not use: which pages look like Brisnet PPs,
    plus samples of the ones that don't, so the format can be added."""
    brisnet = [i for i, t in enumerate(pages) if HEADER.search(t)]
    other = [i for i, t in enumerate(pages) if i not in brisnet and t.strip()]
    lines = [f"{len(pages)} pages; {len(brisnet)} look like Brisnet Ultimate PP pages; "
             f"{len(other)} other pages with text; {len(pages) - len(brisnet) - len(other)} without text (scanned images?)"]
    for i in brisnet[:3]:
        lines.append(f"\n--- page {i + 1} (Brisnet) header: {HEADER.search(pages[i]).group(0)[:200]}")
    for i in other[:3]:
        lines.append(f"\n--- page {i + 1} (not recognised), first 2000 characters:\n{pages[i][:2000]}")
    return "\n".join(lines)


CSV_COLUMNS = ["track", "race_number", "post_time", "program_num", "name", "style", "qsp",
               "rating", "ml_odds", "call1_fps", "call2_fps", "final_fps", "brisnet_style"]


def to_csv(races: List[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, extrasaction="ignore")
    w.writeheader()
    for race in races:
        for r in race["runners"]:
            w.writerow({**race, **r})
    return buf.getvalue()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m totebot.brisnet card.pdf > card.csv")
    with open(sys.argv[1], "rb") as fh:
        sys.stdout.write(to_csv(parse_pdf(fh.read())))
