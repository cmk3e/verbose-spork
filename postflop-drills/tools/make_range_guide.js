/* Build the printable "Range advantage guide, 50bb" (HTML + PDF).
 *
 * usage (from postflop-drills/):  node tools/make_range_guide.js
 * writes resources/range-advantage-guide-50bb.html and .pdf
 *
 * For each solved 50bb spot: the raiser's and caller's preflop ranges (from the ranges
 * files the solves used, tools/ranges/) and, for each of the 30 solver flops, who has the
 * range advantage (whole-range equity, 53%+) and the nut advantage (share of the
 * strongest 5% of hands, 1.3x and 1.5 points apart). Flop ranges are the solver's exact
 * starting ranges (root = OOP, x = IP), the same ones the solver drill uses.
 */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources');
const RANKS = 'AKQJT98765432';
const SUIT = { s: ['♠', '#1b1f1d'], h: ['♥', '#c4302b'], d: ['♦', '#1f5fbf'], c: ['♣', '#217a3c'] };
const FLOPS = ['AhAd7c', 'AhKd5c', 'AsQs6d', 'AsJh9s', 'As7d2c', 'Ad5d4c', 'KsKd4h', 'KhQd4c', 'KsJs8s', 'Kd9d5s', 'Ks7d2c',
  'QsTd8c', 'Qh9c4d', 'Qd6d2s', 'JhTd3c', 'Js8d6h', 'Jc7c2h', 'Th9h8c', 'Tc8c4c', 'Td5c2s', '9s9h4h', '9d8d6s', '9s6h4c',
  '8h7c4h', '8d5s2h', '7d7c2s', '7c6d5s', '7h4h2h', '6s4d3c', '5h3c2d'];

// ip: which line of the ranges file (0 = IP, 1 = OOP) belongs to the raiser
const SPOTS = [
  { id: 'utg-bb-50', title: 'UTG vs BB', pre: 'UTG opens 2.2bb, BB calls · 5.9bb pot, 47.8bb behind', file: 'ranges_50_utg_bb.txt', raiser: 'UTG', caller: 'BB', raiserLine: 0, rLab: 'UTG open', cLab: 'BB call' },
  { id: 'hj-bb-50', title: 'HJ vs BB', pre: 'HJ opens 2.2bb, BB calls · 5.9bb pot, 47.8bb behind', file: 'ranges_50_hj_bb.txt', raiser: 'HJ', caller: 'BB', raiserLine: 0, rLab: 'HJ open', cLab: 'BB call' },
  { id: 'co-bb-50', title: 'CO vs BB', pre: 'CO opens 2.2bb, BB calls · 5.9bb pot, 47.8bb behind', file: 'ranges_50_co_bb.txt', raiser: 'CO', caller: 'BB', raiserLine: 0, rLab: 'CO open', cLab: 'BB call' },
  { id: 'btn-bb-50', title: 'BTN vs BB', pre: 'BTN opens 2.2bb, BB calls · 5.9bb pot, 47.8bb behind', file: 'ranges_50_btn_bb.txt', raiser: 'BTN', caller: 'BB', raiserLine: 0, rLab: 'BTN open', cLab: 'BB call' },
  { id: 'sb-bb-50', title: 'SB vs BB', pre: 'SB raises to 3.5bb, BB calls · 8bb pot, 46.5bb behind', file: 'ranges_50_bb_sb.txt', raiser: 'SB', caller: 'BB', raiserLine: 1, rLab: 'SB raise', cLab: 'BB call' },
  { id: 'co-btn-50', title: 'CO vs BTN', pre: 'CO opens 2.2bb, BTN calls, blinds fold · 6.9bb pot, 47.8bb behind', file: 'ranges_50_co_btn.txt', raiser: 'CO', caller: 'BTN', raiserLine: 1, rLab: 'CO open', cLab: 'BTN flat' },
  { id: 'bb3-btn-50', title: 'BB 3-bet vs BTN', pre: 'BTN opens 2.2bb, BB 3-bets to 8.8bb, BTN calls · 19.1bb pot, 41.2bb behind', file: 'ranges_50_bb3_btn.txt', raiser: 'BB', caller: 'BTN', raiserLine: 1, rLab: 'BB 3-bet', cLab: 'BTN call vs 3-bet' },
  { id: 'sb3-btn-50', title: 'SB 3-bet vs BTN', pre: 'BTN opens 2.2bb, SB 3-bets to 8.8bb, BB folds, BTN calls · 19.6bb pot, 41.2bb behind', file: 'ranges_50_sb3_btn.txt', raiser: 'SB', caller: 'BTN', raiserLine: 1, rLab: 'SB 3-bet', cLab: 'BTN call vs 3-bet' },
  { id: 'btn3-co-50', title: 'BTN 3-bet vs CO', pre: 'CO opens 2.2bb, BTN 3-bets to 6.6bb, blinds fold, CO calls · 15.7bb pot, 43.4bb behind', file: 'ranges_50_btn3_co.txt', raiser: 'BTN', caller: 'CO', raiserLine: 0, rLab: 'BTN 3-bet', cLab: 'CO call vs 3-bet' },
];

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pc = (x) => Math.round(x * 100) + '%';
const combosOf = (h) => (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12);

