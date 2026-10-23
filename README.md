# Totebot

Totebot is a small web app for your Ubuntu VM. It watches the post times of the races you load. At **3 minutes to post** it pulls the live tote and runs your `horseplay_betting_engine_v3.py` on it (pace adjustment → Benter blend → Kelly → exacta/superfecta EV). At **2 minutes to post** it releases structured betting tickets to a web page built for the iPad, and can also send a push notification.

```
 race card (your inputs)            live tote (odds, scratches, post time)
          │                                     │
          └──────────────► scheduler ◄──────────┘
                    15 MTP: pre-poll (follows delayed posts)
                     3 MTP: snapshot tote → run engine → tickets
                     2 MTP: publish → web page + ntfy push to iPad
```

## What a ticket looks like

```
AQU R5
$12 WIN #5 Lucky Lariat (12-1, EV +18%)
EXACTA (8 x $1 = $8, hit 8%):
  $1 EX 5 / 3,4,7
  $1 EX 7 / 3,4,5
  $1 EX 3 / 5,7
SUPERFECTA (40 x $0.10 = $4, hit 6%):
  $0.10 SUPER 3 / 5 / 2 / 4,6,7
  ...
A: 2,5  B: 1,3,4,6,7  C: -
```

Each leg is separated by `/`. When the last leg lists several horses, it means one combo per horse. The page also shows the full field table (public vs fundamental vs pace-adjusted vs true probability, EV, Kelly stake), the pace scenario, every exotic combo with its estimated payout, and a **Copy tickets** button.

## Setting it up on the VM (from the iPad)

1. **SSH into the VM** from the iPad. Termius, Blink Shell and the AWS console's browser-based connection (EC2 Instance Connect) all work.
2. Install:
   ```bash
   git clone https://github.com/cmk3e/verbose-spork.git
   cd verbose-spork
   sudo bash deploy/install.sh
   ```
   The script prints a generated **password** and **ntfy topic**. Settings are stored in `/etc/totebot.env`.
3. **Reach the site from the iPad.** Pick one:
   - **Tailscale (recommended):** install Tailscale on the VM (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) and on the iPad. Then open `http://<vm-tailscale-name>:8000`. No ports are open to the internet.
   - **Open the port:** in the EC2 Security Group, allow inbound TCP 8000 **from your IP only**, then open `http://<vm-public-ip>:8000`. Plain HTTP sends the password unencrypted, so for anything long-term put Caddy in front with a domain to get HTTPS.
4. In Safari, tap Share → **Add to Home Screen** so it opens like an app.
5. **Push notifications:** install the free **ntfy** app on the iPad and subscribe to the topic the installer printed.

To change settings, edit `/etc/totebot.env` with `sudo nano /etc/totebot.env`, then run `sudo systemctl restart totebot`. View logs with `journalctl -u totebot -f`. To update, run `git pull && sudo bash deploy/install.sh`.

## Loading races (your handicapping inputs)

Use **Add races** on the page to upload a CSV or JSON file. The Files app works, and so does a CSV exported from Numbers.

CSV with one row per runner (see `examples/race_card.csv`). Fill in track, race number and post time in the form:

```
program_num,name,style,qsp,call1_fps,call2_fps,final_fps,p_fund,ml_odds
1,Iron Ledger,E,7,58,57,49,0.18,3-1
```

To load a whole day in one file (see `examples/day_card.csv`), add `track,race_number,post_time` columns and leave the form blank.

| column | meaning |
|---|---|
| `program_num` | required |
| `style`, `qsp` | E, E/P, P, S and Quirin speed points. Turns on the engine's pace adjustment (both needed for every runner) |
| `call1_fps`, `call2_fps`, `final_fps` | feet-per-second figures for %-early (engine defaults are used if blank) |
| `p_fund` | **your fundamental win probability** (any scale; it gets normalized) |
| `rating` | alternative to `p_fund`: a power rating, converted with `softmax(rating / RATING_SCALE)` |
| `features` | alternative: `;`-separated features for the engine's `ConditionalLogitModel` (set `TRAINING_FILE` to a JSON list of `{"features": [[...], ...], "winner": i}`) |
| `ml_odds` | morning line. Used as a last-resort fundamental, and by the mock tote |
| `scratched` | `Y` to scratch ahead of time |

Fundamentals are taken in this order: `p_fund` → `features` + trained model → `rating` → `ml_odds`.

## Live tote source (`TOTE_SOURCE`)

| value | what it does |
|---|---|
| `tvg` | **Live odds from TVG's public race pages** (no account). Win odds, scratches, post-time changes (including post drag) and exacta probables. Uses the race's track code (e.g. `BEL`); set a race's `source_ref` if TVG's code differs. Check from the VM with `/opt/totebot/.venv/bin/python -m totebot.sources.tvg BEL 3`. |
| `mock` | Simulated, fluctuating tote. Use it to try everything out. |
| `http` | Any JSON odds API. Point `TOTE_HTTP_URL` at it and map the fields with `TOTE_HTTP_*` in `/etc/totebot.env`. Handles win odds, scratches, post-time changes and exacta probables (when provided, the engine uses real probables instead of estimates). |
| `manual` | Uses odds pushed to `POST /api/races/{id}/tote`. A scraper or script you already have, running anywhere, can feed Totebot this way. |

From any race on the page you can also use **Enter odds by hand → Use these odds & run** as a fallback, or **Pull tote & run now**.

Push format:
```bash
curl -u admin:PASSWORD -H 'Content-Type: application/json' \
  -d '{"win_odds": {"1": "5-2", "2": "3", "3": "SCR"}, "exacta_probables": {"1-2": 14.5}}' \
  http://VM:8000/api/races/AQU-20261023-R5/tote
```

To support a provider whose API doesn't fit the JSON mapping, add a class in `totebot/sources/` that implements `async fetch(race) -> ToteSnapshot` and register it in `totebot/sources/__init__.py`.

> **Choosing a feed:** there is no free, official public API for live US tote data. Your options are a commercial racing data provider, an ADW account that offers data access, or your own scraper feeding the `manual` endpoint. Check the terms of service for whichever you use.

## How the timing works

- Times are based on the race's post time, and the tote can update it. Starting at 15 MTP the scheduler polls the source every 60 s. If the source reports a later post time ("post drag"), the 3-minute and 2-minute marks move with it.
- If the tote is unreachable at 3 MTP, it retries every tick until the race goes off. A race not pulled by then is marked `missed`.
- If you see a delay at the track that the source doesn't report, use **Change post time**. The race is re-armed for a fresh pull.
- Change the timing with `FETCH_MTP` and `PUBLISH_MTP`.

## Updating your engine

Drop a new version (for example `horseplay_betting_engine_v4.py`) in the repo root and set `ENGINE_MODULE=horseplay_betting_engine_v4`. Totebot uses these from the module: `PaceAndEnergyAnalyzer`, `BenterProbabilityBlender`, `KellyBankrollManager`, `ExoticEVEngine`, `categorize_runners`, `normalize`, `softmax`, and `ConditionalLogitModel` (optional). The glue code is in `totebot/handicap.py`.

## Development

```bash
pip install -r requirements-dev.txt
pytest
DATA_DIR=./data TOTE_SOURCE=mock python -m totebot   # http://localhost:8000
```
