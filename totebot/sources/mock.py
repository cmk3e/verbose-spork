import math
import random
from typing import Any, Dict, List, Optional

from ..models import Race, ToteSnapshot, utcnow
from ..odds import parse_odds
from .base import ToteSource


class MockToteSource(ToteSource):
    """Simulated tote that drifts every call; for trying the app before a real feed is wired up."""

    name = "mock"

    def __init__(self, takeout: float = 0.17, volatility: float = 0.35, seed: Optional[int] = None):
        self.takeout = takeout
        self.volatility = volatility
        self.rng = random.Random(seed)

    def _base_prob(self, race: Race):
        runners = [r for r in race.runners if not r.scratched]
        if all(r.ml_odds for r in runners):
            raw = [1.0 / parse_odds(r.ml_odds) for r in runners]
        elif all(r.p_fund is not None for r in runners):
            raw = [max(r.p_fund, 1e-3) for r in runners]
        else:
            raw = [1.0] * len(runners)
        return runners, raw

    async def fetch(self, race: Race) -> ToteSnapshot:
        runners, raw = self._base_prob(race)
        noisy = [p * math.exp(self.rng.gauss(0, self.volatility)) for p in raw]
        total = sum(noisy)
        odds = {}
        for r, p in zip(runners, noisy):
            to1 = (1.0 - self.takeout) / (p / total) - 1.0
            # tote rounds down to the nearest 0.1 below 10-1, whole numbers above
            to1 = math.floor(to1 * 10) / 10 if to1 < 10 else math.floor(to1)
            odds[r.program_num] = max(1.1, to1 + 1.0)
        return ToteSnapshot(taken_at=utcnow(), win_odds=odds, source=self.name)

    async def fetch_result(self, race: Race) -> Optional[Dict[str, Any]]:
        return simulate_result(self.rng, race, self.name)


def _sample_finish(rng: random.Random, probs: Dict[str, float]) -> List[str]:
    """Finish order drawn horse by horse in proportion to win probability (Harville)."""
    left = dict(probs)
    order = []
    while left:
        pick, total, acc = rng.random() * sum(left.values()), 0.0, None
        for num, p in left.items():
            total += p
            if pick <= total:
                acc = num
                break
        acc = acc or next(iter(left))
        order.append(acc)
        del left[acc]
    return order


def simulate_result(rng: random.Random, race: Race, source: str = "mock") -> Optional[Dict[str, Any]]:
    """Simulated official result once the race is two minutes past post."""
    if race.snapshot is None or race.mtp() > -2:
        return None
    final = {n: max(1.1, d * math.exp(rng.gauss(0, 0.15))) for n, d in race.snapshot.win_odds.items()}
    probs = {n: 1.0 / d for n, d in final.items()}
    total = sum(probs.values())
    probs = {n: p / total for n, p in probs.items()}
    finish = _sample_finish(rng, probs)
    payoffs: Dict[str, Dict[str, float]] = {"win": {finish[0]: round(final[finish[0]], 2)}}
    p1, p2 = probs[finish[0]], probs[finish[1]]
    payoffs["exacta"] = {f"{finish[0]}-{finish[1]}": round(0.80 / (p1 * p2 / (1 - p1)), 2)}
    if len(finish) >= 4:
        p3, p4 = probs[finish[2]], probs[finish[3]]
        p = p1 * p2 / (1 - p1) * p3 / (1 - p1 - p2) * p4 / (1 - p1 - p2 - p3)
        payoffs["superfecta"] = {"-".join(finish[:4]): round(0.76 / p, 2)}
    return {"official_at": utcnow().isoformat(), "finish": finish, "final_odds": final,
            "scratched": list(race.snapshot.scratched), "payoffs": payoffs, "source": source}
