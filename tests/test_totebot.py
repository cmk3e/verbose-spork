import asyncio
import json
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from totebot.cards import races_from_csv, races_from_json
from totebot.config import Settings
from totebot.handicap import run_handicap
from totebot.models import Race, ToteSnapshot, utcnow
from totebot.odds import format_odds, parse_odds
from totebot.scheduler import RaceScheduler
from totebot.sources import ToteSource, ToteUnavailable
from totebot.sources.http_json import HttpJsonToteSource
from totebot.store import RaceStore
from totebot.web import create_app

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
TZ = "America/New_York"


def settings(tmp_path, **kw) -> Settings:
    return Settings(data_dir=tmp_path, timezone=TZ, **kw)


def sample_race(post_in_min: float = 30) -> Race:
    race = races_from_json(json.loads((EXAMPLES / "race_card.json").read_text()), TZ)[0]
    race.post_time = utcnow() + timedelta(minutes=post_in_min)
    return race


TOTE = {"1": "5-2", "2": "2", "3": "8", "4": "9-2", "5": "12", "6": "7-2", "7": "15"}


def tote(**kw) -> ToteSnapshot:
    return ToteSnapshot(taken_at=utcnow(), win_odds={k: parse_odds(v) for k, v in TOTE.items()}, source="test", **kw)


class FakeSource(ToteSource):
    name = "fake"

    def __init__(self, snap=None, fail=False):
        self.snap, self.fail, self.calls = snap, fail, 0

    async def fetch(self, race):
        self.calls += 1
        if self.fail:
            raise ToteUnavailable("down")
        return self.snap or tote()


# --- odds ---------------------------------------------------------------

@pytest.mark.parametrize("raw,dec", [("5-2", 3.5), ("9/5", 2.8), ("EVEN", 2.0), ("3", 4.0), (3, 4.0), ("1-9", 1.1111)])
def test_parse_odds(raw, dec):
    assert parse_odds(raw) == pytest.approx(dec, abs=1e-3)


def test_parse_odds_scratch_and_decimal():
    assert parse_odds("SCR") is None
    assert parse_odds(3.5, "decimal") == 3.5
    with pytest.raises(ValueError):
        parse_odds("abc")


def test_format_odds():
    assert format_odds(3.5) == "5-2"
    assert format_odds(2.0) == "EVEN"
    assert format_odds(16.0) == "15-1"


# --- cards --------------------------------------------------------------

def test_csv_single_race_with_form_fields():
    races = races_from_csv((EXAMPLES / "race_card.csv").read_text(), TZ, "SAR", 3, "1:45 PM", "2026-08-01")
    assert len(races) == 1
    r = races[0]
    assert r.id == "SAR-20260801-R3"
    assert r.post_time.isoformat() == "2026-08-01T17:45:00+00:00"
    assert r.runners[3].style == "E/P" and r.runners[0].p_fund == 0.18


def test_csv_whole_day():
    races = races_from_csv((EXAMPLES / "day_card.csv").read_text(), TZ, day="2026-10-23")
    assert [r.race_number for r in races] == [1, 2]
    assert len(races[1].runners) == 4


# --- handicapping -------------------------------------------------------

def test_handicap_produces_tickets(tmp_path):
    race = sample_race()
    out = run_handicap(race, tote(), settings(tmp_path))
    assert out["field_size"] == 7
    assert out["fundamental_source"] == "p_fund"
    assert out["pace"]["scenario"] in ("FAST_PACED_COLLAPSE", "LONE_SPEED_SOFT", "BALANCED_PACE")
    assert sum(r["p_true"] for r in out["runners"]) == pytest.approx(1.0, abs=1e-3)
    assert set(out["exotics"]) == {"exacta", "superfecta"}
    for b in out["win_bets"]:
        assert b["stake"] >= 2 and b["ev"] > 0
    assert out["total_cost"] <= 1000 * 0.05 + 20 + 12 + 1e-6
    assert "AQU R5" in out["ticket_text"]
    json.dumps(out)  # must be serializable


