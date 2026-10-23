from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

from ..models import Race, ToteSnapshot


class ToteUnavailable(Exception):
    """The source could not produce odds for this race right now."""


class ToteSource(ABC):
    name = "base"

    @abstractmethod
    async def fetch(self, race: Race) -> ToteSnapshot:
        """Return the current win odds (decimal), scratches and, if known, the current post time."""

    async def fetch_result(self, race: Race) -> Optional[Dict[str, Any]]:
        """The official result (see Race.result for the shape), or None if not official yet.
        Sources that can't report results return None forever."""
        return None

    async def aclose(self) -> None:
        pass
