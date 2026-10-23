import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tote_handicapper.handicap import HandicapError, handicap_race
from tote_handicapper.models import Race, ToteRunner, ToteSnapshot
from tote_handicapper.odds import format_to1, parse_odds
from tote_handicapper.providers import DemoProvider, FileProvider, snapshot_from_dict
from tote_handicapper.scheduler import MISSED, SCHEDULED, SKIPPED, TICKETED, TRACKING, Scheduler
from tote_handicapper.tickets import count_part_wheel, render_text


class FakeClock:
    def __init__(self):
        self.now = datetime(2026, 10, 23, 18, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


class OddsTests(unittest.TestCase):
    def test_parse(self):
        self.assertAlmostEqual(parse_odds("5-2"), 3.5)
        self.assertAlmostEqual(parse_odds("9/5"), 2.8)
        self.assertAlmostEqual(parse_odds("EVN"), 2.0)
        self.assertAlmostEqual(parse_odds(5), 6.0)
        self.assertAlmostEqual(parse_odds("4.6", "decimal"), 4.6)
        self.assertIsNone(parse_odds("SCR"))
        self.assertIsNone(parse_odds(None))

    def test_format(self):
        self.assertEqual(format_to1(3.5), "5-2")
        self.assertEqual(format_to1(2.0), "1-1")
        self.assertEqual(format_to1(13.7), "12-1")


class HandicapTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.demo = DemoProvider(n_races=2, clock=self.clock)
        self.race = self.demo.list_races()[0]

    def test_produces_tickets_and_drops_scratches(self):
        card = self.demo.get_card(self.race.race_id)
        tote = self.demo.get_tote(self.race.race_id)
        result = handicap_race(self.race, card, tote, {})
        live = {r.program_num for r in tote.runners if r.active}
        self.assertEqual({r["program_num"] for r in result["runners"]}, live)
        self.assertAlmostEqual(sum(r["p_true"] for r in result["runners"]), 1.0, places=6)
        self.assertLessEqual(sum(b["stake"] for b in result["win_bets"]), 1000 * 0.05 + 1e-9)
        for t in result["exotics"]:
            self.assertLessEqual(t["cost"], 20.0 + 1e-9)
            for c in t["combos"]:
                self.assertTrue(set(c["combo"]) <= live)
        self.assertIn("RACE 1", render_text({**result, "wheels": []}))

    def test_morning_line_fallback_and_probables(self):
        card = {"runners": [{"program_num": str(i), "ml_odds": ml, "style": s, "qsp": q}
                            for i, ml, s, q in [(1, 2, "E", 7), (2, 3, "P", 3), (3, 5, "S", 1), (4, 9, "P", 2)]]}
        tote = snapshot_from_dict({
            "race_id": "X", "runners": [{"program_num": str(i), "odds": o} for i, o in
                                        [(1, "8-5"), (2, "5-2"), (3, "8-1"), (4, "12-1")]],
            "exacta_probables": {"3-1": 90.0}, "probables_base": 2,
        })
        race = Race("X", "TST", 1, self.clock() + timedelta(minutes=2))
        result = handicap_race(race, card, tote, {})
        self.assertEqual(result["probability_source"], "morning line")
        exacta = next(t for t in result["exotics"] if t["bet_type"] == "exacta")
        self.assertEqual(exacta["priced_from"], "live probables where posted")

    def test_card_without_probabilities_is_rejected(self):
        card = {"runners": [{"program_num": "1"}, {"program_num": "2"}]}
        tote = ToteSnapshot("X", self.clock(), [ToteRunner("1", "a", 3.0), ToteRunner("2", "b", 2.0)])
        with self.assertRaises(HandicapError):
            handicap_race(self.race, card, tote, {})


class WheelTests(unittest.TestCase):
    def test_part_wheel_count(self):
        self.assertEqual(count_part_wheel([["1"], ["2", "3", "4"]]), 3)
        self.assertEqual(count_part_wheel([["1", "2"], ["1", "2", "3"]]), 4)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.demo = DemoProvider(n_races=1, first_post_min=5, clock=self.clock)
        self.out = tempfile.mkdtemp()
        self.sched = Scheduler(self.demo, {"output_dir": self.out}, clock=self.clock)
        self.rid = "DEMO-R1"

    def run_until(self, mtp_sec, step=1):
        post = self.demo.races[self.rid].post_time
        while (post - self.clock()).total_seconds() > mtp_sec:
            self.clock.advance(step)
            self.sched.tick()

    def test_timeline(self):
        self.sched.tick()
        state = self.sched.races[self.rid]
        self.assertEqual(state.status, SCHEDULED)
        self.run_until(181)
        self.assertEqual(state.status, SCHEDULED)
        self.assertIsNone(state.latest_tote)

        self.run_until(180)
        self.assertEqual(state.status, TRACKING)
        self.assertIsNotNone(state.latest_tote)

        self.run_until(121)
        self.assertEqual(state.status, TRACKING)
        self.assertEqual(len(state.history), 4)  # T-180, -165, -150, -135

        self.run_until(120)
        self.assertEqual(state.status, TICKETED)
        self.assertEqual(state.result["minutes_to_post_at_tote"], 2.0)
        self.assertTrue((Path(self.out) / f"{self.rid}.txt").exists())
        json.loads((Path(self.out) / f"{self.rid}.json").read_text())

    def test_post_delay_retickets(self):
        self.run_until(120)
        state = self.sched.races[self.rid]
        self.assertEqual(state.status, TICKETED)
        self.demo.races[self.rid].post_time += timedelta(minutes=3)
        self.sched.refresh_races()
        self.assertEqual(state.status, TRACKING)
        self.run_until(120)
        self.assertEqual(state.status, TICKETED)
        self.assertEqual(state.ticketed_for_post, self.demo.races[self.rid].post_time)

    def test_late_start_tickets_immediately_and_past_post_is_missed(self):
        self.clock.advance(5 * 60 - 60)  # launched at 1 MTP
        self.sched.tick()
        self.assertEqual(self.sched.races[self.rid].status, TICKETED)

        demo = DemoProvider(n_races=1, first_post_min=-1, clock=self.clock)
        sched = Scheduler(demo, {}, clock=self.clock)
        sched.tick()
        self.assertEqual(sched.races["DEMO-R1"].status, MISSED)

    def test_missing_card_is_skipped(self):
        tmp = Path(tempfile.mkdtemp())
        post = (self.clock() + timedelta(minutes=1)).isoformat()
        (tmp / "races.json").write_text(json.dumps({"races": [
            {"race_id": "R1", "track": "TST", "race_number": 1, "post_time": post}]}))
        (tmp / "tote").mkdir()
        (tmp / "tote" / "R1.json").write_text(json.dumps({"race_id": "R1", "runners": [
            {"program_num": "1", "odds": "2-1"}, {"program_num": "2", "odds": "3-1"}]}))
        sched = Scheduler(FileProvider(str(tmp)), {}, clock=self.clock)
        sched.tick()
        self.assertEqual(sched.races["R1"].status, SKIPPED)


if __name__ == "__main__":
    unittest.main()
