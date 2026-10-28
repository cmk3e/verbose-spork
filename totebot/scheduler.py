import asyncio
import logging
from collections import defaultdict
from datetime import datetime
from typing import Optional

from . import candidate, notify
from .config import Settings
from .handicap import load_engine, run_handicap
from .models import Race, ToteSnapshot, utcnow
from .performance import settle
from .sources import ToteSource, ToteUnavailable
from .store import RaceStore

log = logging.getLogger(__name__)

POST_TIME_TOLERANCE_S = 30
RESULT_FIRST_CHECK_MIN = 3      # start looking for the official result this long after post
RESULT_CHECK_INTERVAL_S = 120
RESULT_GIVE_UP_MIN = 180
ODDS_HISTORY_MAX = 90
TRACK_INTERVAL_S = 30   # after the pull, keep recording the odds this often...
TRACK_UNTIL_MIN = 5     # ...until this long after post (records only; tickets don't change)
REFIT_CHECK_S = 300     # how often to look for new results to refit the candidate model on...
REFIT_MIN_GAP_S = 3600  # ...but refit at most this often (it takes a while)


class RaceScheduler:
    """Pulls the tote at FETCH_MTP, computes tickets, and releases them at PUBLISH_MTP.

    Before the fetch window it pre-polls the source so a delayed post time moves the schedule.
    After post it collects the official result and settles the published tickets.
    """

    def __init__(self, settings: Settings, store: RaceStore, source: ToteSource):
        self.s = settings
        self.store = store
        self.source = source
        self._locks = defaultdict(asyncio.Lock)
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())
        self._refit_task = asyncio.create_task(self._refit_loop())

    async def stop(self) -> None:
        for task in (self._task, getattr(self, "_refit_task", None)):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        await self.source.aclose()

    async def _refit_loop(self) -> None:
        last_count, last_at = None, None
        while True:
            await asyncio.sleep(REFIT_CHECK_S)
            try:
                count = sum(1 for r in self.store.all() if r.result_status == "official")
                due = last_at is None or (utcnow() - last_at).total_seconds() >= REFIT_MIN_GAP_S
                if count != last_count and due:
                    await asyncio.to_thread(self.refit_candidate)
                    last_count, last_at = count, utcnow()
            except Exception:
                log.exception("Candidate model refit failed")

    def refit_candidate(self) -> dict:
        """Fit and test the candidate model on all settled races; saved for the page and for tickets."""
        report = candidate.evaluate(self.store.all(), load_engine(self.s.engine_module))
        candidate.save(report, self.s.data_dir)
        log.info("Candidate model: %s races, verdict %s", report["races"], report["verdict"])
        return report

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("Scheduler tick failed")
            await asyncio.sleep(self.s.tick_seconds)

    async def tick(self, now: Optional[datetime] = None) -> None:
        races = [r for r in self.store.all()
                 if r.status in ("scheduled", "preview", "ready") or self._awaiting_result(r) or self._tracking_due(r, now or utcnow())]
        await asyncio.gather(*(self._process(r, now) for r in races))

    async def _process(self, race: Race, now: Optional[datetime]) -> None:
        lock = self._locks[race.id]
        if lock.locked():
            return
        async with lock:
            now = now or utcnow()
            mtp = race.mtp(now)
            if race.status in ("scheduled", "preview"):
                if mtp <= self.s.missed_after_mtp:
                    race.status = "missed"
                    race.note("Post passed before tote could be pulled", now)
                    self.store.save(race)
                elif mtp <= self.s.fetch_mtp:
                    await self._snapshot_and_compute(race, now)
                elif mtp <= self.s.prepoll_mtp and self._prepoll_due(race, now):
                    await self._prepoll(race, now)
            if race.status == "ready" and race.mtp(now) <= self.s.publish_mtp:
                await self._publish(race, now)
            if self._tracking_due(race, now):
                await self._track_odds(race, now)
            if self._awaiting_result(race):
                await self._check_result(race, now)

    @staticmethod
    def _tracking_due(race: Race, now: datetime) -> bool:
        """After the pull, record the odds every TRACK_INTERVAL_S up to the off, to measure how much
        they still move (and so when to pull and how big ODDS_HAIRCUT should be)."""
        if race.status not in ("ready", "published") or race.result_status == "official":
            return False
        if race.mtp(now) < -TRACK_UNTIL_MIN:
            return False
        last = race.odds_history[-1]["t"] if race.odds_history else None
        return last is None or (now - datetime.fromisoformat(last)).total_seconds() >= TRACK_INTERVAL_S

    async def _track_odds(self, race: Race, now: datetime) -> None:
        try:
            snap = await self.source.fetch(race)
        except Exception as e:  # recording only: never disturb the race
            log.debug("Odds tracking failed for %s: %s", race.id, e)
            return
        self._observe(race, snap, now)
        self.store.save(race)

    @staticmethod
    def _awaiting_result(race: Race) -> bool:
        return race.status == "published" and bool(race.tickets) and race.result_status not in ("official", "unavailable")

    async def _check_result(self, race: Race, now: datetime) -> None:
        since_post = -race.mtp(now)
        if since_post < RESULT_FIRST_CHECK_MIN:
            return
        if since_post > RESULT_GIVE_UP_MIN:
            race.result_status = "unavailable"
            race.note("No official result found; giving up", now)
            self.store.save(race)
            return
        if race.last_result_check and (now - race.last_result_check).total_seconds() < RESULT_CHECK_INTERVAL_S:
            return
        race.last_result_check = now
        race.result_status = "pending"
        try:
            result = await self.source.fetch_result(race)
        except Exception as e:  # keep trying until RESULT_GIVE_UP_MIN
            log.warning("Result check failed for %s: %s", race.id, e)
            result = None
        if result:
            self.record_result(race, result, now)
        self.store.save(race)

    def record_result(self, race: Race, result: dict, now: Optional[datetime] = None) -> None:
        race.result = result
        race.settlement = settle(race.tickets or {}, result)
        race.result_status = "official"
        total = race.settlement["total"]
        race.note(f"Result {'-'.join(result['finish'][:4])}; tickets cost ${total['cost']:.2f}, "
                  f"returned ${total['return']:.2f} ({total['profit']:+.2f})", now)

    def _prepoll_due(self, race: Race, now: datetime) -> bool:
        return race.last_prepoll is None or (now - race.last_prepoll).total_seconds() >= self.s.prepoll_interval_s

    def _observe(self, race: Race, snap: ToteSnapshot, now: datetime) -> None:
        """Every odds poll: follow post-time changes and keep the odds for the race's history."""
        self._apply_post_time(race, snap, now)
        race.odds_history.append({"t": now.isoformat(), "mtp": round(race.mtp(now), 2), "odds": dict(snap.win_odds)})
        del race.odds_history[:-ODDS_HISTORY_MAX]

    def _apply_post_time(self, race: Race, snap: ToteSnapshot, now: datetime) -> None:
        if snap.post_time and abs((snap.post_time - race.post_time).total_seconds()) > POST_TIME_TOLERANCE_S:
            race.note(f"Post time moved {race.post_time:%H:%M}Z -> {snap.post_time:%H:%M}Z", now)
            race.post_time = snap.post_time

    async def _prepoll(self, race: Race, now: datetime) -> None:
        race.last_prepoll = now
        try:
            snap = await self.source.fetch(race)
            self._observe(race, snap, now)
        except ToteUnavailable as e:
            race.note(f"Pre-poll: {e}", now)
        except Exception as e:
            log.exception("Pre-poll failed for %s", race.id)
            race.note(f"Pre-poll error: {e}", now)
        self.store.save(race)

    async def _snapshot_and_compute(self, race: Race, now: datetime) -> None:
        try:
            snap = await self.source.fetch(race)
        except ToteUnavailable as e:
            race.note(f"Tote unavailable, retrying: {e}", now)
            self.store.save(race)
            return
        except Exception as e:
            log.exception("Tote fetch failed for %s", race.id)
            race.note(f"Tote fetch error, retrying: {e}", now)
            self.store.save(race)
            return

        self._observe(race, snap, now)
        if race.mtp(now) > self.s.fetch_mtp + 0.25:
            self.store.save(race)  # post got pushed back; wait for the new window
            return
        await self._compute(race, snap, now)

    async def _compute(self, race: Race, snap: ToteSnapshot, now: datetime) -> None:
        race.snapshot = snap
        try:
            race.tickets = await asyncio.to_thread(run_handicap, race, snap, self.s)
            race.status = "ready"
            race.error = None
            race.note(f"Tote pulled at {race.mtp(snap.taken_at):.1f} MTP; tickets computed", now)
        except Exception as e:
            log.exception("Handicapping failed for %s", race.id)
            race.status = "error"
            race.error = str(e)
            race.note(f"Handicap error: {e}", now)
            await notify.push(self.s, f"{race.track} R{race.race_number}: error", str(e), race.id, "default")
        self.store.save(race)

    async def _publish(self, race: Race, now: datetime) -> None:
        race.status = "published"
        race.note(f"Tickets published at {race.mtp(now):.1f} MTP", now)
        self.store.save(race)
        t = race.tickets or {}
        cost = t.get("total_cost", 0)
        await notify.push(
            self.s, f"{race.track} R{race.race_number} tickets (${cost:,.2f})", t.get("ticket_text", ""), race.id
        )

    async def run_now(self, race: Race, snap: Optional[ToteSnapshot] = None) -> Race:
        """Pull the tote (or use the given snapshot) and compute now. Inside the fetch window the
        tickets publish at once; earlier they are a preview and the race still gets its normal
        pull at FETCH_MTP."""
        async with self._locks[race.id]:
            now = utcnow()
            if snap is None:
                snap = await self.source.fetch(race)
                self._observe(race, snap, now)
            await self._compute(race, snap, now)
            if race.status == "ready":
                if race.mtp(now) > self.s.fetch_mtp:
                    race.status = "preview"
                    race.note(f"Early preview at {race.mtp(now):.1f} MTP; fresh pull still due at {self.s.fetch_mtp:g} MTP", now)
                    self.store.save(race)
                else:
                    await self._publish(race, now)
            return race
