import re
from typing import Optional, Union

# Odds a US tote board displays below 10-1, as (numerator, denominator).
TOTE_FRACTIONS = [
    (1, 9), (1, 5), (2, 5), (1, 2), (3, 5), (4, 5), (1, 1), (6, 5), (7, 5), (3, 2),
    (8, 5), (9, 5), (2, 1), (5, 2), (3, 1), (7, 2), (4, 1), (9, 2), (5, 1), (6, 1),
    (7, 1), (8, 1), (9, 1),
]

SCRATCH_TOKENS = {"SCR", "SCRATCHED", "S", "-", "--", "X", "N/A", ""}
EVEN_TOKENS = {"EVEN", "EVN", "EV", "EVS", "EVENS"}
MIN_DECIMAL = 1.05


def parse_odds(value: Union[str, float, int, None], numeric_format: str = "to1") -> Optional[float]:
    """Parse a tote odds value into decimal odds; None means scratched/unavailable.

    Accepts "5-2", "5/2", "9-5", "EVEN", "3" (3-1), or plain numbers. Plain numbers are
    read as odds-to-1 (how the tote shows them) unless numeric_format is "decimal".
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        dec = float(value) if numeric_format == "decimal" else float(value) + 1.0
        return max(dec, MIN_DECIMAL)

    text = str(value).strip().upper()
    if text in SCRATCH_TOKENS:
        return None
    if text in EVEN_TOKENS:
        return 2.0
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*[-/:]\s*(\d+(?:\.\d+)?)", text)
    if m:
        num, den = float(m.group(1)), float(m.group(2))
        if den <= 0:
            raise ValueError(f"Bad odds: {value!r}")
        return max(1.0 + num / den, MIN_DECIMAL)
    try:
        return parse_odds(float(text), numeric_format)
    except ValueError:
        raise ValueError(f"Unrecognized odds: {value!r}") from None


def format_odds(decimal: float) -> str:
    """Render decimal odds the way a tote board would (nearest standard price)."""
    to1 = decimal - 1.0
    if to1 >= 9.5:
        return f"{round(to1)}-1"
    num, den = min(TOTE_FRACTIONS, key=lambda f: abs(f[0] / f[1] - to1))
    if (num, den) == (1, 1):
        return "EVEN"
    return f"{num}-{den}"
