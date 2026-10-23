"""Parsing tote odds into decimal odds (stake included)."""

import re
from typing import Optional, Tuple, Union

_FRACTION = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[-/]\s*(\d+(?:\.\d+)?)\s*$")


def parse_odds(value: Union[str, float, int, None], numeric_format: str = "to1") -> Optional[float]:
    """Convert a tote odds value to decimal odds, or None if not bettable.

    Accepts "5-2", "5/2", "EVN"/"EVEN", "9-5", and bare numbers. Tote boards
    show bare numbers as odds-to-1 ("5" = 5-1 = 6.0 decimal), so that is the
    default; pass numeric_format="decimal" if your feed sends decimal odds.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        num = float(value)
        if num <= 0:
            return None
        return num + 1.0 if numeric_format == "to1" else (num if num > 1.0 else None)

    text = str(value).strip().upper()
    if not text or text in {"SCR", "SCRATCHED", "-", "--", "N/A"}:
        return None
    if text in {"EVN", "EVEN", "EVENS"}:
        return 2.0
    m = _FRACTION.match(text)
    if m:
        num, den = float(m.group(1)), float(m.group(2))
        if den <= 0 or num <= 0:
            return None
        return 1.0 + num / den
    try:
        return parse_odds(float(text), numeric_format)
    except ValueError:
        return None


# Odds-to-1 values a US tote board displays below 5-1; above that, whole numbers.
_LADDER = [(1, 9), (1, 5), (2, 5), (1, 2), (3, 5), (4, 5), (1, 1), (6, 5), (7, 5), (3, 2),
           (8, 5), (9, 5), (2, 1), (5, 2), (3, 1), (7, 2), (4, 1), (9, 2)]


def tote_ladder(decimal_odds: float) -> Tuple[int, int]:
    """Round decimal odds down to the board's displayed odds-to-1 (num, den)."""
    to1 = decimal_odds - 1.0
    if to1 >= 5:
        return int(to1 + 1e-9), 1
    best = _LADDER[0]
    for num, den in _LADDER:
        if num / den <= to1 + 1e-9:
            best = (num, den)
    return best


def round_to_tote(decimal_odds: float) -> float:
    num, den = tote_ladder(decimal_odds)
    return 1.0 + num / den


def format_to1(decimal_odds: float) -> str:
    """Render decimal odds the way a tote board would (e.g. 3.5 -> '5-2')."""
    num, den = tote_ladder(decimal_odds)
    return f"{num}-{den}"
