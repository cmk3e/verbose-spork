from abc import ABC, abstractmethod

from ..models import Race, ToteSnapshot


class ToteUnavailable(Exception):
    """The source could not produce odds for this race right now."""


class ToteSource(ABC):
    name = "base"

    @abstractmethod
    async def fetch(self, race: Race) -> ToteSnapshot:
        """Return the current win odds (decimal), scratches and, if known, the current post time."""

    async def aclose(self) -> None:
        pass
