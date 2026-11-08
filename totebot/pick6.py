"""Pick 6 (or any Pick N) ticket builder for carryover / mandatory-payout days.

Per leg it uses the race loaded from your PPs (or, if a leg isn't loaded, the tote alone), pulls the
current odds, and runs the same handicapping as the tickets. Then it builds a ticket within the
budget, adding horses one at a time where they raise the chance of hitting the most per dollar.

Payout estimate: on a mandatory payout everything in the pool goes to the winners, so each $1 of new
money returns ((1 - takeout) * pool + carryover) / pool on average: the carryover is the edge. A
winning ticket's share is estimated from the public's win-pool probabilities (q): a combination of
less popular horses is held by fewer people. Return per $1 on combination c is M / q(c), so a
ticket's expected return is base * M * product over legs of sum(p / q) for the horses used, where
p is the model's (or the public's) probability. Pick 6 bettors don't bet exactly like win bettors,
and one ticket can't win more than the whole pool, so treat the EV as a rough guide.
"""
import math
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from .config import Settings
from .handicap import run_handicap
from .models import Race, Runner, utcnow
from .odds import format_odds
from .sources import ToteSource
from .store import RaceStore


def find_race(store: RaceStore, track: str, number: int, tz: str) -> Optional[Race]:
    """Today's race at this track (by code or name) and number, the one with the nearest post time."""
    today = datetime.now(ZoneInfo(tz)).date()
    t = track.lower()
    matches = [r for r in store.all() if r.race_number == number
               and t in (r.track.lower(), r.id.split("-")[0].lower())
               and r.post_time.astimezone(ZoneInfo(tz)).date() == today]
    return min(matches, key=lambda r: abs((r.post_time - utcnow()).total_seconds()), default=None)


async def leg(store: RaceStore, source: ToteSource, settings: Settings, track: str, number: int) -> dict:
    race = find_race(store, track, number, settings.timezone)
    loaded = race is not None
    if race is None:  # not on your card: odds only
        race = Race(id=f"{track.upper()}-PICK-R{number}", track=track.upper(), race_number=number,
                    post_time=utcnow() + timedelta(hours=1), runners=[])
    snap = await source.fetch(race)
    if not loaded:
        race.runners = [Runner(program_num=n, ml_odds=format_odds(o)) for n, o in snap.win_odds.items()
                        if n not in snap.scratched and o]
    note = "your card" if loaded else "not loaded from PPs: public odds only"
    try:
        rows = run_handicap(race, snap, settings)["runners"]
        horses = [{"num": r["program_num"], "name": r.get("name") or "", "odds": r.get("odds"),
                   "p": r["p_true"], "q": r["p_public"]} for r in rows]
    except Exception as e:  # fall back to the tote
        inv = {n: 1 / o for n, o in snap.win_odds.items() if n not in snap.scratched and o}
        total = sum(inv.values())
        horses = [{"num": n, "name": "", "odds": snap.win_odds[n], "p": v / total, "q": v / total} for n, v in inv.items()]
        note = f"handicapping failed ({e}); public odds only"
    total_p, total_q = sum(h["p"] for h in horses) or 1, sum(h["q"] for h in horses) or 1
    for h in horses:
        h["p"], h["q"] = h["p"] / total_p, h["q"] / total_q
    horses.sort(key=lambda h: h["p"], reverse=True)
    return {"race": number, "track": race.track, "note": note, "horses": horses,
            "post": race.post_time if loaded else snap.post_time}


def build_ticket(legs: List[dict], budget: float, base: float, key: str = "p") -> List[List[dict]]:
    """Start with each leg's top horse; keep adding the horse that raises the hit chance most per
    extra dollar (log gain in hit chance / log gain in cost) while the ticket fits the budget."""
    picks = [[lg["horses"][0]] for lg in legs]
    while True:
        cost = base * math.prod(len(p) for p in picks)
        best, best_score = None, 0.0
        for i, lg in enumerate(legs):
            n = len(picks[i])
            if n >= len(lg["horses"]) or cost * (n + 1) / n > budget + 1e-9:
                continue
            h = lg["horses"][n]
            s = sum(x[key] for x in picks[i])
            score = math.log((s + h[key]) / s) / math.log((n + 1) / n)
            if score > best_score:
                best, best_score = i, score
        if best is None:
            return picks
        picks[best].append(legs[best]["horses"][len(picks[best])])


def evaluate(picks: List[List[dict]], base: float, multiplier: float) -> dict:
    combos = math.prod(len(p) for p in picks)
    hit_model = math.prod(sum(h["p"] for h in p) for p in picks)
    hit_public = math.prod(sum(h["q"] for h in p) for p in picks)
    ev = base * multiplier * math.prod(sum(h["p"] / max(h["q"], 1e-4) for h in p) for p in picks)
    cost = base * combos
    return {"combos": combos, "cost": cost, "hit_model": hit_model, "hit_public": hit_public,
            "ev": ev, "roi": ev / cost - 1 if cost else None}


def report(legs: List[dict], budget: float, base: float, carryover: float, pool: float, takeout: float) -> str:
    m = ((1 - takeout) * pool + carryover) / pool
    out = [f"Pick {len(legs)}: {legs[0]['track']} R{legs[0]['race']}-R{legs[-1]['race']}   base ${base:g}   "
           f"carryover ${carryover:,.0f}, est. new money ${pool:,.0f}, takeout {takeout:.0%}",
           f"Average return per $1 of new money: {m:.2f} (the carryover's edge, before any handicapping)", ""]
    for lg in legs:
        out.append(f"R{lg['race']} ({lg['note']})")
        out.append("    #  horse                  odds   model  public  model/public")
        for h in lg["horses"]:
            odds = format_odds(h["odds"]) if h.get("odds") else "-"
            out.append(f"  {h['num']:>3}  {h['name'][:20]:<20} {odds:>6}  {h['p']:6.1%}  {h['q']:6.1%}  {h['p'] / max(h['q'], 1e-4):5.2f}")
        out.append("")
    for b in sorted({budget / 2, budget, budget * 2}):
        for key, label in (("p", "model"), ("q", "public odds")):
            picks = build_ticket(legs, b, base, key)
            e = evaluate(picks, base, m)
            line = " / ".join(",".join(h["num"] for h in p) for p in picks)
            out.append(f"Budget ${b:,.0f}, horses chosen by {label}:  {line}")
            out.append(f"    {e['combos']} combos = ${e['cost']:,.2f}   hit chance: model {e['hit_model']:.1%}, "
                       f"public {e['hit_public']:.1%}   est. return ${e['ev']:,.2f} ({e['roi']:+.0%})")
        out.append("")
    out.append("Model/public above 1 = the model likes the horse more than the crowd (fewer tickets share the "
               "payout if it wins). Your results so far haven't shown the model beating the final odds, so "
               "the 'public odds' tickets are the safer read; the carryover is the edge either way.")
    return "\n".join(out)
