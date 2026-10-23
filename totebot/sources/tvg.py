"""Live tote from TVG's public race pages (the same data www.tvg.com/racetracks/<TRK>/... loads).

Check it from the VM:  cd /opt/totebot && .venv/bin/python -m totebot.sources.tvg BEL 3
List today's tracks:   cd /opt/totebot && .venv/bin/python -m totebot.sources.tvg tracks
"""
import asyncio
import re
import sys
import time
from datetime import timedelta
from typing import Any, Dict, List, Optional

import httpx

from ..models import Race, ToteSnapshot, _parse_dt, utcnow
from .base import ToteSource, ToteUnavailable

GRAPHQL_URL = "https://api.tvg.com/cosmo/v1/graphql"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": "https://www.tvg.com",
    "Referer": "https://www.tvg.com/",
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
}
QUERY = """
query getRaceProgram($trackAbbr: String, $raceNumber: String, $wagerProfile: String) {
  race(track: $trackAbbr, number: $raceNumber, profile: $wagerProfile) {
    number
    mtp
    postTime
    status { code }
    bettingInterests {
      biNumber
      currentOdds { numerator denominator }
      morningLineOdds { numerator denominator }
      runners { runnerId scratched horseName }
    }
    probables {
      betCombos { runner1 runner2 payout }
      minWagerAmount
      wagerType { id name }
    }
  }
}
"""
TRACKS_QUERY = """
query getTracks($wagerProfile: String, $filter: TrackListFilter) {
  tracks(profile: $wagerProfile, filter: $filter) { code name }
}
"""
GENERIC_WORDS = {"park", "race", "course", "racecourse", "racetrack", "racing", "the", "at", "downs"}
TRACK_LIST_TTL_S = 1800


def normalize_track(name: str) -> str:
    """'Belmont Park' -> 'belmont'; 'GB - Wolverhampton' -> 'wolverhampton'."""
    name = re.sub(r"^[A-Z]{2}\s*-\s*", "", name.strip())
    words = [w for w in re.split(r"[^a-z0-9]+", name.lower()) if w and w not in GENERIC_WORDS]
    return "".join(words)


def match_track(candidates: List[str], tracks: Dict[str, str]) -> Optional[str]:
    """TVG code for the first candidate (a code or a track name) that matches today's TVG tracks."""
    for cand in candidates:
        if cand.upper() in tracks:
            return cand.upper()
    by_name = {normalize_track(name): code for code, name in tracks.items()}
    for cand in candidates:
        key = normalize_track(cand)
        if not key:
            continue
        if key in by_name:
            return by_name[key]
        close = [code for n, code in by_name.items() if n.startswith(key) or key.startswith(n)]
        if len(close) == 1:
            return close[0]
    return None


# TVG race status codes for races still taking bets (O = open, MO = morning odds, IC = in contention/near post).
OPEN_STATUSES = {"O", "MO", "IC"}


def odds_to_decimal(odds: Optional[Dict[str, Any]]) -> Optional[float]:
    if not odds or odds.get("numerator") in (None, ""):
        return None
    num = float(odds["numerator"])
    den = float(odds.get("denominator") or 1)
    return max(1.0 + num / den, 1.05) if den > 0 else None


def parse_race(data: Dict[str, Any], source: str = "tvg") -> ToteSnapshot:
    race = (data.get("data") or {}).get("race")
    if not race:
        errors = data.get("errors") or "no race in response"
        raise ToteUnavailable(f"TVG returned no race: {errors}")
    now = utcnow()
    win_odds: Dict[str, float] = {}
    scratched = []
    for bi in race.get("bettingInterests") or []:
        dec = odds_to_decimal(bi.get("currentOdds"))
        for runner in bi.get("runners") or []:
            num = str(runner.get("runnerId") or bi.get("biNumber")).strip()
            if runner.get("scratched"):
                scratched.append(num)
            elif dec is not None:
                win_odds[num] = dec  # coupled entries (1, 1A) share their interest's odds

    post = _parse_dt(race.get("postTime"))
    status = ((race.get("status") or {}).get("code") or "").upper()
    mtp = race.get("mtp")
    # When the track drags past post, TVG keeps counting minutes to post; trust that over the printed time.
    if post and status in OPEN_STATUSES and isinstance(mtp, (int, float)) and mtp > 0:
        post = max(post, now + timedelta(minutes=mtp))

    exacta: Dict[str, float] = {}
    for prob in race.get("probables") or []:
        name = ((prob.get("wagerType") or {}).get("name") or "").lower()
        base = float(prob.get("minWagerAmount") or 1) or 1.0
        if "exacta" not in name:
            continue
        for combo in prob.get("betCombos") or []:
            if combo.get("payout"):
                exacta[f"{combo['runner1']}-{combo['runner2']}"] = float(combo["payout"]) / base

    if not win_odds:
        raise ToteUnavailable(f"TVG has no odds yet for this race (status {status or '?'})")
    return ToteSnapshot(taken_at=now, win_odds=win_odds, scratched=scratched,
                        post_time=post, exacta_probables=exacta, source=source)


