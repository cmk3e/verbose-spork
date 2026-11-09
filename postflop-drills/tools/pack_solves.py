"""Pack export_flops JSON output into compact per-flop files for solver.html.

usage: python3 pack_solves.py <solves_dir> <out_dir> <spot_id> <title> [ip] [oop] [ranges.txt]
  e.g. python3 pack_solves.py solves solver-data/btn-bb-50 btn-bb-50 "BTN vs BB, 50bb" BTN BB

Each output node keeps: player, pot, actions, and per combo
[reach weight 0-1 (relative to the node's max), freq%..., EV(bb)...].
"""
import glob
import json
import os
import sys

src, out, spot_id, title = sys.argv[1:5]
ip = sys.argv[5] if len(sys.argv) > 5 else 'BTN'
oop = sys.argv[6] if len(sys.argv) > 6 else 'BB'
ranges_file = sys.argv[7] if len(sys.argv) > 7 else None


def class_weights(line):
    """Solver range syntax ("AKs,AQo:0.5") -> {hand class: weight}."""
    out = {}
    for item in line.strip().split(','):
        if not item:
            continue
        h, _, w = item.partition(':')
        out[h] = round(float(w), 3) if w else 1.0
    return out
os.makedirs(out, exist_ok=True)
flops = []
for f in sorted(glob.glob(os.path.join(src, '*.json'))):
    d = json.load(open(f))
    nodes = {}
    for name, n in d['nodes'].items():
        k = len(n['actions'])
        if not n['hands']:
            continue  # nobody reaches this node (e.g. a bet size that is never used)
        wmax = max(v[0] for v in n['hands'].values()) or 1
        hands = {}
        for combo, v in n['hands'].items():
            w = v[0] / wmax
            if w < 0.005:
                continue
            freqs = [int(v[1 + 2 * a]) for a in range(k)]
            evs = [round(v[2 + 2 * a], 2) for a in range(k)]
            hands[combo] = [round(w, 3)] + freqs + evs
        if not hands:
            continue  # every combo had ~zero reach
        nodes[name] = {'player': n['player'], 'pot': n['pot'], 'actions': n['actions'], 'hands': hands}
    packed = {'flop': d['flop'], 'pot': d['pot'], 'stack': d['stack'], 'exploitability': d['exploitability'], 'nodes': nodes}
    with open(os.path.join(out, d['flop'] + '.json'), 'w') as fh:
        json.dump(packed, fh, separators=(',', ':'))
    flops.append(d['flop'])
index = {'id': spot_id, 'title': title, 'pot': d['pot'], 'stack': d['stack'], 'ip': ip, 'oop': oop, 'flops': flops}
if ranges_file:
    # preflop weight of each hand class reaching the flop, for the drill's main-range filter
    lines = open(ranges_file).read().splitlines()
    index['pfIP'], index['pfOOP'] = class_weights(lines[0]), class_weights(lines[1])
with open(os.path.join(out, 'index.json'), 'w') as fh:
    json.dump(index, fh, separators=(',', ':'))
print(len(flops), 'flops packed into', out)
