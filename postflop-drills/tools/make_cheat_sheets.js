/* Two printable one-to-two page sheets (HTML + PDF):
 *   resources/preflop-sizing-chart.(html|pdf)  open / 3-bet / 4-bet sizes by stack depth
 *   resources/raising-cheat-sheet.(html|pdf)   when to raise on the flop and turn
 *
 * usage (from postflop-drills/):  node tools/make_cheat_sheets.js
 *
 * Open sizes and how often 3-bets / 4-bets are all in come from the chart data
 * (preflop-data.js). Raise frequencies come from every solved spot in solver-data/.
 */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources');
global.window = global;
require(path.join(ROOT, 'preflop-data.js'));
const PF = global.PF_PREFLOP_DATA;
const DIG = '0123456789abcdefghijk';
const combos = (h) => (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12);
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pct = (x) => Math.round(x * 100) + '%';

// ------------------------------------------------------------------ preflop chart shares
function share(chart, act) {
  if (!chart[act]) return 0;
  let s = 0;
  PF.order.forEach((h, i) => { s += (DIG.indexOf(chart[act][i]) / 20) * combos(h); });
  return s;
}
function jamShares(depth) {
  const C = PF.depths[depth].charts;
  const acc = { open: [0, 0], ip3: [0, 0], blind3: [0, 0], four: [0, 0] };
  for (const [t, c] of Object.entries(C)) {
    let k = null;
    if (/ · RFI$/.test(t) && / vs /.test(t)) k = /^(SB|BB) /.test(t) ? 'blind3' : 'ip3';
    else if (/ · RFI$/.test(t)) k = 'open';
    else if (/ · 3-Bet$/.test(t)) k = 'four';
    if (!k) continue;
    acc[k][0] += share(c, 'allin');
    acc[k][1] += share(c, 'raise');
  }
  const out = {};
  for (const [k, [a, r]] of Object.entries(acc)) out[k] = a + r > 0 ? a / (a + r) : null;
  return out;
}

// Called 3-bet pot: SPR after the flop comes (1bb big-blind ante, blinds fold unless 3-betting)
function spr3(depth, open, three, fromBlind) {
  const dead = fromBlind ? 1.5 - 1 + 1 : 1.5 + 1; // BB 3-betting: SB 0.5 + ante 1 are dead
  const pot = three * 2 + dead;
  return (depth - three) / pot;
}

const SIZES = [
  {
    d: 80, open: '2.3bb', sb: '3.5bb',
    ip: '3× the open (about 7bb)', blind: '4× (about 9–9.5bb); vs an SB open, about 3× (10–11bb)',
    four: 'About 2.2× the 3-bet in position, 2.5× out of position (about 16–22bb)',
    note: 'Deep enough to 3-bet and 4-bet small. Stacks go in later, after the flop.',
    spr: [spr3(80, 2.3, 7, false), spr3(80, 2.3, 9.2, true)],
  },
  {
    d: 50, open: '2.2bb', sb: '3.5bb',
    ip: '3× (6.6bb)', blind: '4× (8.8bb); vs an SB open, about 3× (10.5bb)',
    four: 'All in, or a small 4-bet of about 2.2× (15bb) that commits you anyway',
    note: 'The sizes the 50bb solver spots use. A called 3-bet leaves SPR under 3: top pair is usually good enough to get it in.',
    spr: [spr3(50, 2.2, 6.6, false), spr3(50, 2.2, 8.8, true)],
  },
  {
    d: 30, open: '2.3bb', sb: '3.2bb',
    ip: 'About 2.5× (5.5–6bb), or all in', blind: 'About 3× (7bb), or all in',
    four: 'Always all in',
    note: 'A small 3-bet already commits about a fifth of your stack, so many 3-bets from the blinds are simply all in.',
    spr: [spr3(30, 2.3, 5.75, false), spr3(30, 2.3, 6.9, true)],
  },
  {
    d: 20, open: '2bb (min-raise); some all-in opens late', sb: '3bb',
    ip: 'Almost always all in', blind: 'Mostly all in; a few small 3-bets (about 5bb) from the big blind',
    four: 'Always all in',
    note: 'Re-jam territory. A non-all-in 3-bet leaves too little behind to fold.',
    spr: null,
  },
  {
    d: 12, open: 'Min-raise (2bb) or all in', sb: 'Limp or all in',
    ip: 'All in', blind: 'All in',
    four: 'n/a',
    note: 'Push/fold: every re-raise is all in. See the 12bb push/fold charts.',
    spr: null,
  },
];

