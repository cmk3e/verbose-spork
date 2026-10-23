import asyncio
import csv
import html
import io
import json
import logging
import re
import secrets
from contextlib import asynccontextmanager
from datetime import timezone
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel

from . import brisnet, performance, performance_page
from .cards import CardError, parse_post_time, races_from_csv, races_from_json
from .config import Settings, get_settings
from .handicap import load_engine
from .models import Race, ToteSnapshot, _parse_dt, utcnow
from .odds import parse_odds
from .scheduler import RaceScheduler
from .sources import ToteUnavailable, build_source
from .store import RaceStore

log = logging.getLogger("totebot")
STATIC = Path(__file__).parent / "static"


def create_app(settings: Optional[Settings] = None, start_scheduler: bool = True) -> FastAPI:
    settings = settings or get_settings()
    store = RaceStore(settings.data_dir)
    scheduler = RaceScheduler(settings, store, build_source(settings))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if not settings.password:
            log.warning("APP_PASSWORD is not set: the site is open to anyone who can reach it")
        if start_scheduler:
            scheduler.start()
        yield
        await scheduler.stop()

    app = FastAPI(title="Totebot", lifespan=lifespan)
    app.state.settings, app.state.store, app.state.scheduler = settings, store, scheduler
    security = HTTPBasic(auto_error=False)

    def auth(creds: Optional[HTTPBasicCredentials] = Depends(security)) -> None:
        if not settings.password:
            return
        ok = creds is not None and secrets.compare_digest(creds.username, settings.username) \
            and secrets.compare_digest(creds.password, settings.password)
        if not ok:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, headers={"WWW-Authenticate": "Basic"})

    def get_race(race_id: str) -> Race:
        race = store.get(race_id)
        if race is None:
            raise HTTPException(404, "Race not found")
        return race

    def add_races(races: List[Race], replace: bool, skipped: Optional[List[str]] = None) -> List[dict]:
        """Save races. Existing ones are kept unless replace; with a `skipped` list they are noted
        there instead of failing the request."""
        out = []
        for race in races:
            if store.get(race.id) and not replace:
                if skipped is None:
                    raise HTTPException(409, f"{race.id} already exists (send replace=true to overwrite)")
                skipped.append(f"{race.track} R{race.race_number}: already loaded (tick Replace to overwrite)")
                continue
            store.save(race)
            out.append(race.to_dict())
        return out

    def upload_result(races: List[Race], replace: bool, skipped: List[str]) -> dict:
        return {"races": add_races(races, replace, skipped), "skipped": skipped}

    @app.get("/", include_in_schema=False, dependencies=[Depends(auth)])
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/health")
    def health():
        return {"ok": True, "time": utcnow().isoformat()}

    @app.get("/api/config", dependencies=[Depends(auth)])
    def config():
        return settings.public()

    @app.get("/api/races", dependencies=[Depends(auth)])
    def list_races(include_runners: bool = False):
        now = utcnow()
        out = []
        for r in store.all():
            d = r.to_dict(now)
            if not include_runners:
                d.pop("runners")
                d.pop("log")
                t = d.pop("tickets") or {}
                d["total_cost"] = t.get("total_cost")
                d.pop("snapshot")
                d.pop("manual_tote")
                d["profit"] = (d.pop("settlement") or {}).get("total", {}).get("profit")
                d["finish"] = ((d.pop("result") or {}).get("finish") or [])[:4]
            out.append(d)
        return out

    @app.get("/api/races/{race_id}", dependencies=[Depends(auth)])
    def race_detail(race_id: str):
        return get_race(race_id).to_dict()

    @app.post("/api/races", dependencies=[Depends(auth)])
    async def create_races(request: Request, replace: bool = False, date: Optional[str] = None):
        try:
            payload = await request.json()
            races = races_from_json(payload, settings.timezone, date)
        except (json.JSONDecodeError, UnicodeDecodeError, CardError, ValueError) as e:
            raise HTTPException(422, str(e))
        return add_races(races, replace)

    @app.post("/api/races/upload", dependencies=[Depends(auth)])
    async def upload_card(
        file: UploadFile = File(...),
        track: str = Form(""),
        race_number: Optional[int] = Form(None),
        post_time: str = Form(""),
        date: str = Form(""),
        replace: bool = Form(False),
    ):
        data = await file.read()
        try:
            if data[:5] == b"%PDF-":
                pages = await asyncio.to_thread(brisnet.pdf_pages, data)  # big PDFs take a while
                try:
                    parsed, skipped = brisnet.load_pages(pages)
                    races = races_from_json(parsed, settings.timezone)
                except (CardError, ValueError) as e:
                    upload_dir.mkdir(parents=True, exist_ok=True)
                    (upload_dir / "last-rejected.pdf").write_bytes(data)
                    (upload_dir / "last-rejected.txt").write_text(
                        f"{file.filename}: {e}\n\n" + brisnet.diagnose(pages))
                    raise ValueError(f"{e} (details: open /debug/upload)") from e
                return upload_result(races, replace, skipped)
            text = data.decode("utf-8-sig")
            if (file.filename or "").lower().endswith(".json") or text.lstrip().startswith(("{", "[")):
                payload = json.loads(text)
                if isinstance(payload, dict) and "races" not in payload:
                    payload.setdefault("track", track)
                    payload.setdefault("race_number", race_number)
                    payload.setdefault("post_time", post_time)
                races = races_from_json(payload, settings.timezone, date or None)
            else:
                races = races_from_csv(text, settings.timezone, track, race_number, post_time, date or None)
        except (json.JSONDecodeError, UnicodeDecodeError, CardError, ValueError) as e:
            raise HTTPException(422, str(e))
        return upload_result(races, replace, [])

    @app.delete("/api/races/{race_id}", dependencies=[Depends(auth)])
    def delete_race(race_id: str):
        if not store.delete(race_id):
            raise HTTPException(404, "Race not found")
        return {"deleted": race_id}

    class PostTimeIn(BaseModel):
        post_time: str

    @app.post("/api/races/{race_id}/post_time", dependencies=[Depends(auth)])
    def set_post_time(race_id: str, body: PostTimeIn):
        race = get_race(race_id)
        local_day = race.post_time.astimezone(ZoneInfo(settings.timezone)).date().isoformat()
        try:
            race.post_time = parse_post_time(body.post_time, local_day, settings.timezone).astimezone(timezone.utc)
        except (CardError, ValueError) as e:
            raise HTTPException(422, str(e))
        race.note(f"Post time set to {race.post_time:%H:%M}Z")
        if race.status in ("missed", "error", "preview", "ready", "published") and race.mtp() > settings.fetch_mtp:
            race.status = "scheduled"
            race.note("Re-armed for a fresh tote pull")
        store.save(race)
        return race.to_dict()

    @app.post("/api/races/{race_id}/scratch/{program_num}", dependencies=[Depends(auth)])
    def toggle_scratch(race_id: str, program_num: str):
        race = get_race(race_id)
        for r in race.runners:
            if r.program_num == program_num:
                r.scratched = not r.scratched
                race.note(f"#{program_num} {'scratched' if r.scratched else 'reinstated'}")
                store.save(race)
                return race.to_dict()
        raise HTTPException(404, "Runner not found")

    class ToteIn(BaseModel):
        win_odds: Dict[str, object]                 # program_num -> "5-2" | 3.5 | "SCR"
        odds_format: str = "to1"                    # how to read bare numbers
        scratched: List[str] = []
        exacta_probables: Dict[str, float] = {}     # "1-2" -> payout per $1
        post_time: Optional[str] = None             # ISO with offset
        run: bool = False                           # compute + publish immediately

    @app.post("/api/races/{race_id}/tote", dependencies=[Depends(auth)])
    async def push_tote(race_id: str, body: ToteIn):
        race = get_race(race_id)
        odds, scratched = {}, list(body.scratched)
        try:
            for num, val in body.win_odds.items():
                dec = parse_odds(val, body.odds_format)
                if dec is None:
                    scratched.append(str(num))
                else:
                    odds[str(num)] = dec
            post = _parse_dt(body.post_time) if body.post_time else None
        except ValueError as e:
            raise HTTPException(422, str(e))
        snap = ToteSnapshot(taken_at=utcnow(), win_odds=odds, scratched=scratched,
                            post_time=post, exacta_probables=body.exacta_probables, source="manual")
        race.manual_tote = snap
        store.save(race)
        if body.run:
            await scheduler.run_now(race, snap)
        return race.to_dict()

    @app.post("/api/races/{race_id}/run", dependencies=[Depends(auth)])
    async def run_now(race_id: str):
        race = get_race(race_id)
        try:
            await scheduler.run_now(race)
        except ToteUnavailable as e:
            raise HTTPException(503, str(e))
        return race.to_dict()

    class ResultIn(BaseModel):
        finish: List[str]                                   # program numbers in finishing order
        payoffs: Dict[str, Dict[str, float]] = {}           # {"exacta": {"4-6": 9.2}} per $1
        final_odds: Dict[str, object] = {}                  # program_num -> "5-2" | 3.5
        scratched: List[str] = []

    @app.post("/api/races/{race_id}/result", dependencies=[Depends(auth)])
    def enter_result(race_id: str, body: ResultIn):
        """Record a result by hand (e.g. when the tote source can't report results)."""
        race = get_race(race_id)
        if not race.tickets:
            raise HTTPException(409, "This race has no tickets to settle")
        try:
            final = {str(k): parse_odds(v) for k, v in body.final_odds.items()}
        except ValueError as e:
            raise HTTPException(422, str(e))
        result = {"official_at": utcnow().isoformat(), "finish": [str(x) for x in body.finish],
                  "final_odds": {k: v for k, v in final.items() if v}, "scratched": body.scratched,
                  "payoffs": body.payoffs, "source": "manual"}
        scheduler.record_result(race, result)
        store.save(race)
        return race.to_dict()

    @app.get("/api/performance", dependencies=[Depends(auth)])
    def performance_json():
        return performance.summarize(store.all(), settings.timezone, load_engine(settings.engine_module))

    @app.get("/performance", include_in_schema=False, dependencies=[Depends(auth)])
    def performance_html():
        summary = performance.summarize(store.all(), settings.timezone, load_engine(settings.engine_module))
        return HTMLResponse(performance_page.render(summary, settings))

    @app.get("/api/performance/history.csv", dependencies=[Depends(auth)])
    def performance_csv():
        rows = performance.history_rows(store.all(), settings.timezone)
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": 'attachment; filename="totebot-history.csv"'})

    discovery_dir = Path(settings.data_dir) / "discovery"
    upload_dir = Path(settings.data_dir) / "uploads"

    @app.get("/debug/upload", include_in_schema=False, dependencies=[Depends(auth)])
    def debug_upload():
        """Why the last PDF upload was rejected."""
        report = upload_dir / "last-rejected.txt"
        body = (
            '<button onclick="navigator.clipboard.writeText(document.getElementById(\'s\').innerText)'
            '.then(()=>this.textContent=\'Copied\')">Copy report</button>'
            f'<pre id="s">{html.escape(report.read_text())}</pre>'
        ) if report.exists() else "<p>No rejected uploads.</p>"
        return HTMLResponse(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upload report</title>'
            "<style>body{font-family:-apple-system,system-ui,sans-serif;margin:16px;background:#fff;color:#111}"
            "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:#f3f4f6;padding:12px;border-radius:8px}"
            "button{font:inherit;padding:10px 16px;min-height:44px}"
            "@media (prefers-color-scheme:dark){body{background:#0e1116;color:#e6edf3}pre{background:#161b22}}</style>"
            f"<h1>Last rejected upload</h1>{body}"
        )

    @app.get("/discovery", include_in_schema=False, dependencies=[Depends(auth)])
    def discovery():
        """Results of the last tote-source discovery run (see totebot/tools/)."""
        summary = discovery_dir / "summary.txt"
        shots = sorted(p.name for p in discovery_dir.glob("*.png")) if discovery_dir.is_dir() else []
        if summary.exists():
            body = (
                '<button onclick="navigator.clipboard.writeText(document.getElementById(\'s\').innerText)'
                '.then(()=>this.textContent=\'Copied\')">Copy summary</button>'
                f'<pre id="s">{html.escape(summary.read_text())}</pre>'
            )
        elif shots:
            body = "<p>The last run did not finish (no summary). Screenshots it took:</p>"
        else:
            body = "<p>No discovery run yet.</p>"
        body += "".join(f'<h3>{n}</h3><img src="/discovery/files/{n}">' for n in shots)
        return HTMLResponse(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discovery</title>'
            "<style>body{font-family:-apple-system,system-ui,sans-serif;margin:16px;background:#fff;color:#111}"
            "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:#f3f4f6;padding:12px;border-radius:8px}"
            "img{max-width:100%;border:1px solid #ccc}button{font:inherit;padding:10px 16px;min-height:44px}"
            "@media (prefers-color-scheme:dark){body{background:#0e1116;color:#e6edf3}pre{background:#161b22}}</style>"
            f"<h1>Discovery</h1>{body}"
        )

    @app.get("/discovery/files/{name}", include_in_schema=False, dependencies=[Depends(auth)])
    def discovery_file(name: str):
        if not re.fullmatch(r"[\w.-]+\.(png|txt|json|jsonl)", name):
            raise HTTPException(404)
        path = discovery_dir / name
        if not path.is_file():
            raise HTTPException(404)
        return FileResponse(path)

    return app


def app_factory() -> FastAPI:
    """Entry point for uvicorn: `uvicorn totebot.web:app_factory --factory`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()
