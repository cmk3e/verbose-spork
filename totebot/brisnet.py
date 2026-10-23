"""Read race cards out of Brisnet Ultimate PP PDFs.

Per runner it takes program number, name, Brisnet run style + Quirin points, morning line and
Prime Power (used as the `rating`). Usage:  python -m totebot.brisnet card.pdf > card.csv
"""
import csv
import io
import re
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Optional
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
}
RACE_TYPES = {"alw", "mdn", "md", "mc", "clm", "oc", "stk", "hcp", "str", "msw", "moc", "aoc", "soc", "mcl", "wcl",
              "s", "g1", "g2", "g3", "spwt", "mdspwt", "mdsp", "mcl", "trl", "fut", "dby", "oaks"}
SMALL_WORDS = {"at", "the", "of", "de", "la", "a", "big"}

HEADER = re.compile(r"Ultimate PP's w/ QuickPlay Comments (?P<rest>.+?)\s+"
                    r"(?P<date>[A-Z][a-z]+ \d{1,2}, \d{4})\s+Race (?P<race>\d+)\s*$", re.M)
POST = re.compile(r"Post Time:\s*\(\s*(\d{1,2}):(\d{2})\)")
HORSE = re.compile(r"^(?P<num>\d{1,2}[A-Z]?) (?P<name>.+?) \((?P<style>E/P|E|P|S|NA)\s*(?P<qsp>\d)?\)\s*Own:", re.M)
ML = re.compile(r"^\s*(\d{1,3}/\d{1,2})\b", re.M)
PRIME = re.compile(r"Prime Power:\s*([\d.]+)")


class BrisnetError(ValueError):
    pass


def _track_name(rest: str) -> str:
    words = []
    for w in rest.split():
        clean = w.strip("™‘’'\"").lower()
        abbrev = len(clean) >= 2 and w.strip("™‘’'\"").isupper()  # race-type codes like MC, OC, AOC
        if not w[:1].isalpha() or clean in RACE_TYPES or abbrev or not (w[:1].isupper() or clean in SMALL_WORDS):
            break
        words.append(w)
    return " ".join(words) or "TRACK"


def _post_times(times: Dict[int, tuple], day: datetime) -> Dict[int, datetime]:
    """Clock times without AM/PM -> datetimes. 10:xx-11:xx are morning; later races never go backwards."""
    out: Dict[int, datetime] = {}
    prev: Optional[datetime] = None
    for race in sorted(times):
        h, m = times[race]
        hour = h if h in (10, 11) else (h % 12) + 12
        dt = day.replace(hour=hour % 24, minute=m) + timedelta(days=hour // 24)
        while prev and dt < prev:
            dt += timedelta(hours=12)
        out[race] = prev = dt
    return out


def parse_pages(pages: List[str]) -> List[dict]:
    """Race dicts (track, race_number, post_time ISO, runners) from the text of each PDF page.
    One PDF may hold several tracks; races are kept apart by track and date."""
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
        race = races.setdefault((name, day, num), {
            "track": TRACK_CODES.get(name.lower(), name), "track_name": name,
            "race_number": num, "runners": [],
        })
        post = POST.search(text)
        if post:
            times.setdefault(card, {})[num] = (int(post.group(1)), int(post.group(2)))
        horses = list(HORSE.finditer(text))
        for i, h in enumerate(horses):
            block = text[h.end(): horses[i + 1].start() if i + 1 < len(horses) else len(text)]
            ml = ML.search("\n".join(block.splitlines()[:3]))
            prime = PRIME.search(block)
            style = h.group("style")
            race["runners"].append({
                "program_num": h.group("num"),
                "name": h.group("name").strip(),
                # The engine has no "NA" (unknown) style; treat those as pressers.
                "style": "P" if style == "NA" else style,
                "brisnet_style": style,
                "qsp": int(h.group("qsp") or 0),
                "ml_odds": ml.group(1).replace("/", "-") if ml else "",
                "rating": float(prime.group(1)) if prime else "",
            })
    if not races:
        raise BrisnetError("No Brisnet Ultimate PP races found in this PDF")
    posts = {card: _post_times(t, card[1]) for card, t in times.items()}
    out = []
    for (name, day, num), race in sorted(races.items(), key=lambda kv: (kv[0][1], kv[0][0], kv[0][2])):
        post = posts.get((name, day), {}).get(num)
        if post is None:
            raise BrisnetError(f"No post time found for {name} race {num}")
        seen = set()
        race["runners"] = [r for r in race["runners"] if not (r["program_num"] in seen or seen.add(r["program_num"]))]
        race["post_time"] = post.isoformat()
        out.append(race)
    out.sort(key=lambda r: r["post_time"])
    return out


def pdf_pages(data: bytes) -> List[str]:
    from pypdf import PdfReader

    return [p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages]


def parse_pdf(data: bytes) -> List[dict]:
    return parse_pages(pdf_pages(data))


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
               "rating", "ml_odds", "brisnet_style"]


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
