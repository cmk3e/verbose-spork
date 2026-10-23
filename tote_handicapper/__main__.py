"""Command line entry point.

  python -m tote_handicapper run   [--config config.json]   scheduler + dashboard
  python -m tote_handicapper once  RACE_ID [--config ...]   handicap one race now
  python -m tote_handicapper train HISTORY.json --out model.json
"""

import argparse
import json
import logging
import os
import re
import sys
import threading
from pathlib import Path

from .handicap import engine, handicap_race, save_model
from .providers import build_provider
from .scheduler import CardStore, Scheduler
from .tickets import render_text, structured_wheels
from .web import serve

_ENV = re.compile(r"\$\{(\w+)\}")


def _expand_env(value):
    """Replace ${VAR} in config strings so API keys can stay out of the file."""
    if isinstance(value, str):
        return _ENV.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


def load_config(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        logging.getLogger("tote_handicapper").info("%s not found; using demo defaults", path)
        return {"provider": {"type": "demo"}, "output_dir": "output"}
    return _expand_env(json.loads(p.read_text()))


def cmd_run(args) -> None:
    cfg = load_config(args.config)
    provider = build_provider(cfg.get("provider", {"type": "demo"}))
    scheduler = Scheduler(provider, cfg)
    web_cfg = cfg.get("web", {})
    host = args.host or web_cfg.get("host", "127.0.0.1")
    password = web_cfg.get("password") or os.environ.get("TOTE_DASHBOARD_PASSWORD")
    if host not in ("127.0.0.1", "localhost") and not password:
        logging.getLogger("tote_handicapper").warning(
            "dashboard is reachable from the network without a password; set TOTE_DASHBOARD_PASSWORD")
    server = serve(scheduler, host, args.port or web_cfg.get("port", 8000), password)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        scheduler.run_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.stop()
        server.shutdown()


def cmd_once(args) -> None:
    cfg = load_config(args.config)
    provider = build_provider(cfg.get("provider", {"type": "demo"}))
    races = {r.race_id: r for r in provider.list_races()}
    if args.race_id not in races:
        sys.exit(f"Unknown race {args.race_id!r}. Known: {', '.join(races) or 'none'}")
    card = CardStore(cfg.get("cards_dir"), provider).get(args.race_id)
    if card is None:
        sys.exit(f"No fundamentals card for {args.race_id}")
    scheduler = Scheduler(provider, cfg)
    result = handicap_race(races[args.race_id], card, provider.get_tote(args.race_id), cfg, scheduler.model)
    result["wheels"] = structured_wheels(result["groups"], cfg.get("exotics", {}))
    print(json.dumps(result, indent=2, default=str) if args.json else render_text(result))


def cmd_train(args) -> None:
    """History file: {"features": [names], "races": [{"runners": [[...], ...], "winner": idx}]}"""
    data = json.loads(Path(args.history).read_text())
    races = [(r["runners"], int(r["winner"])) for r in data["races"]]
    model = engine.ConditionalLogitModel(l2=args.l2, lr=args.lr, epochs=args.epochs).fit(races)
    save_model(model, args.out, data.get("features", []))
    print(f"Trained on {len(races)} races -> {args.out}")
    for name, w in zip(data.get("features", []), model.weights):
        print(f"  {name:<20} {w:+.3f}")


def main(argv=None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(prog="tote_handicapper")
    sub = ap.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="track the tote and issue tickets on schedule, with dashboard")
    run.add_argument("--config", default="config.json")
    run.add_argument("--host")
    run.add_argument("--port", type=int)
    run.set_defaults(fn=cmd_run)

    once = sub.add_parser("once", help="handicap one race immediately off the current tote")
    once.add_argument("race_id")
    once.add_argument("--config", default="config.json")
    once.add_argument("--json", action="store_true")
    once.set_defaults(fn=cmd_once)

    train = sub.add_parser("train", help="fit the conditional logit model on past races")
    train.add_argument("history")
    train.add_argument("--out", default="model.json")
    train.add_argument("--l2", type=float, default=0.01)
    train.add_argument("--lr", type=float, default=0.5)
    train.add_argument("--epochs", type=int, default=150)
    train.set_defaults(fn=cmd_train)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
