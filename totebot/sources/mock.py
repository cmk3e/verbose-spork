import math
import random
from typing import Optional

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