def test_handicap_drops_scratches_and_uses_probables(tmp_path):
    race = sample_race()
    snap = tote(scratched=["7"], exacta_probables={"2-1": 9.0, "1-2": 12.5})
    out = run_handicap(race, snap, settings(tmp_path))
    assert out["field_size"] == 6
    assert "7" not in [r["program_num"] for r in out["runners"]]
    assert out["exotics"]["exacta"]["payout_source"] == "tote probables"


def test_handicap_falls_back_to_rating(tmp_path):
    race = races_from_csv((EXAMPLES / "day_card.csv").read_text(), TZ, day="2026-10-23")[0]
    snap = ToteSnapshot(taken_at=utcnow(), win_odds={"1": 3.0, "2": 4.0, "3": 4.5, "4": 7.0, "5": 11.0})
    out = run_handicap(race, snap, settings(tmp_path))
    assert out["fundamental_source"] == "rating"


# --- scheduler ----------------------------------------------------------

def run(coro):
    return asyncio.run(coro)


def test_scheduler_fetches_at_3_and_publishes_at_2(tmp_path):
    s = settings(tmp_path)
    store = RaceStore(tmp_path)
    race = sample_race(post_in_min=10)
    store.save(race)
    src = FakeSource()
    sched = RaceScheduler(s, store, src)
    post = race.post_time

    run(sched.tick(post - timedelta(minutes=3.5)))   # pre-poll only
    assert race.status == "scheduled" and src.calls == 1
    run(sched.tick(post - timedelta(minutes=2.9)))   # tote pulled, tickets computed
    assert race.status == "ready" and race.tickets
    run(sched.tick(post - timedelta(minutes=2.5)))   # still embargoed
    assert race.status == "ready"
    run(sched.tick(post - timedelta(minutes=1.95)))  # released
    assert race.status == "published"
    assert RaceStore(tmp_path).get(race.id).status == "published"  # persisted


def test_scheduler_follows_delayed_post(tmp_path):
    s = settings(tmp_path)
    store = RaceStore(tmp_path)
    race = sample_race(post_in_min=10)
    store.save(race)
    original = race.post_time
    src = FakeSource(snap=tote(post_time=original + timedelta(minutes=4)))
    sched = RaceScheduler(s, store, src)
    run(sched.tick(original - timedelta(minutes=2.9)))
    assert race.status == "scheduled"
    assert race.post_time == original + timedelta(minutes=4)


def test_scheduler_retries_when_tote_down_then_misses(tmp_path):
    s = settings(tmp_path)
    store = RaceStore(tmp_path)
    race = sample_race(post_in_min=10)
    store.save(race)
    sched = RaceScheduler(s, store, FakeSource(fail=True))
    run(sched.tick(race.post_time - timedelta(minutes=2.9)))
    assert race.status == "scheduled"
    run(sched.tick(race.post_time + timedelta(minutes=6)))
    assert race.status == "missed"


# --- http source --------------------------------------------------------

def test_http_source_parses_mapping(tmp_path):
    s = settings(tmp_path, tote_source="http", http_url="https://x/{track}/{date}/{race}",
                 http_runners_path="data.entries", http_program_field="pp", http_odds_field="live.win",
                 http_scratch_field="scr", http_post_time_path="data.post", http_exacta_path="data.ex")
    src = HttpJsonToteSource(s)
    payload = {"data": {
        "post": "2026-10-23T17:47:00Z",
        "ex": {"1/2": 30.0},
        "entries": [
            {"pp": 1, "live": {"win": "5-2"}, "scr": False},
            {"pp": 2, "live": {"win": 3}, "scr": False},
            {"pp": 3, "live": {"win": "9-5"}, "scr": True},
        ]}}
    snap = src.parse(payload)
    assert snap.win_odds == {"1": 3.5, "2": 4.0}
    assert snap.scratched == ["3"]
    assert snap.exacta_probables == {"1-2": 15.0}
    assert snap.post_time.hour == 17
    race = sample_race()
    assert src.url_for(race).startswith("https://x/AQU/")
    run(src.aclose())


