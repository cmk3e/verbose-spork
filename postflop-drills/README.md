# Postflop Framework Drills (beta)

Three drills, linked from the top of each page:

- **Flop checklist** (`index.html`): the seven-question postflop thought process below.
- **Preflop trainer** (`preflop.html`): pick the play from your PokerCoaching charts (opens, facing opens, limps, 3-bets, 4-bets, all-ins at 12–80bb). After each answer it shows the full chart with your hand outlined. Data: `preflop-data.js`.
- **Solver turn drill** (`turn.html`, pilot): BTN vs BB 50bb after BB checks the flop, BTN bets ⅓ and BB calls. 10 flops × about 8 turn cards (overcard, board pair, flush, straight, blank, middle card), 79 turns in all. Decisions: BB leads or checks, BTN barrels (⅓, ¾ or 125% overbet) or checks back, BB faces each barrel size, BTN faces a lead. Same EV grading, why panel and range/nut advantage cards as the flop drill, recomputed for the turn card.
- **Resources** (`resources.html`): printable PDFs: the range advantage guide, the stack-depth slide deck and 12bb push/fold/re-jam charts (`node tools/make_pushfold_charts.js`). The briefing and player's guide are still built by their tools but no longer listed. First guide: `resources/range-advantage-guide-50bb.pdf`, one page per solved 50bb spot with both preflop ranges and the range/nut advantage on all 30 flops. Rebuild with `node tools/make_range_guide.js` (needs Playwright for the PDF; the solve ranges are in `tools/ranges/`). Second: `resources/stack-size-briefing.pdf`, a briefing on a stack-depth webinar and a bubble-strategy video, built from `resources/src/stack-size-briefing.md` with `node tools/make_briefing.js`. Fourth: `resources/stack-depth-slides.pdf`, a 20-slide deck built with `node tools/make_slides.js` (grids drawn from the chart data). Third: the player's guide `resources/players-guide.html` (also PDF) and `resources/quick-card.pdf`, built with `node tools/make_players_guide.js` (styles in `tools/guide.css`): stack-range pages with chart numbers, range grids, SPR ladder, risk-premium grid, mistakes, quiz and glossary, with practice links (`ranges.html?depth=&open=&resp=`, `preflop.html?depth=`).
- **My leaks** (`leaks.html`): every drill logs its answers (history.js, this browser only, last 3,000). The page ranks your solver leaks by EV lost per spot and decision (with a breakdown by hand type), lists the preflop and push/fold spot types and seats you miss most, shows the flop checklist accuracy per question, and keeps your recent mistakes with Replay links. "Drill this spot" opens a drill limited to that decision (`?only=`). Each drill also has a "Focus on my weak spots" setting that deals more of the spots and hand types where you lose the most.
- **Range viewer** (`ranges.html`): a table with all eight seats and a stack-depth menu (12–80bb). Tap the opener to see its open range, then a later seat to see that seat's response chart (call, 3-bet, all-in, fold) beside it; an option highlights the calling range only. Pick one of the 30 solver-drill flops to see who has the range advantage and the nut advantage, computed from the opener's raising range against the responder's calling range.
- **12bb push/fold** (`pushfold.html`): the preflop trainer limited to your 12bb charts and grouped as push/fold spots: open shove (or min-raise) or fold, rejam over an open, call an open-shove, call a rejam after you min-raised, and BB vs SB limp. Filter by your position; after each answer you see the whole chart and its overall shove/call ranges. One 12bb chart (BTN vs HJ all-in) is drawn incorrectly in the PDF and is corrected in `tools/chart_fixes.json`.
- **Solver flop drill** (`solver.html`): BTN vs BB at 50, 30 and 20bb; BB vs SB at 50, 30 and 20bb; UTG, HJ and CO vs BB, CO vs BTN (BTN flats), and BB 3-bet vs BTN, SB 3-bet vs BTN and BTN 3-bet vs CO at 50bb; single-raised pots, 30 solved flops each. A setting limits deals to hands the preflop chart plays at least half the time. After each answer, a "why" panel describes your hand (made hand, draws, backdoor flush draws), compares the same hand in other suits, and shows how the range plays each hand type (strong made hands, strong draws, marginal made hands, weak draws, air). `solver.html?hand=sb-bb-50/9d8d6s/root/Ks5d` opens a specific hand. The play panel shows who has the range advantage and the nut advantage, using the checklist's measures on the solver's starting ranges for that flop (a setting can hide them until you answer). You're the raiser deciding whether to c-bet, BB after SB checks, or BB facing a ⅓- or ¾-pot c-bet, and you're graded by EV loss against a GTO solver. Data: `solver-data/`.

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
# optional last argument: the ranges file, stored in index.json for the main-range filter
# (used for spots whose ranges are not plain open/call charts, e.g. 3-bet pots)
# then add the spot id to SPOTS at the top of solver.js
```

Each flop takes about 3½ minutes on 4 cores and about 3.4GB of memory. The tree is simplified:
- Flop: the raiser bets 33% or 75%, and BB can lead 33%.
- Raises are 3x.
- Turn and river: 66% bets, plus all-in.

Flops are solved to about 0.5% of the pot.

### Turn spots

Turns are solved on their own (turn and river) from the ranges the flop solve reaches:

```
# ranges after the flop line (IP bet small, OOP called) + 8 representative turn cards
python3 tools/turn_setup.py ../solves/Ks7d2c.json ranges_Ks7d2c.txt   # prints: pot stack turn:kind ...
cp tools/solver/export_turns.rs postflop-solver/examples/ && cargo build ... --example export_turns
./target/release/examples/export_turns ranges_Ks7d2c.txt 97 459 ../turns Ks7d2c Ah Kh 2h 9s 3h 8h Qh 4h
python3 tools/pack_turns.py ../turns solver-data/btn-bb-50-t1 btn-bb-50-t1 "..." BTN BB tools/turn_plan_btn_bb_50.txt
```

Turn bet sizes: in-position 33/75/125%, out-of-position leads 33/75%, river 33/75% plus all-in. Each turn solves in 1-3 seconds.