function classWeights(line) {
  const out = {};
  for (const item of line.trim().split(',')) {
    if (!item) continue;
    const [h, w] = item.split(':');
    out[h] = w ? +w : 1;
  }
  return out;
}

function chartHTML(weights, color, title) {
  let cells = '';
  let combos = 0;
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const h = r === c ? RANKS[r] + RANKS[r] : r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o';
      const w = Math.min(1, weights[h] || 0);
      combos += w * combosOf(h);
      const bg = w > 0 ? `linear-gradient(90deg, ${color} ${w * 100}%, #eef1ef ${w * 100}%)` : '#f7f8f7';
      cells += `<div class="c${w > 0 ? '' : ' o'}" style="background:${bg}">${h}</div>`;
    }
  }
  return `<div class="chart"><div class="ch-t"><b>${esc(title)}</b><span>${(combos / 1326 * 100).toFixed(1)}% of hands</span></div><div class="g">${cells}</div></div>`;
}

const flopHTML = (f) => f.match(/../g).map((c) => `<span style="color:${SUIT[c[1]][1]}">${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]][0]}</span>`).join(' ');

function toRange(hands) {
  return Object.entries(hands).map(([c, v]) => {
    const h = [E.parseCard(c.slice(0, 2)), E.parseCard(c.slice(2))];
    h.w = v[0];
    return h;
  });
}

function analyse(sp) {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'solver-data', sp.id, 'index.json')));
  const raiserIP = idx.ip === sp.raiser;
  const rows = [];
  for (const flop of FLOPS) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'solver-data', sp.id, flop + '.json')));
    const ip = toRange(d.nodes.x.hands), oop = toRange(d.nodes.root.hands);
    const R = raiserIP ? ip : oop, C = raiserIP ? oop : ip;
    const board = flop.match(/../g).map(E.parseCard);
    E.setSeed(20261110);
    const eq = E.rangeEquity(R, C, board, 30000);
    const nuts = E.nutStats(R, C, board, 0.05);
    const hi = Math.max(nuts.aFrac, nuts.bFrac), lo = Math.min(nuts.aFrac, nuts.bFrac);
    const nut = hi - lo < 0.015 ? null : (lo === 0 ? hi > 0 : hi / lo >= 1.3) ? (nuts.aFrac > nuts.bFrac ? 'r' : 'c') : null;
    rows.push({
      flop, eq, range: eq >= 0.53 ? 'r' : eq <= 0.47 ? 'c' : null, nutR: nuts.aFrac, nutC: nuts.bFrac, nut,
      cut: nuts.cutLabel.replace(/ \(.*\)$/, '').toLowerCase(), texture: E.describeBoard(board),
    });
  }
  return rows;
}

function pageHTML(sp, lines, rows) {
  const rw = classWeights(lines[sp.raiserLine]), cw = classWeights(lines[1 - sp.raiserLine]);
  const name = (s) => (s === 'r' ? sp.raiser : sp.caller);
  const cls = (s) => (s === 'r' ? 'r' : s === 'c' ? 'k' : 'e');
  const body = rows.map((x) => `<tr>
      <td class="fl">${flopHTML(x.flop)}<small>${esc(x.texture)}</small></td>
      <td><b class="${cls(x.range)}">${x.range ? name(x.range) : 'Even'}</b> <span class="n">${pc(x.eq)} – ${pc(1 - x.eq)}</span></td>
      <td><b class="${cls(x.nut)}">${x.nut ? name(x.nut) : 'Even'}</b> <span class="n">${pc(x.nutR)} vs ${pc(x.nutC)}</span> <small>(${esc(x.cut)}+)</small></td>
    </tr>`).join('');
  const count = (k, s) => rows.filter((x) => x[k] === s).length;
  return `<section class="page">
    <header><h2>${esc(sp.title)} <span>50bb</span></h2><p>${esc(sp.pre)}</p></header>
    <div class="charts">${chartHTML(rw, '#e5483f', sp.rLab)}${chartHTML(cw, '#4cae62', sp.cLab)}</div>
    <p class="sum">Range advantage: <b class="r">${sp.raiser}</b> on ${count('range', 'r')} flops, <b class="k">${sp.caller}</b> on ${count('range', 'c')}, even on ${count('range', null)}.
      Nut advantage: <b class="r">${sp.raiser}</b> ${count('nut', 'r')}, <b class="k">${sp.caller}</b> ${count('nut', 'c')}, even ${count('nut', null)}.</p>
    <table><thead><tr><th>Flop</th><th>Range advantage <small>(${sp.raiser} – ${sp.caller} equity)</small></th><th>Nut advantage <small>(share of each range in the top 5%)</small></th></tr></thead>
    <tbody>${body}</tbody></table>
  </section>`;
}