function bar(x, label) {
  if (x == null) return '<span class="na">n/a</span>';
  const j = Math.round(x * 100);
  return `<div class="bar" title="${label}"><i class="jam" style="width:${j}%"></i><i class="sm" style="width:${100 - j}%"></i></div><span class="bl">${j}% all in</span>`;
}

function sizingHTML() {
  const rows = SIZES.map((s) => {
    const js = jamShares(String(s.d));
    return `<tr>
      <th><span class="depth">${s.d}bb</span></th>
      <td><b>${esc(s.open)}</b><div class="sub">SB vs BB: ${esc(s.sb)}</div>${js.open ? `<div class="sub">${pct(js.open)} of opens are all in</div>` : ''}</td>
      <td>${esc(s.ip)}<div class="mini">${bar(js.ip3, 'in position')}</div></td>
      <td>${esc(s.blind)}<div class="mini">${bar(js.blind3, 'from the blinds')}</div></td>
      <td>${esc(s.four)}<div class="mini">${bar(js.four, '4-bets')}</div></td>
      <td class="why">${esc(s.note)}${s.spr ? `<div class="sub">Called 3-bet SPR: about ${s.spr[0].toFixed(1)} in position, ${s.spr[1].toFixed(1)} from the BB</div>` : ''}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preflop sizing chart</title><style>${CSS}
  table.size th:first-child { width: 4.2em; }
  table.size td { width: 18%; }
  table.size td.why { width: 22%; color: #3b4a42; }
  .depth { display: inline-block; background: #1d5640; color: #fff; font-weight: 800; border-radius: 6px; padding: 2px 7px; }
  .bar { display: flex; height: 7px; border-radius: 3px; overflow: hidden; margin-top: 5px; background: #eef1ef; }
  .bar .jam { background: #8f1f1a; } .bar .sm { background: #e5483f; opacity: .45; }
  .bl { font-size: 7.2pt; color: #5a6a61; }
  .na { font-size: 7.2pt; color: #a0aaa5; }
  </style></head><body>
  <h1>Preflop raise sizing by stack depth</h1>
  <p class="lead">How big to open, 3-bet and 4-bet at 80, 50, 30, 20 and 12bb (8-max, 1bb big-blind ante). The bars show how often your charts make that raise all in rather than a smaller raise.</p>
  <table class="size keep"><thead><tr><th>Stack</th><th>Open (folded to you)</th><th>3-bet in position</th><th>3-bet from the blinds</th><th>4-bet</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="key"><span><i style="background:#8f1f1a"></i>All-in share</span><span><i style="background:#e5483f;opacity:.45"></i>Smaller raise</span></div>

  <div class="cols">
    <div>
      <h2>Adjustments</h2>
      <ul>
        <li><b>Limpers:</b> add 1bb to your open for each limper.</li>
        <li><b>Squeeze</b> (open plus callers): your normal 3-bet plus one open-size for each caller. At 30bb and below, squeeze all in.</li>
        <li><b>Out of position, go bigger:</b> 3-bet about 4× from the blinds vs 3× in position, so the caller pays more to play the hand with position.</li>
        <li><b>Short stack behind you:</b> at 20–25bb, prefer a min-raise you can fold to a re-jam, or open-jam, over a big open you are committed to.</li>
        <li><b>Effective stack:</b> size for the smaller stack in the hand, not your own.</li>
      </ul>
    </div>
    <div>
      <h2>Why sizes shrink as stacks shrink</h2>
      <ul>
        <li>Opens stay about 2–2.3bb at every depth; what changes is the 3-bet.</li>
        <li>A 3-bet is a share of your stack: 7bb is 9% of 80bb but 23% of 30bb. Once a 3-bet costs a fifth of your stack, you can't fold to a jam, so the solver jams instead.</li>
        <li>That is why the all-in share jumps from about 0% at 50bb to about a third at 30bb and most 3-bets at 20bb.</li>
        <li>4-bets go all in from about 50bb: a 4-bet to 15bb leaves too little behind to fold.</li>
      </ul>
    </div>
  </div>
  <p class="src">Opens, SB sizes and all-in shares: your PokerCoaching charts. Your charts don't list 3-bet and 4-bet sizes, so the bb amounts are standard sizes (the 50bb solver spots use 6.6bb in position and 8.8bb from the blinds).</p>
  </body></html>`;
}

// ------------------------------------------------------------------ solver raise stats
const SPOTS = {
  'btn-bb-50': 'IP', 'btn-bb-30': 'IP', 'btn-bb-20': 'IP', 'hj-bb-50': 'IP', 'utg-bb-50': 'IP', 'co-bb-50': 'IP', 'btn3-co-50': 'IP',
  'sb-bb-50': 'OOP', 'sb-bb-30': 'OOP', 'sb-bb-20': 'OOP', 'co-btn-50': 'OOP', 'bb3-btn-50': 'OOP', 'sb3-btn-50': 'OOP',
  'btn-bb-50-t1': 'IP',
};
const SRP50_BB = ['btn-bb-50', 'co-bb-50', 'hj-bb-50', 'utg-bb-50'];
const THREE_BET = ['bb3-btn-50', 'sb3-btn-50', 'btn3-co-50'];

function fine(hole, board) {
  const f = E.handFeatures(hole, board);
  const L = f.label;
  if (f.group === 'strong') return /Overpair/.test(L) ? 'overpair' : /Top pair/.test(L) ? 'tpgk' : 'twoplus';
  if (f.group === 'draw') {
    if (/^(Top|Middle|Bottom|Pocket|Underpair|Overpair)/.test(L)) return 'pairdraw';
    if (/Combo/.test(L)) return 'combo';
    return /flush draw/i.test(L) ? 'fd' : 'oesd';
  }
  if (f.group === 'marginal') return /Top pair/.test(L) ? 'tpwk' : /ace high/i.test(L) ? 'ahigh' : 'weakpair';
  if (f.group === 'weakdraw') return /Gutshot/.test(L) ? 'gutshot' : 'backdoor';
  return 'air';
}
const FINE = {
  twoplus: 'Sets, two pair, straights, flushes', overpair: 'Overpairs', tpgk: 'Top pair, J+ kicker',
  combo: 'Combo draws', oesd: 'Open-ended straight draws', fd: 'Flush draws', gutshot: 'Gutshots', pairdraw: 'Pair + strong draw',
  tpwk: 'Top pair, weak kicker', weakpair: 'Middle, bottom and under pairs', ahigh: 'Ace high (AT+)', backdoor: 'Backdoor draws only', air: 'Air (nothing)',
};
function boardClass(board) {
  const b = E.describeBoard(board).split(', ');
  if (b.includes('paired')) return 'Paired';
  if (b.includes('monotone')) return 'Monotone';
  const hi = { high: 'Q-high or higher', middling: '9 to J high', low: '8-high or lower' }[b[0]];
  return hi;
}

const rows = [];
for (const [id, raiserPos] of Object.entries(SPOTS)) {
  const dir = path.join(ROOT, 'solver-data', id);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f === 'index.json') continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f)));
    const board = d.flop.match(/../g).map(E.parseCard);
    for (const [node, n] of Object.entries(d.nodes)) {
      if (!/b\d$/.test(node)) continue;
      const ri = n.actions.findIndex((a) => /Raise|All-in/.test(a));
      if (ri < 0) continue;
      const ci = n.actions.indexOf('Call');
      const who = (n.player === 'OOP') === (raiserPos === 'OOP') ? 'raiser' : 'caller';
      const parent = d.nodes[node.startsWith('x-') ? 'x' : 'root'];
      const bet = +parent.actions[+node.slice(-1)].split(' ')[1];
      const role = `${who}-${n.player}-${node.startsWith('x-') ? 'xr' : 'raise'}`;
      for (const [h, v] of Object.entries(n.hands)) {
        if (!v[0]) continue;
        const hole = h.match(/../g).map(E.parseCard);
        rows.push({
          id, street: board.length === 4 ? 'turn' : 'flop', board, role, size: bet / parent.pot, w: v[0],
          raise: v[1 + ri] / 100, call: v[1 + ci] / 100, fine: fine(hole, board),
        });
      }
    }
  }
}
function rate(filter, key) {
  const A = {};
  for (const r of rows) {
    if (!filter(r)) continue;
    const k = key ? key(r) : 'all';
    const a = (A[k] = A[k] || [0, 0, 0]);
    a[0] += r.w; a[1] += r.w * r.raise; a[2] += r.w * r.call;
  }
  const out = {};
  for (const [k, a] of Object.entries(A)) out[k] = { raise: a[1] / a[0], call: a[2] / a[0], fold: 1 - (a[1] + a[2]) / a[0], raiseW: a[1] };
  return out;
}
const small = (r) => r.size < 0.5;
const one = (f) => rate(f).all;

