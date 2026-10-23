"""Runs horseplay_betting_engine_v3 against a live tote snapshot.

Pipeline per race:
  1. Match the fundamentals card to the live tote; drop scratches.
  2. Fundamental probabilities: card ``p_fund`` > trained conditional-logit
     ``features`` > morning line ``ml_odds``.
  3. PaceAndEnergyAnalyzer adjusts them for the projected pace scenario.
  4. BenterProbabilityBlender blends them with the live public probabilities.
  5. KellyBankrollManager sizes win bets on the blended probabilities.
  6. categorize_runners builds the A/B/C groups.
  7. ExoticEVEngine picks +EV exacta and superfecta combinations, priced off
     the live exacta probables when the feed provides them.
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import horseplay_betting_engine_v3 as engine  # noqa: E402

from .models import Race, ToteSnapshot  # noqa: E402


class HandicapError(Exception):
    pass


def load_model(path: Optional[str]) -> Optional[engine.ConditionalLogitModel]:
    if not path:
        return None
    data = json.loads(Path(path).read_text())
    model = engine.ConditionalLogitModel()
    model.weights, model.means, model.stds = data["weights"], data["means"], data["stds"]
    return model


def save_model(model: engine.ConditionalLogitModel, path: str, feature_names: List[str]) -> None:
    Path(path).write_text(json.dumps({
        "features": feature_names, "weights": model.weights, "means": model.means, "stds": model.stds,
    }, indent=2))


def fundamental_probabilities(runners: List[dict], model: Optional[engine.ConditionalLogitModel]) -> Tuple[List[float], str]:
    if all(r.get("p_fund") is not None for r in runners):
        return engine.normalize([float(r["p_fund"]) for r in runners]), "card p_fund"
    if model is not None and all(r.get("features") for r in runners):
        return model.predict_proba([list(map(float, r["features"])) for r in runners]), "conditional logit"
    if all(r.get("ml_odds") is not None for r in runners):
        decimal = [float(r["ml_odds"]) + 1.0 for r in runners]
        return engine.normalize([1.0 / d for d in decimal]), "morning line"
    raise HandicapError("Card needs p_fund, features (with a trained model) or ml_odds for every runner")


def _round_down(x: float, unit: float) -> float:
    return math.floor(x / unit + 1e-9) * unit


def handicap_race(race: Race, card: dict, tote: ToteSnapshot, cfg: dict,
                  model: Optional[engine.ConditionalLogitModel] = None) -> dict:
    bank = cfg.get("bankroll", {})
    ex_cfg = cfg.get("exotics", {})

    live = {r.program_num: r for r in tote.runners if r.active}
    runners = [dict(r) for r in card["runners"] if str(r["program_num"]) in live]
    missing = [str(r["program_num"]) for r in card["runners"] if str(r["program_num"]) not in live]
    unknown = sorted(set(live) - {str(r["program_num"]) for r in card["runners"]})
    if len(runners) < 2:
        raise HandicapError(f"Only {len(runners)} card runner(s) have live odds")
    for r in runners:
        r["program_num"] = str(r["program_num"])
        r.setdefault("style", "P")
        r.setdefault("qsp", 0)
        r["odds"] = live[r["program_num"]].odds
        r["name"] = r.get("name") or live[r["program_num"]].name

    p_fund, p_source = fundamental_probabilities(runners, model)

    pace = engine.PaceAndEnergyAnalyzer(**cfg.get("pace", {}))
    p_pace, pace_info = pace.adjust_probabilities(runners, p_fund)

    blender = engine.BenterProbabilityBlender(odds_format="decimal", **cfg.get("blend", {}))
    odds = [r["odds"] for r in runners]
    p_pub = blender.public_probabilities(odds)
    p_true = blender.blend(p_pace, p_pub)
    for r, pf, pp, pt, pu in zip(runners, p_fund, p_pace, p_true, p_pub):
        r.update(p_fund=pf, p_pace=pp, p_true=pt, p_public=pu)

    kelly = engine.KellyBankrollManager(
        bankroll=bank.get("amount", 1000.0),
        fractional_kelly=bank.get("fractional_kelly", 0.25),
        max_race_exposure=bank.get("max_race_exposure", 0.05),
        odds_haircut=bank.get("odds_haircut", 0.05),
    )
    evaluated = kelly.evaluate_field(runners)
    groups = engine.categorize_runners(evaluated)

    win_min = bank.get("win_min_bet", 2.0)
    win_bets = []
    for e in evaluated:
        stake = _round_down(e["recommended_stake"], 1.0)
        if stake >= win_min:
            win_bets.append({"program_num": e["program_num"], "name": e["name"], "stake": stake,
                             "odds": e["odds"], "ev": e["ev"], "p_true": e["p_true"]})
    win_bets.sort(key=lambda b: b["stake"], reverse=True)

    exotics = engine.ExoticEVEngine(
        lambdas=ex_cfg.get("lambdas", (1.0, 0.85, 0.75, 0.70)),
        takeouts=ex_cfg.get("takeouts"),
    )
    index = {r["program_num"]: i for i, r in enumerate(runners)}
    pool_payouts = {}
    for (a, b), payout in tote.exacta_probables.items():
        if a in index and b in index:
            pool_payouts[(index[a], index[b])] = payout

    exotic_tickets = []
    for bet_type in ("exacta", "superfecta"):
        bc = ex_cfg.get(bet_type, {})
        if not bc.get("enabled", True) or len(runners) < engine.ExoticEVEngine.DEPTH[bet_type]:
            continue
        t = exotics.build_ticket(
            bet_type, p_true, p_pub,
            base=bc.get("base", 1.0 if bet_type == "exacta" else 0.10),
            budget=bc.get("budget", 20.0 if bet_type == "exacta" else 12.0),
            min_edge=bc.get("min_edge", 0.10),
            min_combo_prob=bc.get("min_combo_prob", 0.002 if bet_type == "exacta" else 0.0005),
            pool_payouts=pool_payouts if bet_type == "exacta" else None,
        )
        t["base"] = bc.get("base", 1.0 if bet_type == "exacta" else 0.10)
        t["priced_from"] = "live probables where posted" if (bet_type == "exacta" and pool_payouts) else "win-pool model"
        for c in t["combos"]:
            c["combo"] = [runners[i]["program_num"] for i in c["combo"]]
        exotic_tickets.append(t)

    total_cost = sum(b["stake"] for b in win_bets) + sum(t["cost"] for t in exotic_tickets)
    return {
        "race": race.to_dict(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tote_fetched_at": tote.fetched_at.isoformat(),
        "minutes_to_post_at_tote": round((race.post_time - tote.fetched_at).total_seconds() / 60.0, 2),
        "probability_source": p_source,
        "pace": pace_info,
        "scratched_or_unpriced": missing,
        "on_tote_not_on_card": unknown,
        "overround": blender.last_overround,
        "runners": [
            {**e, "style": r["style"], "qsp": r["qsp"], "p_fund": r["p_fund"], "p_pace": r["p_pace"],
             "p_public": r["p_public"], "pace_mod": r.get("pace_mod", 0.0)}
            for e, r in zip(evaluated, runners)
        ],
        "groups": groups,
        "win_bets": win_bets,
        "exotics": exotic_tickets,
        "total_cost": round(total_cost, 2),
    }
