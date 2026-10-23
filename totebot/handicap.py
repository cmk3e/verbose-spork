"""Glue between a race card + live tote snapshot and the Horseplay betting engine."""
import importlib
import json
import logging
import math
import statistics
from functools import lru_cache
from typing import Dict, List, Optional, Sequence, Tuple

from .config import Settings
from .models import Race, Runner, ToteSnapshot, utcnow
from .odds import format_odds, parse_odds

log = logging.getLogger(__name__)


class HandicapError(Exception):
    pass


@lru_cache(maxsize=4)
def load_engine(module_name: str):
    return importlib.import_module(module_name)


@lru_cache(maxsize=4)
def load_logit_model(module_name: str, training_file: str):
    """Fit the engine's ConditionalLogitModel from a JSON list of {"features": [[...]], "winner": i}."""
    engine = load_engine(module_name)
    with open(training_file) as fh:
        races = [(r["features"], int(r["winner"])) for r in json.load(fh)]
    return engine.ConditionalLogitModel().fit(races)


def active_runners(race: Race, snap: ToteSnapshot) -> List[Runner]:
    scratched = set(snap.scratched)
    return [
        r for r in race.runners
        if not r.scratched and r.program_num not in scratched and snap.win_odds.get(r.program_num)
    ]


def fundamental_probabilities(engine, runners: Sequence[Runner], settings: Settings) -> Tuple[List[float], str]:
    """Pick the best fundamental input every active runner has."""
    if all(r.p_fund is not None for r in runners):
        return engine.normalize([max(r.p_fund, 1e-6) for r in runners]), "p_fund"
    if settings.training_file and all(r.features for r in runners):
        model = load_logit_model(settings.engine_module, settings.training_file)
        return model.predict_proba([r.features for r in runners]), "logit_model"
    rated = [r.rating for r in runners if r.rating is not None]
    if rated and 2 * len(rated) >= len(runners):
        # A few unrated runners (e.g. first-time starters) get the field's median rating.
        fill = statistics.median(rated)
        missing = [r.program_num for r in runners if r.rating is None]
        ratings = [fill if r.rating is None else r.rating for r in runners]
        source = "rating" + (f" (median {fill:g} used for #{', #'.join(missing)})" if missing else "")
        return engine.softmax([x / settings.rating_scale for x in ratings]), source
    if all(r.ml_odds for r in runners):
        return engine.normalize([1.0 / parse_odds(r.ml_odds) for r in runners]), "morning_line"
    raise HandicapError(
        "Every active runner needs p_fund, rating, features (with TRAINING_FILE) or ml_odds"
    )


PACE_KEYS = ("call1_fps", "call2_fps", "final_fps")
TVG_PACE_KEYS = ("tvg_pace_early", "tvg_pace_middle", "tvg_pace_finish")


def pace_inputs(runners: Sequence[Runner], snap: ToteSnapshot) -> Tuple[Optional[List[Dict[str, float]]], str]:
    """Early/late pace numbers for the engine's %-early: the card's own (Brisnet E1/E2/LP or your
    call fps) when at least half the field has them, else TVG's average pace figures. Runners
    without figures get the field median, so they get no pace edge either way."""
    extras = (snap.extras or {}).get("runners") or {}
    sources = [
        ("card", [tuple(getattr(r, k) for k in PACE_KEYS) for r in runners]),
        ("tvg", [tuple((extras.get(r.program_num) or {}).get(k) for k in TVG_PACE_KEYS) for r in runners]),
    ]
    for label, values in sources:
        have = [v for v in values if None not in v]
        if have and 2 * len(have) >= len(runners):
            medians = [statistics.median(v[i] for v in have) for i in range(3)]
            filled = [v if None not in v else tuple(medians) for v in values]
            missing = len(values) - len(have)
            note = label + (f" (median for {missing} without figures)" if missing else "")
            return [dict(zip(PACE_KEYS, v)) for v in filled], note
    return None, "none"


def odds_features(race: Race, snap: ToteSnapshot, num: str) -> Dict[str, float]:
    """How the odds moved: vs the morning line, and over the last ~10 minutes of polls.
    Positive 'steam' means the horse was bet down (shorter odds now)."""
    now = snap.win_odds.get(num)
    out: Dict[str, float] = {}
    if not now:
        return out
    if race.runners:
        ml = next((r.ml_odds for r in race.runners if r.program_num == num and r.ml_odds), None)
        ml_dec = parse_odds(ml) if ml else None
        if ml_dec:
            out["odds_ml"] = round(ml_dec, 3)
            out["steam_ml"] = round(math.log(ml_dec / now), 4)
    mtp_now = race.mtp(snap.taken_at)
    earlier = [h for h in race.odds_history if h.get("mtp", 0) >= mtp_now + 7 and h.get("odds", {}).get(num)]
    if earlier:
        then = min(earlier, key=lambda h: h["mtp"])  # the latest poll at least 7 minutes before this one
        out["steam_10m"] = round(math.log(then["odds"][num] / now), 4)
        out["steam_window_min"] = round(then["mtp"] - mtp_now, 1)
    return out


