import json, sys
import os
ch = json.load(open(sys.argv[1]))
# manual fixes for charts the PDF renders incorrectly (see chart_fixes.json)
fixes = json.load(open(os.path.join(os.path.dirname(__file__), 'chart_fixes.json')))
for c in ch:
    f = fixes.get(c['depth'] + '|' + c['title'])
    if f:
        c['acts'], c['cells'] = f['acts'], f['cells']
RANKS = 'AKQJT98765432'
order = []
for r in range(13):
    for c in range(13):
        order.append(RANKS[r]*2 if r == c else (RANKS[r]+RANKS[c]+'s' if c > r else RANKS[c]+RANKS[r]+'o'))
DIG = '0123456789abcdefghijk'  # 0..20 = 0%..100% in 5% steps
SIZES = {'80': (2.3, 3.5), '50': (2.2, 3.5), '30': (2.3, 3.2), '20': (2.0, 3.0), '12': (None, None)}
out = {}
for c in ch:
    d = c['depth'][:-2]
    acts = [a for a in c['acts'] if a != '?']
    strs = {a: '' for a in acts}
    for h in order:
        fr = dict(zip(c['acts'], c['cells'][h]))
        s = sum(fr.get(a, 0) for a in acts)
        for a in acts:
            q = round(fr.get(a, 0) / s * 20) if s >= 0.5 else 0
            strs[a] += DIG[q]
    D = out.setdefault(d, {'openSize': SIZES[d][0], 'sbOpenSize': SIZES[d][1], 'charts': {}})
    D['charts'][c['title']] = strs
js = '/* Preflop strategy charts extracted from the PokerCoaching preflop charts PDF the user supplied.\n * charts[title][action] = 169 chars in grid order (see order); each char 0-9a-k = 0%..100% in 5% steps.\n * A hand with every action at 0 is not in the range for that spot. */\n'
js += '(function (root) {\n  root.PF_PREFLOP_DATA = ' + json.dumps({'order': order, 'depths': out}, separators=(',', ':')) + ';\n})(typeof window !== "undefined" ? window : globalThis);\n'
open(sys.argv[2], 'w').write(js)
for d, D in out.items(): print(d, len(D['charts']), 'charts')
