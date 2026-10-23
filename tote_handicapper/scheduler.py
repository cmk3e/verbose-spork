"""Watches post times, tracks the tote, and fires the handicapper on time.

Timeline per race (defaults, all configurable):
  T-3:00  start pulling the live tote, re-polling every ``tote_poll_sec``
  T-2:00  take one final fresh tote pull, handicap, publish tickets
  post    races that never got tickets are marked missed

If the feed reports a later post time after tickets were issued (a track
delay), the race goes back to tracking and is re-ticketed at the new T-2:00,
because the odds will keep moving until the gates actually open.
"""

import json
import logging
import threading
import time
import traceback
import urllib.request
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .handicap import HandicapError, handicap_race, load_model
from .models import Race
from .providers import ToteProvider
from .tickets import render_text, structured_wheels

log = logging.getLogger("tote_handicapper")

SCHEDULED, TRACKING, TICKETED, SKIPPED, MISSED, ERROR = (
    "scheduled", "tracking", "ticketed", "skipped", "missed", "error")


class CardStore:
    """Fundamentals cards: ``<cards_dir>/<race_id>.json``, else the provider's."""

    def __init__(self, directory: Optional[str], provider: ToteProvider):
        self.dir = Path(directory) if directory else None
        self.provider = provider

    def get(self, race_id: str) -> Optional[dict]:
        if self.dir:
            path = self.dir / f"{race_id}.json"
            if path.exists():
                return json.loads(path.read_text())
        return self.provider.get_card(race_id)


class RaceState:
    def __init__(self, race: Race):
        self.race = race
        self.status = SCHEDULED
        self.last_poll: Optional[datetime] = None
        self.latest_tote = None
        self.history: List[dict] = []  # [{"t": iso, "odds": {prog: decimal}}]
        self.result: Optional[dict] = None
        self.ticket_text: Optional[str] = None
        self.ticketed_for_post: Optional[datetime] = None
        self.message = ""

    def to_dict(self) -> dict:
        return {
            "race": self.race.to_dict(),
            "status": self.status,
            "message": self.message,
            "latest_tote": self.latest_tote.to_dict() if self.latest_tote else None,
            "history": self.history,
            "result": self.result,
            "ticket_text": self.ticket_text,
        }


