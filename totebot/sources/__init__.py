from ..config import Settings
from .base import ToteSource, ToteUnavailable
from .http_json import HttpJsonToteSource
from .manual import ManualToteSource
from .mock import MockToteSource
from .tvg import TvgToteSource


def build_source(settings: Settings) -> ToteSource:
    kind = settings.tote_source
    if kind == "mock":
        return MockToteSource()
    if kind == "manual":
        return ManualToteSource()
    if kind == "http":
        return HttpJsonToteSource(settings)
    if kind == "tvg":
        return TvgToteSource(settings.tvg_wager_profile, settings.http_timeout_s)
    raise ValueError(f"Unknown TOTE_SOURCE {kind!r} (use tvg, mock, manual or http)")


__all__ = ["ToteSource", "ToteUnavailable", "build_source", "HttpJsonToteSource", "ManualToteSource", "MockToteSource", "TvgToteSource"]
