from ..models import Race, ToteSnapshot
from .base import ToteSource, ToteUnavailable


class ManualToteSource(ToteSource):
    """Uses whatever odds were last pushed to POST /api/races/{id}/tote.

    Lets any outside scraper or script (or you, typing from the iPad) feed the tote in.
    """

    name = "manual"

    async def fetch(self, race: Race) -> ToteSnapshot:
        if race.manual_tote is None:
            raise ToteUnavailable("No odds have been pushed for this race yet")
        return race.manual_tote