# --- web ----------------------------------------------------------------

def test_web_flow(tmp_path):
    s = settings(tmp_path, password="pw", tote_source="mock")
    app = create_app(s, start_scheduler=False)
    with TestClient(app) as c:
        assert c.get("/api/races").status_code == 401
        c.auth = ("admin", "pw")
        with open(EXAMPLES / "race_card.csv", "rb") as fh:
            r = c.post("/api/races/upload", files={"file": ("card.csv", fh, "text/csv")},
                       data={"track": "AQU", "race_number": "7", "post_time": "4:30 PM", "date": "2026-10-23"})
        assert r.status_code == 200, r.text
        rid = r.json()[0]["id"]
        assert [x["id"] for x in c.get("/api/races").json()] == [rid]

        r = c.post(f"/api/races/{rid}/tote", json={"win_odds": TOTE, "run": True})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] in ("preview", "published")  # preview unless inside the fetch window
        assert body["tickets"]["tote_source"] == "manual"

        r = c.post(f"/api/races/{rid}/run")
        assert r.status_code == 200 and r.json()["tickets"]["tote_source"] == "mock"

        assert c.post(f"/api/races/{rid}/scratch/7").json()["runners"][6]["scratched"] is True
        assert c.get("/").status_code == 200
        assert c.delete(f"/api/races/{rid}").status_code == 200


def test_discovery_page(tmp_path):
    from totebot.tools.amwager_discover import Scrubber

    scrub = Scrubber("me@x.com", "hunter22")
    assert scrub('{"accessToken":"abc","u":"me@x.com","p":"hunter22"}') == '{"accessToken":"***","u":"***","p":"***"}'
    d = tmp_path / "discovery"
    d.mkdir()
    (d / "summary.txt").write_text("runners <odds>")
    (d / "1-home.png").write_bytes(b"\x89PNG")
    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    with TestClient(app) as c:
        assert c.get("/discovery").status_code == 401
        c.auth = ("admin", "pw")
        page = c.get("/discovery").text
        assert "runners &lt;odds&gt;" in page and "/discovery/files/1-home.png" in page
        assert c.get("/discovery/files/1-home.png").status_code == 200
        assert c.get("/discovery/files/..%2Fraces").status_code == 404


BRISNET_PAGE = """Ultimate PP's w/ QuickPlay Comments Belmont Park ™OC  80000n2x 6 Furlongs (t) 3&up, F & M Friday,  October 23, 2026 Race {race}
Post Time: ( {post})/ 1:16/12:16/11:16
1 Xmas in Cairo (E/P 4)Own: Dunham Bernard G
20/1 Hot Pink, Two Black Hoops, Hot Pink Cap
Prime Power: 120.3 (3rd) Life: 12 3 - 2 - 3 $111,850 84
2 Good Vintage (NA 0)Own: Egl-one Racing
10/1 Purple, Gold Circle
Life: 0 0 - 0 - 0 $0
3 Queen Martina (S 0)Own: Kincaid Brad E
2/1 White, Blue Hoops
Prime Power: 142.0 (1st) Life: 7 2 - 4 - 1 $97,450 85
"""


def test_brisnet_parse_pages():
    from totebot.brisnet import parse_pages, to_csv

    races = parse_pages([BRISNET_PAGE.format(race=3, post="2:16"), BRISNET_PAGE.format(race=4, post="11:49")])
    assert [r["race_number"] for r in races] == [3, 4]
    r3 = races[0]
    assert r3["track"] == "BEL" and r3["post_time"] == "2026-10-23T14:16:00-04:00"
    assert races[1]["post_time"] == "2026-10-23T23:49:00-04:00"  # never earlier than the race before it
    assert [(x["program_num"], x["style"], x["qsp"], x["ml_odds"], x["rating"]) for x in r3["runners"]] == [
        ("1", "E/P", 4, "20-1", 120.3), ("2", "P", 0, "10-1", ""), ("3", "S", 0, "2-1", 142.0)]
    loaded = races_from_csv(to_csv(races), TZ)
    assert loaded[0].runners[1].rating is None and loaded[0].runners[2].rating == 142.0


