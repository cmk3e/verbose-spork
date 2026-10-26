import asyncio
import math
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
        rid = r.json()["races"][0]["id"]
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
        if body["operationName"] == "getRaceProgram":
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


def test_brisnet_partial_pdf_reports_skipped():
    from totebot.brisnet import load_pages

    cover = "Free Past Performances\nBelmont Park\n Race 2\n 3\nRace 3\n 4\nDelta Downs\n Race 7\n 9\n"
    equineline = "Purchase the Full Card Program Help\n10/23/26 APPROX. POST: 1:43PM Exacta ($1)"
    delta_no_post = BRISNET_PAGE.replace("Belmont Park", "Delta Downs").replace("Post Time:", "Post at").format(race=7, post="9:52")
    races, skipped = load_pages([cover, equineline, BRISNET_PAGE.format(race=3, post="2:16"), delta_no_post])
    assert [(r["track"], r["race_number"]) for r in races] == [("BEL", 3)]
    assert skipped == ["Delta Downs R7: no post time found",
                       "Belmont Park R2: not a Brisnet Ultimate PP (probably Equineline)"]


def test_post_time_10_or_11_oclock_picks_the_one_still_ahead():
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    from totebot.brisnet import _post_times

    day = datetime(2026, 10, 23, tzinfo=ZoneInfo("America/New_York"))
    morning = datetime(2026, 10, 23, 13, 0, tzinfo=timezone.utc)   # 9 AM ET
    evening = datetime(2026, 10, 23, 18, 0, tzinfo=timezone.utc)   # 2 PM ET
    assert _post_times({7: (10, 15)}, day, morning)[7].hour == 10
    assert _post_times({7: (10, 15)}, day, evening)[7].hour == 22
    assert _post_times({1: (11, 30), 2: (12, 1), 9: (10, 5)}, day, morning)[9].hour == 22


