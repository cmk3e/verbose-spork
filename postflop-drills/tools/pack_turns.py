"""Pack export_turns output for the turn drill and record each turn card's type.

usage: python3 pack_turns.py <solves_dir> <out_dir> <spot_id> <title> <ip> <oop> <plan.txt>
  plan.txt: lines "<flop> <pot> <stack> <turn>:<kind> ..." as printed by turn_setup.py.
"""
import json
import os
import subprocess
import sys

src, out, spot_id, title, ip, oop, plan = sys.argv[1:8]
here = os.path.dirname(os.path.abspath(__file__))
subprocess.run([sys.executable, os.path.join(here, 'pack_solves.py'), src, out, spot_id, title, ip, oop], check=True)
kinds = {}
for line in open(plan):
    parts = line.split()
    if not parts:
        continue
    flop = parts[0]
    for t in parts[3:]:
        card, kind = t.split(':')
        kinds[flop + card] = kind.replace('_', ' ')
idx_path = os.path.join(out, 'index.json')
idx = json.load(open(idx_path))
idx['street'] = 'turn'
idx['turnKind'] = {b: kinds.get(b, '') for b in idx['flops']}
json.dump(idx, open(idx_path, 'w'), separators=(',', ':'))
print('turn kinds added for', len(idx['flops']), 'boards')
