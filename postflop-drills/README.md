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

## How answers are graded

All logic lives in `engine.js` (no DOM), and the UI is in `app.js`.

- **Spots**: single-raised, heads-up pots from 8-max ranges at about 40bb (2.2bb opens, SB opens 3bb, BB ante). Ten opener/caller pairings. Edit the `RANGES` and `SPOTS` tables to change them.
- **Position**: postflop order SB, BB, UTG, MP, LJ, HJ, CO, BTN.
- **Top card**: the share of each range holding the top board rank. A side needs 1.2x as much, and at least 2 points more, to be "favored".
- **Connected**: a straight is already possible, or two non-ace cards are within two ranks of each other.
- **Static / dynamic**: texture score. Two-tone +1, monotone +2, straight possible +2, adjacent cards +2, one-gap +1, paired −1. 2 or more is dynamic.
- **Range advantage**: Monte Carlo equity of range vs range to the river (6,000 runouts). 53% or more is an advantage, 47–53% is even.
- **Nut advantage**: pool both ranges, take the strongest 5% of made hands on the flop, and compare each range's share. One side needs 1.3x as much and at least 1.5 points more.
- **Hand strength**:
  - Premium: sets, trips, two pair, straights and better, overpairs, top pair with a J+ kicker.
  - Draw: flush draw, OESD or double gutshot, combo draw. A marginal pair plus a strong draw also accepts "marginal".
  - Marginal: weak top pair, middle or bottom pair, underpairs, A-high with a T+ kicker.
  - Air: everything else, including lone gutshots.
- Hero's hand is sampled from their own range, with each strength tier equally likely.

The "Putting it together" notes are rules of thumb, not solver output.