const S = {
  bbXrSmall: one((r) => r.street === 'flop' && SRP50_BB.includes(r.id) && r.role === 'caller-OOP-xr' && small(r)),
  bbXrBig: one((r) => r.street === 'flop' && SRP50_BB.includes(r.id) && r.role === 'caller-OOP-xr' && !small(r)),
  ipRaiseSmall: one((r) => r.street === 'flop' && ['sb-bb-50', 'co-btn-50'].includes(r.id) && r.role === 'caller-IP-raise' && small(r)),
  ipRaiseBig: one((r) => r.street === 'flop' && ['sb-bb-50', 'co-btn-50'].includes(r.id) && r.role === 'caller-IP-raise' && !small(r)),
  threeBetCaller: one((r) => r.street === 'flop' && THREE_BET.includes(r.id) && r.role.startsWith('caller')),
  raiserXr: one((r) => r.street === 'flop' && r.id.endsWith('-50') && r.role === 'raiser-OOP-xr'),
  vsLead: one((r) => r.street === 'flop' && r.role === 'raiser-IP-raise' && small(r)),
  turnXr: rate((r) => r.street === 'turn' && r.role === 'caller-OOP-xr', (r) => (r.size < 0.5 ? 's' : r.size < 1 ? 'b' : 'o')),
  turnVsLead: one((r) => r.street === 'turn' && r.role === 'raiser-IP-raise' && small(r)),
  depth: rate((r) => r.street === 'flop' && r.role === 'caller-OOP-xr' && ['btn-bb-50', 'btn-bb-30', 'btn-bb-20'].includes(r.id), (r) => r.id + '|' + r.fine),
};
const bbFine = rate((r) => r.street === 'flop' && SRP50_BB.includes(r.id) && r.role === 'caller-OOP-xr', (r) => r.fine);
const ipFine = rate((r) => r.street === 'flop' && ['sb-bb-50', 'co-btn-50'].includes(r.id) && r.role === 'caller-IP-raise', (r) => r.fine);
const tbFine = rate((r) => r.street === 'flop' && THREE_BET.includes(r.id) && r.role.startsWith('caller'), (r) => r.fine);
const turnFine = rate((r) => r.street === 'turn' && r.role === 'caller-OOP-xr', (r) => r.fine);
const bbBoard = rate((r) => r.street === 'flop' && SRP50_BB.includes(r.id) && r.role === 'caller-OOP-xr' && small(r), (r) => boardClass(r.board.slice(0, 3)));
const perFlop = rate((r) => r.street === 'flop' && r.id === 'btn-bb-50' && r.role === 'caller-OOP-xr' && small(r), (r) => r.board.map(E.cardStr).join(''));
const flopRank = Object.entries(perFlop).sort((a, b) => b[1].raise - a[1].raise);
const fmtBoard = (s) => s.match(/../g).map((c) => `${c[0]}<span class="s${c[1]}">${{ s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]]}</span>`).join('');

