"""How the tickets did once results are in: settlement per race, and performance across races.

All tickets are settled as if they were bet as printed (paper trading).
"""
import math
import statistics
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

from .models import Race

CALIBRATION_BINS = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.0001]
MIN_RACES_FOR_FIT = 100
CV_FOLDS = 5
MAX_FOLD_SPREAD = 0.3   # fitted weights moving more than this between folds aren't settled yet


def settle(tickets: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    """Cost, return and profit of each ticket line, given the official result."""
    finish = list(result.get("finish") or [])
    scratched = set(result.get("scratched") or [])
    payoffs = result.get("payoffs") or {}
    final_odds = result.get("final_odds") or {}
    bets: List[Dict[str, Any]] = []

    for b in tickets.get("win_bets") or []:
        num, stake = b["program_num"], float(b["stake"])
        estimated = False
        if num in scratched:
            ret, outcome = stake, "refund"
        elif finish and finish[0] == num:
            per = (payoffs.get("win") or {}).get(num)
            if per is None:
                per, estimated = final_odds.get(num, b["odds"]), True
            ret, outcome = stake * per, "won"
        else:
            ret, outcome = 0.0, "lost"
        clv = b["odds"] / final_odds[num] - 1 if num in final_odds else None
        bets.append({"type": "win", "selection": num, "cost": stake, "return": ret, "outcome": outcome,
                     "estimated": estimated, "odds_bet": b["odds"], "odds_final": final_odds.get(num), "clv": clv})

    for kind, t in (tickets.get("exotics") or {}).items():
        base = float(t.get("base") or 0)
        for c in t.get("combos") or []:
            combo = [str(x) for x in c["combo"]]
            key = "-".join(combo)
            estimated = False
            if scratched & set(combo):
                ret, outcome = base, "refund"
            elif finish[:len(combo)] == combo:
                per = (payoffs.get(kind) or {}).get(key)
                if per is None:
                    per, estimated = c.get("est_payout_per_$1", 0.0), True
                ret, outcome = base * per, "won"
            else:
                ret, outcome = 0.0, "lost"
            bets.append({"type": kind, "selection": key, "cost": base, "return": ret,
                         "outcome": outcome, "estimated": estimated})

    by_type: Dict[str, Dict[str, Any]] = {}
    for b in bets:
        t = by_type.setdefault(b["type"], {"bets": 0, "hits": 0, "cost": 0.0, "return": 0.0, "estimated": False})
        t["bets"] += 1
        t["hits"] += b["outcome"] == "won"
        t["cost"] += b["cost"]
        t["return"] += b["return"]
        t["estimated"] |= b["estimated"]
    for t in by_type.values():
        t["profit"] = round(t["return"] - t["cost"], 2)
        t["cost"], t["return"] = round(t["cost"], 2), round(t["return"], 2)
    cost = sum(t["cost"] for t in by_type.values())
    ret = sum(t["return"] for t in by_type.values())
    return {"bets": bets, "by_type": by_type,
            "total": {"cost": round(cost, 2), "return": round(ret, 2), "profit": round(ret - cost, 2)}}


def _paced(rows: Sequence[dict]) -> List[float]:
    raw = [max(r["p_fund"], 1e-6) * (1 + r.get("pace_mod", 0.0)) for r in rows]
    total = sum(raw)
    return [x / total for x in raw]


def _settled(races: Sequence[Race]) -> List[Race]:
    return [r for r in races if r.result and r.settlement and r.tickets and r.result.get("finish")]


def history_rows(races: Sequence[Race], tz_name: str) -> List[Dict[str, Any]]:
    """One row per runner per settled race: what the engine thought, the odds, and what happened."""
    from zoneinfo import ZoneInfo

    out = []
    for race in _settled(races):
        finish = race.result["finish"]
        final = race.result.get("final_odds") or {}
        stakes = {b["program_num"]: b["stake"] for b in race.tickets.get("win_bets") or []}
        rows = race.tickets.get("runners") or []
        paced = _paced(rows) if rows else []
        for r, p_paced in zip(rows, paced):
            num = r["program_num"]
            out.append({
                "date": race.post_time.astimezone(ZoneInfo(tz_name)).date().isoformat(),
                "race_id": race.id, "track": race.track, "race": race.race_number,
                "program_num": num, "name": r.get("name", ""),
                "field_size": len(rows), "fundamental_source": race.tickets.get("fundamental_source", ""),
                "odds_at_pull": r["odds"], "odds_final": final.get(num, ""),
                "p_fund": r["p_fund"], "pace_mod": r.get("pace_mod", 0.0), "p_paced": round(p_paced, 4),
                "p_public": r["p_public"], "p_true": r["p_true"], "ev": r["ev"],
                "pct_early": r.get("pct_early", ""),
                "win_stake": stakes.get(num, 0),
                "win_pool": race.tickets.get("win_pool") or "",
                "surface_change": race.tickets.get("surface_change") or "",
                "finish_pos": finish.index(num) + 1 if num in finish else "",
                "won": int(bool(finish) and finish[0] == num),
                **(r.get("stats") or {}),
            })
    return out


def _log_loss(races: Sequence[Race], key: str) -> Optional[float]:
    losses = []
    for race in races:
        rows = race.tickets.get("runners") or []
        winner = race.result["finish"][0]
        if key == "p_paced":
            probs = dict(zip((r["program_num"] for r in rows), _paced(rows))) if rows else {}
        else:
            probs = {r["program_num"]: r[key] for r in rows}
        if winner in probs:
            losses.append(-math.log(max(probs[winner], 1e-6)))
    return sum(losses) / len(losses) if losses else None


def _final_probs(race: Race) -> Dict[str, float]:
    """The public's probabilities from the final (closing) odds, over the runners in the ticket."""
    final = race.result.get("final_odds") or {}
    inv = {r["program_num"]: 1.0 / final[r["program_num"]]
           for r in race.tickets.get("runners") or [] if final.get(r["program_num"])}
    total = sum(inv.values())
    return {n: v / total for n, v in inv.items()} if total else {}


def closing_comparison(races: Sequence[Race]) -> Optional[Dict[str, Any]]:
    """Model vs the final odds, on the races where the final odds are known. The closing odds
    include the late (often sharpest) money, so this is the stricter test of an edge."""
    model, final, diffs = [], [], []
    for race in races:
        winner = race.result["finish"][0]
        probs = _final_probs(race)
        row = next((r for r in race.tickets.get("runners") or [] if r["program_num"] == winner), None)
        if winner not in probs or row is None:
            continue
        m, f = -math.log(max(row["p_true"], 1e-6)), -math.log(max(probs[winner], 1e-6))
        model.append(m)
        final.append(f)
        diffs.append(f - m)
    if len(diffs) < 2:
        return None
    gain = sum(diffs) / len(diffs)
    se = math.sqrt(sum((d - gain) ** 2 for d in diffs) / (len(diffs) - 1) / len(diffs))
    return {"races": len(diffs), "model": sum(model) / len(model), "final": sum(final) / len(final),
            "gain": gain, "gain_se": se}


DRIFT_CHECKPOINTS = [5, 3, 2, 1, 0]   # minutes to post
DRIFT_TOLERANCE_MIN = 0.5


def _shrink(then: float, final: float) -> float:
    """How much a horse's odds-to-1 shrank from `then` to the off (the engine's haircut units)."""
    return 1 - (final - 1) / (then - 1)


def drift_by_mtp(races: Sequence[Race]) -> List[Dict[str, Any]]:
    """For each checkpoint (minutes before the actual post time), how much the odds still shrank
    before the off: for the ticket's overlays (what gets bet) and for all horses. The latest
    checkpoint you can bet at is the best pull time, and its overlay shrink is its ODDS_HAIRCUT."""
    out = []
    for cp in DRIFT_CHECKPOINTS:
        overlays, everyone, race_count = [], [], 0
        for race in races:
            final = race.result.get("final_odds") or {}
            polls = [(((race.post_time - datetime.fromisoformat(h["t"])).total_seconds() / 60), h["odds"])
                     for h in race.odds_history or [] if h.get("t")]
            near = [(abs(m - cp), odds) for m, odds in polls if abs(m - cp) <= DRIFT_TOLERANCE_MIN]
            if not near or not final:
                continue
            odds_then = min(near, key=lambda x: x[0])[1]
            race_count += 1
            for r in race.tickets.get("runners") or []:
                n = r["program_num"]
                if odds_then.get(n, 0) > 1 and final.get(n):
                    s = _shrink(odds_then[n], final[n])
                    everyone.append(s)
                    if r["ev"] > 0:
                        overlays.append(s)
        if race_count:
            out.append({"mtp": cp, "races": race_count, "overlays": len(overlays),
                        "overlay_shrink": statistics.median(overlays) if overlays else None,
                        "all_shrink": statistics.median(everyone) if everyone else None})
    return out


EV_BUCKETS = [(-math.inf, -0.25, "below −25%"), (-0.25, 0.0, "−25% to 0"), (0.0, 0.10, "0 to +10%"),
              (0.10, 0.25, "+10% to +25%"), (0.25, 0.50, "+25% to +50%"), (0.50, math.inf, "above +50%")]


def ev_buckets(races: Sequence[Race]) -> List[Dict[str, Any]]:
    """A flat $1 win bet on every runner, grouped by the model's EV at the pull. If the EV numbers
    mean anything, ROI should climb from the bottom group to the top."""
    groups: Dict[str, Dict[str, float]] = {label: {"runners": 0, "winners": 0, "p": 0.0, "return": 0.0}
                                           for _, _, label in EV_BUCKETS}
    for race in races:
        winner = race.result["finish"][0]
        win_pay = (race.result.get("payoffs") or {}).get("win") or {}
        final = race.result.get("final_odds") or {}
        for r in race.tickets.get("runners") or []:
            label = next(lbl for lo, hi, lbl in EV_BUCKETS if lo <= r["ev"] < hi)
            g = groups[label]
            g["runners"] += 1
            g["p"] += r["p_true"]
            if r["program_num"] == winner:
                g["winners"] += 1
                g["return"] += win_pay.get(winner) or final.get(winner) or r["odds"]
    out = []
    for _, _, label in EV_BUCKETS:
        g = groups[label]
        if g["runners"]:
            out.append({"range": label, "runners": g["runners"], "winners": g["winners"],
                        "predicted": g["p"] / g["runners"], "actual": g["winners"] / g["runners"],
                        "roi": g["return"] / g["runners"] - 1})
    return out


def exotic_check(races: Sequence[Race]) -> Dict[str, Dict[str, Any]]:
    """How the exotic tickets' own forecasts compared with what happened."""
    out: Dict[str, Dict[str, Any]] = {}
    for race in races:
        for kind, t in (race.tickets.get("exotics") or {}).items():
            if not t.get("combos"):
                continue
            hit = (race.settlement["by_type"].get(kind) or {}).get("hits", 0)
            agg = out.setdefault(kind, {"tickets": 0, "pred_hit": 0.0, "races_hit": 0, "expected_combo_hits": 0.0,
                                        "combo_hits": 0, "cost": 0.0, "expected_return": 0.0, "return": 0.0})
            agg["tickets"] += 1
            agg["pred_hit"] += t.get("hit_probability", 0.0)
            agg["races_hit"] += int(hit > 0)
            agg["expected_combo_hits"] += sum(c.get("p_model", 0.0) for c in t["combos"])
            agg["combo_hits"] += hit
            agg["cost"] += t.get("cost", 0.0)
            agg["expected_return"] += t.get("expected_return", 0.0)  # engine's dollars, at the ticket's base
            agg["return"] += (race.settlement["by_type"].get(kind) or {}).get("return", 0.0)
    for agg in out.values():
        n, cost = agg["tickets"], agg["cost"]
        agg.update(predicted_hit_rate=agg["pred_hit"] / n, actual_hit_rate=agg["races_hit"] / n,
                   predicted_roi=agg["expected_return"] / cost - 1 if cost else None,
                   actual_roi=agg["return"] / cost - 1 if cost else None)
    return out


def _calibration(rows: Sequence[dict], key: str) -> List[Dict[str, Any]]:
    out = []
    for lo, hi in zip(CALIBRATION_BINS, CALIBRATION_BINS[1:]):
        inside = [r for r in rows if lo <= r[key] < hi]
        if inside:
            out.append({"range": f"{lo:.0%}–{min(hi, 1):.0%}", "runners": len(inside),
                        "predicted": sum(r[key] for r in inside) / len(inside),
                        "actual": sum(r["won"] for r in inside) / len(inside)})
    return out


def _blend_data(races: Sequence[Race]) -> List[tuple]:
    """Per race: ([log p_paced, log p_public] per runner, index of the winner)."""
    data = []
    for race in races:
        rows = race.tickets.get("runners") or []
        nums = [r["program_num"] for r in rows]
        winner = race.result["finish"][0]
        if len(rows) < 2 or winner not in nums:
            continue
        paced = _paced(rows)
        X = [[math.log(max(p, 1e-6)), math.log(max(r["p_public"], 1e-6))] for r, p in zip(rows, paced)]
        data.append((X, nums.index(winner)))
    return data


def _race_log_loss(X: List[List[float]], winner: int, alpha: float, beta: float) -> float:
    scores = [alpha * x[0] + beta * x[1] for x in X]
    top = max(scores)
    return -(scores[winner] - top - math.log(sum(math.exp(s - top) for s in scores)))


def _fit_weights(engine, data: List[tuple]) -> tuple:
    model = engine.ConditionalLogitModel(l2=0.0, epochs=400).fit(data)
    return tuple(w / s for w, s in zip(model.weights, model.stds))  # back to raw log-probability units


def fit_blend(races: Sequence[Race], engine, current: tuple = (0.6, 0.4)) -> Optional[Dict[str, Any]]:
    """Benter's second stage: fit win ~ a*log(p_paced) + b*log(p_public) with the engine's
    ConditionalLogitModel, in BLEND_ALPHA / BLEND_BETA units. Also checks it out of sample:
    5-fold cross-validation compares the fitted weights with the current ones on races each fit
    never saw, and reports how much the weights move between folds."""
    data = _blend_data(races)
    if len(data) < MIN_RACES_FOR_FIT:
        return None
    alpha, beta = _fit_weights(engine, data)
    diffs, fold_fits = [], []
    for k in range(CV_FOLDS):
        train = [d for i, d in enumerate(data) if i % CV_FOLDS != k]
        test = [d for i, d in enumerate(data) if i % CV_FOLDS == k]
        a, b = _fit_weights(engine, train)
        fold_fits.append((a, b))
        diffs += [_race_log_loss(X, w, *current) - _race_log_loss(X, w, a, b) for X, w in test]
    n = len(diffs)
    gain = sum(diffs) / n
    se = math.sqrt(sum((d - gain) ** 2 for d in diffs) / (n - 1) / n)
    alphas, betas = [f[0] for f in fold_fits], [f[1] for f in fold_fits]
    stable = max(alphas) - min(alphas) <= MAX_FOLD_SPREAD and max(betas) - min(betas) <= MAX_FOLD_SPREAD
    return {
        "alpha": round(alpha, 3), "beta": round(beta, 3), "races": len(data),
        "current": {"alpha": current[0], "beta": current[1]},
        "cv_log_loss_current": round(sum(_race_log_loss(X, w, *current) for X, w in data) / len(data), 4),
        "cv_gain": round(gain, 4), "cv_gain_se": round(se, 4),
        "alpha_range": [round(min(alphas), 3), round(max(alphas), 3)],
        "beta_range": [round(min(betas), 3), round(max(betas), 3)],
        "stable": stable,
        "recommend": stable and gain > 2 * se,
    }


def summarize(races: Sequence[Race], tz_name: str, engine=None, current_blend: tuple = (0.6, 0.4)) -> Dict[str, Any]:
    settled = _settled(races)
    by_type: Dict[str, Dict[str, Any]] = {}
    for race in settled:
        for kind, t in race.settlement["by_type"].items():
            agg = by_type.setdefault(kind, {"bets": 0, "hits": 0, "cost": 0.0, "return": 0.0, "estimated": False})
            for k in ("bets", "hits", "cost", "return"):
                agg[k] += t[k]
            agg["estimated"] |= t.get("estimated", False)
    for t in by_type.values():
        t["profit"] = t["return"] - t["cost"]
        t["roi"] = t["profit"] / t["cost"] if t["cost"] else None
    cost = sum(t["cost"] for t in by_type.values())
    ret = sum(t["return"] for t in by_type.values())

    win_bets = [b for race in settled for b in race.settlement["bets"] if b["type"] == "win" and b["clv"] is not None]
    rows = history_rows(settled, tz_name)
    overlays = [r for r in rows if r["ev"] > 0 and r["odds_final"]]
    clv = {
        "win_bets": len(win_bets),
        "win_bet_clv": sum(b["clv"] for b in win_bets) / len(win_bets) if win_bets else None,
        "overlays": len(overlays),
        "overlay_clv": (sum(r["odds_at_pull"] / r["odds_final"] - 1 for r in overlays) / len(overlays)) if overlays else None,
        # Payouts use the final odds, so the engine's odds haircut should match how much an overlay's
        # odds-to-1 shrink between the pull and the off: haircut = 1 - (final - 1) / (pull - 1), median.
        "suggested_haircut": (round(statistics.median(1 - (r["odds_final"] - 1) / (r["odds_at_pull"] - 1)
                                                      for r in overlays if r["odds_at_pull"] > 1), 3)
                              if overlays else None),
    }
    log_loss = {k: _log_loss(settled, k) for k in ("p_true", "p_public", "p_paced", "p_fund")}
    blend = fit_blend(settled, engine, current_blend) if engine is not None else None
    return {
        "races": len(settled),
        "races_pending": sum(1 for r in races if r.status == "published" and r.result_status not in ("official", "unavailable")),
        "total": {"cost": cost, "return": ret, "profit": ret - cost, "roi": (ret - cost) / cost if cost else None},
        "by_type": by_type,
        "clv": clv,
        "log_loss": log_loss,
        "calibration": {"model": _calibration(rows, "p_true"), "public": _calibration(rows, "p_public")},
        "blend_fit": blend,
        "closing": closing_comparison(settled),
        "ev_buckets": ev_buckets(settled),
        "drift": drift_by_mtp(settled),
        "exotic_check": exotic_check(settled),
        "min_races_for_fit": MIN_RACES_FOR_FIT,
    }