class TvgToteSource(ToteSource):
    """Win odds, scratches, post time and exacta probables from TVG. Uses the race's track code
    (e.g. BEL), or its source_ref when TVG's code differs."""

    name = "tvg"

    def __init__(self, wager_profile: str = "PORT-Generic", timeout_s: float = 10.0):
        self.wager_profile = wager_profile
        self.client = httpx.AsyncClient(timeout=timeout_s, headers=HEADERS)
        self._tracks: Dict[str, str] = {}
        self._tracks_at = 0.0
        self._resolved: Dict[str, str] = {}

    async def tracks(self) -> Dict[str, str]:
        """Today's TVG tracks as {code: name}, cached for half an hour."""
        if not self._tracks or time.monotonic() - self._tracks_at > TRACK_LIST_TTL_S:
            data = await self._post("getTracks", TRACKS_QUERY, {
                "wagerProfile": self.wager_profile, "filter": {"allTrackClasses": True}})
            rows = (data.get("data") or {}).get("tracks") or []
            self._tracks = {r["code"].upper(): r.get("name") or "" for r in rows if r.get("code")}
            self._tracks_at = time.monotonic()
        return self._tracks

    async def resolve_track(self, race: Race) -> str:
        """The race's TVG track code: its source_ref if set, else its code or name matched against TVG."""
        if race.source_ref:
            return race.source_ref.upper()
        if race.track in self._resolved:
            return self._resolved[race.track]
        from ..brisnet import TRACK_CODES

        names = [race.track] + [n for n, c in TRACK_CODES.items() if c == race.track.upper()]
        try:
            code = match_track(names, await self.tracks())
        except ToteUnavailable:
            code = None  # track list unavailable; fall back to the card's own code
        if code is None:
            if race.track.isalnum() and len(race.track) <= 4:
                return race.track.upper()
            raise ToteUnavailable(f"No TVG track matches {race.track!r} today (set the race's source_ref to TVG's code)")
        self._resolved[race.track] = code
        return code

    async def fetch_raw(self, track: str, race_number: int) -> Dict[str, Any]:
        return await self._post("getRaceProgram", QUERY, {
            "trackAbbr": track, "raceNumber": str(race_number), "wagerProfile": self.wager_profile})

    async def _post(self, operation: str, query: str, variables: Dict[str, Any]) -> Dict[str, Any]:
        payload = {"operationName": operation, "query": query, "variables": variables}
        try:
            resp = await self.client.post(GRAPHQL_URL, json=payload)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            raise ToteUnavailable(f"TVG HTTP {e.response.status_code}: {e.response.text[:200]}") from e
        except (httpx.HTTPError, ValueError) as e:
            raise ToteUnavailable(f"TVG request failed: {e}") from e

    async def fetch(self, race: Race) -> ToteSnapshot:
        track = await self.resolve_track(race)
        return parse_race(await self.fetch_raw(track, race.race_number))

    async def aclose(self) -> None:
        await self.client.aclose()


async def _list_tracks() -> None:
    src = TvgToteSource()
    try:
        for code, name in sorted((await src.tracks()).items(), key=lambda kv: kv[1]):
            print(f"{code:<5} {name}")
    finally:
        await src.aclose()


async def _check(track: str, race_number: int) -> None:
    from ..odds import format_odds

    src = TvgToteSource()
    try:
        code = match_track([track], await src.tracks()) or track
        if code != track:
            print(f"{track!r} is TVG track {code}")
        track = code
        snap = parse_race(await src.fetch_raw(track, race_number))
    finally:
        await src.aclose()
    print(f"TVG {track} R{race_number}: post {snap.post_time:%H:%M}Z, {len(snap.win_odds)} runners with odds")
    for num, dec in sorted(snap.win_odds.items(), key=lambda kv: (len(kv[0]), kv[0])):
        print(f"  #{num:<3} {format_odds(dec):>6}")
    if snap.scratched:
        print("  scratched: " + ", ".join(snap.scratched))
    print(f"  exacta probables: {len(snap.exacta_probables)} combos")


if __name__ == "__main__":
    if sys.argv[1:] == ["tracks"]:
        asyncio.run(_list_tracks())
    elif len(sys.argv) == 3:
        asyncio.run(_check(sys.argv[1], int(sys.argv[2])))
    else:
        raise SystemExit("usage: python -m totebot.sources.tvg TRACK RACE   (e.g. BEL 3 or 'Delta Downs' 4)\n"
                         "       python -m totebot.sources.tvg tracks      (today's TVG tracks)")
