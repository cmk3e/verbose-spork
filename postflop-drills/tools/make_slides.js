/* Build "Tactical Stack-Size Adjustments" as a 16:9 slide deck (HTML + PDF).
 * A corrected and extended version of an AI-generated deck: every range grid is drawn
 * from the user's PokerCoaching chart data, and the numbers are recomputed.
 *
 * usage (from postflop-drills/):  node tools/make_slides.js
 * writes resources/stack-depth-slides.html and .pdf
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
const C = { bg: '#1d242b', panel: '#28323b', line: '#3a4651', ink: '#efe8dc', muted: '#9fabb3', deep: '#3d82c4', shallow: '#d36a3b', amber: '#e8a33c', green: '#4cae62', red: '#e5483f', dark: '#7a1d1a', dark2: '#e8a33c' };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const combos = (h) => (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12);
const handAt = (r, c) => (r === c ? RANKS[r] + RANKS[r] : r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o');

function freq(depth, title, action) {
  const c = DATA.depths[depth].charts[title];
  const out = {};
  ORDER.forEach((h, i) => { out[h] = c[action] ? DIG.indexOf(c[action][i]) / 20 : 0; });
  return out;
}
const pct = (fr) => ORDER.reduce((s, h) => s + fr[h] * combos(h), 0) / 1326 * 100;

// ------------------------------------------------------------------ visual pieces
function slider(pos, label = 'Stack depth') {
  // pos 0 = deep, 1 = shallow
  const x = 30 + pos * 440;
  return `<div class="slider"><div class="sl-t">${label}</div><svg viewBox="0 0 500 70" width="420">
    <defs><linearGradient id="g${Math.round(pos * 100)}" x1="0" x2="1"><stop offset="0" stop-color="${C.deep}"/><stop offset="1" stop-color="${C.shallow}"/></linearGradient></defs>
    <rect x="30" y="22" width="440" height="16" rx="8" fill="url(#g${Math.round(pos * 100)})"/>
    <circle cx="${x}" cy="30" r="20" fill="#c9ced2" stroke="#7d868d" stroke-width="3"/><circle cx="${x}" cy="30" r="8" fill="#e9ecee"/>
    <text x="30" y="64" fill="${C.deep}" font-size="17" font-weight="700">DEEP</text><text x="470" y="64" text-anchor="end" fill="${C.shallow}" font-size="17" font-weight="700">SHALLOW</text></svg></div>`;
}

function head(title, pos, kicker) {
  return `<header class="hd"><div>${kicker ? `<div class="kick">${kicker}</div>` : ''}<h1>${title}</h1></div>${pos == null ? '' : slider(pos)}</header>`;
}

function grid(fr, color, opts = {}) {
  let cells = '';
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const h = handAt(r, c);
      const v = fr[h] || 0;
      const bg = v > 0 ? `linear-gradient(90deg, ${color} ${v * 100}%, #333d46 ${v * 100}%)` : '#2b343c';
      cells += `<div class="gc${v > 0 ? ' on' : ''}" style="background:${bg}">${opts.labels === false ? '' : h}</div>`;
    }
  }
  return `<div class="g ${opts.size || ''}">${cells}</div>`;
}

function deltaGrid(a, b) {
  let cells = '';
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const h = handAt(r, c);
      const x = a[h], y = b[h];
      let cls = 'gc', style = '';
      if (y - x >= 0.25) { cls += ' add'; style = `background:${C.shallow}`; }
      else if (x - y >= 0.25) { cls += ' rem'; }
      else if (y > 0) { cls += ' keep'; style = `background:linear-gradient(90deg, #4f6d8a ${y * 100}%, #333d46 ${y * 100}%)`; }
      cells += `<div class="${cls}" style="${style}">${h}</div>`;
    }
  }
  return `<div class="g big delta">${cells}</div>`;
}

function card(rank, suit) {
  const sym = { s: '♠', h: '♥', d: '♦', c: '♣' }[suit];
  const red = suit === 'h' || suit === 'd';
  return `<div class="pc${red ? ' red' : ''}"><b>${rank}</b><span>${sym}</span></div>`;
}

function bars(rows, color) {
  // rows: [label, action, pot, stack, sprText]
  const max = Math.max(...rows.map((r) => Math.max(r[2], r[3])));
  return `<div class="bars">${rows.map(([l, act, pot, st, spr]) => `<div class="bcol"><div class="bh">${l}</div><div class="ba">${act}</div>
    <div class="bplot"><div class="bar pot" style="height:${(pot / max) * 100}%"><span>${pot}bb</span></div><div class="bar st" style="height:${(st / max) * 100}%;background:${color}"><span>${st}bb</span></div></div>
    <div class="bl"><span>Pot</span><span>Behind</span></div><div class="bs">${spr}</div></div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ data
const LJ = { 80: freq('80', 'LJ · RFI', 'raise'), 50: freq('50', 'LJ · RFI', 'raise'), 30: freq('30', 'LJ · RFI', 'raise'), 20: freq('20', 'LJ · RFI', 'raise') };
const offsuit80 = ORDER.filter((h) => h.endsWith('o') && LJ[80][h] >= 0.5);
function delta(a, b) {
  let rem = 0, add = 0;
  const R = [], A = [];
  for (const h of ORDER) {
    const d = (b[h] - a[h]) * combos(h);
    if (b[h] - a[h] <= -0.25) { rem -= d; R.push(h); }
    if (b[h] - a[h] >= 0.25) { add += d; A.push(h); }
  }
  return { rem: Math.round(rem), add: Math.round(add), R, A };
}
const D20 = delta(LJ[80], LJ[20]);
const D50 = delta(LJ[80], LJ[50]);

// ------------------------------------------------------------------ slides
const S = [];

S.push(`<section class="slide title">
  <div class="t-kick">Postflop Framework Drills · Player's guide companion</div>
  <h1 class="big">TACTICAL STACK-SIZE<br>ADJUSTMENTS</h1>
  ${slider(0.5, '')}
  <p class="t-sub">How preflop ranges, 3-bets and postflop commitment change from deep stacks to push/fold</p>
</section>`);



S.push(`<section class="slide">
  ${head('The inverse value seesaw', null)}
  <div class="ss-labels"><div><b style="color:${C.deep}">DEEP STACKS</b><span>Suited connectors, small pairs, suited wheel aces</span></div><div><b style="color:${C.shallow}">SHALLOW STACKS</b><span>Big offsuit cards: KJo, KTo, ATo, A9o, QJo</span></div></div>
  <svg viewBox="0 0 1600 360" class="seesaw">
    <polygon points="800,290 760,355 840,355" fill="#5b6670"/>
    <g transform="rotate(-8 800 290)"><rect x="260" y="280" width="1080" height="18" rx="6" fill="#8b959c"/>
    ${Array.from({ length: 10 }, (_, i) => `<ellipse cx="370" cy="${265 - i * 20}" rx="70" ry="16" fill="${C.deep}" stroke="#9fc4ea" stroke-width="2"/>`).join('')}
    ${Array.from({ length: 3 }, (_, i) => `<ellipse cx="1230" cy="${265 - i * 20}" rx="70" ry="16" fill="${C.shallow}" stroke="#f2b08f" stroke-width="2"/>`).join('')}</g>
  </svg>
  <div class="callout">As stacks get <b>shorter</b>, big offsuit cards gain value: they make top pairs you can get all in with. As stacks get <b>deeper</b>, suited connectors and small pairs gain value: they make the straights, flushes and sets that win big pots.</div>
  <p class="foot">One exception at the very short end: once you're shoving, small pairs and weak aces gain value again for their all-in equity and blockers.</p>
</section>`);

S.push(`<section class="slide">
  ${head('What your hands are for', 0.5)}
  <div class="two">
    <div class="pane goal deep"><h2 style="color:${C.deep}">Deep: making the nuts</h2>
      <div class="cards">${card('10', 's')}${card('9', 's')}<span class="cl">T9 suited</span></div>
      <div class="box" style="border-color:${C.deep}"><b style="color:${C.deep}">150bb:</b> T9s is excellent because it makes straights and flushes that can win a 300bb pot. One pair rarely can.</div></div>
    <div class="pane goal"><h2 style="color:${C.shallow}">Shallow: strong top pairs</h2>
      <div class="cards">${card('K', 'h')}${card('Q', 'c')}<span class="cl">KQ offsuit</span></div>
      <div class="box" style="border-color:${C.shallow}"><b style="color:${C.shallow}">40–50bb:</b> KQo on K-8-4 is a strong hand. With standard bets it can get all the money in by the river (SPR about 5 at 40bb). In a 3-bet pot at 50bb it is a clear stack-off.</div></div>
  </div>
</section>`);

const offsuitList = offsuit80.join(', ');
S.push(`<section class="slide">
  ${head('Opening ranges: the deep blueprint', 0.2, 'Lojack open · 80bb · your chart')}
  <div class="gridrow">
    <div class="note left"><h3 style="color:${C.deep}">How to read the grid</h3><p>Pairs on the diagonal, <b>suited</b> hands above it, <b>offsuit</b> hands below it. Part-filled cells are opened only some of the time.</p>
      <h3 style="color:${C.deep}">The offsuit desert</h3><p>Only ${offsuit80.length} offsuit hands are opened at least half the time: ${offsuitList}. KTo and A9o are mixed in rarely.</p></div>
    ${grid(LJ[80], C.deep, { size: 'big' })}
    <div class="note"><h3 style="color:${C.deep}">The suited bias</h3><p>Every suited ace, suited kings down to K5s, suited connectors down to 65s and small pairs 33+. These hands set up straights, flushes and sets.</p>
      <div class="stat"><b>${pct(LJ[80]).toFixed(1)}%</b><span>of hands</span></div></div>
  </div>
  <p class="foot">Your charts start at 80bb. At 150bb (the webinar's example) the same idea is stronger still: even fewer offsuit hands and more small pairs and suited connectors.</p>
</section>`);

S.push(`<section class="slide">
  ${head('The shallow shift: same size, different hands', 0.85, 'Lojack open · 80bb → 20bb · your charts')}
  <div class="gridrow">
    <div class="note left box2 grey"><h3>Folded: playability</h3><p><b>${D20.rem} combos removed.</b></p><p>${D20.R.join(', ')}. Small pairs, small suited connectors and weak suited kings lose their implied odds.</p></div>
    <div><div class="legend3"><span><i style="background:#4f6d8a"></i>In both</span><span><i class="x"></i>Removed</span><span><i style="background:${C.shallow}"></i>Added</span></div>${deltaGrid(LJ[80], LJ[20])}</div>
    <div class="note box2 orange"><h3>Added: top-pair power</h3><p><b>${D20.add} combos added.</b></p><p>${D20.A.join(', ')}. Offsuit Broadways and offsuit aces make top pairs you can stack off with.</p></div>
  </div>
  <div class="eq"><b>${pct(LJ[80]).toFixed(1)}%</b> at 80bb ≈ <b>${pct(LJ[20]).toFixed(1)}%</b> at 20bb. Not tighter: <b>different</b>. At 50bb the shift is part-way: ${D50.R.join(', ')} out; ${D50.A.join(', ')} in.</div>
</section>`);

const bt80 = freq('80', 'BTN vs LJ · RFI', 'raise'), bt50 = freq('50', 'BTN vs LJ · RFI', 'raise');
S.push(`<section class="slide">
  ${head('3-betting: the deep-stack strategy', 0.15)}
  <div class="two">
    <div class="pane center">
      <svg viewBox="0 0 420 420" width="380"><circle cx="210" cy="210" r="190" fill="#2f5f8f"/><circle cx="210" cy="210" r="115" fill="${C.deep}"/>
        <text x="210" y="200" text-anchor="middle" fill="#fff" font-size="26" font-weight="800">VALUE</text><text x="210" y="232" text-anchor="middle" fill="#fff" font-size="22">JJ+, AK, AQs</text>
        <text x="210" y="62" text-anchor="middle" fill="#d6e6f5" font-size="22" font-weight="700">BLUFFS</text><text x="210" y="380" text-anchor="middle" fill="#d6e6f5" font-size="20">65s 76s 87s T9s A5s A4s</text></svg>
      <p class="small">Webinar example: about 44 value combos and 36 bluff combos, so the range is balanced.</p></div>
    <div class="pane"><h2>Why suited connectors and wheel aces?</h2>
      <div class="cards sm">${card('5', 's')}${card('6', 'h')}${card('7', 'c')}</div>
      <p>If you 3-bet only JJ+ and AK, a 5-6-7 flop misses you completely and opponents can attack it. Bluffs like 65s, 76s and A5s/A4s make straights, two pairs and wheels on those boards, so you're <b>much harder to exploit</b> on low, connected flops.</p>
      <div class="box" style="border-color:${C.deep}">Your 80bb BTN vs LJ chart agrees: it 3-bets A2s 95%, 65s 75%, 87s 60% and T9s 50% of the time as bluffs.</div></div>
  </div>
</section>`);

// BTN vs LJ open at 100bb vs 40bb (PokerCoaching charts from the user's screenshots, used only here)
(() => {
  const X = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'btn_vs_lj_100_40.json'), 'utf8'));
  const deepOnly = ['QJs', 'JTs', '65s', '76s'], shallowOnly = ['K9s', 'K7s', 'K6s'];
  const g = (fr) => {
    let cells = '';
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const h = handAt(r, c); const f = fr[h] || {}; let x = 0; const st = [];
      for (const [a, col] of [['raise', C.red], ['call', C.green]]) { const v = f[a] || 0; if (v > 0) { st.push(`${col} ${x * 100}% ${(x + v) * 100}%`); x += v; } }
      st.push(`#46525c ${x * 100}% 100%`);
      const cls = deepOnly.includes(h) ? ' hl-deep' : shallowOnly.includes(h) ? ' hl-shal' : '';
      cells += `<div class="gc on${cls}" style="background:linear-gradient(90deg,${st.join(',')})">${h}</div>`;
    }
    return `<div class="g mid8">${cells}</div>`;
  };
  const p3 = (d, h) => Math.round(((X[d][h] || {}).raise || 0) * 100);
  const rows = [...shallowOnly, ...deepOnly].map((h) => `<tr class="${shallowOnly.includes(h) ? 'rs' : 'rd'}"><td><b>${h}</b></td><td>${p3('100', h)}%</td><td>${p3('40', h)}%</td></tr>`).join('');
  S.push(`<section class="slide">
  ${head('3-betting: what changes from 100bb to 40bb', 0.6, 'Button vs a lojack open · PokerCoaching charts at 100bb and 40bb')}
  <div class="row8">
    <div><div class="mini-t">100bb</div>${g(X['100'])}</div>
    <div class="mid-col">
      <div class="legend3 col"><span><i style="background:${C.red}"></i>3-bet</span><span><i style="background:${C.green}"></i>Call</span><span><i style="background:#46525c"></i>Fold</span></div>
      <table class="tbl t8"><thead><tr><th>Hand</th><th>3-bet at 100bb</th><th>at 40bb</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="legend3 col"><span><i class="o-deep"></i>3-bet deep, flat at 40bb</span><span><i class="o-shal"></i>Flat deep, 3-bet at 40bb</span></div>
    </div>
    <div><div class="mini-t">40bb</div>${g(X['40'])}</div>
  </div>
  <div class="two8">
    <div class="box" style="border-color:${C.deep}"><b style="color:${C.deep}">100bb:</b> QJs, JTs, 65s and 76s are 3-bets. Deep, a 3-bet pot is big and still has room to play, so you want hands that make straights and flushes and cover low and middle boards. K9s–K6s just call: they make second-best flushes and weak top pairs, which are costly in big pots.</div>
    <div class="box" style="border-color:${C.shallow}"><b style="color:${C.shallow}">40bb:</b> the lojack can 4-bet jam over your 3-bet, so the bluffs become K9s, K7s and K6s: the king blocks KK and AK, and they fold easily to a jam. QJs, JTs, 65s and 76s now just call: in position at 40bb they play well postflop and hate being jammed off their equity.</div>
  </div>
</section>`);
})();

S.push(`<section class="slide">
  ${head('The 3-bet bluff paradox: KTo vs KQo', 0.75, 'Button vs a middle-position open at 50bb')}
  <div class="flow">
    <div class="fbox top">Middle position opens · you're on the button</div>
    <div class="fcols">
      <div class="fcol good"><div class="fbox">3-bet <b>KTo</b></div><div class="fdown">↓</div><div class="fbox">They fold <b>better</b> hands: KJ, KQ, and AT</div><div class="fdown">↓</div><div class="fbox hl">Win: you fold out hands with about 70% equity against you</div></div>
      <div class="fcol bad"><div class="fbox">3-bet <b>KQo</b></div><div class="fdown">↓</div><div class="fbox">They fold the hands you <b>dominate</b> (KJ, KT) and continue with hands that crush you (AK, AQ, big pairs)</div><div class="fdown">↓</div><div class="fbox dim">Loss: you've removed the hands you wanted to play against</div></div>
    </div>
  </div>
  <div class="banner">Flat KQo to keep dominated hands in the pot. 3-bet KTo to fold out better hands.</div>
</section>`);

// calling an open (RFI): small pairs and suited connectors across depths
(() => {
  const hl = ['33', '65s', '76s'];
  const depths = [['80', 2.3], ['50', 2.2], ['30', 2.3], ['20', 2]];
  const chartOf = (d) => { const c = DATA.depths[d].charts['CO vs UTG · RFI']; const o = {}; ORDER.forEach((h, i) => { o[h] = {}; for (const a of Object.keys(c)) o[h][a] = DIG.indexOf(c[a][i]) / 20; }); return o; };
  const miniGrid = (fr) => {
    let cells = '';
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const h = handAt(r, c); const f = fr[h]; let x = 0; const st = [];
      for (const [a, col] of [['call', C.green], ['raise', C.red], ['allin', C.amber]]) { const v = f[a] || 0; if (v > 0) { st.push(`${col} ${x * 100}% ${(x + v) * 100}%`); x += v; } }
      st.push(`#46525c ${x * 100}% 100%`);
      cells += `<div class="gc${hl.includes(h) ? ' hlc' : ''}" style="background:linear-gradient(90deg,${st.join(',')})"></div>`;
    }
    return `<div class="g small">${cells}</div>`;
  };
  const pc = (v) => (v < 1 ? ' ' + Math.round(v * 100) + '%' : '');
  const word = (f) => {
    const parts = [];
    if (f.call > 0) parts.push(`<span style="color:${C.green}">Call${pc(f.call)}</span>`);
    if (f.raise > 0) parts.push(`<span style="color:${C.red}">3-bet${pc(f.raise)}</span>`);
    if (f.allin > 0) parts.push(`<span style="color:${C.amber}">Jam${pc(f.allin)}</span>`);
    if (!parts.length) return '<span class="mut">Fold</span>';
    if (f.fold > 0.05) parts.push(`<span class="mut">Fold${pc(f.fold)}</span>`);
    return parts.join(' · ');
  };
  const charts = depths.map(([d]) => chartOf(d));
  S.push(`<section class="slide">
  ${head('Calling an open: deep yes, shallow no', 0.5, 'UTG opens · folds to the cutoff · your charts')}
  <div class="callrow">
    <div class="cgrids">${depths.map(([d], i) => `<div><div class="mini-t">${d}bb</div>${miniGrid(charts[i])}</div>`).join('')}
      <div class="legend3 left"><span><i style="background:${C.green}"></i>Call</span><span><i style="background:${C.red}"></i>3-bet</span><span><i style="background:${C.amber}"></i>Jam</span><span><i style="background:#46525c"></i>Fold</span><span><i class="hlk"></i>33, 65s, 76s</span></div></div>
    <table class="tbl hands"><thead><tr><th>Hand</th>${depths.map(([d]) => `<th>${d}bb</th>`).join('')}</tr></thead><tbody>
      ${hl.map((h) => `<tr><td><b>${h}</b></td>${charts.map((c) => `<td>${word(c[h])}</td>`).join('')}</tr>`).join('')}
      <tr class="odds"><td>Behind ÷ call</td>${depths.map(([d, op]) => `<td>${((+d - op) / op).toFixed(0)}×</td>`).join('')}</tr></tbody></table>
  </div>
  <div class="callout">Calling an open with a small pair or suited connector is a bet on making a big hand and getting paid. With 50bb+ there's 20–35 times the call behind, comfortably above the <b>15–20×</b> set-mining needs. At 30bb (12×) and 20bb (9×) there isn't, and players left to act can squeeze you off the hand, so only 55+ keeps calling.</div>
</section>`);
})();

// calling a 3-bet: small pairs and suited connectors across depths
(() => {
  const hl = ['22', '33', '65s', '76s'];
  const depths = [['80', 10, 2.3, 0.15], ['50', 8.8, 2.2, 0.45], ['30', 8, 2.3, 0.7], ['20', 6.6, 2, 0.9]];
  const chartOf = (d) => { const c = DATA.depths[d].charts['BTN vs BB · 3-Bet']; const o = {}; ORDER.forEach((h, i) => { o[h] = {}; for (const a of Object.keys(c)) o[h][a] = DIG.indexOf(c[a][i]) / 20; }); return o; };
  const miniGrid = (fr) => {
    let cells = '';
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const h = handAt(r, c); const f = fr[h]; let x = 0; const st = [];
      for (const [a, col] of [['call', C.green], ['allin', C.amber], ['raise', C.red]]) { const v = f[a] || 0; if (v > 0) { st.push(`${col} ${x * 100}% ${(x + v) * 100}%`); x += v; } }
      const inRange = Object.values(f).some((v) => v > 0);
      st.push(`${inRange ? '#46525c' : '#2b343c'} ${x * 100}% 100%`);
      cells += `<div class="gc${hl.includes(h) ? ' hlc' : ''}" style="background:linear-gradient(90deg,${st.join(',')})"></div>`;
    }
    return `<div class="g small">${cells}</div>`;
  };
  const word = (f, rfi) => {
    const parts = [];
    if (f.call > 0) parts.push(`<span style="color:${C.green}">Call${f.call < 1 ? ' ' + Math.round(f.call * 100) + '%' : ''}</span>`);
    if (f.allin > 0) parts.push(`<span style="color:${C.amber}">Jam${f.allin < 1 ? ' ' + Math.round(f.allin * 100) + '%' : ''}</span>`);
    if (f.raise > 0) parts.push(`<span style="color:${C.red}">4-bet</span>`);
    if (!parts.length) {
      if (f.fold > 0) return '<span class="mut">Fold</span>';
      return rfi.allin > 0 ? `<span style="color:${C.amber}">Open-jams instead</span>` : '<span class="mut">Not opened</span>';
    }
    if (f.fold > 0.05) parts.push(`<span class="mut">Fold ${Math.round(f.fold * 100)}%</span>`);
    return parts.join(' · ');
  };
  const charts = depths.map(([d]) => chartOf(d));
  const rfiOf = (d, h) => { const c = DATA.depths[d].charts['BTN · RFI']; const i = ORDER.indexOf(h); const o = {}; for (const k of Object.keys(c)) o[k] = DIG.indexOf(c[k][i]) / 20; return o; };
  S.push(`<section class="slide">
  ${head('Calling a 3-bet: the deeper, the more you call', 0.5, 'Button opens · big blind 3-bets · button decides · your charts')}
  <div class="callrow">
    <div class="cgrids">${depths.map(([d], i) => `<div><div class="mini-t">${d}bb</div>${miniGrid(charts[i])}</div>`).join('')}
      <div class="legend3 left"><span><i style="background:${C.green}"></i>Call</span><span><i style="background:${C.amber}"></i>4-bet jam</span><span><i style="background:${C.red}"></i>4-bet</span><span><i style="background:#46525c"></i>Fold</span><span><i class="hlk"></i>22, 33, 65s, 76s</span></div></div>
    <table class="tbl hands"><thead><tr><th>Hand</th>${depths.map(([d]) => `<th>${d}bb</th>`).join('')}</tr></thead><tbody>
      ${hl.map((h) => `<tr><td><b>${h}</b></td>${charts.map((c, i) => `<td>${word(c[h], rfiOf(depths[i][0], h))}</td>`).join('')}</tr>`).join('')}
      <tr class="odds"><td>Behind ÷ call</td>${depths.map(([d, tb, op]) => `<td>${((+d - tb) / (tb - op)).toFixed(0)}×</td>`).join('')}</tr></tbody></table>
  </div>
  <div class="callout">Pure set-mining needs roughly <b>15–20 times</b> the call still behind (you flop a set about 1 time in 8.5). At 80bb, in position, there's about 9× plus the hands' other equity, so they call. At 50bb (6×) small pairs switch to <b>4-bet jams</b>; by 30bb (4×) suited connectors fold too.</div>
</section>`);
})();

S.push(`<section class="slide">
  ${head('The engine of playability: stack-to-pot ratio', 0.5)}
  <div class="formula">SPR = effective stack behind ÷ pot on the flop</div>
  <div class="ladder">${[
    ['13+', 'Nut hands only', 'Sets, straights, flushes', '#3d79b8'],
    ['7–13', 'Two pair or sets', 'One pair = pot control', '#6f9cc9'],
    ['4–7', 'Top pair: be careful', 'Good kicker can play a big pot', '#b9b95e'],
    ['2–4', 'Top pair, overpair', 'Plan to get it in', '#e39545'],
    ['0–2', 'Any pair, good draw', 'Already committed', '#d65a3a'],
  ].map(([s, a, b, col]) => `<div class="rung" style="background:${col}"><b>SPR ${s}</b><span>${a}</span><small>${b}</small></div>`).join('')}</div>
  <div class="spots"><span><b>13</b> 100bb single-raised</span><span><b>8</b> 50bb single-raised</span><span><b>4.5</b> 30bb single-raised · 100bb 3-bet pot</span><span><b>3.3</b> 20bb single-raised</span><span><b>2.2</b> 50bb 3-bet pot</span></div>
  <p class="foot">Each band shows the weakest hand usually strong enough to stack off (rough guide). Typical SPRs from your charts and solves, with a 1bb big-blind ante.</p>
</section>`);

S.push(`<section class="slide">
  ${head('The commitment zone: SPR 5 or less', 0.9, '40bb deep · KQo vs a button caller · flop K-8-4')}
  ${bars([
    ['Flop', 'After a 2.5bb open and call', 7.5, 37.5, 'Flop SPR = 5'],
    ['Turn', 'After you bet 5bb, called', 17.5, 32.5, 'Turn SPR ≈ 1.9'],
    ['River', 'After you bet 12.5bb, called', 42.5, 20, 'River SPR ≈ 0.5'],
  ], C.shallow)}
  <div class="callout warm">With 20bb left and 42.5bb in the pot, a half-pot shove gets it all in. Normal-sized bets commit a 40bb stack with one strong top pair. At this depth, stronger hands (AQ, sets, two pairs) usually raise earlier, so KQ is near the top of what's left.</div>
</section>`);

S.push(`<section class="slide">
  ${head('The maneuver zone: SPR above 5', 0.1, '150bb deep · same hand, same bets')}
  ${bars([
    ['Flop', 'After a 2.5bb open and call', 7.5, 147.5, 'Flop SPR ≈ 20'],
    ['Turn', 'After you bet 5bb, called', 17.5, 142.5, 'Turn SPR ≈ 8'],
    ['River', 'After you bet 12.5bb, called', 42.5, 130, 'River SPR ≈ 3'],
  ], C.deep)}
  <div class="callout cool">Same bets, but 130bb are still behind on the river. You can't get stacks in without large overbets, and opponents have the implied odds to float and draw. Their calling range includes AQ, sets, two pairs and straights that would have raised earlier when shallow, so top pair is vulnerable.</div>
</section>`);

S.push(`<section class="slide">
  ${head('The multiway modifier', 0.35)}
  <div class="mw"><div class="mwi"><div class="chips deep"></div><b>Heads-up</b><small>150bb · pot 7.5bb · SPR ≈ 20</small></div><div class="arr">→</div>
    <div class="mwi"><div class="people">👤👤👤</div><b>Open + 3 callers</b><small>3bb × 4 + blinds and ante ≈ 13.5bb pot</small></div><div class="arr">→</div>
    <div class="mwi"><div class="chips shallow"></div><b>Multiway</b><small>SPR ≈ 11: plays shallower</small></div></div>
  <div class="three-cols">
    <div class="pane"><h3>The math</h3><p>More players in the pot means a bigger pot for the same stacks, so a lower SPR, even at 150bb.</p></div>
    <div class="pane"><h3>The shift</h3><p>Strong top pairs and overpairs gain value, but so do opponents' two pairs and sets: with more players, someone has hit more often. Bluff less.</p></div>
    <div class="pane"><h3>Example</h3><p>Deep, with two early limpers, <b>over-limp</b> 44 behind them rather than isolate: it hates most flops and wants a cheap set. Don't open-limp from early position.</p></div>
  </div>
</section>`);

S.push(`<section class="slide">
  ${head('Effective stacks and opponent tendencies', null)}
  <div class="two">
    <div class="pane"><h2>The effective stack rule</h2>
      <div class="bigstat">100bb <span>vs</span> 25bb <span>=</span> <b style="color:${C.shallow}">25bb</b></div>
      <p>The effective stack is the smaller stack <b>in the hand</b>: it's the most you can win or lose. With 100bb against a 25bb player, play a 25bb strategy against them. Against another 100bb player, you're deep again. Use the stacks of the players who can enter the pot, not the table average.</p></div>
    <div class="pane"><h2>Adjust to opponents</h2>
      <table class="tbl"><tbody>
        <tr><td>They fold too much to 3-bets</td><td>3-bet more blocker bluffs</td></tr>
        <tr><td>They call 3-bets with weak hands</td><td>Drop the bluffs; 3-bet more value hands</td></tr>
        <tr><td>They 4-bet jam only premiums</td><td>Fold AQ, AJs, KQs to the jam</td></tr>
        <tr><td>They open too tight</td><td>3-bet less</td></tr>
        <tr><td>They open too wide</td><td>3-bet and re-jam more</td></tr>
      </tbody></table></div>
  </div>
</section>`);

const bb80 = { r: 15.8, j: 0, c: 65.2 }, bb30 = { r: 6.4, j: 11.1, c: 59.9 }, bb20 = { r: 6.6, j: 13.7, c: 65.7 }, bb12 = { r: 0, j: 20.9, c: 40.5 };
S.push(`<section class="slide">
  ${head('The re-jam zone (20–35bb)', 0.75, 'Big blind vs a button open · your charts')}
  <div class="two wide-l">
    <div class="pane"><h2>3-bets become all-ins: hand by hand</h2>
      <table class="tbl ex"><thead><tr><th>Hand</th><th>80bb</th><th>30bb</th><th>What happened</th></tr></thead><tbody>
        <tr><td><b>AQo</b></td><td class="r">3-bet</td><td class="a">Re-jam</td><td>Value 3-bet becomes a jam: a small 3-bet would commit a third of your stack anyway</td></tr>
        <tr><td><b>TT</b></td><td class="r">3-bet</td><td class="a">Re-jam 85%</td><td>Same: get it in now, while the opener's weaker hands still call</td></tr>
        <tr><td><b>66</b></td><td class="c">Call 85%</td><td class="a">Re-jam</td><td>Too shallow to call and set-mine, but great all-in equity and fold equity</td></tr>
        <tr><td><b>ATo</b></td><td class="c">Call</td><td class="a">Re-jam</td><td>Blocks AA and AK, and is ahead of much of a wide button range</td></tr>
        <tr><td><b>A5s</b></td><td class="r">3-bet 45%</td><td class="c">Call</td><td>The deep bluff 3-bet becomes a call: it plays well postflop but can't call a jam</td></tr>
        <tr><td><b>KJo</b></td><td class="c">Call 90%</td><td class="c">Call</td><td>Playable, but behind the hands that call a jam: just call</td></tr>
      </tbody></table></div>
    <div class="pane"><h2>The pattern</h2>
      <ul class="pts"><li>Small 3-bets drop from <b>16%</b> to <b>6%</b> of hands; re-jams rise from <b>0%</b> to <b>11%</b> (14% at 20bb).</li>
        <li><b>Re-jam</b> pairs and strong aces: good all-in equity, and aces block the opener's best hands.</li>
        <li><b>Call</b> hands that play well after the flop but can't stand a jam (suited aces, KJo).</li>
        <li><b>Open smaller</b> (2–2.3bb): the BTN opens 54% at 80bb but 36% at 20bb because the blinds re-jam.</li></ul></div>
  </div>
</section>`);

S.push(`<section class="slide">
  ${head('Calling all-ins: tighter than jamming', 0.85, 'Your charts')}
  <div class="two">
    <div class="pane"><h2>Big blind facing a button open-shove</h2>
      <table class="tbl ex"><thead><tr><th>Hand</th><th>20bb shove</th><th>12bb shove</th></tr></thead><tbody>
        <tr><td><b>A8o</b></td><td class="c">Call</td><td class="c">Call</td></tr>
        <tr><td><b>QJo</b></td><td class="c">Call 60%</td><td class="c">Call</td></tr>
        <tr><td><b>KJo</b></td><td class="c">Call 40%</td><td class="c">Call</td></tr>
        <tr><td><b>KTo</b></td><td class="f">Fold</td><td class="c">Call</td></tr>
        <tr><td><b>K9s</b></td><td class="f">Fold</td><td class="c">Call</td></tr>
        <tr><td><b>22</b></td><td class="f">Fold</td><td class="c">Call</td></tr>
      </tbody></table>
      <p class="small">Call wider against <b>shorter</b> shoves: the price is better and their range is wider.</p></div>
    <div class="pane"><h2>Button facing a big-blind re-jam</h2>
      <table class="tbl ex"><thead><tr><th>Hand</th><th>50bb re-jam</th><th>20bb re-jam</th></tr></thead><tbody>
        <tr><td><b>AJo</b></td><td class="c">Call 80%</td><td class="c">Call</td></tr>
        <tr><td><b>ATo</b></td><td class="f">Fold 80%</td><td class="c">Call</td></tr>
        <tr><td><b>A9o</b></td><td class="f">Fold</td><td class="c">Call</td></tr>
        <tr><td><b>KQo</b></td><td class="f">Fold</td><td class="c">Call</td></tr>
        <tr><td><b>66</b></td><td class="f">Fold 65%</td><td class="c">Call</td></tr>
        <tr><td><b>KJo</b></td><td class="f">Fold</td><td class="f">Fold</td></tr>
      </tbody></table>
      <p class="small">You opened every one of these, but you call a 50bb re-jam with far fewer: you need a hand <b>ahead of their jamming range</b>, not just a playable one.</p></div>
  </div>
</section>`);

const u12s = freq('12', 'UTG · RFI', 'allin'), u12r = freq('12', 'UTG · RFI', 'raise');
const u12 = {};
for (const h of ORDER) u12[h] = 0;
S.push(`<section class="slide">
  ${head('Push or fold (15bb and under)', 0.97)}
  <div class="gridrow">
    <div class="note left"><h3 style="color:${C.amber}">Two-way opens at 12bb</h3><p><b style="color:#ff8a75">Min-raise</b> the best hands (AA–TT, the best suited aces) so they get action, plus a few that can fold.</p><p><b style="color:${C.amber}">Shove</b> the middle: small and medium pairs, offsuit aces and Broadways. They win most when everyone folds and hate being re-jammed.</p></div>
    <div><div class="legend3"><span><i style="background:${C.dark2}"></i>Shove ${pct(u12s).toFixed(0)}%</span><span><i style="background:${C.red}"></i>Min-raise ${pct(u12r).toFixed(0)}%</span></div>${(() => {
      let cells = '';
      for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
        const h = handAt(r, c); const a = u12s[h], b = u12r[h];
        const bg = a + b > 0 ? `linear-gradient(90deg, ${C.red} ${b * 100}%, ${C.dark2} ${b * 100}% ${(a + b) * 100}%, #333d46 ${(a + b) * 100}%)` : '#2b343c';
        cells += `<div class="gc${a + b > 0 ? ' on' : ''}" style="background:${bg}">${h}</div>`;
      }
      return `<div class="g big">${cells}</div>`;
    })()}<div class="mini-p">UTG open · 12bb · your chart</div></div>
    <div class="note"><h3 style="color:${C.amber}">Under 10bb</h3><p>Shove or fold. Each orbit costs about 2.5bb, so shove before you're too short to make anyone fold.</p><p>Shove wider the later your seat and the shorter your stack.</p></div>
  </div>
</section>`);

S.push(`<section class="slide">
  ${head('The bubble: why you call less', 0.6, 'Bubble · you have 10bb in the big blind · the 40bb small blind shoves any two cards')}
  <div class="two wide-l">
    <div class="pane"><h2>Same hand, different answer</h2>
      <table class="tbl ex"><thead><tr><th>Your hand</th><th>Equity vs any two</th><th>Normal: need 43%</th><th>Bubble: need ~56%</th></tr></thead><tbody>
        ${[['55', 61], ['A8o', 60], ['K9o', 58], ['QJo', 58], ['K7o', 55], ['A2o', 55], ['33', 53], ['97s', 49]].map(([h, e]) => `<tr><td><b>${h}</b></td><td>${e}%</td><td class="c">Call</td><td class="${e >= 56 ? 'c' : 'f'}">${e >= 56 ? 'Call' : 'Fold'}</td></tr>`).join('')}
      </tbody></table>
      <p class="small">Normally you call 9bb to win 21bb, so 43% equity is enough. On the bubble, busting costs you a sure min-cash and doubling up doesn't double your prize, so you need roughly 12% more.</p></div>
    <div class="pane"><h2>More examples</h2>
      <ul class="pts"><li><b>QQ vs AK</b> with two big stacks: QQ is only about 55%, but with both players cashing comfortably you'd need around 70%. <b>Fold.</b></li>
        <li><b>Big stack vs a short stack's jam:</b> losing barely dents you, so call about as wide as normal.</li>
        <li><b>Medium stack vs another medium stack:</b> the most dangerous all-in on the bubble. Avoid it without a premium.</li>
        <li><b>As the big stack,</b> open and shove wider: medium stacks have to fold too much.</li>
        <li><b>Your charts ignore payouts:</b> on the bubble, call tighter than the charts.</li></ul></div>
  </div>
</section>`);

S.push(`<section class="slide">
  ${head('The master stack-depth matrix', null)}
  <table class="matrix"><thead><tr><th></th><th class="c1">100bb+<small>Maneuver</small></th><th class="c2">40–60bb<small>Top pair</small></th><th class="c3">20–35bb<small>Re-jam</small></th><th class="c4">15bb and under<small>Push/fold</small></th></tr></thead><tbody>
    <tr><th>Single-raised pot SPR</th><td>13+</td><td>About 6–8</td><td>About 3–4.5</td><td>About 2 (after a min-raise)</td></tr>
    <tr><th>Main priority</th><td>Making the nuts; pot control with one pair</td><td>Strong top pairs</td><td>High cards, blockers, fold equity</td><td>All-in equity</td></tr>
    <tr><th>Opens gain</th><td>Small pairs, suited connectors, suited aces</td><td>KJo, KTo, JTo, ATo, A9o</td><td>Same %, smaller sizes; BTN tightens</td><td>Shoves: pairs, Ax, Broadways</td></tr>
    <tr><th>3-bet bluffs</th><td>65s, 76s, 87s, T9s, A5s, A4s</td><td>ATo, AJo, KJo, KTo, A9s–A6s</td><td>Re-jams with blockers (Ax, Kx)</td><td>Re-jam or fold</td></tr>
    <tr><th>Top pair</th><td>Pot control; vulnerable to floats</td><td>Strong; stacks off in 3-bet pots</td><td>Usually a stack-off</td><td>Get it in</td></tr>
  </tbody></table>
  <p class="foot">Numbers come from your PokerCoaching charts (80bb is the deepest they go) and the solved spots in the drills. Ideas also from PokerCoaching videos by Matt Affleck (stack depth) and Jonathan Little (bubble). Full details: the Stack Depth &amp; Bubble Strategy player's guide.</p>
</section>`);

// ------------------------------------------------------------------ page
const CSS = `
@page { size: 1920px 1080px; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; background: #111; font-family: "Liberation Sans", "Helvetica Neue", Arial, sans-serif; color: ${C.ink}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.slide { width: 1920px; height: 1080px; position: relative; overflow: hidden; padding: 56px 80px; background: radial-gradient(ellipse at 30% 20%, #27313a 0%, ${C.bg} 70%); break-after: page; display: flex; flex-direction: column; gap: 26px; }
.hd { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid ${C.line}; padding-bottom: 18px; }
.hd h1 { margin: 0; font-size: 60px; line-height: 1.05; letter-spacing: .01em; text-transform: uppercase; font-weight: 800; max-width: 1200px; }
.kick { color: ${C.muted}; font-size: 24px; margin-bottom: 6px; letter-spacing: .04em; }
.slider { text-align: center; } .sl-t { color: ${C.muted}; font-size: 18px; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; }
.title { justify-content: center; align-items: center; text-align: center; }
.title .big { font-size: 120px; line-height: 1.02; margin: 10px 0 40px; font-weight: 900; letter-spacing: .02em; }
.title .slider svg { width: 900px; }
.t-kick { color: ${C.muted}; font-size: 28px; letter-spacing: .1em; text-transform: uppercase; }
.t-sub { font-size: 40px; color: #cfc8bb; max-width: 1400px; margin-top: 40px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 50px; flex: 1; }
.three-cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 30px; }
.pane { background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 18px; padding: 30px 34px; font-size: 28px; line-height: 1.35; }
.pane h2 { margin: 0 0 18px; font-size: 38px; text-transform: uppercase; letter-spacing: .02em; }
.pane h3 { margin: 0 0 10px; font-size: 30px; }
.pane p { margin: 0 0 14px; }
.center { text-align: center; display: flex; flex-direction: column; align-items: center; }
.small { font-size: 24px; color: #cfc8bb; }
.g { display: grid; grid-template-columns: repeat(13, 1fr); gap: 3px; }
.g.big { width: 700px; } .g.big.delta { width: 620px; } .g.big.delta .gc { font-size: 13px; } .g.mid { width: 560px; } .g.small { width: 250px; gap: 2px; }
.gc { aspect-ratio: 1; display: grid; place-items: center; font-size: 15px; font-weight: 700; color: #7f8b93; border-radius: 3px; }
.gc.on, .gc.add, .gc.keep { color: #fff; }
.g.small .gc { font-size: 0; border-radius: 2px; }
.row8 { display: grid; grid-template-columns: auto 1fr auto; gap: 34px; align-items: center; }
.g.mid8 { width: 560px; gap: 2px; } .g.mid8 .gc { font-size: 12px; }
.gc.hl-deep { outline: 4px solid #8fc3f2; outline-offset: -2px; position: relative; z-index: 1; }
.gc.hl-shal { outline: 4px solid #ffb37a; outline-offset: -2px; position: relative; z-index: 1; }
.mid-col { display: flex; flex-direction: column; gap: 16px; align-items: center; }
.legend3.col { flex-wrap: wrap; justify-content: center; }
.legend3 i.o-deep { background: transparent; outline: 4px solid #8fc3f2; outline-offset: -4px; } .legend3 i.o-shal { background: transparent; outline: 4px solid #ffb37a; outline-offset: -4px; }
.t8 { font-size: 26px; } .t8 td, .t8 th { text-align: center; padding: 8px 10px; } .t8 tr.rs td:first-child { color: #ffb37a; } .t8 tr.rd td:first-child { color: #8fc3f2; }
.two8 { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; font-size: 24px; } .two8 .box { font-size: 24px; padding: 16px 20px; }
.two.wide-l { grid-template-columns: 1.35fr 1fr; }
.tbl.ex { font-size: 25px; } .tbl.ex td { padding: 9px 10px; } .tbl.ex td.c { color: ${C.green}; font-weight: 700; } .tbl.ex td.r { color: #ff8a75; font-weight: 700; } .tbl.ex td.a { color: ${C.amber}; font-weight: 700; } .tbl.ex td.f { color: #8b969d; }
.gc.hlc { outline: 3px solid #fff; outline-offset: -1px; z-index: 1; position: relative; }
.callrow { display: grid; grid-template-columns: 1.15fr 1fr; gap: 40px; align-items: center; flex: 1; }
.cgrids { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px 30px; justify-items: center; }
.cgrids .g.small { width: 232px; }\n.cgrids { gap: 10px 30px; } .cgrids .mini-t { margin-bottom: 4px; }
.legend3.left { grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
.legend3 i.hlk { background: transparent; outline: 3px solid #fff; outline-offset: -3px; }
.tbl.hands { font-size: 28px; } .tbl.hands td { padding: 14px 12px; } .tbl.hands .mut { color: #8b969d; } .tbl.hands tr.odds td { color: ${C.amber}; font-weight: 800; border-top: 2px solid #9fabb3; }
.gc.rem { background: #3f474e; color: #b7bec3; position: relative; }
.gc.rem::after { content: '✕'; position: absolute; inset: 0; display: grid; place-items: center; color: #ff8a75; font-size: 30px; opacity: .85; }
.lockwrap { position: relative; display: flex; justify-content: center; margin: 10px 0 24px; }
.lockwrap .g { filter: grayscale(1) brightness(.75); }
.lock { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 200px; filter: grayscale(1); }
.tri { display: flex; justify-content: space-between; gap: 18px; margin: 10px 0 24px; }
.mini-t { font-size: 22px; font-weight: 700; margin-bottom: 8px; } .mini-p { font-size: 20px; color: ${C.muted}; margin-top: 6px; text-align: center; }
.seesaw { width: 100%; height: 360px; }
.ss-labels { display: flex; justify-content: space-between; padding: 0 120px; } .ss-labels div { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 28px; max-width: 520px; text-align: center; } .ss-labels b { font-size: 38px; }
.callout { border: 2px solid #8b959c; border-radius: 16px; padding: 24px 34px; font-size: 32px; line-height: 1.4; background: #252e36; }
.callout.warm { border-color: ${C.shallow}; background: #3a2a22; } .callout.cool { border-color: ${C.deep}; background: #1f2f3e; }
.foot { margin: auto 0 0; font-size: 22px; color: ${C.muted}; }
.cards { display: flex; align-items: center; gap: 16px; margin: 10px 0 28px; } .cards.sm .pc { width: 90px; height: 126px; } .cards.sm .pc b { font-size: 46px; }
.pc { width: 120px; height: 168px; background: #f6f3ec; border-radius: 12px; color: #161b1f; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 6px 16px rgba(0,0,0,.4); }
.pc b { font-size: 64px; line-height: 1; } .pc span { font-size: 54px; } .pc.red { color: #c4302b; }
.cl { font-size: 46px; font-weight: 800; margin-left: 18px; }
.box { border: 3px solid; border-radius: 12px; padding: 20px 24px; font-size: 28px; }
.gridrow { display: grid; grid-template-columns: 1fr auto 1fr; gap: 40px; align-items: center; flex: 1; }
.note { font-size: 27px; line-height: 1.35; } .note h3 { font-size: 32px; margin: 0 0 8px; } .note p { margin: 0 0 22px; }
.note.left { text-align: right; }
.stat { margin-top: 10px; } .stat b { font-size: 70px; color: ${C.deep}; display: block; } .stat span { color: ${C.muted}; font-size: 24px; }
.box2 { border-radius: 16px; padding: 24px 28px; } .box2.grey { background: #3a4249; text-align: left; } .box2.orange { background: #6a3420; }
.legend3 { display: flex; gap: 26px; justify-content: center; font-size: 22px; margin-bottom: 10px; }
.legend3 i { display: inline-block; width: 22px; height: 22px; border-radius: 4px; vertical-align: -4px; margin-right: 8px; }
.legend3 i.x { background: #3f474e; position: relative; } .legend3 i.x::after { content: '✕'; color: #ff8a75; position: absolute; inset: 0; display: grid; place-items: center; font-size: 16px; }
.eq { text-align: center; font-size: 30px; background: #252e36; border: 2px solid ${C.line}; border-radius: 14px; padding: 14px 24px; }
.shield { position: relative; display: flex; flex-direction: column; gap: 10px; margin: 10px 0 20px; align-items: flex-start; }
.arrow { background: ${C.red}; color: #fff; font-weight: 800; font-size: 30px; padding: 6px 60px 6px 18px; clip-path: polygon(0 0, 80% 0, 100% 50%, 80% 100%, 0 100%); }
.sh { position: absolute; right: -120px; top: 20px; width: 120px; height: 150px; background: ${C.shallow}; clip-path: polygon(50% 0, 100% 18%, 92% 70%, 50% 100%, 8% 70%, 0 18%); display: grid; place-items: center; font-size: 70px; font-weight: 900; color: #fff; }
.swap { display: flex; align-items: center; gap: 18px; margin: 20px 0 26px; } .swap .old { background: #39424a; padding: 16px 20px; border-radius: 10px; font-size: 30px; text-decoration: line-through; text-decoration-color: ${C.red}; text-decoration-thickness: 4px; }
.swap .arr, .mw .arr { font-size: 60px; color: ${C.shallow}; } .swap .new { background: ${C.shallow}; padding: 16px 20px; border-radius: 10px; font-size: 30px; font-weight: 800; }
.tbl { width: 100%; border-collapse: collapse; font-size: 26px; } .tbl th, .tbl td { padding: 10px 12px; border-bottom: 1px solid ${C.line}; text-align: left; } .tbl th { color: ${C.muted}; font-size: 20px; text-transform: uppercase; }
.tbl.big { font-size: 32px; }
.flow { display: flex; flex-direction: column; align-items: center; gap: 16px; flex: 1; }
.fbox { background: ${C.panel}; border: 2px solid ${C.line}; border-radius: 12px; padding: 16px 24px; font-size: 28px; text-align: center; }
.fbox.top { font-size: 32px; font-weight: 700; }
.fcols { display: grid; grid-template-columns: 1fr 1fr; gap: 80px; width: 100%; }
.fcol { display: flex; flex-direction: column; align-items: center; gap: 8px; } .fdown { font-size: 40px; color: ${C.muted}; }
.fcol.good .fbox { border-color: ${C.shallow}; } .fbox.hl { background: #4a2b1d; font-weight: 800; color: #ffb48f; } .fbox.dim { color: #b7bec3; font-weight: 700; }
.banner { background: ${C.shallow}; margin: 0 -80px -56px; padding: 26px 80px; font-size: 36px; font-weight: 800; text-align: center; }
.formula { text-align: center; font-size: 56px; font-weight: 800; }
.ladder { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.rung { padding: 22px 18px; border-radius: 10px; color: #13221a; display: flex; flex-direction: column; gap: 6px; min-height: 190px; } .rung b { font-size: 30px; } .rung span { font-size: 30px; font-weight: 800; } .rung small { font-size: 22px; }
.spots { display: flex; flex-wrap: wrap; gap: 14px 30px; font-size: 26px; color: #cfc8bb; } .spots b { color: ${C.amber}; font-size: 30px; margin-right: 6px; }
.bars { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; flex: 1; }
.bcol { background: ${C.panel}; border-radius: 16px; padding: 20px 26px; display: flex; flex-direction: column; }
.bh { font-size: 34px; font-weight: 800; text-transform: uppercase; } .ba { font-size: 22px; color: ${C.muted}; margin-bottom: 10px; }
.bplot { flex: 1; display: flex; align-items: flex-end; justify-content: center; gap: 30px; min-height: 260px; border-bottom: 2px solid ${C.line}; margin-top: 54px; }
.bar { width: 120px; border-radius: 8px 8px 0 0; position: relative; } .bar.pot { background: #e8e5de; } .bar span { position: absolute; top: -40px; left: 0; right: 0; text-align: center; font-size: 28px; font-weight: 800; }
.bl { display: flex; justify-content: center; gap: 70px; font-size: 22px; color: ${C.muted}; margin-top: 8px; } .bs { text-align: center; font-size: 32px; font-weight: 800; margin-top: 10px; }
.mw { display: flex; align-items: center; justify-content: space-around; background: ${C.panel}; border-radius: 18px; padding: 26px; }
.mwi { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 30px; } .mwi small { font-size: 22px; color: ${C.muted}; }
.chips { width: 140px; height: 140px; border-radius: 50%; border: 10px dashed #fff3; } .chips.deep { background: ${C.deep}; } .chips.shallow { background: ${C.shallow}; width: 100px; height: 100px; }
.people { font-size: 70px; filter: grayscale(1); }
.bigstat { font-size: 64px; font-weight: 900; margin: 10px 0 24px; } .bigstat span { color: ${C.muted}; font-size: 40px; margin: 0 10px; }
.pts { margin: 0; padding-left: 28px; } .pts li { margin-bottom: 14px; }
.risk { width: 100%; border-collapse: separate; border-spacing: 6px; font-size: 26px; text-align: center; } .risk th { color: ${C.muted}; font-size: 22px; } .risk td { padding: 18px 8px; border-radius: 8px; font-weight: 800; color: #1a1a1a; }
.r0 { background: #8fd0a2; } .r1 { background: #c7dd9a; } .r2 { background: #f0d48a; } .r3 { background: #f0a77d; } .r4 { background: #e9776a; }
.matrix { width: 100%; border-collapse: collapse; font-size: 26px; flex: 1; } .matrix th, .matrix td { border: 2px solid ${C.line}; padding: 14px 16px; vertical-align: middle; }
.matrix thead th { font-size: 30px; text-align: center; } .matrix thead th small { display: block; font-size: 20px; font-weight: 400; opacity: .9; }
.matrix tbody th { text-align: left; background: #2b343c; width: 300px; } .matrix td { text-align: center; }
.c1 { background: ${C.deep}; } .c2 { background: #6c6fa0; } .c3 { background: #b56a4a; } .c4 { background: ${C.shallow}; }
.matrix tbody td:nth-child(2) { background: #23384c; } .matrix tbody td:nth-child(3) { background: #2d2f45; } .matrix tbody td:nth-child(4) { background: #3e2c25; } .matrix tbody td:nth-child(5) { background: #4a2a1c; }
`;

(async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tactical Stack-Size Adjustments</title><style>${CSS}</style></head><body>${S.join('\n')}</body></html>`;
  const out = path.join(ROOT, 'resources', 'stack-depth-slides.html');
  fs.writeFileSync(out, html);
  console.log('wrote', out, S.length, 'slides');
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + out);
  await page.pdf({ path: out.replace(/\.html$/, '.pdf'), width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log('wrote', out.replace(/\.html$/, '.pdf'));
})();
