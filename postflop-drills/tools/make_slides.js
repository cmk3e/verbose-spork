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
  ${head('The static fallacy vs the dynamic strategy', null)}
  <div class="two">
    <div class="pane"><h2>The static fallacy</h2>
      <div class="lockwrap">${grid(LJ[50], '#59636b', { labels: false, size: 'mid' })}<div class="lock">🔒</div></div>
      <p>Weaker players use one opening range at every stack depth, ignoring what happens after the flop.</p></div>
    <div class="pane"><h2>The dynamic strategy</h2>
      <div class="tri">${[['80', C.deep], ['50', '#8f7ba4'], ['20', C.shallow]].map(([d, col]) => `<div><div class="mini-t">LJ open · ${d}bb</div>${grid(LJ[d], col, { labels: false, size: 'small' })}<div class="mini-p">${pct(LJ[d]).toFixed(1)}% of hands</div></div>`).join('')}</div>
      <p>Good players keep roughly the same <b>number</b> of hands but change <b>which</b> hands as the effective stack shrinks. These are your real lojack charts.</p></div>
  </div>
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

S.push(`<section class="slide">
  ${head('3-betting: the shallow-stack strategy', 0.8)}
  <div class="three-cols">
    <div class="pane center"><h2>The blocker shield</h2>
      <div class="shield">${['AA', 'KK', 'AK', 'AQ'].map((h) => `<div class="arrow">${h}</div>`).join('')}<div class="sh">A</div></div>
      <p class="small">At 50bb, opponents 4-bet <b>jam</b> over your 3-bet. An ace in your hand cuts their AA, AK and AQ combos; a king cuts KK and AK.</p></div>
    <div class="pane center"><h2>The swap</h2>
      <div class="swap"><div class="old">76s · 65s</div><div class="arr">→</div><div class="new">ATo · AJo · KJo<br>KTo · A9s–A6s</div></div>
      <p class="small">Small suited connectors can't call a jam and don't block anything. Offsuit Broadways block the jams and flop top pairs that are easy to play when called.</p></div>
    <div class="pane"><h2>Your 50bb chart</h2>
      <table class="tbl"><thead><tr><th>Hand</th><th>3-bet at 80bb</th><th>at 50bb</th></tr></thead><tbody>
        ${['ATo', 'AQo', 'A5s', 'KJo', 'QJo', 'A2s', '65s'].map((h) => `<tr><td>${h}</td><td>${Math.round(bt80[h] * 100)}%</td><td>${Math.round(bt50[h] * 100)}%</td></tr>`).join('')}</tbody></table>
      <p class="small">BTN vs LJ open. Offsuit Broadways rise; A2s and 65s drop out. A5s stays: it blocks aces and still makes wheels.</p></div>
  </div>
</section>`);

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
  ${head('New: the re-jam zone (20–35bb)', 0.75)}
  <div class="two">
    <div class="pane"><h2>3-bets become all-ins</h2>
      <table class="tbl big"><thead><tr><th>BB vs BTN open</th><th>3-bet</th><th>Re-jam</th><th>Call</th></tr></thead><tbody>
        ${[['80bb', bb80], ['30bb', bb30], ['20bb', bb20], ['12bb', bb12]].map(([d, x]) => `<tr><td>${d}</td><td>${x.r}%</td><td style="color:${C.amber}">${x.j}%</td><td>${x.c}%</td></tr>`).join('')}</tbody></table>
      <p class="small">From your charts. A small 3-bet at 30bb already commits a third of your stack, so the all-in replaces it.</p></div>
    <div class="pane"><h2>What changes</h2>
      <ul class="pts"><li><b>Open smaller</b> (2–2.3bb). The BTN tightens from 54% (80bb) to 45% (30bb) to 36% (20bb) because the blinds re-jam.</li>
        <li><b>Re-jam with blockers</b> and hands that do well all in: Ax, KQ, KJ, pairs.</li>
        <li><b>Call jams tighter than you'd jam</b> (the gap concept): you need a hand ahead of their range.</li>
        <li><b>Postflop</b>: SPR 3–4.5 makes top pair good kicker a stack-off; bet small and plan to get it in.</li></ul></div>
  </div>
</section>`);

const u12s = freq('12', 'UTG · RFI', 'allin'), u12r = freq('12', 'UTG · RFI', 'raise');
const u12 = {};
for (const h of ORDER) u12[h] = 0;
S.push(`<section class="slide">
  ${head('New: push or fold (15bb and under)', 0.97)}
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
    <div class="note"><h3 style="color:${C.amber}">Facing a shove</h3><p>At 12bb the BB calls a BTN shove with about 28% of hands and an SB shove with about 40%.</p><h3 style="color:${C.amber}">Under 10bb</h3><p>Shove or fold. Each orbit costs about 2.5bb, so shove before you're too short to make anyone fold.</p></div>
  </div>
</section>`);

S.push(`<section class="slide">
  ${head('New: the bubble and risk premium', 0.6)}
  <div class="two">
    <div class="pane"><h2>Extra equity needed to call an all-in</h2>
      <table class="risk"><thead><tr><th>You / they</th><th>Short</th><th>Medium</th><th>Big</th></tr></thead><tbody>
        <tr><th>Short</th><td class="r2">Moderate</td><td class="r3">High</td><td class="r3">+9–15%</td></tr>
        <tr><th>Medium</th><td class="r1">Low</td><td class="r4">Very high</td><td class="r4">Very high</td></tr>
        <tr><th>Big</th><td class="r0">Very low</td><td class="r2">Moderate</td><td class="r4">+18–35%</td></tr></tbody></table>
      <p class="small">Rough guide (numbers from Jonathan Little; other cells follow the same logic). Near the money, chips you lose cost more than chips you win are worth.</p></div>
    <div class="pane"><h2>How it plays</h2>
      <ul class="pts"><li><b>Example:</b> 10bb in the BB vs a 40bb SB shove with any two: you need about 56% (44+, A6s+, A8o+, K6s+, K8o+, Q8s+, JTs), not 43%.</li>
        <li><b>Big stack:</b> open, 3-bet and defend wider; medium stacks can't fight back.</li>
        <li><b>Medium stack:</b> avoid the big stacks; pressure other medium and short stacks.</li>
        <li><b>Short stack:</b> shove, don't min-raise and call off.</li>
        <li><b>Your charts are chip EV:</b> tighten calls by the risk premium on the bubble.</li></ul></div>
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
.bplot { flex: 1; display: flex; align-items: flex-end; justify-content: center; gap: 30px; min-height: 260px; border-bottom: 2px solid ${C.line}; }
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