const CSS = `
@page { size: Letter; margin: 0.4in 0.45in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Public Sans", "Helvetica Neue", Arial, sans-serif; color: #15211b; font-size: 8.4pt; }
.page { page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; }
header h2 { margin: 0; font-size: 19pt; letter-spacing: .01em; }
header h2 span { font-size: 11pt; color: #5a6a61; font-weight: 600; margin-left: 6px; }
header p { margin: 2px 0 8px; color: #5a6a61; font-size: 9pt; }
.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.ch-t { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; font-size: 9pt; }
.ch-t span { color: #5a6a61; }
.g { display: grid; grid-template-columns: repeat(13, 1fr); gap: 1px; }
.c { aspect-ratio: 1 / .66; display: grid; place-items: center; font-size: 5.6pt; font-family: Menlo, Consolas, monospace; color: #15211b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.c.o { color: #b7bfba; }
.sum { margin: 8px 0 4px; font-size: 8.6pt; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 7.6pt; text-transform: uppercase; letter-spacing: .05em; color: #5a6a61; border-bottom: 1.5px solid #15211b; padding: 3px 4px; }
th small { text-transform: none; letter-spacing: 0; font-weight: 400; }
td { padding: 2.1px 4px; border-bottom: .5px solid #d3dbd6; vertical-align: baseline; }
td.fl { font-weight: 700; font-size: 9.2pt; white-space: nowrap; }
td.fl small { font-weight: 400; color: #5a6a61; font-size: 7pt; margin-left: 8px; }
td small { color: #5a6a61; font-size: 7pt; }
.n { font-variant-numeric: tabular-nums; color: #3b4a42; }
b.r { color: #c23a32; } b.k { color: #2f8a46; } b.e { color: #5a6a61; font-weight: 600; }
tr:nth-child(even) td { background: #f4f6f5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cover h1 { font-size: 30pt; margin: 0.6in 0 4px; }
.cover .lede { font-size: 12pt; color: #3b4a42; max-width: 6in; }
.cover h3 { margin: 22px 0 6px; font-size: 11pt; }
.cover ol { font-size: 10.5pt; line-height: 1.7; }
.cover p, .cover li { font-size: 10pt; line-height: 1.5; }
.cover .key b { margin-right: 4px; }
`;

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pages = [];
  const contents = [];
  for (const sp of SPOTS) {
    const lines = fs.readFileSync(path.join(__dirname, 'ranges', sp.file), 'utf8').split('\n');
    const rows = analyse(sp);
    pages.push(pageHTML(sp, lines, rows));
    contents.push(`<li>${esc(sp.title)} <span style="color:#5a6a61">· ${esc(sp.pre.split(' · ')[0])}</span></li>`);
    process.stdout.write(sp.id + ' ');
  }
  const cover = `<section class="page cover">
    <h1>Range advantage guide · 50bb</h1>
    <p class="lede">Who has the range advantage and the nut advantage on 30 flops, for every 50bb spot solved in the Postflop Framework Drills.</p>
    <h3>Spots</h3><ol>${contents.join('')}</ol>
    <h3>How to read each page</h3>
    <p class="key">Charts: the preflop raiser's range on the left (red) and the caller's range on the right (green). Partly filled cells are hands played only some of the time; the fill shows how often.</p>
    <p class="key"><b>Range advantage</b> goes to whoever's whole range has 53% or more equity against the other's on that flop (shown as raiser – caller equity). Between 47% and 53% is <b class="e">Even</b>.</p>
    <p class="key"><b>Nut advantage</b> compares how much of each range is in the strongest 5% of hands on that flop (the cutoff hand is in brackets). One side needs about 1.3 times the other's share, and at least 1.5 points more, to have the edge.</p>
    <p>The flop ranges are the solver's exact starting ranges for each spot (preflop chart ranges with the flop cards removed). Ranges come from your PokerCoaching charts; solutions from postflop-solver.</p>
  </section>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Range advantage guide · 50bb</title><style>${CSS}</style></head><body>${cover}${pages.join('')}</body></html>`;
  const htmlPath = path.join(OUT, 'range-advantage-guide-50bb.html');
  fs.writeFileSync(htmlPath, html);
  console.log('\nwrote', htmlPath);
  return htmlPath;
}

(async () => {
  const htmlPath = main();
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.log('playwright not found: open the HTML and print to PDF instead'); return; }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath);
  const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
  await page.pdf({
    path: pdfPath, format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font-size:7px;color:#888;padding:0 0.45in;display:flex;justify-content:space-between"><span>Postflop Framework Drills · Range advantage guide · 50bb</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  await browser.close();
  console.log('wrote', pdfPath);
})();