def test_rating_imputes_minority_missing(tmp_path):
    from totebot.brisnet import parse_pages

    race = races_from_json(parse_pages([BRISNET_PAGE.format(race=3, post="2:16")]), TZ)[0]
    snap = ToteSnapshot(taken_at=utcnow(), win_odds={"1": 15.0, "2": 8.0, "3": 3.0})
    out = run_handicap(race, snap, settings(tmp_path))
    assert out["fundamental_source"] == "rating (median 131.15 used for #2)"


def tvg_payload(mtp=83, status="O", post="2026-10-23T18:16:00Z"):
    def bi(n, num, den=None, scratched=False, runner_ids=None):
        return {"biNumber": n, "currentOdds": {"numerator": num, "denominator": den},
                "morningLineOdds": {"numerator": num, "denominator": den},
                "runners": [{"runnerId": r, "scratched": scratched, "horseName": f"H{r}"} for r in (runner_ids or [str(n)])]}
    return {"data": {"race": {
        "number": "3", "mtp": mtp, "postTime": post, "status": {"code": status},
        "bettingInterests": [bi(1, 20), bi(2, 12), bi(3, 8, scratched=True), bi(4, 2), bi(6, 9, 2), bi(7, 5, runner_ids=["7", "7A"])],
        "probables": [{"minWagerAmount": 2, "wagerType": {"id": 110, "name": "Exacta"},
                       "betCombos": [{"runner1": "4", "runner2": "6", "payout": 18.4}]},
                      {"minWagerAmount": 1, "wagerType": {"id": 160, "name": "Daily Double"},
                       "betCombos": [{"runner1": "4", "runner2": "1", "payout": 9.0}]}],
    }}}


def test_tvg_parse():
    from totebot.sources.tvg import parse_race

    snap = parse_race(tvg_payload(mtp=0))
    assert snap.win_odds == {"1": 21.0, "2": 13.0, "4": 3.0, "6": 5.5, "7": 6.0, "7A": 6.0}
    assert snap.scratched == ["3"]
    assert snap.exacta_probables == {"4-6": 9.2}
    assert snap.post_time.isoformat() == "2026-10-23T18:16:00+00:00"


def test_tvg_follows_post_drag():
    from totebot.sources.tvg import parse_race

    past_post = (utcnow() - timedelta(minutes=1)).isoformat()
    snap = parse_race(tvg_payload(mtp=4, post=past_post))
    assert 3.5 < (snap.post_time - utcnow()).total_seconds() / 60 <= 4.01
    off = parse_race(tvg_payload(mtp=4, status="SK", post=past_post))
    assert off.post_time < utcnow()


def test_tvg_fetch_uses_track_and_race(tmp_path):
    import httpx
    from totebot.sources.tvg import TvgToteSource

    seen = {}

    def handler(request):
        body = json.loads(request.content)
        seen.update(body["variables"])
        return httpx.Response(200, json=tvg_payload())

    src = TvgToteSource()
    src.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    race = sample_race()
    race.track, race.source_ref = "bel", None
    snap = run(src.fetch(race))
    assert seen["trackAbbr"] == "BEL" and seen["raceNumber"] == "5"
    assert snap.source == "tvg" and "4" in snap.win_odds
    run(src.aclose())


TVG_TRACKS = {"BEL": "Belmont", "KEE": "Keeneland", "GP": "Gulfstream Park", "LRL": "Laurel Park",
              "WVD": "GB - Wolverhampton", "DED": "Delta Downs", "CHS": "Harrahs Philadelphia"}