function freqBar(x) {
  return `<span class="fb"><i class="r" style="width:${x.raise * 100}%"></i><i class="c" style="width:${x.call * 100}%"></i></span>`;
}
function fineTable(title, F, order) {
  const body = order.filter((k) => F[k]).map((k) => {
    const x = F[k];
    return `<tr><td>${FINE[k]}</td><td class="n"><b>${pct(x.raise)}</b></td><td class="n">${pct(x.call)}</td><td class="n">${pct(x.fold)}</td><td>${freqBar(x)}</td></tr>`;
  }).join('');
  return `<table class="fine keep"><thead><tr><th>${esc(title)}</th><th>Raise</th><th>Call</th><th>Fold</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}
const ORDER = ['twoplus', 'overpair', 'tpgk', 'combo', 'oesd', 'fd', 'gutshot', 'pairdraw', 'tpwk', 'weakpair', 'ahigh', 'backdoor', 'air'];

function raisingHTML() {
  const dep = (id, k) => S.depth[id + '|' + k];
  const boards = ['8-high or lower', 'Paired', '9 to J high', 'Monotone', 'Q-high or higher'].filter((k) => bbBoard[k]);
  const boardRows = boards.map((k) => `<tr><td>${k}</td><td class="n"><b>${pct(bbBoard[k].raise)}</b></td><td>${freqBar(bbBoard[k])}</td></tr>`).join('');
  const top3 = flopRank.slice(0, 4).map(([b, x]) => `${fmtBoard(b)} ${pct(x.raise)}`).join(' · ');
  const bot3 = flopRank.slice(-4).reverse().map(([b, x]) => `${fmtBoard(b)} ${pct(x.raise)}`).join(' · ');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Raising cheat sheet</title><style>${CSS}
  .sh { color: #c4302b; } .sd { color: #1f5fbf; } .sc { color: #217a3c; } .ss { color: #1b1f1d; }
  .fb { display: inline-flex; width: 110px; height: 8px; border-radius: 3px; overflow: hidden; background: #eef1ef; vertical-align: middle; }
  .fb .r { background: #e5483f; } .fb .c { background: #4cae62; }
  table.fine td, table.fine th { padding: 2.5px 6px; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  .stat { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 6px 0 10px; }
  .stat div { background: #f4f6f5; border-radius: 6px; padding: 6px 8px; }
  .stat b { display: block; font-size: 15pt; color: #8f1f1a; }
  .stat span { font-size: 7.6pt; color: #3b4a42; }
  .rules { background: #eaf2ee; border-radius: 8px; padding: 6px 12px; }
  .rules li { margin-bottom: 3px; }
  .page2 { break-before: page; }
  </style></head><body>
  <h1>When to raise on the flop and turn</h1>
  <p class="lead">From every solved spot on the site (13 flop spots × 30 flops, plus 79 turns in BTN vs BB). "Raise" includes check-raises. Percentages are how often the solver raises when facing a bet, weighted by how often each hand gets there.</p>

  <div class="stat">
    <div><b>${pct(S.bbXrSmall.raise)}</b><span>BB check-raises a ⅓-pot c-bet (50bb, vs UTG–BTN)</span></div>
    <div><b>${pct(S.bbXrBig.raise)}</b><span>BB check-raises a ¾-pot c-bet</span></div>
    <div><b>${pct(S.ipRaiseSmall.raise)}</b><span>In-position caller raises a ⅓-pot c-bet (BB vs SB, BTN vs CO)</span></div>
    <div><b>${pct(S.threeBetCaller.raise)}</b><span>Caller raises in 3-bet pots (low SPR)</span></div>
    <div><b>${pct(S.raiserXr.raise)}</b><span>Preflop raiser check-raises out of position</span></div>
    <div><b>${pct(S.vsLead.raise)}</b><span>Preflop raiser raises a small donk lead (leads are rare and capped)</span></div>
    <div><b>${pct(S.turnXr.s.raise)}</b><span>BB check-raises a ⅓-pot turn bet (${pct(S.turnXr.b.raise)} vs ¾, ${pct(S.turnXr.o.raise)} vs an overbet)</span></div>
    <div><b>3×</b><span>Raise size: about 3× the bet on both streets (⅓ pot → raise to about a full pot)</span></div>
  </div>

  <div class="rules"><h2>Rules of thumb</h2><ol>
    <li><b>Raise small bets, call big ones.</b> Against ⅓ pot the BB check-raises about ${pct(S.bbXrSmall.raise)}; against ¾ pot only about ${pct(S.bbXrBig.raise)}. A big bet already gets folds, and it means the bettor holds more strong hands.</li>
    <li><b>Out of position, raise; in position, call.</b> Flush draws check-raise ${pct(bbFine.fd.raise)} out of position but raise only ${pct(ipFine.fd.raise)} in position. In position you see every turn and river for the price of a call.</li>
    <li><b>Raise with the top and with strong draws; call with the middle.</b> Two pair or better raises ${pct(bbFine.twoplus.raise)}, open-enders ${pct(bbFine.oesd.raise)}, but top pair with a weak kicker raises only ${pct(bbFine.tpwk.raise)} and weak pairs ${pct(bbFine.weakpair.raise)}. Middle hands beat bluffs but hate a re-raise.</li>
    <li><b>Raise more on boards that help the caller.</b> Low and paired boards, where the big blind holds more sets, two pairs and straights.</li>
    <li><b>Shorter stacks: raise-or-fold with top pair.</b> At 20bb top pair with a good kicker check-raises ${pct(dep('btn-bb-20', 'tpgk').raise)} (vs ${pct(dep('btn-bb-50', 'tpgk').raise)} at 50bb): a raise is close to all in, so get it in now.</li>
    <li><b>On the turn, raise less and bluff less.</b> With one card to come, draws are worth less: the BB check-raises the turn about half as often as the flop, mostly with two pair or better.</li>
  </ol></div>

  <h2>Which hands the big blind check-raises (flop, 50bb, vs UTG/HJ/CO/BTN c-bets)</h2>
  ${fineTable('Hand', bbFine, ORDER)}
  <div class="key"><span><i style="background:#e5483f"></i>Raise</span><span><i style="background:#4cae62"></i>Call</span><span><i style="background:#eef1ef"></i>Fold</span><span>On paired boards, "middle pairs" include hands like 4x on 9-9-4, which check-raise about half the time; elsewhere weak pairs raise under 10%.</span></div>

  <section class="page2">
  <div class="cols">
    <div>
      <h2>Which boards: BB check-raise vs ⅓ pot</h2>
      <table class="keep"><thead><tr><th>Flop</th><th>Raise</th><th></th></tr></thead><tbody>${boardRows}</tbody></table>
      <p class="small">Most (BTN vs BB): ${top3}<br>Least: ${bot3}</p>
      <p class="small">Ace- and king-high boards hit the raiser's range (AK, AQ, KQ, big pairs). Low and paired boards hit the big blind's suited connectors, small pairs and trips.</p>
    </div>
    <div>
      <h2>Stack depth (BTN vs BB, check-raise)</h2>
      <table class="keep"><thead><tr><th>Hand</th><th>50bb</th><th>30bb</th><th>20bb</th></tr></thead><tbody>
        ${['twoplus', 'tpgk', 'tpwk', 'fd', 'oesd', 'gutshot'].map((k) => `<tr><td>${FINE[k]}</td>${['btn-bb-50', 'btn-bb-30', 'btn-bb-20'].map((id) => `<td class="n">${dep(id, k) ? pct(dep(id, k).raise) : '–'}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
      <p class="small">Shallow, one-pair hands turn into raises: a check-raise puts you close to all in, so you take the money now. Draws and gutshots raise less, because a bluff-raise can't fold anyone out with so little behind. Sets and two pair raise less too: the stack goes in later anyway, so they let the button keep betting.</p>
    </div>
  </div>

  <div class="cols">
    <div>
      <h2>3-bet pots (caller, 50bb, SPR about 2–3)</h2>
      ${fineTable('Hand', tbFine, ['twoplus', 'overpair', 'tpgk', 'tpwk', 'combo', 'pairdraw', 'fd', 'oesd', 'weakpair', 'ahigh'])}
      <p class="small">With so little behind, top pair and good draws raise much more (top pair, good kicker ${pct(tbFine.tpgk.raise)}). The stack goes in on the flop, so raising gets your equity in before a scary turn. Sets and two pair often just call to keep bluffs in.</p>
    </div>
    <div>
      <h2>Turn check-raises (BTN vs BB, ⅓ c-bet called)</h2>
      ${fineTable('Hand', turnFine, ['twoplus', 'tpgk', 'combo', 'fd', 'oesd', 'tpwk', 'gutshot', 'weakpair', 'ahigh', 'air'])}
      <p class="small">Two pair or better makes up nearly half of all turn check-raises. Weak pairs and ace high almost never raise the turn. Turns that add straight draws or overcards get slightly more raises; turns that pair the board get the fewest.</p>
    </div>
  </div>
  <p class="src">Solver: postflop-solver, 50/30/20bb, ⅓- and ¾-pot c-bets (turn: ⅓, ¾, 125%), raises of about 3×. Hand groups follow the solver drill's hand labels.</p>
  </section>
  </body></html>`;
}

const CSS = `
@page { size: Letter; margin: 0.45in 0.45in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Public Sans", "Helvetica Neue", Arial, sans-serif; color: #15211b; font-size: 8.6pt; line-height: 1.4; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 19pt; margin: 0 0 3px; }
h2 { font-size: 11pt; margin: 10px 0 4px; break-after: avoid; }
.lead { color: #3b4a42; margin: 0 0 8px; font-size: 9pt; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 6px; }
th, td { text-align: left; vertical-align: top; padding: 5px 6px; border-bottom: 1px solid #d3dbd6; }
thead th { font-size: 7pt; text-transform: uppercase; letter-spacing: .05em; color: #5a6a61; border-bottom: 2px solid #15211b; }
tbody tr:nth-child(even) td, tbody tr:nth-child(even) th { background: #f4f6f5; }
table.keep, .stat, .rules { break-inside: avoid; }
.sub { font-size: 7.4pt; color: #5a6a61; margin-top: 2px; }
.key { display: flex; flex-wrap: wrap; gap: 12px; font-size: 7.6pt; color: #3b4a42; margin: 2px 0 8px; }
.key i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; border: 1px solid #ccd3cf; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
ul, ol { margin: 2px 0 6px; padding-left: 16px; } li { margin-bottom: 3px; }
.small { font-size: 7.8pt; color: #3b4a42; margin: 3px 0; }
.src { font-size: 7pt; color: #7a8780; margin-top: 10px; }
`;

(async () => {
  const outs = [
    ['preflop-sizing-chart', sizingHTML(), 'Preflop raise sizing'],
    ['raising-cheat-sheet', raisingHTML(), 'When to raise: flop and turn'],
  ];
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  for (const [name, html, label] of outs) {
    const file = path.join(OUT, name + '.html');
    fs.writeFileSync(file, html);
    const page = await browser.newPage();
    await page.goto('file://' + file);
    await page.pdf({
      path: file.replace(/\.html$/, '.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:7px;color:#888;padding:0 0.45in;display:flex;justify-content:space-between"><span>Postflop Framework Drills · ${label}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
    await page.close();
    console.log('wrote', name, '.html/.pdf');
  }
  await browser.close();
})();
