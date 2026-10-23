"""How the tickets did once results are in: settlement per race, and performance across races.

All tickets are settled as if they were bet as printed (paper trading).
"""
import math
from typing import Any, Dict, List, Optional, Sequence

from .models import Race

CALIBRATION_BINS = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.0001]
MIN_RACES_FOR_FIT = 100


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


def _calibration(rows: Sequence[dict], key: str) -> List[Dict[str, Any]]:
    out = []
    for lo, hi in zip(CALIBRATION_BINS, CALIBRATION_BINS[1:]):
        inside = [r for r in rows if lo <= r[key] < hi]
        if inside:
            out.append({"range": f"{lo:.0%}–{min(hi, 1):.0%}", "runners": len(inside),
                        "predicted": sum(r[key] for r in inside) / len(inside),
                        "actual": sum(r["won"] for r in inside) / len(inside)})
    return out


def fit_blend(races: Sequence[Race], engine) -> Optional[Dict[str, float]]:
    """Benter's second stage: fit win ~ a*log(p_paced) + b*log(p_public) with the engine's
    ConditionalLogitModel. Returns the weights in BLEND_ALPHA / BLEND_BETA units."""
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
    if len(data) < MIN_RACES_FOR_FIT:
        return None
    model = engine.ConditionalLogitModel(l2=0.0, epochs=400).fit(data)
    alpha, beta = (w / s for w, s in zip(model.weights, model.stds))
    return {"alpha": round(alpha, 3), "beta": round(beta, 3), "races": len(data)}


def summarize(races: Sequence[Race], tz_name: str, engine=None) -> Dict[str, Any]:
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
    }
    log_loss = {k: _log_loss(settled, k) for k in ("p_true", "p_public", "p_paced", "p_fund")}
    blend = fit_blend(settled, engine) if engine is not None else None
    return {
        "races": len(settled),
        "races_pending": sum(1 for r in races if r.status == "published" and r.result_status not in ("official", "unavailable")),
        "total": {"cost": cost, "return": ret, "profit": ret - cost, "roi": (ret - cost) / cost if cost else None},
        "by_type": by_type,
        "clv": clv,
        "log_loss": log_loss,
        "calibration": {"model": _calibration(rows, "p_true"), "public": _calibration(rows, "p_public")},
        "blend_fit": blend,
        "min_races_for_fit": MIN_RACES_FOR_FIT,
    }
