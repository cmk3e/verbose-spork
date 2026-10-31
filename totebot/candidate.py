"""Candidate model: Benter's full method on everything Totebot records.

The engine's ConditionalLogitModel is fitted on, per horse, the public's odds at the pull plus the
recorded handicapping numbers and odds movement (only things known at bet time). It's judged out of
sample (5-fold) against the current model and against the final odds, and only meant to replace the
current model once it beats the final odds on races it never saw.
"""
import json
import logging
import math
import statistics
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .models import Race, utcnow

log = logging.getLogger(__name__)

MIN_RACES = 500           # before this the weights are mostly noise
MIN_RACES_TO_SHOW = 100   # below this there's nothing worth showing
CV_FOLDS = 5
EPOCHS = 150
L2 = 0.01                 # mild shrinkage: many inputs, few races


def _log(x: Optional[float]) -> Optional[float]:
    return math.log(max(x, 1e-6)) if x is not None else None


def _rate(wins: Optional[float], starts: Optional[float]) -> Optional[float]:
    """Win rate shrunk toward ~12% so a 1-for-1 record doesn't count as 100%."""
    if wins is None or starts is None:
        return None
    return (wins + 1) / (starts + 8)


def _stat(name: str) -> Callable[[dict], Optional[float]]:
    return lambda row: (row.get("stats") or {}).get(name)


# name -> how to read it from a ticket row. Only things known when the tote is pulled.
FEATURES: List[Tuple[str, Callable[[dict], Optional[float]]]] = [
    ("public odds at pull (log prob)", lambda r: _log(r.get("p_public"))),
    ("your fundamentals (log prob)", lambda r: _log(r.get("p_fund"))),
    ("pace adjustment", lambda r: math.log1p(r["pace_mod"]) if r.get("pace_mod") is not None else None),
    ("best speed, last 3", _stat("best_speed_3")),
    ("last speed", _stat("last_speed")),
    ("early pace (E1)", _stat("avg_e1")),
    ("late pace (LP)", _stat("avg_lp")),
    ("days off (log)", lambda r: math.log1p(_stat("days_off")(r)) if _stat("days_off")(r) is not None else None),
    ("surface win rate", lambda r: _rate(_stat("surface_wins")(r), _stat("surface_starts")(r))),
    ("career win rate", lambda r: _rate(_stat("life_wins")(r), _stat("life_starts")(r))),
    ("jockey win %", _stat("jockey_win_pct")),
    ("trainer win %", _stat("trainer_win_pct")),
    ("QuickPlay + minus -", lambda r: (_stat("qp_positive")(r) - _stat("qp_negative")(r))
     if _stat("qp_positive")(r) is not None and _stat("qp_negative")(r) is not None else None),
    ("steam since morning line", _stat("steam_ml")),
    ("steam, last ~10 min", _stat("steam_10m")),
]
FEATURE_NAMES = [name for name, _ in FEATURES]


def race_matrix(rows: Sequence[dict]) -> List[List[float]]:
    """Feature matrix for one race. A missing value gets the race median of that feature (or 0 if
    nobody has it): the model compares horses within a race, so a fill that's the same for
    everyone carries no signal either way."""
    raw = [[get(r) for _, get in FEATURES] for r in rows]
    for j in range(len(FEATURES)):
        have = [x[j] for x in raw if x[j] is not None]
        fill = statistics.median(have) if have else 0.0
        for x in raw:
            if x[j] is None:
                x[j] = fill
    return raw


def has_extra_data(race: Race) -> bool:
    rows = race.tickets.get("runners") or []
    with_figs = [r for r in rows if any(_stat(k)(r) is not None for k in ("best_speed_3", "avg_lp", "days_off"))]
    return bool(rows) and 2 * len(with_figs) >= len(rows)


def training_data(races: Sequence[Race]) -> List[Tuple[List[List[float]], int, Race]]:
    from .performance import unique_races

    out = []
    for race in unique_races(races):
        if not (race.result and race.tickets and race.result.get("finish")) or not has_extra_data(race):
            continue
        rows = race.tickets.get("runners") or []
        nums = [r["program_num"] for r in rows]
        winner = race.result["finish"][0]
        if len(rows) >= 2 and winner in nums:
            out.append((race_matrix(rows), nums.index(winner), race))
    return out


