import json, sys
charts = json.load(open(sys.argv[1]))
def act(rgb):
    r, g, b = rgb
    if r > 180 and g < 110: return 'raise'
    if r > 60 and r < 150 and g < 60 and b < 60: return 'allin'
    if g > 150 and r < 140: return 'call'
    if b > 150 and r < 100: return 'fold'
    return '?'
def ncombo(h): return 6 if len(h) == 2 else (4 if h[2] == 's' else 12)
for c in charts:
    acts = [act(l) for l in c['legend']]
    tot = {}
    for h, fr in c['cells'].items():
        for a, f in zip(acts, fr): tot[a] = tot.get(a, 0) + f * ncombo(h)
    c['acts'] = acts
    c['pct'] = {a: round(v / 1326 * 100, 2) for a, v in tot.items()}
json.dump(charts, open(sys.argv[1], 'w'))
for c in charts:
    if len(sys.argv) > 2 and sys.argv[2] not in c['depth'] + ' ' + c['title']: continue
    print(c['depth'], c['title'], c['acts'], c['pct'])