def _floor_to(x: float, step: float) -> float:
    return math.floor(x / step + 1e-9) * step


def run_handicap(race: Race, snap: ToteSnapshot, settings: Settings) -> dict:
    engine = load_engine(settings.engine_module)
    runners = active_runners(race, snap)
    if len(runners) < 2:
        raise HandicapError(f"Only {len(runners)} active runner(s) with tote odds")
    nums = [r.program_num for r in runners]
    odds = [snap.win_odds[n] for n in nums]
    notes: List[str] = []

    missing = [r.program_num for r in race.runners
               if not r.scratched and r.program_num not in snap.scratched and r.program_num not in snap.win_odds]
    if missing:
        notes.append(f"No tote odds for #{', #'.join(missing)}; treated as scratched")

    p_fund, fund_source = fundamental_probabilities(engine, runners, settings)

    pace = None
    p_paced = p_fund
    pace_rows = [r for r in runners if r.style and r.qsp is not None]
    pace_figs, pace_source = pace_inputs(runners, snap)
    if len(pace_rows) == len(runners):
        dicts = []
        for i, r in enumerate(runners):
            d = {"qsp": r.qsp, "style": r.style}
            if pace_figs:
                d.update(pace_figs[i])
            dicts.append(d)
        p_paced, pace = engine.PaceAndEnergyAnalyzer().adjust_probabilities(dicts, p_fund)
        pace_mods = [d["pace_mod"] for d in dicts]
        pct_early = [d["pct_early"] for d in dicts]
        pace["figures"] = pace_source
        if not pace_figs:
            notes.append("No pace figures: %-early used engine defaults")
    else:
        pace_mods = [0.0] * len(runners)
        pct_early = [None] * len(runners)
        notes.append("Pace adjustment skipped (style/qsp missing for some runners)")

    extras = snap.extras or {}
    tvg_runner = extras.get("runners") or {}
    surface_change = extras.get("surface_change")
    if surface_change:
        notes.insert(0, f"SURFACE CHANGE ({surface_change}): figures from the card may not apply")
    for change in (extras.get("late_changes") or [])[:5]:
        if change != surface_change:
            notes.append(f"Late change: {change}")
    win_pool = (extras.get("pools") or {}).get("win")
    stake_cap = math.floor(win_pool * settings.max_pool_share) if win_pool and settings.max_pool_share > 0 else None

    blender = engine.BenterProbabilityBlender(
        alpha=settings.alpha, beta=settings.beta, odds_format="decimal"
    )
    p_pub = blender.public_probabilities(odds)
    p_true = blender.blend(p_paced, p_pub)

    kelly = engine.KellyBankrollManager(
        bankroll=settings.bankroll,
        fractional_kelly=settings.fractional_kelly,
        max_race_exposure=settings.max_race_exposure,
        odds_haircut=settings.odds_haircut,
    )
    evaluated = kelly.evaluate_field([
        {"program_num": r.program_num, "name": r.name, "p_true": p, "odds": o}
        for r, p, o in zip(runners, p_true, odds)
    ])
    groups = engine.categorize_runners(evaluated)

    by_num = {r.program_num: r for r in runners}
    table = []
    win_bets = []
    capped = []
    for i, ev in enumerate(evaluated):
        row = {
            "program_num": ev["program_num"],
            "name": ev["name"],
            "odds": round(ev["odds"], 3),
            "odds_display": format_odds(ev["odds"]),
            "p_fund": round(p_fund[i], 4),
            "pace_mod": round(pace_mods[i], 4),
            "p_public": round(p_pub[i], 4),
            "p_true": round(ev["p_true"], 4),
            "ev": round(ev["ev"], 4),
            "full_kelly_pct": round(ev["full_kelly_pct"], 3),
            "fractional_kelly_pct": round(ev["fractional_kelly_pct"], 3),
            "recommended_stake": round(ev["recommended_stake"], 2),
            "pct_early": round(pct_early[i], 2) if pct_early[i] is not None else None,
            # Everything known about the runner, recorded for fitting the model later.
            "stats": {**(by_num[ev["program_num"]].stats or {}), **tvg_runner.get(ev["program_num"], {}),
                      **odds_features(race, snap, ev["program_num"])},
        }
        table.append(row)
        stake = _floor_to(ev["recommended_stake"], 1.0)
        if stake_cap is not None and stake > stake_cap:
            capped.append(f"#{ev['program_num']} ${stake:g}->${stake_cap:g}")
            stake = stake_cap
        if stake >= settings.min_win_bet:
            win_bets.append({**{k: v for k, v in row.items() if k != "stats"}, "stake": stake})
    table.sort(key=lambda r: r["p_true"], reverse=True)
    win_bets.sort(key=lambda r: r["ev"], reverse=True)
    if win_pool:
        notes.append(f"Win pool ${win_pool:,.0f}" + (f"; capped at {settings.max_pool_share:.0%} of pool: {', '.join(capped)}" if capped else ""))

    exotic = engine.ExoticEVEngine(takeouts={
        "exacta": settings.exacta_takeout, "superfecta": settings.superfecta_takeout,
    })
    index = {n: i for i, n in enumerate(nums)}
    exacta_pool: Dict[Tuple[int, ...], float] = {}
    for key, payout in snap.exacta_probables.items():
        parts = key.split("-")
        if len(parts) == 2 and all(p in index for p in parts):
            exacta_pool[(index[parts[0]], index[parts[1]])] = payout

    exotics = {}
    plans = [
        ("exacta", settings.exacta_base, settings.exacta_budget, settings.min_combo_prob_exacta, exacta_pool or None),
        ("superfecta", settings.superfecta_base, settings.superfecta_budget, settings.min_combo_prob_superfecta, None),
    ]
    for bet_type, base, budget, min_p, pool in plans:
        if budget <= 0 or len(runners) < engine.ExoticEVEngine.DEPTH[bet_type]:
            continue
        ticket = exotic.build_ticket(
            bet_type, p_true, p_pub, base=base, budget=budget,
            min_edge=settings.min_edge, min_combo_prob=min_p, pool_payouts=pool,
        )
        for c in ticket["combos"]:
            c["combo"] = [nums[i] for i in c["combo"]]
        ticket["base"] = base
        ticket["grouped"] = group_combos([c["combo"] for c in ticket["combos"]])
        ticket["payout_source"] = "tote probables" if pool else "estimated from win pool"
        exotics[bet_type] = ticket

    if surface_change and settings.surface_change_action == "skip":
        win_bets, exotics = [], {}
        notes.insert(1, "No bets: SURFACE_CHANGE_ACTION=skip")

    return {
        "computed_at": utcnow().isoformat(),
        "tote_taken_at": snap.taken_at.isoformat(),
        "tote_source": snap.source,
        "fundamental_source": fund_source,
        "field_size": len(runners),
        "overround": round(blender.last_overround or 0.0, 4),
        "pace": pace,
        "groups": groups,
        "runners": table,
        "win_bets": win_bets,
        "exotics": exotics,
        "total_cost": round(sum(b["stake"] for b in win_bets) + sum(t["cost"] for t in exotics.values()), 2),
        "notes": notes,
        "win_pool": win_pool,
        "surface_change": surface_change,
        "ticket_text": ticket_text(race, win_bets, groups, exotics, surface_change),
    }


