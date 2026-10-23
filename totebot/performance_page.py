"""HTML for the /performance page."""
from html import escape
from typing import Any, Dict, List, Optional

from .config import Settings


def _money(x: Optional[float]) -> str:
    if x is None:
        return "–"
    sign = "-" if x < 0 else ""
    return f"{sign}${abs(x):,.2f}"


def _pct(x: Optional[float], signed: bool = False) -> str:
    if x is None:
        return "–"
    return f"{x:+.1%}" if signed else f"{x:.1%}"


def _cls(x: Optional[float]) -> str:
    return "" if x is None else ("pos" if x > 0 else "neg" if x < 0 else "")


def _table(head: List[str], rows: List[List[str]]) -> str:
    th = "".join(f"<th>{h}</th>" for h in head)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="wrap"><table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>'


def render(summary: Dict[str, Any], settings: Settings) -> str:
    n = summary["races"]
    pending = summary["races_pending"]
    waiting = f", {pending} waiting for results" if pending else ""
    parts = [f'<p class="muted">{n} settled race{"s" if n != 1 else ""}{waiting}. '
             "Paper trading: every ticket is settled as if it was bet exactly as printed.</p>"]
    if n == 0:
        parts.append("<p>No settled races yet. Results are collected automatically a few minutes after each "
                     "published race goes official.</p>")
    else:
        if n < 50:
            parts.append(f'<p class="warn">Small sample: with {n} races, luck dominates these numbers. '
                         "Treat them as directional until you have a few hundred races.</p>")

        rows = []
        for kind, t in sorted(summary["by_type"].items()):
            rows.append([escape(kind) + (" *" if t["estimated"] else ""), str(t["bets"]), str(t["hits"]),
                         _money(t["cost"]), _money(t["return"]),
                         f'<span class="{_cls(t["profit"])}">{_money(t["profit"])}</span>',
                         f'<span class="{_cls(t["roi"])}">{_pct(t["roi"], True)}</span>'])
        tot = summary["total"]
        rows.append(["<b>total</b>", "", "", _money(tot["cost"]), _money(tot["return"]),
                     f'<b class="{_cls(tot["profit"])}">{_money(tot["profit"])}</b>',
                     f'<b class="{_cls(tot["roi"])}">{_pct(tot["roi"], True)}</b>'])
        parts.append("<h2>Return by bet type</h2>" + _table(["Type", "Bets", "Hits", "Cost", "Return", "Profit", "ROI"], rows))
        if any(t["estimated"] for t in summary["by_type"].values()):
            parts.append('<p class="muted">* some winning payouts weren\'t reported, so estimates were used.</p>')

        ll = summary["log_loss"]
        verdict = ""
        if ll["p_true"] is not None and ll["p_public"] is not None:
            diff = ll["p_public"] - ll["p_true"]
            verdict = (f'<p class="{"pos" if diff > 0 else "neg"}">'
                       + (f"The model's probabilities beat the public odds by {diff:.4f} per race."
                          if diff > 0 else f"The public odds are more accurate than the model so far ({-diff:.4f} per race).")
                       + "</p>")
        parts.append(
            "<h2>Is there an edge?</h2>"
            '<p class="muted">Log loss: how surprised each set of probabilities was by the actual winners. '
            "Lower is better. A model with real value has to beat the public odds here.</p>"
            + _table(["Probabilities", "Log loss"], [
                ["Model (blended, what tickets use)", f'{ll["p_true"]:.4f}' if ll["p_true"] is not None else "–"],
                ["Public (tote odds at pull)", f'{ll["p_public"]:.4f}' if ll["p_public"] is not None else "–"],
                ["Your fundamentals + pace", f'{ll["p_paced"]:.4f}' if ll["p_paced"] is not None else "–"],
                ["Your fundamentals only", f'{ll["p_fund"]:.4f}' if ll["p_fund"] is not None else "–"],
            ]) + verdict)

        clv = summary["clv"]
        parts.append(
            "<h2>Closing-line value</h2>"
            '<p class="muted">Odds when the tote was pulled vs final odds. Positive means you got a better '
            "price than the closing odds, usually the earliest sign of a real edge.</p>"
            + _table(["Group", "Count", "Avg CLV"], [
                ["Win bets placed", str(clv["win_bets"]),
                 f'<span class="{_cls(clv["win_bet_clv"])}">{_pct(clv["win_bet_clv"], True)}</span>'],
                ["All overlays (EV > 0)", str(clv["overlays"]),
                 f'<span class="{_cls(clv["overlay_clv"])}">{_pct(clv["overlay_clv"], True)}</span>'],
            ]))

        def cal_rows(rows):
            return [[r["range"], str(r["runners"]), _pct(r["predicted"]), _pct(r["actual"])] for r in rows]

        parts.append(
            "<h2>Calibration</h2>"
            '<p class="muted">Of horses given a win chance in each range, how often did they actually win?</p>'
            "<h3>Model</h3>" + _table(["Win chance", "Runners", "Predicted", "Actual"], cal_rows(summary["calibration"]["model"]))
            + "<h3>Public</h3>" + _table(["Win chance", "Runners", "Predicted", "Actual"], cal_rows(summary["calibration"]["public"])))

        fit = summary["blend_fit"]
        if fit:
            parts.append(
                "<h2>Fitted blend</h2>"
                f"<p>From {fit['races']} races, the best weights are <b>BLEND_ALPHA={fit['alpha']}</b> (yours) and "
                f"<b>BLEND_BETA={fit['beta']}</b> (public). Current settings: {settings.alpha} / {settings.beta}. "
                "Refit after more races before relying on it; then set them in /etc/totebot.env.</p>")
        else:
            parts.append(f'<h2>Fitted blend</h2><p class="muted">Needs {summary["min_races_for_fit"]} settled races '
                         f"(have {n}). Then this suggests BLEND_ALPHA / BLEND_BETA fitted to your results.</p>")

    body = "\n".join(parts)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Totebot Performance</title>
<style>
  :root {{ --bg:#f5f6f8; --panel:#fff; --ink:#14171c; --muted:#646b76; --line:#dde1e6; --good:#1a7f37; --bad:#cf222e; --warn:#9a6700; --accent:#1f6feb; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg:#0e1116; --panel:#161b22; --ink:#e6edf3; --muted:#8d96a0; --line:#2a313c; --good:#3fb950; --bad:#f85149; --warn:#d29922; --accent:#4493f8; }} }}
  body {{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; }}
  main {{ max-width:900px; margin:0 auto; padding:16px; }}
  h1 {{ font-size:22px; margin:8px 0 4px; }} h2 {{ font-size:17px; margin:24px 0 6px; }} h3 {{ font-size:14px; color:var(--muted); margin:12px 0 4px; }}
  .wrap {{ overflow-x:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; }}
  table {{ border-collapse:collapse; width:100%; font-size:14px; font-variant-numeric:tabular-nums; }}
  th, td {{ padding:8px 10px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }}
  th:first-child, td:first-child {{ text-align:left; }} th {{ color:var(--muted); font-weight:500; }}
  tr:last-child td {{ border-bottom:0; }}
  .muted {{ color:var(--muted); font-size:14px; }} .warn {{ color:var(--warn); }} .pos {{ color:var(--good); }} .neg {{ color:var(--bad); }}
  nav a {{ color:var(--accent); margin-right:16px; text-decoration:none; }}
</style></head>
<body><main>
<nav><a href="/">← Races</a><a href="/api/performance/history.csv">Download history (CSV)</a></nav>
<h1>Performance</h1>
{body}
</main></body></html>"""