class Scheduler:
    def __init__(self, provider: ToteProvider, cfg: dict,
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self.provider = provider
        self.cfg = cfg
        self.clock = clock
        t = cfg.get("timing", {})
        self.pull_at = float(t.get("pull_at_sec", 180))
        self.ticket_at = float(t.get("ticket_at_sec", 120))
        self.tote_poll = float(t.get("tote_poll_sec", 15))
        self.race_refresh = float(t.get("race_refresh_sec", 60))
        self.delay_tolerance = float(t.get("reticket_if_delayed_sec", 60))
        self.cards = CardStore(cfg.get("cards_dir"), provider)
        self.model = load_model(cfg.get("model_path"))
        self.output_dir = Path(cfg["output_dir"]) if cfg.get("output_dir") else None
        self.webhook = cfg.get("webhook_url")
        self.races: Dict[str, RaceState] = {}
        self.lock = threading.Lock()
        self._last_refresh: Optional[datetime] = None
        self._stop = threading.Event()
        self.listeners: List[Callable[[RaceState], None]] = []

    # -- race list -----------------------------------------------------------
    def refresh_races(self) -> None:
        try:
            races = self.provider.list_races()
        except Exception as exc:  # feed hiccup: keep the last known schedule
            log.warning("race list refresh failed: %s", exc)
            return
        with self.lock:
            for race in races:
                state = self.races.get(race.race_id)
                if state is None:
                    # Own copy, so post-time changes are detected, not shared.
                    self.races[race.race_id] = RaceState(replace(race))
                else:
                    self._apply_post_time(state, race.post_time)
        self._last_refresh = self.clock()

    def _apply_post_time(self, state: RaceState, post_time: datetime) -> None:
        if post_time == state.race.post_time:
            return
        log.info("%s post time moved %s -> %s", state.race.race_id, state.race.post_time, post_time)
        state.race.post_time = post_time
        if (state.status == TICKETED and state.ticketed_for_post
                and (post_time - state.ticketed_for_post).total_seconds() > self.delay_tolerance):
            state.status = TRACKING
            state.message = "Post delayed; will re-ticket at the new T-2:00"

    # -- main loop -----------------------------------------------------------
    def tick(self) -> None:
        now = self.clock()
        if self._last_refresh is None or (now - self._last_refresh).total_seconds() >= self.race_refresh:
            self.refresh_races()
        with self.lock:
            states = list(self.races.values())
        for state in states:
            self._step(state, self.clock())

    def _step(self, state: RaceState, now: datetime) -> None:
        if state.status in (SKIPPED, MISSED, ERROR) or (state.status == TICKETED):
            return
        secs = (state.race.post_time - now).total_seconds()
        if secs <= 0:
            state.status = MISSED
            state.message = "Reached post before tickets were produced"
            return
        if secs > self.pull_at:
            return
        if state.status == SCHEDULED:
            state.status = TRACKING
            state.message = "Tracking live tote"
        if secs <= self.ticket_at:
            self._issue_tickets(state)
        elif state.last_poll is None or (now - state.last_poll).total_seconds() >= self.tote_poll:
            self._poll(state)

    def _poll(self, state: RaceState):
        try:
            tote = self.provider.get_tote(state.race.race_id)
        except Exception as exc:
            state.message = f"Tote pull failed: {exc}"
            log.warning("%s tote pull failed: %s", state.race.race_id, exc)
            return None
        state.last_poll = self.clock()
        state.latest_tote = tote
        state.history.append({"t": tote.fetched_at.isoformat(),
                              "odds": {r.program_num: r.odds for r in tote.runners if r.active}})
        state.history = state.history[-40:]
        if tote.post_time:
            self._apply_post_time(state, tote.post_time)
        return tote

    def _issue_tickets(self, state: RaceState) -> None:
        card = self.cards.get(state.race.race_id)
        if card is None:
            state.status = SKIPPED
            state.message = "No fundamentals card for this race"
            self._notify(state)
            return
        tote = self._poll(state)  # always handicap off a fresh T-2 pull
        if tote is None:
            tote = state.latest_tote
            if tote is None:
                return  # retry next tick while there is still time
        try:
            result = handicap_race(state.race, card, tote, self.cfg, self.model)
        except HandicapError as exc:
            state.status = SKIPPED
            state.message = str(exc)
            self._notify(state)
            return
        except Exception as exc:
            state.status = ERROR
            state.message = f"Handicapper crashed: {exc}"
            log.error("%s handicap failed\n%s", state.race.race_id, traceback.format_exc())
            return
        result["wheels"] = structured_wheels(result["groups"], self.cfg.get("exotics", {}))
        state.result = result
        state.ticket_text = render_text(result)
        state.status = TICKETED
        state.ticketed_for_post = state.race.post_time
        state.message = f"Tickets ready ({result['minutes_to_post_at_tote']:.1f} MTP odds)"
        self._publish(state)

    # -- output --------------------------------------------------------------
    def _publish(self, state: RaceState) -> None:
        log.info("\n%s\n", state.ticket_text)
        if self.output_dir:
            self.output_dir.mkdir(parents=True, exist_ok=True)
            stem = self.output_dir / state.race.race_id
            stem.with_suffix(".json").write_text(json.dumps(state.result, indent=2, default=str))
            stem.with_suffix(".txt").write_text(state.ticket_text + "\n")
        if self.webhook:
            threading.Thread(target=self._post_webhook, args=(state.ticket_text,), daemon=True).start()
        self._notify(state)

    def _post_webhook(self, text: str) -> None:
        # Slack takes {"text"}, Discord takes {"content"}; sending both suits either.
        body = json.dumps({"text": f"```{text}```", "content": f"```{text}```"}).encode()
        req = urllib.request.Request(self.webhook, data=body, headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=10).close()
        except Exception as exc:
            log.warning("webhook failed: %s", exc)

    def _notify(self, state: RaceState) -> None:
        for fn in self.listeners:
            fn(state)

    def snapshot(self) -> dict:
        with self.lock:
            races = sorted(self.races.values(), key=lambda s: s.race.post_time)
            return {
                "server_time": self.clock().isoformat(),
                "pull_at_sec": self.pull_at,
                "ticket_at_sec": self.ticket_at,
                "races": [s.to_dict() for s in races],
            }

    def run_forever(self, tick_sec: float = 1.0) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.tick()
            except Exception:
                log.error("tick failed\n%s", traceback.format_exc())
            self._stop.wait(max(0.0, tick_sec - (time.monotonic() - started)))

    def stop(self) -> None:
        self._stop.set()
