import math
from itertools import permutations
from typing import Dict, List, Optional, Sequence, Tuple

def to_decimal_odds(odds: float, fmt: str = "decimal") -> float:
    if fmt == "to1":
        return odds + 1.0
    if fmt == "decimal":
        return odds
    raise ValueError(f"Unknown odds format: {fmt!r} (use 'decimal' or 'to1')")

def softmax(scores: Sequence[float]) -> List[float]:
    m = max(scores)
    exps = [math.exp(s - m) for s in scores]
    total = sum(exps)
    return [e / total for e in exps]

def normalize(values: Sequence[float]) -> List[float]:
    total = sum(values)
    if total <= 0:
        raise ValueError("Cannot normalize: non-positive total")
    return [v / total for v in values]

def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))

class PaceAndEnergyAnalyzer:
    SCENARIO_MODS: Dict[str, Dict[str, float]] = {
        "FAST_PACED_COLLAPSE": {"early": -0.15, "stalker": +0.05, "closer": +0.15},
        "LONE_SPEED_SOFT": {"early": +0.15, "stalker": 0.00, "closer": -0.10},
        "BALANCED_PACE": {"early": 0.00, "stalker": 0.00, "closer": 0.00},
    }
    STYLE_GROUP = {"E": "early", "P": "stalker", "S": "closer"}

    def __init__(
        self,
        optimum_pct_early: float = 52.5,
        fast_threshold: float = 20,
        soft_threshold: float = 12,
        pct_early_sensitivity: float = 0.03,
        max_modifier: float = 0.5,
    ):
        self.optimum_pct_early = optimum_pct_early
        self.fast_threshold = fast_threshold
        self.soft_threshold = soft_threshold
        self.pct_early_sensitivity = pct_early_sensitivity
        self.max_modifier = max_modifier

    def calculate_percent_early(self, call1_fps: float, call2_fps: float, final_fps: float) -> float:
        early = (call1_fps + call2_fps) / 2.0
        total = early + final_fps
        if total <= 0:
            return 0.0
        return early / total * 100.0

    def evaluate_quirin_pace_scenario(self, runners_qsp: Sequence[float]) -> dict:
        top3 = sum(sorted(runners_qsp, reverse=True)[:3])
        if top3 >= self.fast_threshold:
            scenario = "FAST_PACED_COLLAPSE"
            desc = f"Pace duel (top 3 QSP = {top3} >= {self.fast_threshold}). Early speed expected to tire."
        elif top3 <= self.soft_threshold:
            scenario = "LONE_SPEED_SOFT"
            desc = f"Soft pace (top 3 QSP = {top3} <= {self.soft_threshold}). Front-runner advantage."
        else:
            scenario = "BALANCED_PACE"
            desc = f"Balanced pace (top 3 QSP = {top3})."
        return {"top_3_qsp_sum": top3, "scenario": scenario, "description": desc}

    def style_modifier(self, style: str, scenario: str, pct_early: float) -> float:
        mods = self.SCENARIO_MODS[scenario]
        if style == "E/P":
            base = 0.5 * mods["early"] + 0.5 * mods["stalker"]
        elif style in self.STYLE_GROUP:
            base = mods[self.STYLE_GROUP[style]]
        else:
            raise ValueError(f"Unknown running style: {style!r} (use E, E/P, P, S)")

        pct_dir = -1.0 if scenario == "FAST_PACED_COLLAPSE" else (1.0 if scenario == "LONE_SPEED_SOFT" else 0.0)
        deviation = (pct_early - self.optimum_pct_early) / 10.0
        extra = self.pct_early_sensitivity * deviation * pct_dir
        return clamp(base + extra, -self.max_modifier, self.max_modifier)

    def adjust_probabilities(self, runners: List[dict], p_fund: Sequence[float]) -> Tuple[List[float], dict]:
        pace = self.evaluate_quirin_pace_scenario([r["qsp"] for r in runners])
        adjusted = []
        for r, p in zip(runners, p_fund):
            r["pct_early"] = self.calculate_percent_early(r.get("call1_fps", 55.0), r.get("call2_fps", 55.0), r.get("final_fps", 50.0))
            r["pace_mod"] = self.style_modifier(r["style"], pace["scenario"], r["pct_early"])
            adjusted.append(max(0.001, p * (1.0 + r["pace_mod"])))
        return normalize(adjusted), pace

