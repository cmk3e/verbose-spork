"""Build turn-start ranges from a flop solve and pick representative turn cards.

usage: python3 turn_setup.py <flop_solve.json> <out_ranges.txt> [line]
  line: "cbet1" (default) = OOP checks, IP bets the small size, OOP calls.
Prints: pot_tenths stack_tenths turn1:type1 turn2:type2 ...

The ranges file has the IP range on line 1 and the OOP range on line 2, as exact
combos with weights ("AhKd:0.42,..."), which postflop-solver accepts.
"""
import json
import sys

RANKS = '23456789TJQKA'
SUITS = 'cdhs'


def rv(card):
    return RANKS.index(card[0]) + 2


def straight_combos(board_ranks):
    """Number of two-card rank holdings that make a straight with these board ranks."""
    n = 0
    ranks = range(2, 15)
    for a in ranks:
        for b in ranks:
            if b < a:
                continue
            s = set(board_ranks) | {a, b}
            if 14 in s:
                s.add(1)
            if any(all(x in s for x in range(lo, lo + 5)) for lo in range(1, 11)):
                n += 1
    return n


def pick_turns(flop):
    cards = [flop[i:i + 2] for i in (0, 2, 4)]
    franks = sorted((rv(c) for c in cards), reverse=True)
    fsuits = [c[1] for c in cards]
    deck = [r + s for r in RANKS for s in SUITS if r + s not in cards]
    suit_count = {s: fsuits.count(s) for s in SUITS}
    flush_suit = max(SUITS, key=lambda s: suit_count[s]) if max(suit_count.values()) >= 2 else None
    # a "quiet" suit: one that adds no flush draw (fewest on the flop)
    quiet = sorted(SUITS, key=lambda s: (suit_count[s], s))
    base_straights = straight_combos(franks)

    def quiet_card(rank):
        for s in quiet:
            c = rank + s
            if c in deck:
                return c
        return None

    picks = []

    def add(card, kind):
        if card and card not in [p[0] for p in picks]:
            picks.append((card, kind))

    # overcards
    overs = [r for r in RANKS[::-1] if rv(r) > franks[0]]
    if overs:
        add(quiet_card(overs[0]), 'overcard')
    # pairs the top / bottom card
    add(quiet_card(RANKS[franks[0] - 2]), 'pairs the top card')
    if franks[2] != franks[0]:
        add(quiet_card(RANKS[franks[2] - 2]), 'pairs the bottom card')
    # flush card: completes a flush on two-tone flops, brings a flush draw on rainbow flops
    fs = flush_suit or fsuits[0]
    fr = [r for r in RANKS if r + fs in deck and rv(r) not in franks]
    if fr:
        mid = fr[len(fr) // 2]
        kind = 'completes the flush' if suit_count[fs] >= 2 else 'brings a flush draw'
        add(mid + fs, kind)
    # straight card: most new straight combinations
    cand = []
    for r in RANKS:
        if rv(r) in franks:
            continue
        gain = straight_combos(franks + [rv(r)]) - base_straights
        cand.append((gain, r))
    cand.sort(reverse=True)
    if cand and cand[0][0] > 0:
        add(quiet_card(cand[0][1]), 'straight card')
    # blank: low, no pair, fewest new straights
    blanks = sorted((g, rv(r), r) for g, r in cand if rv(r) < franks[0])
    if blanks:
        add(quiet_card(blanks[0][2]), 'blank')
    # middle card between board ranks
    mids = [r for r in RANKS if franks[2] < rv(r) < franks[0] and rv(r) not in franks]
    if mids:
        add(quiet_card(mids[len(mids) // 2]), 'middle card')
    # one more overcard (at most two), then fill to 8 with the most distinct remaining ranks
    for r in overs[1:2]:
        add(quiet_card(r), 'overcard')
    used = {p[0][0] for p in picks}
    for g, r in sorted(cand, key=lambda x: -abs(rv(x[1]) - 8)):
        if len(picks) >= 8:
            break
        if r in used or rv(r) > franks[0]:
            continue
        used.add(r)
        if len(picks) >= 8:
            break
        add(quiet_card(r), 'other')
    return picks[:8]


def main():
    src, out = sys.argv[1], sys.argv[2]
    d = json.load(open(src))
    x, xb1 = d['nodes']['x'], d['nodes']['x-b1']
    bet_idx = [i for i, a in enumerate(x['actions']) if a.startswith('Bet')][0]
    call_idx = xb1['actions'].index('Call')

    def rng(node, idx):
        k = len(node['actions'])
        ws = {}
        for c, v in node['hands'].items():
            w = v[0] * v[1 + 2 * idx] / 100.0
            if w > 0:
                ws[c] = w
        m = max(ws.values())
        return ','.join(f'{c}:{w / m:.3f}' for c, w in ws.items() if w / m >= 0.002)

    ip, oop = rng(x, bet_idx), rng(xb1, call_idx)
    open(out, 'w').write(ip + '\n' + oop + '\n')
    bet = round(float(x['actions'][bet_idx].split()[1]) * 10)
    pot = round(d['pot'] * 10) + 2 * bet
    stack = round(d['stack'] * 10) - bet
    turns = pick_turns(d['flop'])
    print(pot, stack, ' '.join(f'{c}:{k.replace(" ", "_")}' for c, k in turns))


if __name__ == '__main__':
    main()
