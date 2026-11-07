"""Pack export_flops JSON output into compact per-flop files for solver.html.

usage: python3 pack_solves.py <solves_dir> <out_dir> <spot_id> <title>
  e.g. python3 pack_solves.py solves solver-data/btn-bb-50 btn-bb-50 "BTN vs BB, 50bb"

Each output node keeps: player, pot, actions, and per combo
[reach weight 0-1 (relative to the node's max), freq%..., EV(bb)...].
"""
import glob
import json
import os
import sys

src, out, spot_id, title = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
flops = []
for f in sorted(glob.glob(os.path.join(src, '*.json'))):
    d = json.load(open(f))
    nodes = {}
    for name, n in d['nodes'].items():
        k = len(n['actions'])
        wmax = max(v[0] for v in n['hands'].values()) or 1
        hands = {}
        for combo, v in n['hands'].items():
            w = v[0] / wmax
            if w < 0.005:
                continue
            freqs = [int(v[1 + 2 * a]) for a in range(k)]
            evs = [round(v[2 + 2 * a], 2) for a in range(k)]
            hands[combo] = [round(w, 3)] + freqs + evs
        nodes[name] = {'player': n['player'], 'pot': n['pot'], 'actions': n['actions'], 'hands': hands}
    packed = {'flop': d['flop'], 'pot': d['pot'], 'stack': d['stack'], 'exploitability': d['exploitability'], 'nodes': nodes}
    with open(os.path.join(out, d['flop'] + '.json'), 'w') as fh:
        json.dump(packed, fh, separators=(',', ':'))
    flops.append(d['flop'])
index = {'id': spot_id, 'title': title, 'pot': d['pot'], 'stack': d['stack'], 'ip': 'BTN', 'oop': 'BB', 'flops': flops}
with open(os.path.join(out, 'index.json'), 'w') as fh:
    json.dump(index, fh, separators=(',', ':'))
print(len(flops), 'flops packed into', out)
