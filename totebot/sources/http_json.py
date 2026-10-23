from typing import Any, Dict

import httpx

from ..config import Settings
from ..models import Race, ToteSnapshot, _parse_dt, utcnow
from ..odds import parse_odds
from .base import ToteSource, ToteUnavailable


def dig(obj: Any, path: str) -> Any:
    """Follow a dotted path like "data.races.0.runners" through dicts and lists."""
    if not path:
        return obj
    for part in path.split("."):
        if isinstance(obj, list):
            obj = obj[int(part)]
        elif isinstance(obj, dict):
            obj = obj.get(part)
        else:
            return None
        if obj is None:
            return None
    return obj


class HttpJsonToteSource(ToteSource):
    """Generic adapter for any odds provider that returns JSON.

    Configure with TOTE_HTTP_* env vars. The URL is a template that can use
    {track}, {race}, {date} (YYYY-MM-DD, track local), {yyyymmdd} and {ref} (the race's source_ref).
    """

    name = "http"

    def __init__(self, settings: Settings):
        if not settings.http_url:
            raise ValueError("TOTE_SOURCE=http requires TOTE_HTTP_URL")
        self.s = settings
        self.client = httpx.AsyncClient(timeout=settings.http_timeout_s, headers=settings.http_headers)

    def url_for(self, race: Race) -> str:
        from zoneinfo import ZoneInfo

        local = race.post_time.astimezone(ZoneInfo(self.s.timezone))
        return self.s.http_url.format(
            track=race.track,
            race=race.race_number,
            date=local.strftime("%Y-%m-%d"),
            yyyymmdd=local.strftime("%Y%m%d"),
            ref=race.source_ref or "",
        )

    def parse(self, payload: Any) -> ToteSnapshot:
        rows = dig(payload, self.s.http_runners_path)
        if not isinstance(rows, list) or not rows:
            raise ToteUnavailable(f"No runner list at {self.s.http_runners_path!r}")
        odds: Dict[str, float] = {}
        scratched = []
        for row in rows:
            num = dig(row, self.s.http_program_field)
            if num is None:
                continue
            num = str(num).strip()
            scr = dig(row, self.s.http_scratch_field)
            dec = parse_odds(dig(row, self.s.http_odds_field), self.s.http_odds_format)
            if scr in (True, "true", "True", "Y", "y", 1, "1") or dec is None:
                scratched.append(num)
            else:
                odds[num] = dec
        post_time = None
        if self.s.http_post_time_path:
            post_time = _parse_dt(dig(payload, self.s.http_post_time_path))
        exacta = {}
        if self.s.http_exacta_path:
            raw = dig(payload, self.s.http_exacta_path) or {}
            for combo, payout in raw.items():
                key = "-".join(p.strip() for p in str(combo).replace("/", "-").split("-"))
                exacta[key] = float(payout) / self.s.http_exacta_base
        return ToteSnapshot(
            taken_at=utcnow(), win_odds=odds, scratched=scratched,
            post_time=post_time, exacta_probables=exacta, source=self.name,
        )

    async def fetch(self, race: Race) -> ToteSnapshot:
        try:
            resp = await self.client.get(self.url_for(race))
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise ToteUnavailable(f"Tote request failed: {e}") from e
        return self.parse(resp.json())

    async def aclose(self) -> None:
        await self.client.aclose()