class ConditionalLogitModel:
    def __init__(self, l2: float = 0.01, lr: float = 0.5, epochs: int = 150):
        self.l2 = l2
        self.lr = lr
        self.epochs = epochs
        self.weights: List[float] = []
        self.means: List[float] = []
        self.stds: List[float] = []

    def _standardize(self, x: Sequence[float]) -> List[float]:
        return [(v - m) / s for v, m, s in zip(x, self.means, self.stds)]

    def fit(self, races: List[Tuple[List[List[float]], int]]) -> "ConditionalLogitModel":
        if not races:
            raise ValueError("No training races")
        d = len(races[0][0][0])
        flat = [x for X, _ in races for x in X]
        self.means = [sum(x[j] for x in flat) / len(flat) for j in range(d)]
        self.stds = []
        for j in range(d):
            var = sum((x[j] - self.means[j]) ** 2 for x in flat) / len(flat)
            self.stds.append(math.sqrt(var) or 1.0)

        data = [([self._standardize(x) for x in X], w) for X, w in races]
        w = [0.0] * d
        n = len(data)
        for _ in range(self.epochs):
            grad = [0.0] * d
            for X, win in data:
                p = softmax([sum(wj * xj for wj, xj in zip(w, x)) for x in X])
                for j in range(d):
                    grad[j] += X[win][j] - sum(pi * x[j] for pi, x in zip(p, X))
            w = [wj + self.lr * (g / n - self.l2 * wj) for wj, g in zip(w, grad)]
        self.weights = w
        return self

    def predict_proba(self, X: List[List[float]]) -> List[float]:
        scores = [sum(wj * xj for wj, xj in zip(self.weights, self._standardize(x))) for x in X]
        return softmax(scores)

class BenterProbabilityBlender:
    def __init__(self, alpha: float = 0.6, beta: float = 0.4, takeout_rate: float = 0.17, odds_format: str = "decimal"):
        self.alpha = alpha
        self.beta = beta
        self.takeout_rate = takeout_rate
        self.odds_format = odds_format
        self.last_overround: Optional[float] = None

    def public_probabilities(self, odds_list: Sequence[float]) -> List[float]:
        decimal = [to_decimal_odds(o, self.odds_format) for o in odds_list]
        if any(d <= 1.0 for d in decimal):
            raise ValueError("All decimal odds must be > 1.0")
        raw = [1.0 / d for d in decimal]
        total = sum(raw)
        self.last_overround = total
        return [r / total for r in raw]

    @staticmethod
    def _log(p: float) -> float:
        return math.log(max(p, 1e-6))

    def blend(self, p_fund: Sequence[float], p_pub: Sequence[float], alpha: Optional[float] = None, beta: Optional[float] = None) -> List[float]:
        a = self.alpha if alpha is None else alpha
        b = self.beta if beta is None else beta
        scores = [a * self._log(f) + b * self._log(p) for f, p in zip(p_fund, p_pub)]
        return softmax(scores)

    def blend_from_odds(self, p_fund: Sequence[float], odds_list: Sequence[float]) -> List[float]:
        return self.blend(p_fund, self.public_probabilities(odds_list))

class KellyBankrollManager:
    def __init__(self, bankroll: float = 10000.0, fractional_kelly: float = 0.25, max_race_exposure: float = 0.05, odds_haircut: float = 0.05):
        self.bankroll = bankroll
        self.fractional_kelly = fractional_kelly
        self.max_race_exposure = max_race_exposure
        self.odds_haircut = odds_haircut

    def effective_odds(self, decimal_odds: float) -> float:
        return 1.0 + (decimal_odds - 1.0) * (1.0 - self.odds_haircut)

    @staticmethod
    def calculate_ev(p_true: float, decimal_odds: float) -> float:
        return p_true * decimal_odds - 1.0

    @staticmethod
    def simultaneous_kelly(p: Sequence[float], d: Sequence[float]) -> List[float]:
        n = len(p)
        order = sorted(range(n), key=lambda i: p[i] * d[i], reverse=True)
        chosen: List[int] = []
        sum_p, sum_inv, reserve = 0.0, 0.0, 1.0
        for i in order:
            if p[i] * d[i] <= reserve:
                break
            new_sum_p, new_sum_inv = sum_p + p[i], sum_inv + 1.0 / d[i]
            if new_sum_inv >= 1.0:
                break
            chosen.append(i)
            sum_p, sum_inv = new_sum_p, new_sum_inv
            reserve = (1.0 - sum_p) / (1.0 - sum_inv)
        f = [0.0] * n
        for i in chosen:
            f[i] = max(0.0, p[i] - reserve / d[i])
        return f

    def evaluate_field(self, runners: List[dict]) -> List[dict]:
        p = [r["p_true"] for r in runners]
        d_quoted = [r["odds"] for r in runners]
        d_eff = [self.effective_odds(x) for x in d_quoted]

        full = self.simultaneous_kelly(p, d_eff)
        rec = [f * self.fractional_kelly for f in full]
        total = sum(rec)
        if total > self.max_race_exposure:
            scale = self.max_race_exposure / total
            rec = [x * scale for x in rec]

        out = []
        for r, f_full, f_rec, de in zip(runners, full, rec, d_eff):
            out.append({
                "program_num": r["program_num"],
                "name": r["name"],
                "p_true": r["p_true"],
                "odds": r["odds"],
                "implied_prob": 1.0 / r["odds"],
                "ev": self.calculate_ev(r["p_true"], de),
                "ev_quoted": self.calculate_ev(r["p_true"], r["odds"]),
                "full_kelly_pct": f_full * 100,
                "fractional_kelly_pct": f_rec * 100,
                "recommended_stake": self.bankroll * f_rec,
            })
        return out

