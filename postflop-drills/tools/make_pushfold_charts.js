/* Printable 12bb push / fold / re-jam charts (HTML + PDF) from the preflop chart data.
 *
 * usage (from postflop-drills/):  node tools/make_pushfold_charts.js
 * writes resources/pushfold-12bb-charts.html and .pdf
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'preflop-data.js'));
const DATA = global.PF_PREFLOP_DATA;
const ORDER = DATA.order;
const DIG = '0123456789abcdefghijk';
const RANKS = 'AKQJT98765432';
const SEATS = ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const COL = { allin: '#8f1f1a', raise: '#e5483f', call: '#4cae62', fold: '#eef1ef' };
const charts = DATA.depths['12'].charts;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const combos = (h) => (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12);
const handAt = (r, c) => (r === c ? RANKS[r] + RANKS[r] : r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o');

function grid(title, labels, sub) {
  const c = charts[title];
  if (!c) return '';
  const f = (a, h) => (c[a] ? DIG.indexOf(c[a][ORDER.indexOf(h)]) / 20 : 0);
  let cells = '';
  let inRange = 0;
  const share = {};
  for (let r = 0; r < 13; r++) {
    for (let k = 0; k < 13; k++) {
      const h = handAt(r, k);
      let x = 0;
      const st = [];
      for (const a of ['allin', 'raise', 'call']) {
        const v = f(a, h);
        if (v > 0) { st.push(`${COL[a]} ${x * 100}% ${(x + v) * 100}%`); x += v; share[a] = (share[a] || 0) + v * combos(h); }
      }
      const any = x > 0 || f('fold', h) > 0;
      if (any) inRange += combos(h);
      st.push(`${any ? COL.fold : '#ffffff'} ${x * 100}% 100%`);
      cells += `<div class="c${any ? '' : ' o'}${x > 0 ? ' on' : ''}" style="background:linear-gradient(90deg,${st.join(',')})">${h}</div>`;
    }
  }
  const base = inRange || 1326;
  const lg = Object.entries(labels).filter(([a]) => share[a] > 0).map(([a, l]) => `<span><i style="background:${COL[a]}"></i>${l} ${(share[a] / base * 100).toFixed(0)}%</span>`).join('');
  return `<figure><figcaption><b>${esc(sub)}</b></figcaption><div class="g">${cells}</div><div class="lg">${lg}</div></figure>`;
}

const sections = [];

// A. opening
sections.push({
  title: 'Opening: folded to you',
  note: 'Shove (dark red) or min-raise (red). Min-raise your strongest hands so they get action; shove the middle hands that win most when everyone folds. Small blind: no 12bb open chart; it plays limp/shove (see BB vs SB limp for the big blind side).',
  grids: SEATS.slice(0, 6).map((s) => grid(`${s} · RFI`, { allin: 'Shove', raise: 'Min-raise' }, `${s} opens`)),
});

// B. facing a min-raise
for (const v of SEATS.slice(0, 6)) {
  const heroes = SEATS.slice(SEATS.indexOf(v) + 1);
  sections.push({
    title: `Facing a ${v} min-raise`,
    note: v === 'UTG' ? 'Re-jam all in (dark red), call (green) or fold. Percentages are shares of all hands.' : '',
    grids: heroes.map((h) => grid(`${h} vs ${v} · RFI`, { allin: 'Re-jam', call: 'Call' }, `${h} vs ${v} min-raise`)),
  });
}

// C. calling an open-shove
const shoveGrids = [];
for (const v of SEATS.slice(0, 7)) {
  for (const h of SEATS.slice(SEATS.indexOf(v) + 1)) {
    const g = grid(`${h} vs ${v} · All-In`, { call: 'Call' }, `${h} vs ${v} shove`);
    if (g) shoveGrids.push(g);
  }
}
sections.push({ title: 'Calling an open-shove (12bb)', note: 'Green = call the all-in; everything else folds. Call wider against later-position shoves, whose ranges are wider.', grids: shoveGrids });

// D. calling a re-jam after you min-raised
const rejamGrids = [];
for (const h of SEATS.slice(0, 6)) {
  for (const v of SEATS.slice(SEATS.indexOf(h) + 1)) {
    const g = grid(`${h} vs ${v} · 3-Bet All-In`, { call: 'Call' }, `${h} min-raise, ${v} re-jams`);
    if (g) rejamGrids.push(g);
  }
}
sections.push({ title: 'You min-raised and got re-jammed', note: 'Only the hands you min-raised appear (white = not in your min-raise range). Green = call the re-jam.', grids: rejamGrids });

// E. BB vs SB
sections.push({
  title: 'Big blind vs the small blind',
  note: 'BB facing an SB limp: shove, raise or check. BB facing an SB shove: call or fold.',
  grids: [grid('BB vs SB · Limp', { allin: 'Shove', raise: 'Raise', call: 'Check' }, 'BB vs SB limp'), grid('BB vs SB · All-In', { call: 'Call' }, 'BB vs SB shove')],
});

const count = sections.reduce((n, s) => n + s.grids.filter(Boolean).length, 0);

const CSS = `
@page { size: Letter; margin: 0.4in 0.4in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Public Sans", "Helvetica Neue", Arial, sans-serif; color: #15211b; font-size: 8pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 20pt; margin: 0 0 2px; }
.sub { color: #5a6a61; margin: 0 0 6px; font-size: 9pt; }
.key { display: flex; flex-wrap: wrap; gap: 14px; font-size: 8.5pt; margin: 4px 0 10px; padding: 6px 8px; background: #f4f6f5; border-radius: 6px; }
.key i, .lg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; border: 1px solid #ccd3cf; }
section { margin-bottom: 10px; }
section.break { break-before: page; }
h2 { font-size: 12pt; margin: 8px 0 2px; break-after: avoid; }
.note { color: #3b4a42; margin: 0 0 6px; font-size: 8.2pt; }
.grids { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 14px; }
figure { margin: 0; break-inside: avoid; }
figcaption { font-size: 8.6pt; margin-bottom: 2px; }
.g { display: grid; grid-template-columns: repeat(13, 1fr); gap: 1px; }
.c { aspect-ratio: 1 / .82; display: grid; place-items: center; font: 600 4.6pt Menlo, Consolas, monospace; color: #7d8a83; }
.c.on { color: #fff; text-shadow: 0 0 2px rgba(0,0,0,.45); }
.c.o { color: #d5dbd8; }
.lg { display: flex; flex-wrap: wrap; gap: 8px; font-size: 7.4pt; margin-top: 2px; color: #3b4a42; }
`;

const body = sections.map((s, i) => `<section class="${i === 1 ? 'break' : ''}${i > 1 && (s.title.startsWith('Calling') || s.title.startsWith('You min')) ? 'break' : ''}">
  <h2>${esc(s.title)}</h2>${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
  <div class="grids">${s.grids.filter(Boolean).join('')}</div></section>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>12bb push/fold charts</title><style>${CSS}</style></head><body>
  <h1>12bb push / fold / re-jam charts</h1>
  <p class="sub">From your PokerCoaching charts (12bb effective, 8-max, 1bb big-blind ante). Chip EV: on the bubble, call tighter. ${count} charts.</p>
  <div class="key"><span><i style="background:${COL.allin}"></i>All in (shove or re-jam)</span><span><i style="background:${COL.raise}"></i>Min-raise / raise</span><span><i style="background:${COL.call}"></i>Call (or check)</span><span><i style="background:${COL.fold}"></i>Fold</span><span>Split cells are mixed: the chart plays each action that share of the time.</span></div>
  ${body}
</body></html>`;

(async () => {
  const out = path.join(ROOT, 'resources', 'pushfold-12bb-charts.html');
  fs.writeFileSync(out, html);
  console.log('wrote', out, count, 'charts');
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + out);
  await page.pdf({
    path: out.replace(/\.html$/, '.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font-size:7px;color:#888;padding:0 0.4in;display:flex;justify-content:space-between"><span>Postflop Framework Drills · 12bb push/fold charts</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  await browser.close();
  console.log('wrote', out.replace(/\.html$/, '.pdf'));
})();