def _model_loss(model, X: List[List[float]], winner: int) -> float:
    return -math.log(max(model.predict_proba(X)[winner], 1e-9))


def _final_loss(race: Race, winner_num: str) -> Optional[float]:
    final = race.result.get("final_odds") or {}
    inv = {r["program_num"]: 1 / final[r["program_num"]] for r in race.tickets["runners"] if final.get(r["program_num"])}
    if winner_num not in inv:
        return None
    return -math.log(inv[winner_num] / sum(inv.values()))


def _gain(diffs: List[float]) -> Tuple[float, float]:
    mean = sum(diffs) / len(diffs)
    se = math.sqrt(sum((d - mean) ** 2 for d in diffs) / (len(diffs) - 1) / len(diffs)) if len(diffs) > 1 else float("inf")
    return mean, se


def evaluate(races: Sequence[Race], engine) -> Dict[str, Any]:
    """Fit on all races with the extra data, test out of sample, and give a verdict."""
    data = training_data(races)
    report: Dict[str, Any] = {"races": len(data), "min_races": MIN_RACES, "fitted_at": utcnow().isoformat()}
    if len(data) < MIN_RACES_TO_SHOW:
        report["verdict"] = "not enough data"
        return report
    fit = lambda rows: engine.ConditionalLogitModel(l2=L2, epochs=EPOCHS).fit([(X, w) for X, w, _ in rows])
    full = fit(data)
    vs_current, vs_final, losses = [], [], []
    for k in range(CV_FOLDS):
        model = fit([d for i, d in enumerate(data) if i % CV_FOLDS != k])
        for X, w, race in (d for i, d in enumerate(data) if i % CV_FOLDS == k):
            cand = _model_loss(model, X, w)
            losses.append(cand)
            current = -math.log(max(race.tickets["runners"][w]["p_true"], 1e-9))
            vs_current.append(current - cand)
            final = _final_loss(race, race.tickets["runners"][w]["program_num"])
            if final is not None:
                vs_final.append(final - cand)
    gain_current, se_current = _gain(vs_current)
    gain_final, se_final = _gain(vs_final) if vs_final else (None, None)
    beats_final = gain_final is not None and gain_final > 2 * se_final
    beats_current = gain_current > 2 * se_current
    if len(data) < MIN_RACES:
        verdict = "not enough data"
    elif beats_final and beats_current:
        verdict = "ready"
    else:
        verdict = "doesn't beat the final odds" if not beats_final else "doesn't beat the current model"
    report.update(
        verdict=verdict,
        log_loss=sum(losses) / len(losses),
        gain_vs_current=gain_current, gain_vs_current_se=se_current,
        gain_vs_final=gain_final, gain_vs_final_se=se_final, races_with_final=len(vs_final),
        weights=[{"feature": n, "weight": round(w, 4)} for n, w in zip(FEATURE_NAMES, full.weights)],
        model={"features": FEATURE_NAMES, "weights": full.weights, "means": full.means, "stds": full.stds},
    )
    return report


# --- persistence and live use ---------------------------------------------------

def report_path(data_dir: Path) -> Path:
    return Path(data_dir) / "candidate_model.json"


def save(report: Dict[str, Any], data_dir: Path) -> None:
    path = report_path(data_dir)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(report))
    tmp.replace(path)


def load(data_dir: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(report_path(data_dir).read_text())
    except (OSError, ValueError):
        return None


def predict(report: Dict[str, Any], engine, rows: Sequence[dict]) -> Optional[List[float]]:
    """Win probabilities for one race from a saved fit, or None if it can't be used."""
    spec = report.get("model") or {}
    if spec.get("features") != FEATURE_NAMES:
        return None  # fitted on a different feature set; refit first
    model = engine.ConditionalLogitModel()
    model.weights, model.means, model.stds = spec["weights"], spec["means"], spec["stds"]
    return model.predict_proba(race_matrix(rows))
