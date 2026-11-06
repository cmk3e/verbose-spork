import json, sys
ch = json.load(open(sys.argv[1]))
RANKS = 'AKQJT98765432'
order = []
for r in range(13):
    for c in range(13):
        order.append(RANKS[r]*2 if r == c else (RANKS[r]+RANKS[c]+'s' if c > r else RANKS[c]+RANKS[r]+'o'))
def enc(c, action):
    s = ''
    for h in order:
        fr = c['cells'][h]
        f = sum(x for a, x in zip(c['acts'], fr) if a == action)
        q = round(f * 10)
        s += 'X' if q >= 10 else str(q)
    return s
SIZES = {'80': (2.3, 3.5), '50': (2.2, 3.5), '30': (2.3, 3.2), '20': (2.0, 3.0)}
out = {}
for c in ch:
    d = c['depth'][:-2]
    if d not in SIZES: continue
    t = c['title']
    D = out.setdefault(d, {'openSize': SIZES[d][0], 'sbOpenSize': SIZES[d][1], 'open': {}, 'call': {}})
    if t.endswith(' · RFI') and ' vs ' not in t:
        D['open'][t.split(' ·')[0]] = enc(c, 'raise')
    elif t.endswith(' · RFI') and ' vs ' in t:
        caller, opener = t.split(' ·')[0].split(' vs ')
        D['call'][caller + '>' + opener] = enc(c, 'call')
js = '/* Preflop ranges extracted from the PokerCoaching preflop charts PDF the user supplied.\n * Each string lists 169 hands in grid order (row = first rank AKQ..2, column = second rank;\n * above the diagonal suited, below offsuit). Each character is the frequency in tenths\n * (0-9, X = 100%). "open" = raise-first-in (non-all-in raise); "call" key is CALLER>OPENER\n * and holds the flat-call frequency vs that open. */\n'
js += '(function (root) {\n  root.PF_RANGE_DATA = ' + json.dumps({'order': order, 'depths': out}, separators=(',', ':')) + ';\n})(typeof window !== "undefined" ? window : globalThis);\n'
open(sys.argv[2], 'w').write(js)
for d, D in out.items(): print(d, len(D['open']), 'opens', len(D['call']), 'calls')