def test_upload_skips_existing_races(tmp_path, monkeypatch):
    from totebot import brisnet

    monkeypatch.setattr(brisnet, "pdf_pages", lambda data: [BRISNET_PAGE.format(race=3, post="11:16"), BRISNET_PAGE.format(race=4, post="11:49")])
    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    with TestClient(app) as c:
        c.auth = ("admin", "pw")
        first = c.post("/api/races/upload", files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")}).json()
        assert len(first["races"]) == 2 and first["skipped"] == []
        again = c.post("/api/races/upload", files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")}).json()
        assert again["races"] == [] and len(again["skipped"]) == 2


# --- results & performance ---------------------------------------------

TICKETS = {
    "win_bets": [{"program_num": "4", "stake": 10.0, "odds": 4.0}, {"program_num": "6", "stake": 4.0, "odds": 8.0},
                 {"program_num": "3", "stake": 2.0, "odds": 9.0}],
    "exotics": {
        "exacta": {"base": 1.0, "combos": [{"combo": ["4", "6"], "est_payout_per_$1": 20.0},
                                           {"combo": ["6", "4"], "est_payout_per_$1": 25.0}]},
        "superfecta": {"base": 0.1, "combos": [{"combo": ["4", "6", "8", "1"], "est_payout_per_$1": 500.0}]},
    },
    "runners": [
        {"program_num": "4", "name": "A", "odds": 4.0, "p_fund": 0.4, "pace_mod": 0.0, "p_public": 0.3, "p_true": 0.35, "ev": 0.2},
        {"program_num": "6", "name": "B", "odds": 8.0, "p_fund": 0.3, "pace_mod": 0.1, "p_public": 0.15, "p_true": 0.2, "ev": 0.1},
        {"program_num": "8", "name": "C", "odds": 3.0, "p_fund": 0.2, "pace_mod": 0.0, "p_public": 0.35, "p_true": 0.3, "ev": -0.1},
        {"program_num": "1", "name": "D", "odds": 6.0, "p_fund": 0.1, "pace_mod": 0.0, "p_public": 0.2, "p_true": 0.15, "ev": -0.1},
    ],
}
RESULT = {"finish": ["4", "6", "8", "1"], "final_odds": {"4": 3.5, "6": 9.0, "8": 3.0, "1": 6.0},
          "scratched": ["3"], "payoffs": {"win": {"4": 3.4}, "exacta": {"4-6": 18.5}}, "source": "test"}


def test_settle():
    from totebot.performance import settle

    s = settle(TICKETS, RESULT)
    bt = s["by_type"]
    assert bt["win"] == {"bets": 3, "hits": 1, "cost": 16.0, "return": 36.0, "estimated": False, "profit": 20.0}
    assert bt["exacta"]["return"] == 18.5 and bt["exacta"]["hits"] == 1
    assert bt["superfecta"]["return"] == 50.0 and bt["superfecta"]["estimated"] is True
    win4 = next(b for b in s["bets"] if b["type"] == "win" and b["selection"] == "4")
    assert win4["clv"] == pytest.approx(4.0 / 3.5 - 1)
    assert s["total"]["profit"] == pytest.approx(36 + 18.5 + 50 - 16 - 2 - 0.1)


def test_tvg_parse_result():
    from totebot.sources.tvg import parse_result

    payload = {"data": {"race": {"status": {"code": "RO"},
        "bettingInterests": [{"biNumber": 4, "currentOdds": {"numerator": 5, "denominator": 2}, "runners": [{"runnerId": "4", "scratched": False}]},
                             {"biNumber": 3, "currentOdds": None, "runners": [{"runnerId": "3", "scratched": True}]}],
        "results": {
            "runners": [{"runnerNumber": "6", "finishPosition": 2, "betAmount": 2, "winPayoff": 0},
                        {"runnerNumber": "4", "finishPosition": 1, "betAmount": 2, "winPayoff": 7.0}],
            "payoffs": [{"wagerAmount": 1, "wagerType": {"name": "Exacta"}, "selections": [{"selection": "4/6", "payoutAmount": 12.5}]},
                        {"wagerAmount": 0.1, "wagerType": {"name": "Superfecta"}, "selections": [{"selection": "4-6-8-1", "payoutAmount": 45.0}]}],
        }}}}
    r = parse_result(payload)
    assert r["finish"] == ["4", "6"] and r["scratched"] == ["3"] and r["final_odds"] == {"4": 3.5}
    assert r["payoffs"] == {"win": {"4": 3.5}, "exacta": {"4-6": 12.5}, "superfecta": {"4-6-8-1": 450.0}}
    payload["data"]["race"]["status"]["code"] = "SK"
    assert parse_result(payload) is None


def test_scheduler_collects_result(tmp_path):
    class ResultSource(FakeSource):
        def __init__(self):
            super().__init__()
            self.result_calls = 0

        async def fetch_result(self, race):
            self.result_calls += 1
            return RESULT if self.result_calls >= 2 else None

    store = RaceStore(tmp_path)
    race = sample_race(post_in_min=10)
    race.status, race.tickets = "published", TICKETS
    store.save(race)
    src = ResultSource()
    sched = RaceScheduler(settings(tmp_path), store, src)
    run(sched.tick(race.post_time + timedelta(minutes=1)))
    assert src.result_calls == 0
    run(sched.tick(race.post_time + timedelta(minutes=4)))
    assert race.result_status == "pending" and src.result_calls == 1
    run(sched.tick(race.post_time + timedelta(minutes=5)))      # too soon to re-check
    assert src.result_calls == 1
    run(sched.tick(race.post_time + timedelta(minutes=7)))
    assert race.result_status == "official" and race.settlement["total"]["profit"] > 0
    run(sched.tick(race.post_time + timedelta(minutes=10)))
    assert src.result_calls == 2
    assert RaceStore(tmp_path).get(race.id).result_status == "official"


def _simulated_races(n, alpha, beta, seed=7):
    import math as m
    import random
    from totebot.models import Race as R
    from totebot.performance import settle

    rng = random.Random(seed)
    races = []
    for i in range(n):
        k = rng.randint(5, 10)
        fund = [rng.random() ** 2 + 0.02 for _ in range(k)]
        pub = [f * m.exp(rng.gauss(0, 0.8)) for f in fund]
        fund = [x / sum(fund) for x in fund]
        pub = [x / sum(pub) for x in pub]
        true = [f ** alpha * p ** beta for f, p in zip(fund, pub)]
        true = [x / sum(true) for x in true]
        winner = rng.choices(range(k), weights=true)[0]
        rows = [{"program_num": str(j + 1), "name": "", "odds": 0.83 / pub[j], "p_fund": fund[j], "pace_mod": 0.0,
                 "p_public": pub[j], "p_true": true[j], "ev": true[j] * 0.83 / pub[j] - 1} for j in range(k)]
        tickets = {"win_bets": [], "exotics": {}, "runners": rows}
        finish = [str(winner + 1)] + [str(j + 1) for j in range(k) if j != winner]
        result = {"finish": finish, "final_odds": {r["program_num"]: r["odds"] for r in rows}, "payoffs": {}, "scratched": []}
        race = R(id=f"SIM-{i}", track="SIM", race_number=1, post_time=utcnow(), runners=[], status="published",
                 tickets=tickets, result=result, settlement=settle(tickets, result), result_status="official")
        races.append(race)
    return races


def test_summarize_and_blend_fit(tmp_path):
    from totebot.handicap import load_engine
    from totebot.performance import summarize

    races = _simulated_races(600, alpha=0.7, beta=0.5)
    s = summarize(races, TZ, load_engine("horseplay_betting_engine_v3"))
    assert s["races"] == 600
    assert s["log_loss"]["p_true"] < s["log_loss"]["p_public"]     # the generating model beats the public
    fit = s["blend_fit"]
    assert fit["races"] == 600
    assert abs(fit["alpha"] - 0.7) < 0.25 and abs(fit["beta"] - 0.5) < 0.25
    assert sum(b["runners"] for b in s["calibration"]["model"]) == sum(len(r.tickets["runners"]) for r in races)
    assert summarize(races[:10], TZ, load_engine("horseplay_betting_engine_v3"))["blend_fit"] is None


def test_performance_pages_and_manual_result(tmp_path):
    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    store = app.state.store
    race = sample_race(post_in_min=-20)
    race.status, race.tickets = "published", TICKETS
    store.save(race)
    with TestClient(app) as c:
        c.auth = ("admin", "pw")
        assert "No settled races yet" in c.get("/performance").text
        r = c.post(f"/api/races/{race.id}/result", json={"finish": ["4", "6", "8", "1"], "payoffs": {"win": {"4": 3.4}},
                                                          "final_odds": {"4": "5-2"}, "scratched": ["3"]})
        assert r.status_code == 200 and r.json()["result_status"] == "official"
        listed = c.get("/api/races").json()[0]
        assert listed["finish"] == ["4", "6", "8", "1"] and listed["profit"] is not None
        page = c.get("/performance").text
        assert "Return by bet type" in page and "Small sample" in page
        csv_text = c.get("/api/performance/history.csv").text
        assert csv_text.startswith("date,race_id,track") and csv_text.count("\n") == 5
        assert c.get("/api/performance").json()["races"] == 1


# --- extra data: Brisnet figures, TVG extras, odds history ------------------

BRISNET_BLOCK = """ Test Owner
5/2 Red, White Cap
DOE JOHN  (100  15-10-12  15%)
B. f. 4
Trnr: Roe Richard (40  8-6-5  20%)
Prime Power: 130.0 (1st) Life: 10 3 - 2 - 1 $100,000 92
2026 6 2 - 1 - 1 $70,000 92
Fst (110) 6 2 - 1 - 0 $60,000 90
Dis (105) 2 1 - 0 - 0 $20,000 88
Trf (99) 4 1 - 1 - 1 $40,000 92
L 124
ñ Best speed in field × Poor trainer win%
    DATE  TRK               DIST RR     RACETYPE CR   E1    E2/     LP     1c    2c     SPD  PP  ST 1C
01Oct26Bel« Ì 6f ft :22 :45 1:09 ¦ ¨¨§ Alw 80000¨¨©90 88/ 80 +2 0 88 1 4 3 4 2 1 SmithJ L 2.00 X Y Z ok 6
10Sep26Sar¨ à 5f fm :22 :44 :56 ¦ ¨¨« OC100k¨¨ª 93/ 78 80 4 2 4 4 3 7 SmithJ L 3.20 X Y Z weakened 8
15Aug26Sar¬ Ì 6f ft :22 :45 1:10 ¦ ¨¨§ Alw 80000 ¨¨§ 84 82/ 78 0 0 85 2 3 3 3 3 2 SmithJ L 4.00 X Y Z ins 7
16Aug24 Newbury(GB) à *5f gd 1:00 ¨¨¬ Hcp 57132 ¨¨® 3 O'neillK 40.00 A B C 13
×10Oct Bel  4f  ft   :48  B1/9      03Oct Bel  4f  ft   :49  B3/10
"""


def test_brisnet_horse_stats():
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from totebot.brisnet import horse_stats

    s = horse_stats(BRISNET_BLOCK, datetime(2026, 10, 23, tzinfo=ZoneInfo(TZ)), "Fst")
    assert s["days_off"] == 22
    assert (s["last_speed"], s["best_speed_3"], s["races_with_figs"]) == (88, 88, 3)
    assert s["avg_e1"] == 87.0                       # E1 only from full lines: (90 + 84) / 2
    assert s["avg_e2"] == pytest.approx(87.67, abs=0.01) and s["avg_lp"] == pytest.approx(78.67, abs=0.01)
    assert (s["jockey_win_pct"], s["trainer_win_pct"]) == (15, 20)
    assert (s["life_starts"], s["life_wins"], s["life_best_speed"]) == (10, 3, 92)
    assert (s["surface_starts"], s["surface_wins"], s["surface_best_speed"], s["surface_pedigree"]) == (6, 2, 90, 110)
    assert (s["dist_starts"], s["dist_best_speed"]) == (2, 88)
    assert (s["lasix"], s["weight"]) == (1, 124)
    assert (s["qp_positive"], s["qp_negative"]) == (1, 1)    # the workout bullet doesn't count


def test_brisnet_pages_feed_pace_figures():
    from totebot.brisnet import parse_pages

    page = BRISNET_PAGE.format(race=3, post="2:16").replace(
        "Prime Power: 120.3 (3rd)", "PARS: 94  97/ 86   87\nPrime Power: 120.3 (3rd)").replace(
        "Prime Power: 142.0 (1st) Life: 7 2 - 4 - 1 $97,450 85\n",
        "Prime Power: 142.0 (1st) Life: 7 2 - 4 - 1 $97,450 85\n" + BRISNET_BLOCK[BRISNET_BLOCK.index("    DATE"):])
    race = parse_pages([page])[0]
    martina = race["runners"][2]
    assert (martina["call1_fps"], martina["call2_fps"]) == (87.0, pytest.approx(87.67, abs=0.01))
    assert martina["stats"]["prime_power"] == 142.0 and martina["stats"]["turf"] == 1
    assert martina["stats"]["par_speed"] == 87 and martina["stats"]["speed_vs_par"] == 1
    assert "call1_fps" not in race["runners"][1]          # first-time starter: no figures


def test_tvg_parse_extras():
    from totebot.sources.tvg import parse_extras

    data = {"data": {"race": {
        "racePools": [{"wagerType": {"name": "Win"}, "amount": 15234.0}, {"wagerType": {"name": "Exacta"}, "amount": 9000}],
        "lateChanges": {"raceChanges": [{"description": "Surface Change", "oldValue": "Turf", "newValue": "Dirt"}],
                        "horseChanges": [{"runnerId": "2", "changes": [{"description": "Jockey", "oldValue": "A", "newValue": "B"}]}]},
        "bettingInterests": [{"runners": [{"runnerId": "1", "handicapping": {
            "speedAndClass": {"avgSpeed": 85, "highSpeed": 90}, "averagePace": {"early": 92, "middle": 90, "finish": 80},
            "snapshot": {"daysOff": 21, "powerRating": None}}}]}],
    }}}
    x = parse_extras(data)
    assert x["pools"] == {"win": 15234.0, "exacta": 9000.0}
    assert x["surface_change"] == "Surface Change: Turf -> Dirt"
    assert "#2 Jockey: A -> B" in x["late_changes"]
    assert x["runners"]["1"] == {"tvg_avg_speed": 85.0, "tvg_high_speed": 90.0, "tvg_pace_early": 92.0,
                                 "tvg_pace_middle": 90.0, "tvg_pace_finish": 80.0, "tvg_days_off": 21.0}
    assert parse_extras({}) == {"pools": {}, "late_changes": [], "surface_change": None, "runners": {}}


def test_pace_inputs_prefers_card_then_tvg():
    from totebot.handicap import pace_inputs
    from totebot.models import Runner

    rs = [Runner("1", call1_fps=90, call2_fps=88, final_fps=80), Runner("2", call1_fps=80, call2_fps=82, final_fps=90),
          Runner("3")]
    snap = tote()
    figs, label = pace_inputs(rs, snap)
    assert label == "card (median for 1 without figures)" and figs[2] == {"call1_fps": 85.0, "call2_fps": 85.0, "final_fps": 85.0}
    bare = [Runner("1"), Runner("2"), Runner("3")]
    snap.extras = {"runners": {n: {"tvg_pace_early": 90, "tvg_pace_middle": 85, "tvg_pace_finish": 80} for n in ("1", "2", "3")}}
    figs, label = pace_inputs(bare, snap)
    assert label == "tvg" and figs[0]["final_fps"] == 80
    assert pace_inputs(bare, tote())[0] is None


def test_odds_features_and_history(tmp_path):
    from totebot.handicap import odds_features

    store = RaceStore(tmp_path)
    race = sample_race(post_in_min=10)
    store.save(race)
    sched = RaceScheduler(settings(tmp_path), store, FakeSource(snap=tote()))
    run(sched.tick(race.post_time - timedelta(minutes=13)))       # pre-poll
    assert len(race.odds_history) == 1 and race.odds_history[0]["mtp"] == 13.0
    snap = tote()
    snap.taken_at = race.post_time - timedelta(minutes=3)
    snap.win_odds["4"] = 2.5                                      # #4 bet down from 9-2 (5.5) at the pre-poll
    f = odds_features(race, snap, "4")
    assert f["steam_10m"] == pytest.approx(math.log(5.5 / 2.5), abs=1e-4) and f["steam_window_min"] == 10.0
    assert f["odds_ml"] == 5.0 and f["steam_ml"] == pytest.approx(math.log(5.0 / 2.5), abs=1e-4)   # ML 4-1


def test_handicap_pool_cap_surface_change_and_stats(tmp_path):
    race = sample_race()
    snap = tote()
    snap.extras = {"pools": {"win": 300.0}, "surface_change": "Surface: Turf -> Dirt", "late_changes": ["Surface: Turf -> Dirt"],
                   "runners": {"1": {"tvg_avg_speed": 80.0}}}
    s = settings(tmp_path, bankroll=100000)
    out = run_handicap(race, snap, s)
    assert out["win_bets"] and all(b["stake"] <= 6 for b in out["win_bets"])   # 2% of a $300 pool
    assert out["ticket_text"].splitlines()[1] == "!! SURFACE CHANGE: Surface: Turf -> Dirt"
    assert out["notes"][0].startswith("SURFACE CHANGE") and any(n.startswith("Win pool $300") for n in out["notes"])
    one = next(r for r in out["runners"] if r["program_num"] == "1")
    assert one["stats"]["tvg_avg_speed"] == 80.0 and "odds_ml" in one["stats"] and one["pct_early"] is not None
    assert out["pace"]["figures"] == "none"                     # only 3 of 7 on this card have figures
    assert "No pace figures: %-early used engine defaults" in out["notes"]
    skip = run_handicap(race, snap, settings(tmp_path, surface_change_action="skip"))
    assert skip["win_bets"] == [] and skip["exotics"] == {}


def test_history_csv_includes_stats(tmp_path):
    from totebot.performance import settle

    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    race = sample_race(post_in_min=-20)
    race.status = "published"
    race.tickets = run_handicap(race, tote(extras={"pools": {"win": 5000.0}}), settings(tmp_path))
    race.result = {"finish": ["4", "2", "6", "1"], "final_odds": {}, "payoffs": {}, "scratched": []}
    race.settlement = settle(race.tickets, race.result)
    race.result_status = "official"
    app.state.store.save(race)
    with TestClient(app) as c:
        c.auth = ("admin", "pw")
        header = c.get("/api/performance/history.csv").text.splitlines()[0].split(",")
        for col in ("pct_early", "win_pool", "odds_ml", "steam_ml", "won"):
            assert col in header


def test_replace_keeps_published_races(tmp_path, monkeypatch):
    from totebot import brisnet

    monkeypatch.setattr(brisnet, "pdf_pages", lambda data: [BRISNET_PAGE.format(race=3, post="11:16"), BRISNET_PAGE.format(race=4, post="11:49")])
    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    with TestClient(app) as c:
        c.auth = ("admin", "pw")
        first = c.post("/api/races/upload", files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")}).json()
        ran = app.state.store.get(first["races"][0]["id"])
        ran.status, ran.tickets = "published", TICKETS
        app.state.store.save(ran)
        again = c.post("/api/races/upload", files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")}, data={"replace": "true"}).json()
        assert [r["race_number"] for r in again["races"]] == [4]
        assert again["skipped"] == ["BEL R3: kept, tickets already published"]
        assert app.state.store.get(ran.id).tickets == TICKETS


def test_horse_missing_from_card_is_included_and_flagged(tmp_path):
    race = sample_race()
    race.runners = [r for r in race.runners if r.program_num != "5"]       # the PP reader "missed" #5
    snap = tote()
    snap.extras = {"names": {"5": "Lucky Lariat"}}
    out = run_handicap(race, snap, settings(tmp_path))
    assert "5" in [r["program_num"] for r in out["runners"]]
    assert out["fundamental_source"].startswith("p_fund (median")
    assert any(n.startswith("NOT ON YOUR CARD: #5 Lucky Lariat") for n in out["notes"])
    five = next(r for r in out["runners"] if r["program_num"] == "5")
    assert five["stats"]["not_on_card"] == 1 and five["name"] == "Lucky Lariat"


def test_upload_flags_program_number_gaps():
    from totebot.brisnet import load_pages

    page = BRISNET_PAGE.format(race=3, post="2:16").replace("2 Good Vintage (NA 0)Own:", "4 Good Vintage (NA 0)Own:")
    races, skipped = load_pages([page])
    assert skipped == ["Belmont Park R3: loaded, but no PP found for #2 (reader may have missed it; it will still be "
                       "included from the tote)"]


# --- PickPony PDFs ----------------------------------------------------------

PICKPONY_P1 = """PickPony PPs Finger Lakes Racetrack Race 1 6 Furlongs Dirt Clm 7500b Claiming Purse: $16200 Claim price: $7500 (68.20) October 26, 2026 (Mon) (12:55)/11:55/10:55/9:55
1
EXACTA * TRIFECTA * SUPERFECTA (10 CENT MINIMUM)
Pars: 91 91/79 Spd: 77
Post times: (12:55)/11:55/10:55/9:55
1
5/1
FIRST HORSE
108.25
Style: E/P3 Weight: 124
Dark Green; White Star
Trainer: Smith A
Meds: Lasix
Avg Speed: 68 (4/6)
Speed Lst 3: 66 (5/6)
Best Spd Dirt: 89 (4/6)
Prime Power: 108 (4/6)
E1 Pace Avg: 87 (3/6)
E2 Pace Avg: 86 (3/6)
LP Pace Avg: 67 (5/6)
PPP Rating [A]: 36
E1 Pace Lst 3: 85 (4/6)
E2 Pace Lst 3: 85 (3/6)
LP Pace Lst 3: 66 (5/6)
Days Snce Lst: 72 (2/6)
Trnr/Jcky ROI: 0.12 (2/2)
Rec S W P S % Earn Bst
Life: 21 3 5 1 43% $165,836 89
2026: 6 1 2 1 67% $50,460 81
Cond S W P S % Earn Bst Ped
Fast: 10 2 4 0 60% $104,818 89 100
Dist: 4 1 0 0 25% $37,855 89 101
Turf: 6 1 1 0 33% $45,513 79 104
Jockey S W P S % ROI
2026: 101 17 14 18 49% -0.44
Sprints: 68 12 7 9 41%
Trainer S W P S % ROI
2026: 296 55 46 40 48% -0.27
Trainer Alert Starts Win% ITM ROI
46-90daysAway: 177 17% 47% -0.67
Claiming: 585 19% 51% -0.35
Date Trk Dist S Rst Race Type T1 T2 T3 T4 E1 E2 LP 1c 2c Spd Pos St C1 C2 Str Fin Jockey Equ Odds Finishers Comments
26Aug15 SAR 1m D 3+mf fsAlw105000n1x :24 :48 1:12 1:38 83 81 47 -2 -5 51/84 5 4 4 7 7 7 CarmouK Lb 6.77 X Y Z faltered
26Jul20 FL 6f D 3+mf fsAlw24500n1x :22 :46 :59 1:12 84 83 73 5 2 67/80 6 7 6 7 7 6 WorrieA Lb 7.59 X Y Z outrun
26Mar21 AQU 7f D 4+mf fsAlw74690n1x :23 :47 1:12 1:25 88 90 79 -5 -6 81/85 3 2 1 1 2 2 CivacisS Lb 1.88 X Y Z kept on
26Oct05 FL 4f ft :49 3/17 Breezing
2
2/1
SECOND HORSE
116.04
Style: E6 Weight: 124
Avg Speed: 74 (2/6)
E1 Pace Lst 3: 93 (1/6)
E2 Pace Lst 3: 92 (1/6)
LP Pace Lst 3: 77 (2/6)
"""
PICKPONY_P2 = """3
4/1
THIRD HORSE
106.78
Style: NA Weight: 124
Avg Speed: 71 (3/6)
Life: 0 0 0 0 0% $0
"""


def test_pickpony_parse():
    from totebot.pickpony import detect, load_pages

    pages = ["cover", PICKPONY_P1, PICKPONY_P2]
    assert detect(pages)
    races, skipped = load_pages(pages)
    assert skipped == []
    race = races[0]
    assert (race["track"], race["track_name"], race["race_number"], race["surface"]) == ("FL", "Finger Lakes Racetrack", 1, "Fst")
    assert race["post_time"] == "2026-10-26T12:55:00-04:00"
    one, two, three = race["runners"]
    assert (one["program_num"], one["name"], one["style"], one["qsp"], one["ml_odds"], one["rating"]) == \
        ("1", "First Horse", "E/P", 3, "5-1", 108.25)
    assert (one["call1_fps"], one["call2_fps"], one["final_fps"]) == (85.0, 85.0, 66.0)
    s = one["stats"]
    assert (s["days_off"], s["avg_speed_3"], s["avg_speed_3_rank"], s["ppp_rating"]) == (72, 66, 5, 36)
    assert (s["life_starts"], s["life_wins"], s["life_best_speed"]) == (21, 3, 89)
    assert (s["surface_starts"], s["surface_wins"], s["surface_best_speed"], s["surface_pedigree"]) == (10, 2, 89, 100)
    assert (s["dist_starts"], s["dist_pedigree"]) == (4, 101)
    assert (s["jockey_win_pct"], s["trainer_win_pct"]) == (17, 19)
    assert (s["trainer_alerts"], s["trainer_alert_best_roi"], s["trainer_alert_worst_roi"]) == (2, -0.35, -0.67)
    assert (s["last_speed"], s["best_speed_3"], s["races_with_figs"]) == (51, 81, 3)   # the workout isn't a race
    assert s["lasix"] == 1 and s["par_speed"] == 77 and s["speed_vs_par"] == 4 and s["turf"] == 0
    assert (two["style"], two["qsp"], two["call1_fps"]) == ("E", 6, 93.0)
    assert (three["program_num"], three["style"], three["brisnet_style"], three["qsp"]) == ("3", "P", "NA", 0)
    assert "call1_fps" not in three


def test_pickpony_upload(tmp_path, monkeypatch):
    from totebot import brisnet

    monkeypatch.setattr(brisnet, "pdf_pages", lambda data: [PICKPONY_P1, PICKPONY_P2])
    app = create_app(settings(tmp_path, password="pw"), start_scheduler=False)
    with TestClient(app) as c:
        c.auth = ("admin", "pw")
        r = c.post("/api/races/upload", files={"file": ("pp.pdf", b"%PDF-1.4", "application/pdf")}).json()
        assert [x["id"] for x in r["races"]] == ["FL-20261026-R1"]
        assert len(r["races"][0]["runners"]) == 3
