# Postflop Framework Drills (beta)

Three drills, linked from the top of each page:

- **Flop checklist** (`index.html`): the seven-question postflop thought process below.
- **Preflop trainer** (`preflop.html`): pick the play from your PokerCoaching charts (opens, facing opens, limps, 3-bets, 4-bets, all-ins at 12–80bb). After each answer it shows the full chart with your hand outlined. Data: `preflop-data.js`.
- **Solver flop drill** (`solver.html`): BTN vs BB at 50, 30 and 20bb, plus HJ vs BB and BB vs SB at 50bb; single-raised pots, 30 solved flops each. A setting limits deals to hands the preflop chart plays at least half the time. After each answer, a "why" panel describes your hand (made hand, draws, backdoor flush draws), compares the same hand in other suits, and shows how the range plays each hand type (strong made hands, strong draws, marginal made hands, weak draws, air). `solver.html?hand=sb-bb-50/9d8d6s/root/Ks5d` opens a specific hand. The play panel shows who has the range advantage and the nut advantage, using the checklist's measures on the solver's starting ranges for that flop (a setting can hide them until you answer). You're the raiser deciding whether to c-bet, BB after SB checks, or BB facing a ⅓- or ¾-pot c-bet, and you're graded by EV loss against a GTO solver. Data: `solver-data/`.

A static web app for drilling a seven-question postflop checklist for MTT no-limit hold'em:

1. Am I in position or out of position?
2. Who does the top card favor?
3. Is the board connected or disconnected?
4. Is the board static or dynamic?
5. Who has the range advantage?
6. Who has the nut advantage?
7. How strong is my hand? (premium / high-equity draw / marginal / air)

## Run it

No build step. Open `index.html` in a browser, or serve the folder:

```
cd postflop-drills && python3 -m http.server 8000
```

Tests (Node 18+): `node test/engine.test.js`

## Using your own preflop charts

The app reads ranges from `ranges-data.js`, which is extracted from paid PokerCoaching charts. Keep this repo private while that file is committed. Without the file, the app uses simplified built-in ranges at about 40bb.

To rebuild it from the PokerCoaching "Preflop Ranges" PDF (needs `poppler-utils`, Pillow and numpy):

```
mkdir -p work/img && cp Preflop_Ranges.pdf work/r.pdf
pdfimages -png -p work/r.pdf work/img/i
python3 tools/extract_charts.py work          # reads every 13x13 grid by colour -> work/charts.json
python3 tools/summarize_charts.py work/charts.json RFI   # check: totals should match each chart's header %
python3 tools/build_ranges_data.py work/charts.json ranges-data.js
```

It uses the raise-first-in charts (opening ranges) and the "X vs Y · RFI" charts (flat-call frequencies) at 80, 50, 30 and 20bb. Mixed-frequency hands are weighted by their frequency, to the nearest 10%.

## How answers are graded

All logic lives in `engine.js` (no DOM), and the UI is in `app.js`.

- **Spots**: single-raised, heads-up pots. With chart data there are all 28 opener/caller pairings at each depth. Common spots come up more often (weighted by the square root of open % × call %). Open sizes follow the charts. Without chart data there are 10 built-in spots.
- **Position**: postflop order SB, BB, UTG, UTG+1, LJ, HJ, CO, BTN.
- **Top card**: the share of each range holding the top board rank. A side needs 1.2x as much, and at least 2 points more, to be "favored".
- **Connected**: a straight is already possible, or two non-ace cards are within two ranks of each other.
- **Static / dynamic**: texture score. Two-tone +1, monotone +2. Straight possible +2. Straight draws: count the two-card holdings that make an open-ended or double-gutshot draw, +2 for three or more, +1 for one or two. 9-high or lower +1 (most turn cards are overcards). Paired −1. 2 or more is dynamic.
- **Range advantage**: Monte Carlo equity of range vs range to the river (6,000 runouts). 53% or more is an advantage, 47–53% is even.
- **Nut advantage**: pool both ranges, take the strongest 5% of made hands on the flop, and compare each range's share. One side needs 1.3x as much and at least 1.5 points more.
- **Hand strength**:
  - Premium: sets, trips, two pair, straights and better, overpairs, top pair with a J+ kicker.
  - Draw: flush draw, OESD or double gutshot, combo draw. A marginal pair plus a strong draw also accepts "marginal".
  - Marginal: weak top pair, middle or bottom pair, underpairs, A-high with a T+ kicker.
  - Air: everything else, including lone gutshots.
- Hero's hand is sampled from their own range, with each strength tier equally likely.

The "Putting it together" notes are rules of thumb, not solver output.

## Solver data (pilot)

The flop solutions come from [postflop-solver](https://github.com/b-inary/postflop-solver) (AGPL-3.0) and `tools/solver/export_flops.rs`, an export example added to that repo:

```
git clone https://github.com/b-inary/postflop-solver && cp tools/solver/export_flops.rs postflop-solver/examples/
cd postflop-solver
RUSTFLAGS="--cap-lints warn" cargo build --release --no-default-features --features rayon --example export_flops
# ranges file: line 1 = raiser (in position) range, line 2 = BB range, in solver syntax (e.g. "AKs,AQo:0.5")
./target/release/examples/export_flops ranges.txt 59 478 ../solves Ks7d2c As7d2c ...   # pot/stack in tenths of a bb
python3 ../tools/pack_solves.py ../solves ../solver-data/btn-bb-50 btn-bb-50 "BTN vs BB, 50bb" BTN BB
# raiser out of position (SB vs BB): ranges line 1 = BB, line 2 = SB, and give SB both c-bet sizes
FLOP_OOP="33%, 75%" ./target/release/examples/export_flops ranges_bb_sb.txt 80 465 ../solves-sb Ks7d2c ...
python3 ../tools/pack_solves.py ../solves-sb ../solver-data/sb-bb-50 sb-bb-50 "BB vs SB, 50bb" BB SB
# then add the spot id to SPOTS at the top of solver.js
```

Each flop takes about 3½ minutes on 4 cores and about 3.4GB of memory. The tree is simplified:
- Flop: the raiser bets 33% or 75%, and BB can lead 33%.
- Raises are 3x.
- Turn and river: 66% bets, plus all-in.

Flops are solved to about 0.5% of the pot.
