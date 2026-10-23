# Tote Handicapper

Tracks the live tote for upcoming races and runs `horseplay_betting_engine_v3.py`
against it on a fixed clock:

| Time to post | What happens |
|---|---|
| **T-3:00** | Starts pulling the live tote and re-polls every 15 s (odds history + sparklines) |
| **T-2:00** | Takes one final fresh pull, handicaps, and publishes structured betting tickets |
| Post delayed | If the feed moves post back by more than 60 s after tickets went out, the race goes back to tracking and gets re-ticketed at the new T-2:00 |
| Post reached with no tickets | Marked **missed** |

All of these times can be changed in `config.json` → `timing`.

Tickets show up in the web dashboard, in `output/<race_id>.txt` / `.json`, in the
console log, and optionally in a Slack/Discord webhook.

It uses only the Python standard library (3.9+), so there's nothing to install.

## Quick start (simulated races)

```bash
python -m tote_handicapper run
# open http://127.0.0.1:8000
```

With no `config.json`, the tool runs the **demo provider**: six fake races, the
first posting 4 minutes after launch and the rest every 5 minutes. Their odds
swing harder as post gets closer, so you can watch the whole T-3 → T-2 cycle
within a few minutes.

Other commands:

```bash
python -m tote_handicapper once DEMO-R1          # handicap one race right now
python -m tote_handicapper once DEMO-R1 --json   # full result incl. every probability
python -m tote_handicapper train examples/history.json --out model.json
python -m unittest discover -s tests
```

## How the engine is used

`tote_handicapper/handicap.py` connects your engine's classes in this order:

1. **Match the card to the tote.** It keeps only runners that have live odds, so scratches drop out.
2. **Fundamental line.** It takes the first source the card provides:
   - `p_fund` (your own probabilities or ratings)
   - `features` scored by a trained `ConditionalLogitModel`
   - `ml_odds` (the morning line)
3. **`PaceAndEnergyAnalyzer`.** It projects the pace scenario from QSP and adjusts each runner by style and % early.
4. **`BenterProbabilityBlender`.** It blends that line with the live public probabilities.
5. **`KellyBankrollManager`.** It sizes win bets with simultaneous Kelly, a fractional multiplier and a per-race cap. Stakes are rounded down to whole dollars, with a $2 minimum.
6. **`categorize_runners`.** It sorts runners into the A/B/C groups.
7. **`ExoticEVEngine`.** It picks +EV exacta and superfecta combinations within budget. Exactas are priced from the live exacta probables when the feed provides them.
8. **A/B/C part wheels.** It builds the wheels A / AB, AB / A and A / AB / ABC / ABC, and prints each one's combination count and cost.

Your engine file is imported as is and never modified.

## Fundamentals cards

The tote only gives you odds. Your handicapping inputs go in
`cards/<race_id>.json` (set the folder with `cards_dir`). See
`examples/cards/AQU-2026-10-23-5.json`:

```json
{"race_id": "AQU-2026-10-23-5",
 "runners": [{"program_num": "1", "name": "Alpha Ledger", "style": "E", "qsp": 7,
              "call1_fps": 58.1, "call2_fps": 56.9, "final_fps": 49.0,
              "p_fund": 0.22, "ml_odds": 3}]}
```

- `style` is one of `E`, `E/P`, `P` or `S`. `qsp` is the Quirin speed points.
- The `*_fps` fields are optional. If you leave them out, the engine uses its own defaults.
- `p_fund` doesn't need to sum to 1, because it gets normalized.
- To use the conditional logit model instead, give each runner `"features": [...]`, in the same order as in training, and set `model_path`.

A race with no card is **skipped**, and the dashboard tells you so.

## Connecting a real tote feed

**Important:** there's no free, public, official US tote API. Live pari-mutuel
odds come from the tote companies and from licensed distributors and ADWs, and
access usually needs an agreement or a paid data plan. Several commercial odds
APIs say they cover horse racing, but many of them carry bookmaker prices, not
US tote pools, so check that before you pay for one. Scraping an ADW site may
break its terms of service.

The tool is provider-agnostic. Choose one of these in `config.json`
(start from `config.example.json`):

| `provider.type` | Use when |
|---|---|
| `demo` | Trying it out |
| `http` | Your feed has a JSON HTTP API. Set `races_url` and `tote_url` (which takes `{race_id}`, `{track}` and `{race_number}`) plus any headers. `${ENV_VAR}` in the config is expanded, so keys can stay out of the file. |
| `file` | Something else (a scraper, a spreadsheet export, you) writes `races.json` and `tote/<race_id>.json`. See `examples/feed/`. |

If your feed's JSON has a different shape, copy `examples/adapter_example.py`,
rename the fields, and set `"adapter": "your_module"`. The schema it needs to
return is documented at the top of `tote_handicapper/providers.py`. Odds can be
`"5-2"`, `"9/5"`, `"EVN"` or bare numbers, which are read as odds-to-1 unless
you set `numeric_format: "decimal"`.

**Post times need a UTC offset** (e.g. `2026-10-23T15:47:00-04:00`). If the feed
reports revised post times, include `post_time` in the tote response and the
scheduler will follow the delays.

## Configuration

Copy `config.example.json` to `config.json`. The main settings are:

- `bankroll`: bankroll, fractional Kelly, max race exposure, odds haircut, minimum win bet
- `exotics`: base bet, budget, minimum edge and minimum combo probability for each bet type; the bet types can be turned off
- `pace` and `blend`: passed straight to your engine's constructors (`alpha`, `beta`, thresholds and so on)
- `webhook_url`: a Slack or Discord incoming webhook that receives each ticket as soon as it's ready
- `web`: the host and port for the dashboard. Use `"host": "0.0.0.0"` to open it from your phone on the same network.

## Layout

```
horseplay_betting_engine_v3.py   your engine (unchanged)
tote_handicapper/
  providers.py   demo / file / http tote feeds + JSON schema
  scheduler.py   T-3 / T-2 timing, polling, delays, publishing
  handicap.py    tote + card -> engine pipeline
  tickets.py     ticket text + A/B/C part wheels
  web.py         dashboard server; dashboard.html is the page
  odds.py        tote odds parsing / tote ladder display
examples/        sample card, file feed, adapter template, training data
tests/           unittest suite (fake clock for the timeline)
```