class ExoticEVEngine:
    TAKEOUT_DEFAULTS = {"exacta": 0.20, "superfecta": 0.24}
    DEPTH = {"exacta": 2, "superfecta": 4}

    def __init__(self, lambdas: Sequence[float] = (1.0, 0.85, 0.75, 0.70), takeouts: Optional[Dict[str, float]] = None):
        self.lambdas = tuple(lambdas)
        self.takeouts = dict(self.TAKEOUT_DEFAULTS)
        if takeouts:
            self.takeouts.update(takeouts)

    def order_probability(self, probs: Sequence[float], order: Sequence[int]) -> float:
        remaining = set(range(len(probs)))
        result = 1.0
        for k, idx in enumerate(order):
            lam = self.lambdas[min(k, len(self.lambdas) - 1)]
            denom = sum(probs[j] ** lam for j in remaining)
            result *= (probs[idx] ** lam) / denom
            remaining.remove(idx)
        return result

    def combo_probabilities(self, probs: Sequence[float], depth: int) -> Dict[Tuple[int, ...], float]:
        return {o: self.order_probability(probs, o) for o in permutations(range(len(probs)), depth)}

    def build_ticket(self, bet_type: str, p_model: Sequence[float], p_pub: Sequence[float], base: float, budget: float, min_edge: float = 0.10, min_combo_prob: float = 0.002, pool_payouts: Optional[Dict[Tuple[int, ...], float]] = None) -> dict:
        if bet_type not in self.DEPTH:
            raise ValueError("bet_type must be 'exacta' or 'superfecta'")
        depth = self.DEPTH[bet_type]
        if len(p_model) < depth:
            raise ValueError(f"Need at least {depth} runners for a {bet_type}")
        takeout = self.takeouts[bet_type]

        pm = self.combo_probabilities(p_model, depth)
        pp = self.combo_probabilities(p_pub, depth)

        candidates = []
        for combo, p_c in pm.items():
            if p_c < min_combo_prob:
                continue
            if pool_payouts and combo in pool_payouts:
                payout = pool_payouts[combo]
            else:
                payout = (1.0 - takeout) / max(pp[combo], 1e-6)
            ev = p_c * payout - 1.0
            if ev >= min_edge:
                candidates.append((ev, combo, p_c, payout))
        candidates.sort(key=lambda c: c[0], reverse=True)
        max_combos = int(budget // base) if base > 0 else 0
        chosen = candidates[:max_combos]

        cost = len(chosen) * base
        expected_return = sum(p_c * payout * base for _, _, p_c, payout in chosen)
        return {
            "bet_type": bet_type,
            "combos": [{"combo": c, "p_model": p, "est_payout_per_$1": pay, "ev_per_$1": ev} for ev, c, p, pay in chosen],
            "n_candidates_passing": len(candidates),
            "cost": cost,
            "hit_probability": sum(p for _, _, p, _ in chosen),
            "expected_return": expected_return,
            "expected_profit": expected_return - cost,
            "roi": (expected_return - cost) / cost if cost > 0 else 0.0,
        }

def categorize_runners(evaluated: List[dict]) -> Dict[str, List[int]]:
    by_prob = sorted(evaluated, key=lambda r: r["p_true"], reverse=True)
    by_ev = sorted(evaluated, key=lambda r: r["ev"], reverse=True)
    a = {by_ev[0]["program_num"], by_prob[0]["program_num"]}
    a |= {r["program_num"] for r in evaluated if r["ev"] >= 0.15}
    b = {r["program_num"] for r in by_prob[:4]} - a
    b |= {r["program_num"] for r in evaluated if r["ev"] >= -0.10 and r["program_num"] not in a}
    all_nums = {r["program_num"] for r in evaluated}
    c = all_nums - a - b
    return {"A": sorted(a), "B": sorted(b), "C": sorted(c), "X": sorted(all_nums)}
