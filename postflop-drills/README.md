# Postflop Framework Drills (beta)

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