@pytest.mark.parametrize("names,code", [
    (["BEL"], "BEL"), (["Belmont Park"], "BEL"), (["Keeneland"], "KEE"), (["Laurel Park"], "LRL"),
    (["Wolverhampton"], "WVD"), (["Delta Downs"], "DED"), (["Harrah's Philadelphia"], "CHS"),
    (["Santa Anita"], None),
])
def test_tvg_match_track(names, code):
    from totebot.sources.tvg import match_track

    assert match_track(names, TVG_TRACKS) == code


def test_tvg_resolves_unlisted_track_by_name():
    import httpx
    from totebot.sources.tvg import TvgToteSource

    asked = []

    def handler(request):
        body = json.loads(request.content)
        if body["operationName"] == "getTracks":
            return httpx.Response(200, json={"data": {"tracks": [{"code": c, "name": n} for c, n in TVG_TRACKS.items()]}})
        asked.append(body["variables"]["trackAbbr"])
        return httpx.Response(200, json=tvg_payload())

    src = TvgToteSource()
    src.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    race = sample_race()
    race.track, race.source_ref = "Delta Downs", None
    run(src.fetch(race))
    race.track = "Nowhere Downs"
    with pytest.raises(ToteUnavailable):
        run(src.fetch(race))
    assert asked == ["DED"]
    run(src.aclose())


def test_brisnet_multi_track_pdf():
    from totebot.brisnet import parse_pages

    kee = BRISNET_PAGE.replace("Belmont Park", "Keeneland")
    races = parse_pages([BRISNET_PAGE.format(race=3, post="2:16"), kee.format(race=3, post="1:35"),
                         BRISNET_PAGE.format(race=4, post="2:49")])
    assert [(r["track"], r["race_number"], r["post_time"][11:16]) for r in races] == [
        ("KEE", 3, "13:35"), ("BEL", 3, "14:16"), ("BEL", 4, "14:49")]


@pytest.mark.parametrize("rest,name", [
    ("Belmont Park ™OC  80000n2x 6 Furlongs (t)", "Belmont Park"),
    ("Keeneland MC 40000 6 Furlongs", "Keeneland"),
    ("Belmont at the Big A Alw 100000n1x", "Belmont at the Big A"),
    ("Delta Downs MSW 25000", "Delta Downs"),
])
def test_brisnet_track_name(rest, name):
    from totebot.brisnet import _track_name

    assert _track_name(rest) == name


def test_run_now_early_is_preview_then_auto_pull(tmp_path):
    s = settings(tmp_path)
    store = RaceStore(tmp_path)
    race = sample_race(post_in_min=30)
    store.save(race)
    src = FakeSource()
    sched = RaceScheduler(s, store, src)
    run(sched.run_now(race))
    assert race.status == "preview" and race.tickets
    run(sched.tick(race.post_time - timedelta(minutes=2.9)))
    assert race.status == "ready" and src.calls == 2
    run(sched.tick(race.post_time - timedelta(minutes=1.9)))
    assert race.status == "published"
    late = sample_race(post_in_min=2.5)
    late.id = "LATE"
    store.save(late)
    run(sched.run_now(late))
    assert late.status == "published"


def test_rejected_pdf_report(tmp_path, monkeypatch):
    from totebot import brisnet

    monkeypatch.setattr(brisnet, "pdf_pages", lambda data: ["Cover page", "EQUINELINE Race 1 something"])
    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    with TestClient(app) as c:
        c.auth = ("admin", "pw")
        r = c.post("/api/races/upload", files={"file": ("x.pdf", b"%PDF-1.4 fake", "application/pdf")})
        assert r.status_code == 422 and "/debug/upload" in r.json()["detail"]
        page = c.get("/debug/upload").text
        assert "2 pages; 0 look like Brisnet" in page and "EQUINELINE Race 1" in page
        assert (tmp_path / "uploads" / "last-rejected.pdf").exists()
