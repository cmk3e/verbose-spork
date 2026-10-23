"""Turns a handicap result into structured, window-ready betting tickets."""

from itertools import permutations
from typing import List, Sequence

from .odds import format_to1


def count_part_wheel(legs: Sequence[Sequence[str]]) -> int:
    """Number of distinct-runner combinations in a part wheel like A / AB / ABC."""
    pool = sorted({p for leg in legs for p in leg})
    return sum(
        1 for combo in permutations(pool, len(legs))
        if all(c in leg for c, leg in zip(combo, legs))
    )


def structured_wheels(groups: dict, ex_cfg: dict) -> List[dict]:
    """A/B/C part wheels built from categorize_runners' groups."""
    a, b, c = groups["A"], groups["B"], groups["C"]
    ab, abc = sorted(set(a) | set(b)), sorted(set(a) | set(b) | set(c))
    ex_base = ex_cfg.get("exacta", {}).get("base", 1.0)
    sf_base = ex_cfg.get("superfecta", {}).get("base", 0.10)
    specs = [
        ("exacta", ex_base, [a, ab]),
        ("exacta", ex_base, [ab, a]),
        ("superfecta", sf_base, [a, ab, abc, abc]),
    ]
    out = []
    for bet_type, base, legs in specs:
        if not all(legs):
            continue
        n = count_part_wheel(legs)
        if n:
            out.append({"bet_type": bet_type, "base": base, "legs": legs,
                        "combinations": n, "cost": round(n * base, 2)})
    return out


def _money(x: float) -> str:
    return f"${x:,.2f}".replace(".00", "")


def render_text(result: dict) -> str:
    race = result["race"]
    lines = [
        f"{race['track']} RACE {race['race_number']}   post {race['post_time']}",
        f"tote @ {result['minutes_to_post_at_tote']:.1f} MTP | pace: {result['pace']['scenario']}"
        f" | line: {result['probability_source']}",
        "-" * 60,
    ]
    if result["win_bets"]:
        for b in result["win_bets"]:
            lines.append(f"WIN        {_money(b['stake']):>8}  #{b['program_num']} {b['name']}"
                         f" ({format_to1(b['odds'])})  EV {b['ev']:+.0%}")
    else:
        lines.append("WIN        no overlays at current odds")
    for t in result["exotics"]:
        label = t["bet_type"].upper()
        if not t["combos"]:
            lines.append(f"{label:<10} no combos clear the edge threshold")
            continue
        if t["bet_type"] == "superfecta":
            # Dozens of dime combos: list them compactly, best EV first.
            keys = ["-".join(c["combo"]) for c in t["combos"]]
            for i in range(0, len(keys), 5):
                head = f"{label:<10} {_money(t['base']):>8}" if i == 0 else " " * 19
                lines.append(f"{head}  {'  '.join(keys[i:i + 5])}")
        else:
            for c in t["combos"]:
                lines.append(f"{label:<10} {_money(t['base']):>8}  {'-'.join(c['combo']):<14}"
                             f" est {_money(c['est_payout_per_$1'] * t['base'])}  EV {c['ev_per_$1']:+.0%}")
        lines.append(f"{'':<10} subtotal {_money(t['cost'])}  hit {t['hit_probability']:.1%}"
                     f"  ROI {t['roi']:+.0%} ({t['priced_from']})")
    g = result["groups"]
    lines.append("-" * 60)
    lines.append(f"A: {','.join(g['A']) or '-'}   B: {','.join(g['B']) or '-'}   C: {','.join(g['C']) or '-'}")
    for w in result.get("wheels", []):
        legs = " / ".join(",".join(leg) for leg in w["legs"])
        lines.append(f"{w['bet_type'].upper():<10} {_money(w['base']):>8}  {legs}"
                     f"  ({w['combinations']} combos, {_money(w['cost'])})")
    if result["scratched_or_unpriced"]:
        lines.append(f"Scratched/unpriced: {', '.join(result['scratched_or_unpriced'])}")
    lines.append(f"TOTAL (EV tickets): {_money(result['total_cost'])}")
    return "\n".join(lines)
