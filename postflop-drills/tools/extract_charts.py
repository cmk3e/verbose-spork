import sys, os, re, json, subprocess, glob
import numpy as np
from PIL import Image
D = sys.argv[1]
# titles per page in reading order
txt = subprocess.run(['pdftotext', '-layout', D + '/r.pdf', '-'], capture_output=True, text=True).stdout
pages = txt.split('\f')
titles = {}
for pi, p in enumerate(pages, 1):
    lines = [l for l in p.split('\n') if l.strip()]
    if not lines: continue
    m = re.match(r'\s*(\d+BB)\s+(.*)', lines[0])
    if not m: continue
    depth = m.group(1)
    ts = []
    for l in lines[1:]:
        if 'POKERCOACHING' in l: continue
        ts += [t.strip() for t in re.split(r'\s{3,}', l.strip()) if t.strip()]
    titles[pi] = (depth, ts)

RANKS = 'AKQJT98765432'
def hand(r, c):
    if r == c: return RANKS[r] * 2
    if c > r: return RANKS[r] + RANKS[c] + 's'
    return RANKS[c] + RANKS[r] + 'o'

def segments(mask):
    # runs of True
    out = []; start = None
    for i, v in enumerate(mask):
        if v and start is None: start = i
        if not v and start is not None: out.append((start, i)); start = None
    if start is not None: out.append((start, len(mask)))
    return out

def parse(path):
    a = np.asarray(Image.open(path).convert('RGB')).astype(int)
    H, W, _ = a.shape
    lum = a.sum(2)
    dark = lum < 70
    # rows: grid rows are bands where most pixels are not dark
    rowfill = (~dark).mean(1)
    legend = (0, 46)
    top = 52
    rh = (H - top) / 13.0
    grid = [(int(top + i * rh), int(top + (i + 1) * rh) - 2) for i in range(13)]
    cw = W / 13.0
    cols = [(int(i * cw), int((i + 1) * cw) - 2) for i in range(13)]
    # legend boxes
    ly = (legend[0] + legend[1]) // 2 - 4
    lsegs = [s for s in segments(~dark[legend[0] + 3]) if s[1] - s[0] > 20]
    leg = [tuple(int(v) for v in np.median(a[legend[0] + 3, s[0] + 5:s[1] - 5], 0)) for s in lsegs]
    legw = [s[1] - s[0] for s in lsegs]
    pal = np.array(leg)
    cells = {}
    for ri, (y0, y1) in enumerate(grid):
        y = y0 + max(2, (y1 - y0) // 6)
        for ci, (x0, x1) in enumerate(cols):
            px = a[y, x0 + 2:x1 - 2]
            d = ((px[:, None, :] - pal[None, :, :]) ** 2).sum(2)
            k = d.argmin(1)
            ok = d.min(1) < 60 ** 2 * 3
            fr = [float(((k == i) & ok).sum()) / max(1, ok.sum()) for i in range(len(pal))]
            cells[hand(ri, ci)] = [round(f, 2) for f in fr]
    return leg, legw, cells

out = []
for pi, (depth, ts) in sorted(titles.items()):
    imgs = sorted(f for f in glob.glob(f'{D}/img/i-{pi:03d}-*.png') if Image.open(f).size == (659, 425) and Image.open(f).mode == 'RGB')
    if len(imgs) != len(ts):
        print('MISMATCH page', pi, len(imgs), ts, file=sys.stderr); continue
    for f, t in zip(imgs, ts):
        leg, legw, cells = parse(f)
        out.append({'page': pi, 'depth': depth, 'title': t, 'img': os.path.basename(f), 'legend': leg, 'legendWidths': legw, 'cells': cells})
json.dump(out, open(D + '/charts.json', 'w'))
print(len(out), 'charts')
cols = {}
for c in out:
    for l in c['legend']: cols[tuple(x // 20 * 20 for x in l)] = cols.get(tuple(x // 20 * 20 for x in l), 0) + 1
print(cols)