def _money(x: float) -> str:
    return f"${x:,.2f}".replace(".00", "") if x >= 1 else f"${x:.2f}"


def group_combos(combos: List[List[str]]) -> List[str]:
    """Collapse combos sharing all but the last leg: 3-5-2, 3-5-4 -> "3 / 5 / 2,4" (best combo first)."""
    groups: Dict[Tuple[str, ...], List[str]] = {}
    for c in combos:
        groups.setdefault(tuple(c[:-1]), []).append(c[-1])
    def key(n: str):
        return (0, int(n), n) if n.isdigit() else (1, 0, n)

    return [" / ".join(head + (",".join(sorted(tails, key=key)),)) for head, tails in groups.items()]


MAX_TICKET_LINES = 25


def ticket_text(race: Race, win_bets: List[dict], groups: Dict[str, List[str]], exotics: Dict[str, dict],
                surface_change: Optional[str] = None) -> str:
    """Plain-text ticket you can read straight to a teller or type into an ADW."""
    lines = [f"{race.track} R{race.race_number}"]
    if surface_change:
        lines.append(f"!! SURFACE CHANGE: {surface_change}")
    if win_bets:
        for b in win_bets:
            lines.append(f"{_money(b['stake'])} WIN #{b['program_num']} {b['name']} ({b['odds_display']}, EV {b['ev']:+.0%})")
    else:
        lines.append("WIN: no overlays")
    for bet_type, t in exotics.items():
        if not t["combos"]:
            lines.append(f"{bet_type.upper()}: pass")
            continue
        label = "EX" if bet_type == "exacta" else "SUPER"
        lines.append(f"{bet_type.upper()} ({len(t['combos'])} x {_money(t['base'])} = {_money(t['cost'])}, hit {t['hit_probability']:.0%}):")
        grouped = group_combos([c["combo"] for c in t["combos"]])
        for g in grouped[:MAX_TICKET_LINES]:
            lines.append(f"  {_money(t['base'])} {label} {g}")
        if len(grouped) > MAX_TICKET_LINES:
            lines.append(f"  ...+{len(grouped) - MAX_TICKET_LINES} more lines (see full list in app)")
    lines.append("A: " + ",".join(groups["A"]) + "  B: " + ",".join(groups["B"]) + "  C: " + (",".join(groups["C"]) or "-"))
    return "\n".join(lines)
