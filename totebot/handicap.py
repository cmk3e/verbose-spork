"""Glue between a race card + live tote snapshot and the Horseplay betting engine."""
import importlib
import json
import logging
import math
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
    if all(r.rating is not None for r in runners):
        return engine.softmax([r.rating / settings.rating_scale for r in runners]), "rating"
    if all(r.ml_odds for r in runners):
        return engine.normalize([1.0 / parse_odds(r.ml_odds) for r in runners]), "morning_line"
    raise HandicapError(
        "Every active runner needs p_fund, rating, features (with TRAINING_FILE) or ml_odds"
    )


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
    if len(pace_rows) == len(runners):
        dicts = []
        for r in runners:
            d = {"qsp": r.qsp, "style": r.style}
            for k in ("call1_fps", "call2_fps", "final_fps"):
                if getattr(r, k) is not None:
                    d[k] = getattr(r, k)
            dicts.append(d)
        p_paced, pace = engine.PaceAndEnergyAnalyzer().adjust_probabilities(dicts, p_fund)
        pace_mods = [d["pace_mod"] for d in dicts]
    else:
        pace_mods = [0.0] * len(runners)
        notes.append("Pace adjustment skipped (style/qsp missing for some runners)")

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

    table = []
    win_bets = []
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
        }
        table.append(row)
        stake = _floor_to(ev["recommended_stake"], 1.0)
        if stake >= settings.min_win_bet:
            win_bets.append({**row, "stake": stake})
    table.sort(key=lambda r: r["p_true"], reverse=True)
    win_bets.sort(key=lambda r: r["ev"], reverse=True)

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
        "ticket_text": ticket_text(race, win_bets, groups, exotics),
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


def ticket_text(race: Race, win_bets: List[dict], groups: Dict[str, List[str]], exotics: Dict[str, dict]) -> str:
    """Plain-text ticket you can read straight to a teller or type into an ADW."""
    lines = [f"{race.track} R{race.race_number}"]
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
