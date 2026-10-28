import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


@dataclass
class Settings:
    data_dir: Path = Path("data")
    timezone: str = "America/New_York"
    username: str = "admin"
    password: str = ""
    public_url: str = ""

    # Where live odds come from: tvg | mock | manual | http
    tote_source: str = "mock"
    engine_module: str = "horseplay_betting_engine_v3"
    tvg_wager_profile: str = "PORT-Generic"

    # Timing (minutes to post)
    fetch_mtp: float = 3.0
    publish_mtp: float = 2.0
    prepoll_mtp: float = 20.0
    prepoll_interval_s: float = 60.0
    missed_after_mtp: float = -5.0
    tick_seconds: float = 5.0

    # Probability model
    alpha: float = 0.6
    beta: float = 0.4
    rating_scale: float = 8.0
    training_file: str = ""

    # Bankroll
    bankroll: float = 1000.0
    fractional_kelly: float = 0.25
    max_race_exposure: float = 0.05
    odds_haircut: float = 0.05
    min_win_bet: float = 2.0
    max_pool_share: float = 0.02         # cap each win bet at this share of the win pool
    surface_change_action: str = "flag"  # flag | skip (no bets) when a race comes off the turf
    candidate_model: str = "off"         # on: tickets use the fitted candidate model instead of the blend

    # Exotics
    exacta_base: float = 1.0
    exacta_budget: float = 20.0
    superfecta_base: float = 0.10
    superfecta_budget: float = 12.0
    min_edge: float = 0.10
    min_combo_prob_exacta: float = 0.002
    min_combo_prob_superfecta: float = 0.002
    exacta_takeout: float = 0.20
    superfecta_takeout: float = 0.24

    # Push notifications (https://ntfy.sh)
    ntfy_server: str = "https://ntfy.sh"
    ntfy_topic: str = ""

    # Generic HTTP/JSON tote source
    http_url: str = ""
    http_headers: Dict[str, str] = field(default_factory=dict)
    http_runners_path: str = "runners"
    http_program_field: str = "program_number"
    http_odds_field: str = "odds"
    http_scratch_field: str = "scratched"
    http_post_time_path: str = ""
    http_exacta_path: str = ""
    http_exacta_base: float = 2.0
    http_odds_format: str = "to1"
    http_timeout_s: float = 10.0

    @classmethod
    def from_env(cls) -> "Settings":
        headers_raw = _env("TOTE_HTTP_HEADERS")
        return cls(
            data_dir=Path(_env("DATA_DIR", "data")),
            timezone=_env("APP_TZ", "America/New_York"),
            username=_env("APP_USERNAME", "admin"),
            password=_env("APP_PASSWORD"),
            public_url=_env("PUBLIC_URL").rstrip("/"),
            tote_source=_env("TOTE_SOURCE", "mock").lower(),
            engine_module=_env("ENGINE_MODULE", "horseplay_betting_engine_v3"),
            tvg_wager_profile=_env("TVG_WAGER_PROFILE", "PORT-Generic"),
            fetch_mtp=_float("FETCH_MTP", 3.0),
            publish_mtp=_float("PUBLISH_MTP", 2.0),
            prepoll_mtp=_float("PREPOLL_MTP", 20.0),
            prepoll_interval_s=_float("PREPOLL_INTERVAL_S", 60.0),
            missed_after_mtp=_float("MISSED_AFTER_MTP", -5.0),
            tick_seconds=_float("TICK_SECONDS", 5.0),
            alpha=_float("BLEND_ALPHA", 0.6),
            beta=_float("BLEND_BETA", 0.4),
            rating_scale=_float("RATING_SCALE", 8.0),
            training_file=_env("TRAINING_FILE"),
            bankroll=_float("BANKROLL", 1000.0),
            fractional_kelly=_float("FRACTIONAL_KELLY", 0.25),
            max_race_exposure=_float("MAX_RACE_EXPOSURE", 0.05),
            odds_haircut=_float("ODDS_HAIRCUT", 0.05),
            min_win_bet=_float("MIN_WIN_BET", 2.0),
            max_pool_share=_float("MAX_POOL_SHARE", 0.02),
            surface_change_action=_env("SURFACE_CHANGE_ACTION", "flag").lower(),
            candidate_model=_env("CANDIDATE_MODEL", "off").lower(),
            exacta_base=_float("EXACTA_BASE", 1.0),
            exacta_budget=_float("EXACTA_BUDGET", 20.0),
            superfecta_base=_float("SUPERFECTA_BASE", 0.10),
            superfecta_budget=_float("SUPERFECTA_BUDGET", 12.0),
            min_edge=_float("MIN_EDGE", 0.10),
            min_combo_prob_exacta=_float("MIN_COMBO_PROB_EXACTA", 0.002),
            min_combo_prob_superfecta=_float("MIN_COMBO_PROB_SUPERFECTA", 0.002),
            exacta_takeout=_float("EXACTA_TAKEOUT", 0.20),
            superfecta_takeout=_float("SUPERFECTA_TAKEOUT", 0.24),
            ntfy_server=_env("NTFY_SERVER", "https://ntfy.sh").rstrip("/"),
            ntfy_topic=_env("NTFY_TOPIC"),
            http_url=_env("TOTE_HTTP_URL"),
            http_headers=json.loads(headers_raw) if headers_raw else {},
            http_runners_path=_env("TOTE_HTTP_RUNNERS_PATH", "runners"),
            http_program_field=_env("TOTE_HTTP_PROGRAM_FIELD", "program_number"),
            http_odds_field=_env("TOTE_HTTP_ODDS_FIELD", "odds"),
            http_scratch_field=_env("TOTE_HTTP_SCRATCH_FIELD", "scratched"),
            http_post_time_path=_env("TOTE_HTTP_POST_TIME_PATH"),
            http_exacta_path=_env("TOTE_HTTP_EXACTA_PATH"),
            http_exacta_base=_float("TOTE_HTTP_EXACTA_BASE", 2.0),
            http_odds_format=_env("TOTE_HTTP_ODDS_FORMAT", "to1"),
            http_timeout_s=_float("TOTE_HTTP_TIMEOUT_S", 10.0),
        )

    def public(self) -> dict:
        """Non-secret settings, safe to show in the UI."""
        return {
            "timezone": self.timezone,
            "tote_source": self.tote_source,
            "engine_module": self.engine_module,
            "fetch_mtp": self.fetch_mtp,
            "publish_mtp": self.publish_mtp,
            "bankroll": self.bankroll,
            "fractional_kelly": self.fractional_kelly,
            "max_race_exposure": self.max_race_exposure,
            "alpha": self.alpha,
            "beta": self.beta,
            "exacta": {"base": self.exacta_base, "budget": self.exacta_budget},
            "superfecta": {"base": self.superfecta_base, "budget": self.superfecta_budget},
            "push_enabled": bool(self.ntfy_topic),
        }


_settings: Optional[Settings] = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings
