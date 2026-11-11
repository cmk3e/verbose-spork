/* Build "Stack Depth & Bubble Strategy: A Player's Guide" (web page + PDF) and its
 * two-page quick card (PDF), from the preflop chart data and the solved spots.
 *
 * usage (from postflop-drills/):  node tools/make_players_guide.js
 * writes resources/players-guide.html/.pdf and resources/quick-card.html/.pdf
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources');
global.window = global;
require(path.join(ROOT, 'preflop-data.js'));
const DATA = global.PF_PREFLOP_DATA;
const ORDER = DATA.order;
const DIG = '0123456789abcdefghijk';
const SITE = 'https://cmk3e.github.io/verbose-spork/postflop-drills/';
const RANKS = 'AKQJT98765432';
const COLORS = { raise: '#e5483f', allin: '#7a1d1a', call: '#4cae62', fold: '#eef1ef' };
const combos = (h) => (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------ chart helpers
function chart(depth, title) {
  const c = DATA.depths[depth].charts[title];
  if (!c) throw new Error('missing chart ' + depth + ' ' + title);
  const freqs = {};
  ORDER.forEach((h, i) => {
    const f = {};
    for (const a of Object.keys(c)) f[a] = DIG.indexOf(c[a][i]) / 20;
    freqs[h] = f;
  });
  return freqs;
}
const playFreq = (f) => (f ? 1 - (f.fold || 0) - 0 : 0);
function share(fr, action) {
  let s = 0;
  for (const h of ORDER) s += (fr[h][action] || 0) * combos(h);
  return s / 1326 * 100;
}

function gridHTML(fr, title, sub, prev, labels) {
  let cells = '';
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const h = r === c ? RANKS[r] + RANKS[r] : r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o';
      const f = fr[h];
      let x = 0;
      const stops = [];
      for (const a of ['raise', 'allin', 'call']) {
        const v = f[a] || 0;
        if (v <= 0) continue;
        stops.push(`${COLORS[a]} ${x * 100}% ${(x + v) * 100}%`);
        x += v;
      }
      stops.push(`${COLORS.fold} ${x * 100}% 100%`);
      let mark = '';
      if (prev) {
        const d = playFreq(f) - playFreq(prev[h]);
        if (d >= 0.5) mark = ' add';
        else if (d <= -0.5) mark = ' rem';
      }
      cells += `<div class="c${mark}${x > 0 ? '' : ' o'}" style="background:linear-gradient(90deg,${stops.join(',')})">${h}</div>`;
    }
  }
  const legend = Object.entries(labels).filter(([a]) => share(fr, a) >= 0.5).map(([a, l]) => `<span><i style="background:${COLORS[a]}"></i>${l} ${share(fr, a).toFixed(0)}%</span>`).join('');
  return `<figure class="grid"><figcaption><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</figcaption><div class="g">${cells}</div><div class="lg">${legend}</div></figure>`;
}

// ------------------------------------------------------------------ figures
function figLJ() {
  const depths = ['80', '50', '30', '20', '12'];
  let prev = null;
  const out = depths.map((d) => {
    const fr = chart(d, 'LJ · RFI');
    const labels = d === '12' ? { allin: 'Shove', raise: 'Min-raise' } : { raise: 'Raise' };
    const g = gridHTML(fr, `LJ open · ${d}bb`, null, prev, labels);
    prev = fr;
    return g;
  });
  return `<div class="grids five">${out.join('')}</div>
    <p class="cap"><b>Figure 1. How one open range changes with depth</b> (lojack, your charts; same layout as every chart: pairs on the diagonal, suited hands above it, offsuit below). <span class="k add">green outline</span> = comes into the range at this depth; <span class="k rem">dashed red</span> = drops out. Same size of range, different hands: small pairs and small suited connectors leave; offsuit Broadways and offsuit aces come in; at 12bb most opens become all-ins.</p>`;
}

function figBB() {
  const lab = { raise: '3-bet', allin: 'All-in', call: 'Call' };
  return `<div class="grids three">${['80', '30', '12'].map((d) => gridHTML(chart(d, 'BB vs BTN · RFI'), `BB vs BTN open · ${d}bb`, null, null, lab)).join('')}</div>
    <p class="cap"><b>Figure 2. The big blind against a button open.</b> Deep, the BB 3-bets to a normal size (red). From about 30bb those 3-bets become all-in re-jams (dark red), and at 12bb the BB either jams or calls the cheap min-raise.</p>`;
}

function figValue() {
  const cols = ['100bb+', '40–60bb', '20–35bb', '10–20bb', 'Under 10bb'];
  const rows = [
    ['Small pairs (22–66)', [3, 1, 1, 3, 3], 'set-mining deep; all-in equity short'],
    ['Suited connectors (54s–T9s)', [3, 2, 1, 1, 1], 'need deep stacks to pay off'],
    ['Suited wheel aces (A2s–A5s)', [3, 2, 2, 3, 3], 'flush/wheel deep; ace blocker short'],
    ['Offsuit Broadways (KJo, QJo, KTo)', [1, 3, 3, 3, 2], 'make top pairs you can stack off with'],
    ['Weak offsuit aces (A2o–A9o)', [1, 1, 2, 3, 3], 'blockers and all-in equity'],
    ['Big pairs and AK', [3, 3, 3, 3, 3], 'always good; play bigger pots shallower'],
  ];
  const dot = (n) => `<span class="dots d${n}">${'●'.repeat(n)}${'○'.repeat(3 - n)}</span>`;
  return `<table class="heat"><thead><tr><th>Hand type</th>${cols.map((c) => `<th>${c}</th>`).join('')}<th>Why</th></tr></thead><tbody>${
    rows.map(([n, v, why]) => `<tr><td>${n}</td>${v.map((x) => `<td class="h${x}">${dot(x)}</td>`).join('')}<td class="why">${why}</td></tr>`).join('')}</tbody></table>
    <p class="cap"><b>Figure 3. Which hands gain and lose value.</b> ●●● = most valuable at that depth. Small pairs and wheel aces are worth most at both ends: deep for their big hands, short because all-in equity and an ace blocker are what matter.</p>`;
}

function figSPR() {
  // equal-width bands (an SPR of 2 vs 4 matters as much as 7 vs 13), markers placed within their band
  const W = 760, x0 = 20, x1 = 740;
  const bands = [
    [99, 13, '#3d79b8', 'Nut hands only', '#fff'], [13, 7, '#7aa3cf', 'Two pair or sets', '#13221a'], [7, 4, '#c9d47e', 'Top pair: be careful', '#13221a'],
    [4, 2, '#f0a24a', 'Top pair, overpair', '#13221a'], [2, 0, '#e5483f', 'Any pair, good draw', '#fff'],
  ];
  const bw = (x1 - x0) / bands.length;
  const X = (v) => {
    for (let i = 0; i < bands.length; i++) {
      const [hi, lo] = bands[i];
      if (v <= hi && v >= lo) { const top = i === 0 ? 20 : hi; return x0 + bw * i + bw * ((top - Math.min(v, top)) / (top - lo)); }
    }
    return x1;
  };
  const marks = [
    [12.7, '100bb single-raised pot', 0], [8.1, '50bb single-raised pot', 1], [4.5, '30bb SRP / 100bb 3-bet pot', 2],
    [3.3, '20bb single-raised pot', 0], [2.2, '50bb 3-bet pot', 1], [1.8, '12bb min-raise called', 2],
  ];
  const H = 176;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="SPR ladder">`;
  svg += `<text x="${x0}" y="14" font-size="11" fill="#5a6a61">Deep (high SPR)</text><text x="${x1}" y="14" text-anchor="end" font-size="11" fill="#5a6a61">Shallow (low SPR)</text>`;
  bands.forEach(([hi, lo, c, l, tc], i) => {
    const x = x0 + bw * i;
    svg += `<rect x="${x}" y="22" width="${bw}" height="40" fill="${c}"/>`;
    svg += `<text x="${x + bw / 2}" y="38" text-anchor="middle" font-size="11" font-weight="700" fill="${tc}">${l}</text>`;
    svg += `<text x="${x + bw / 2}" y="54" text-anchor="middle" font-size="10" fill="${tc}">SPR ${i === 0 ? '13+' : `${lo}–${hi}`}</text>`;
  });
  for (const [v, l, row] of marks) {
    const x = X(v), y = 92 + row * 26;
    svg += `<line x1="${x}" y1="62" x2="${x}" y2="${y - 10}" stroke="#13221a" stroke-width="1"/><circle cx="${x}" cy="62" r="3.5" fill="#13221a"/>`;
    const anchor = x > x1 - 90 ? 'end' : x < x0 + 90 ? 'start' : 'middle';
    svg += `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10.5" fill="#13221a">${l} (${v})</text>`;
  }
  svg += '</svg>';
  return `<figure class="spr">${svg}</figure>
    <p class="cap"><b>Figure 4. The SPR ladder: how strong a hand you need to get all the chips in.</b> Each band names the weakest hand that is usually strong enough to stack off at that SPR (rough guide). Dots mark typical spots from your charts and solves (BB ante, about 2.2bb opens).</p>`;
}

function figRisk() {
  const rows = ['Short stack', 'Medium stack', 'Big stack'];
  const cells = [
    [['Moderate', 2], ['High', 3], ['High · +9–15%', 3]],
    [['Low', 1], ['Very high', 4], ['Very high', 4]],
    [['Very low', 0], ['Moderate', 2], ['Highest · +18–35%', 4]],
  ];
  return `<table class="risk"><thead><tr><th>You are… / they are…</th><th>Short stack</th><th>Medium stack</th><th>Big stack</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr><th>${r}</th>${cells[i].map(([t, k]) => `<td class="r${k}">${t}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="cap"><b>Figure 5. Risk premium on the bubble: extra equity you need, on top of pot odds, to call an all-in (or make one).</b> The two numbers come from Jonathan Little's guide; the rest is the same logic: the more a loss costs you and the less a win helps, the higher it is. Rough guide only: real spots depend on every stack in the tournament.</p>`;
}

// ------------------------------------------------------------------ content
const link = (href, text) => `<a href="${SITE}${href}">${text}</a>`;
function practise(items) {
  return `<div class="practise"><b>Practise this:</b> ${items.map(([h, t]) => link(h, t)).join(' · ')}</div>`;
}

function stackPage(o) {
  const rows = o.rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  return `<section class="stack" id="${o.id}">
    <div class="stack-head"><span class="band">${o.band}</span><h2>${o.title}</h2><p class="when">${o.when}</p></div>
    <p class="lead">${o.lead}</p>
    <table class="plan"><tbody>${rows}</tbody></table>
    ${o.after || ''}
    ${practise(o.practise)}
  </section>`;
}

const STACKS = [
  {
    id: 'deep', band: '100bb+', title: 'Deep stacks', when: 'Early levels. Single-raised pot SPR about 13; 3-bet pot SPR about 4.5.',
    lead: 'Play hands that make <b>big</b> hands. With lots of chips behind, the winner of a big pot usually has two pair or better, so straights, flushes and sets are what you want, and one pair is a pot-control hand.',
    rows: [
      ['Opening', 'Your 80bb charts: UTG 16%, LJ 22%, CO 35%, BTN 54%. Favour suited and connected hands, small pairs and suited aces; open very few offsuit hands outside late position (AKo, AQo, KQo, AJo). The SB mostly limps (83% limp, 8% raise at 80bb).'],
      ['Facing an open', 'Call more in position with suited and connected hands and pairs (BTN flats 16% against a CO open). 3-bet a polarised range: premiums for value, and bluffs that can make strong hands (A5s, A4s, suited connectors). The BB defends about 65% against a BTN open and 3-bets about 16%.'],
      ['Facing a 3-bet', 'Call wide in position with playable hands (BTN calls 25% of hands against a BB 3-bet at 80bb). Small pairs can call to set-mine. 4-bet small and rarely jam. Against tight players who never 4-bet bluff, KK can just call.'],
      ['Postflop', 'Top pair is not a stack-off hand: keep pots small with one pair, and get stacks in with two pair or better. Draws and floats gain value because there is room to bet later streets. Bet sizes must be bigger (pot-sized) to get stacks in by the river.'],
      ['On the bubble', 'Rare this deep, but if you have the big stack, open and 3-bet more against medium stacks who must avoid going broke.'],
    ],
    practise: [['ranges.html?depth=80&open=LJ&resp=BTN', 'Range viewer: LJ vs BTN at 80bb'], ['preflop.html?depth=80', 'Preflop trainer at 80bb']],
  },
  {
    id: 'mid', band: '40–60bb', title: 'Middle stacks', when: 'Middle stages. Single-raised pot SPR about 8; 3-bet pot SPR about 2.',
    lead: 'Play hands that make <b>strong top pairs</b>. You open about the same number of hands as deep, but swap small pairs and small suited connectors for offsuit Broadways and offsuit aces. A 3-bet pot now commits you with any top pair or overpair.',
    rows: [
      ['Opening', 'LJ 23%, CO 36%, BTN 52% (Figure 1: 33 and 54s leave the LJ range; A9o and KTo come in). The SB raises more often (19% raise, 68% limp).'],
      ['Facing an open', 'The BB calls about 70% and 3-bets about 15% against a BTN open. 3-bet bluffs move to hands that block the 4-bet jam range and flop easy top pairs: KJo, KTo, ATo, A9s–A6s. 3-bet AQ and AJs for value: most players jam AK, so when they just call, your AQ is often best. Flat KQo rather than 3-bet it, to keep dominated KJ and KT in.'],
      ['Facing a 3-bet', 'Call less and start jamming: against a BB 3-bet the BTN calls 23% and 4-bet jams 4.5%. Don\'t call 3-bets just to set-mine small pairs; the implied odds are gone.'],
      ['Postflop', 'Single-raised pots (SPR 8): top pair good kicker is strong but needs care against big action; c-bet often and small when you have the range advantage. 3-bet pots (SPR 2): plan to get top pair+ all in. In the solver\'s BB 3-bet vs BTN pot, BTN goes all-in 25–45% of the time facing a ¾-pot bet.'],
      ['On the bubble', 'Most bubbles start around here. Medium stacks must avoid other medium and big stacks; the big stack should pressure them.'],
    ],
    practise: [['ranges.html?depth=50&open=LJ&resp=BB', 'Range viewer: LJ vs BB at 50bb'], ['preflop.html?depth=50', 'Preflop trainer at 50bb'], ['solver.html?only=bb3-btn-50:vsBig', 'Solver: 3-bet pot, facing a ¾-pot bet']],
  },
  {
    id: 'rejam', band: '20–35bb', title: 'The re-jam zone', when: 'Late-middle stages. Single-raised pot SPR about 3–4.5.',
    lead: 'All-in <b>re-jams</b> (3-bet shoves) replace normal 3-bets, so every open risks being shoved on. Open hands that can either call a jam or fold easily, and use blockers (an ace in your hand) to pick re-jam bluffs.',
    rows: [
      ['Opening', 'Open smaller (2–2.3bb). Early positions barely change (UTG 17–18%), but the BTN tightens (54% at 80bb, 45% at 30bb, 36% at 20bb) because the blinds re-jam. At 20bb your BTN chart open-jams some hands that hate facing a re-jam: 22–44, A2s–A4s, A7o–A8o.'],
      ['Facing an open', 'Re-jam or call; small 3-bets almost vanish (Figure 2). The BB re-jams 11% against a BTN open at 30bb and 14% at 20bb; the BTN against a CO open goes from 17% flat / 4% jam at 30bb to 9% flat / 11% jam at 20bb.'],
      ['Facing a 3-bet or jam', 'Calling ranges are much tighter than jamming ranges (the "gap concept"): you need a hand that is ahead of their range, not just a playable one. Against a BB 3-bet the BTN calls 17% at 30bb and 11% at 20bb; facing a BTN open-jam at 20bb, the BB calls about 20%.'],
      ['Postflop', 'SPR 3–4.5: top pair with a good kicker is usually a stack-off hand. Bet small and plan to get it in by the turn: the solver\'s 20bb BTN c-bets ⅓ pot on K-7-2 61% of the time and almost never bets big.'],
      ['On the bubble', 'The hardest zone for ICM: re-jams and calls carry the biggest risk premium. Tighten calls a lot; jam more against medium stacks who can\'t call.'],
    ],
    practise: [['ranges.html?depth=20&open=BTN&resp=BB', 'Range viewer: BTN vs BB at 20bb'], ['preflop.html?depth=20', 'Preflop trainer at 20bb'], ['solver.html?only=btn-bb-20:cbet', 'Solver: BTN c-bets at 20bb']],
  },
  {
    id: 'short', band: '10–20bb', title: 'Short stacks', when: 'Late stages. A called min-raise leaves SPR about 2.',
    lead: 'Most decisions are preflop: <b>min-raise, shove or fold</b>. All-in equity and fold equity matter far more than playability.',
    rows: [
      ['Opening', 'Mix min-raises and open-shoves. At 12bb your charts open-shove 8% (UTG) to 27% (BTN) and still min-raise 8–11%. Min-raise your best hands (AA–TT, the best suited aces) so you get action, plus a few that can fold; shove the middle (small and medium pairs, offsuit aces, Broadways) because those hands win most when everyone folds and hate being re-jammed.'],
      ['Facing an open', 'Re-jam or fold; flatting is rare except in the BB, where the min-raise gives a great price (the BB calls 40% and jams 21% against a 12bb BTN min-raise). BTN vs CO: jam 14%, call 3%.'],
      ['Facing an all-in', 'Call with hands that are ahead of the jamming range. At 12bb, the BB calls a BTN shove with about 28% of hands (any ace, pairs, KT+, QT+) and an SB shove with 40%.'],
      ['Postflop', 'After a called min-raise, any pair or decent draw is usually good enough to get it in.'],
      ['On the bubble', 'If you are the only short stack, shove rather than min-raise. Fold marginal call-offs: K7o facing an 11bb SB jam is normally a call but becomes a fold.'],
    ],
    practise: [['pushfold.html', '12bb push/fold'], ['pushfold.html?only=callShove|BB', 'Push/fold: BB facing a shove']],
  },
  {
    id: 'push', band: 'Under 10bb', title: 'Push or fold', when: 'Any time you are this short. Each orbit costs about 2.5bb (blinds plus a 1bb BB ante).',
    lead: 'Shove or fold. Min-raising and folding wastes chips you can\'t spare, and limping invites the big blind to see a free flop. Shove before you get too short to make anyone fold.',
    rows: [
      ['Opening', 'Shove wider than your 12bb jam ranges, and wider the later your position and the shorter you are. From the button and small blind with 5–8bb, most hands with an ace, a pair or two Broadways are shoves, and many more besides.'],
      ['Why not wait?', 'At 8bb you have about three orbits before you are blinded to nothing. Below about 5bb the big blind calls you very wide, so your fold equity is mostly gone: choose hands with the best raw equity (aces, pairs, big cards).'],
      ['Facing an all-in', 'Call wider against shorter shoves, because the price is better. In the big blind facing a tiny shove, you are often getting more than 3-to-1.'],
      ['On the bubble', 'Fold into the money only if someone else is likely to bust first: many players left, or other stacks as short as yours. If you are the clear next to bust, pick a good spot and shove.'],
    ],
    after: '<p class="note">Your PokerCoaching charts stop at 12bb, so this page uses standard push/fold principles instead of chart numbers.</p>',
    practise: [['pushfold.html?only=open|BTN', 'Push/fold: BTN opens'], ['pushfold.html?only=open|SB', 'SB opens']],
  },
];

const GLOSSARY = [
  ['bb', 'Big blinds. Stacks are measured in big blinds: 50bb means 50 times the big blind.'],
  ['Effective stack', 'The smaller of the two stacks in a pot. It is the most anyone can win or lose, so it decides strategy, not your own stack.'],
  ['SPR (stack-to-pot ratio)', 'Effective stack behind ÷ pot on the flop. Low SPR = easy to get all in; high SPR = you need a very strong hand to.'],
  ['RFI / open', 'Raise first in: the first raise when everyone before you folded.'],
  ['3-bet, 4-bet, squeeze', 'A re-raise of an open (3-bet), a re-raise of that (4-bet). A squeeze is a 3-bet after an open and one or more calls.'],
  ['Re-jam / 3-bet shove', 'Going all in over someone\'s open.'],
  ['Flat', 'Just calling a raise instead of re-raising.'],
  ['Set-mining', 'Calling with a small pair mainly to hit three of a kind (about 12% of flops), needing deep stacks to pay off.'],
  ['Polarised / linear', 'A polarised range is strong hands plus bluffs; a linear range is the best hands in order.'],
  ['Blocker', 'A card in your hand that makes certain opponent hands less likely; an ace blocks AA, AK and AQ.'],
  ['Fold equity', 'The extra value you get from the chance your opponent folds.'],
  ['Implied odds', 'Chips you expect to win later in the hand if you hit, which justify calling now.'],
  ['Range advantage / nut advantage', 'Whose whole range is stronger on a board; whose range has more of the very best hands.'],
  ['Chip EV', 'Strategy that only maximises chips. Your charts, the push/fold page and the solver drills are all chip EV.'],
  ['ICM', 'Independent Chip Model: converts stacks into prize money. Near pay jumps, chips you lose cost more than chips you win are worth.'],
  ['Risk premium', 'The extra equity, beyond pot odds, you need to risk your tournament life on a bubble or final table.'],
  ['Bubble', 'The point just before the money, when the next bust-outs pay nothing.'],
];

const NOTATION = [
  ['AKs / AKo', 'Suited (same suit) / offsuit. "AK" alone means both.'],
  ['A6s+', 'A6s and every better suited ace: A6s, A7s … AKs.'],
  ['K8o+', 'K8o and better offsuit kings, up to KQo.'],
  ['22–44', 'Pocket pairs from deuces to fours: 22, 33, 44.'],
  ['44+', 'Fours and every bigger pair, up to AA.'],
  ['Broadways', 'Cards T and higher; offsuit Broadways = KQo, KJo, QJo, KTo and so on.'],
  ['Wheel aces', 'A2s–A5s: they can make a 5-high straight (the wheel).'],
  ['Combos', 'Ways to be dealt a hand: 6 for a pair, 4 for a suited hand, 12 for an offsuit hand.'],
];

const DISAGREE = [
  ['Wheel aces at 50bb', 'Your charts still open A2s–A5s from LJ and HJ at 50bb and shorter.', 'Fold the worst of them (A2s–A3s) early against tables that 3-bet or re-jam a lot.'],
  ['Small suited connectors at 50bb', 'LJ still opens 65s, 76s, T8s, J8s at 50bb; they leave at 30–20bb.', 'Fold them earlier against aggressive players behind or several short stacks that re-jam.'],
  ['When to start open-jamming', 'Your 20bb BTN chart already open-jams a few hands; at 12bb jams are 8–27% of hands.', 'One webinar presenter prefers to keep min-raising above 15bb for postflop edge. That\'s a style choice; follow the charts unless you clearly outplay the table after the flop.'],
  ['Min-raise UTG, raise bigger on the BTN (deep)', 'Your charts use one open size per depth (about 2.2–2.3bb).', 'A reasonable exploit at deep, passive tables; not needed to play well.'],
  ['3-bet bluffing against weak players', 'The charts 3-bet a balanced mix of value and bluffs.', 'Against players who never fold to 3-bets (common in small online games), drop the bluffs and 3-bet more value hands.'],
  ['Calling 4-bet jams at 50bb', 'Charts assume opponents jam a balanced range.', 'Against typical small-stakes players, fold AQ, AJs and KQs to a 4-bet jam: they jam only their best hands.'],
  ['Any bubble or final-table spot', 'Charts are chip EV and ignore payouts.', 'Tighten calls by the risk premium (Figure 5); big stacks open and jam wider than the charts.'],
];

const MISTAKES = [
  ['Calling 3-bets with small pairs at 40bb or less.', 'Fold them: set-mining needs about 15–20 times the call behind. Call opens with them only in position or in the big blind.'],
  ['Stacking off with one pair when 150bb+ deep.', 'Keep pots small with one pair deep; get it in with two pair or better.'],
  ['Opening the same hands at every depth.', 'Swap small pairs and small suited connectors for offsuit Broadways as you get shorter (Figure 1).'],
  ['Making 3-bets you can\'t call a jam with, at 20–35bb.', 'Re-jam or flat instead; small 3-bets with medium hands get shoved on.'],
  ['Min-raising at 15bb, then calling off light.', 'Shove the hands you don\'t want to face a re-jam with; min-raise only hands happy to call or easy to fold.'],
  ['Calling jams as wide as you would shove.', 'Calling needs a hand ahead of their range; your calling range should be clearly tighter than your shoving range.'],
  ['Playing to your own stack instead of the effective stack.', 'With 100bb against 25bb stacks, play a 25bb game.'],
  ['Locking up too early before the bubble.', 'Keep playing normally until the money is close; drifting from 35bb to 20bb to min-cash kills deep runs.'],
  ['Calling a bubble all-in because you are "ahead of their range".', 'Add the risk premium: 50% isn\'t enough when you need 60–70%.'],
  ['Bullying with the big stack when nobody is folding.', 'Pressure works only against players who must fold; against callers, tighten back up.'],
];

const QUIZ = [
  ['You have 45bb in the lojack with 33. Everyone has 40–60bb. Open or fold?', 'Fold. Your 50bb LJ chart folds 33 and 22; small pairs lose value as stacks get shorter.', 'mid'],
  ['100bb deep, top pair good kicker, and your opponent check-raises the turn for most of the stack. What should you think?', 'At SPR 13, top pair is rarely good enough for 100bb. This is usually a fold or a small-pot call, not a stack-off.', 'deep'],
  ['50bb on the button facing a lojack open. KTo or KQo: which is the better 3-bet bluff?', 'KTo: it folds out KJ and KQ (better hands). KQo folds out only hands it dominates, so flat it.', 'mid'],
  ['You open the button at 25bb and the big blind re-jams. Your hand is A8o. Call or fold?', 'Usually fold. Your calling range against a jam must be tighter than your opening range; A8o is not ahead of a 25bb re-jam range.', 'rejam'],
  ['12bb on the button. Which is more likely a min-raise and which an open-shove in your charts: AA or 55?', 'AA is a min-raise (you want action); 55 is a shove (it wins most when everyone folds and hates facing a re-jam).', 'short'],
  ['30bb in a single-raised pot, you flop top pair good kicker. SPR is about 4.5. Plan?', 'Plan to get it in: bet small on the flop, more on the turn, and you can shove the river (or earlier against action).', 'rejam'],
  ['You have 7bb on the button, no bubble. Folds to you with K9o. Shove, min-raise or fold?', 'Shove. Under 10bb it\'s push or fold; from the button K9o is a clear shove, and waiting only lets the blinds eat your stack.', 'push'],
  ['Bubble, 10bb in the big blind; the 40bb small blind shoves (any two cards). You have K7o. Without ICM you\'d call. Now?', 'Fold. With the risk premium you need about 56% equity: 44+, A6s+, A8o+, K6s+, K8o+, Q8s+, JTs. K7o falls just short.', 'bubble'],
  ['Bubble, you have 50bb and the average is 20bb. Another 50bb player jams; you have QQ against what is likely AK. Call?', 'Fold. QQ is only about 50% against AK, and big stack vs big stack needs about 70% after the risk premium.', 'bubble'],
  ['You have the biggest stack on the bubble. Two 30bb players fold to you on the button. A6o: fold or open?', 'Open. Medium stacks must avoid you, so steal widely; the ace also blocks their best calling hands.', 'bubble'],
];

// ------------------------------------------------------------------ documents
const CSS = fs.readFileSync(path.join(__dirname, 'guide.css'), 'utf8');

function guideHTML() {
  const toc = [['basics', 'The big idea'], ...STACKS.map((s) => [s.id, `${s.band}: ${s.title}`]), ['bubble', 'The bubble'], ['disagree', 'When the charts and coaches disagree'], ['mistakes', 'Common mistakes'], ['quiz', 'Test yourself'], ['glossary', 'Glossary and notation']];
  const stackTable = `<table class="overview"><thead><tr><th>Stack</th><th>What hands are for</th><th>Main weapon</th><th>Stack off with</th></tr></thead><tbody>
    <tr><td><b>100bb+</b></td><td>Big hands: straights, flushes, sets</td><td>Calling and 3-betting in position</td><td>Two pair or better</td></tr>
    <tr><td><b>40–60bb</b></td><td>Strong top pairs</td><td>Open and 3-bet (small)</td><td>Top pair, good kicker (any top pair in 3-bet pots)</td></tr>
    <tr><td><b>20–35bb</b></td><td>High cards and blockers</td><td>Re-jam (3-bet all in)</td><td>Top pair, good kicker, often earlier</td></tr>
    <tr><td><b>10–20bb</b></td><td>All-in equity</td><td>Open-shove, re-jam, min-raise premiums</td><td>Any pair or good draw after a min-raise</td></tr>
    <tr><td><b>Under 10bb</b></td><td>Raw equity</td><td>Push or fold</td><td>Preflop all in</td></tr></tbody></table>`;

  const body = `
  <header class="cover">
    <p class="kicker">Postflop Framework Drills · Player's guide</p>
    <h1>Stack Depth &amp; Bubble Strategy</h1>
    <p class="sub">How to change your play from 100bb+ down to push/fold, and on the bubble. For novice and intermediate MTT players.</p>
    <p class="howto">Find your stack size, read its page, and use the "Practise this" links to drill it. Ranges and numbers come from your PokerCoaching charts and the solved spots in the drills; ideas also come from two PokerCoaching videos (Matt Affleck on stack depth, Jonathan Little on the bubble) and standard tournament theory. New to the terms? Start with the <a href="#glossary">glossary</a>.</p>
    <nav class="toc">${toc.map(([id, t]) => `<a href="#${id}">${t}</a>`).join('')}</nav>
  </header>

  <section id="basics" class="basics">
    <h2>The big idea</h2>
    <p class="lead">As stacks get shorter you play <b>about the same number of hands but different hands</b>, you need a <b>weaker hand to get all in</b>, and re-raises turn into <b>all-ins</b>. Three forces drive this:</p>
    <ol class="forces">
      <li><b>Implied odds shrink.</b> Small pairs and suited connectors need deep stacks to pay off, so they lose value; big offsuit cards that make top pairs gain it.</li>
      <li><b>SPR falls.</b> With less behind relative to the pot, one pair becomes strong enough to get all in (Figure 4).</li>
      <li><b>All-ins take over.</b> Below about 35bb a 3-bet commits you, so re-jams replace 3-bets; blockers and fold equity matter more than playability.</li>
    </ol>
    <p>Always use the <b>effective stack</b>: with 100bb against a 30bb player, play a 30bb hand.</p>
    ${stackTable}
    ${figValue()}
    ${figLJ()}
    ${figBB()}
    ${figSPR()}
  </section>

  ${STACKS.map(stackPage).join('')}

  <section id="bubble" class="bubble">
    <h2>The bubble</h2>
    <p class="lead">Near the money, <b>chips you lose cost more than chips you win are worth</b>, so you need extra equity, the risk premium, to call or make an all-in. Big stacks can exploit this; medium stacks suffer most.</p>
    <p><b>Why.</b> Four players with equal stacks, paid $1,000 / $700 / $400 / $200: each stack is worth $575. Win a 50/50 all-in and you're worth $800; lose and you get $200. On average that's $500, so both players lose $75 and the $150 goes to the players who folded.</p>
    ${figRisk()}
    <p><b>Worked example.</b> Bubble, you have 10bb in the big blind, and a 40bb small blind shoves (they should shove any two cards here). You call 9bb to win 21bb: 43% equity without ICM. Add about 12% risk premium and a small margin, and you need about 56%: roughly 44+, A6s+, A8o+, K6s+, K8o+, Q8s+, JTs. With shorter stacks elsewhere, call tighter still (99+, ATo+, KJs+).</p>
    <table class="plan"><tbody>
      <tr><th>Big stack</th><td>Pressure everyone: open and 3-bet more, defend wider, use small bets postflop. Still fold when clearly behind or when nobody is folding.</td></tr>
      <tr><th>Medium stack</th><td>The hardest seat. Pressure other medium and short stacks; avoid the big stacks, and tighten up with a big stack on your left.</td></tr>
      <tr><th>Short stack</th><td>Pressure other short stacks, otherwise look to sneak in. Shove rather than min-raise; fold marginal call-offs.</td></tr>
    </tbody></table>
    <h3>Four lessons from the hand examples</h3>
    <ol class="lessons">
      <li><b>Attack players who can't afford to call.</b> As the big stack, 3-bet A6o against a 75bb cutoff open; call a 3-bet in position with T7s and bluff boards that suit you.</li>
      <li><b>Get out of the way of bigger stacks.</b> Fold K8s at 75bb with bigger stacks behind; call rather than 3-bet JJ; fold A9o out of position.</li>
      <li><b>When you're the short stack, shove; don't min-raise and call off.</b> At 15–20bb, jam hands like 97s; min-raise only hands that can comfortably fold or call.</li>
      <li><b>The ace is your bluffing card.</b> Ax blocks the hands that call or jam over you, so squeeze A5o, re-jam A2o against wide openers.</li>
    </ol>
    <p><b>Know the payouts.</b> Care about pay jumps that matter (a jump from $150 to $250, not to $156). Don't lock up too early: playing for a min-cash costs far more in deep runs than it gains.</p>
    ${practise([['pushfold.html?only=callShove|BB', 'Push/fold: calling shoves (then tighten by the risk premium)'], ['leaks.html', 'My leaks']])}
  </section>

  <section id="disagree">
    <h2>When the charts and the coaches disagree</h2>
    <p class="lead">Use your <b>charts as the default</b>. The coaches' advice is mostly <b>adjustments against typical small-stakes opponents</b> and for payouts.</p>
    <table class="three"><thead><tr><th>Spot</th><th>Default (your charts)</th><th>Adjust when…</th></tr></thead><tbody>
      ${DISAGREE.map(([a, b, c]) => `<tr><td><b>${a}</b></td><td>${b}</td><td>${c}</td></tr>`).join('')}</tbody></table>
  </section>

  <section id="mistakes">
    <h2>Common mistakes</h2>
    <table class="three mistakes"><thead><tr><th>Mistake</th><th>Fix</th></tr></thead><tbody>
      ${MISTAKES.map(([a, b]) => `<tr><td><b>${a}</b></td><td>${b}</td></tr>`).join('')}</tbody></table>
  </section>

  <section id="quiz">
    <h2>Test yourself</h2>
    <p class="lead">Answers are at the end of this section. Each question names the page that covers it.</p>
    <ol class="quiz">${QUIZ.map(([q, , p]) => `<li>${q} <small>(<a href="#${p}">${p === 'bubble' ? 'the bubble' : STACKS.find((s) => s.id === p).band}</a>)</small></li>`).join('')}</ol>
    <h3>Answers</h3>
    <ol class="answers">${QUIZ.map(([, a]) => `<li>${a}</li>`).join('')}</ol>
  </section>

  <section id="glossary">
    <h2>Glossary</h2>
    <dl class="gloss">${GLOSSARY.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl>
    <h3>Hand notation</h3>
    <dl class="gloss">${NOTATION.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl>
    <p class="note">Not covered here: bounty (PKO) tournaments, where bounties make calling wider correct; final-table ICM in depth; satellites, where ICM is extreme and folding into a seat is often right.</p>
  </section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stack Depth &amp; Bubble Strategy · Player's guide</title><style>${CSS}</style></head><body class="guide"><main>${body}</main></body></html>`;
}

function cardHTML() {
  const rows = [
    ['100bb+', 'Suited, connected, small pairs, suited aces', 'Call in position; 3-bet polarised (A5s, suited connectors as bluffs)', 'Call wide in position; set-mine', 'Two pair+ to stack off; pot-control one pair'],
    ['40–60bb', 'Same %, swap small pairs and small SCs for KJo, KTo, ATo, A9o', '3-bet bluffs with blockers (KJo, KTo, ATo, A9s–A6s); 3-bet AQ, AJs for value', 'Call less; 4-bet jam appears; no set-mining', 'SRP: top pair good kicker strong; 3-bet pot: any top pair commits'],
    ['20–35bb', 'Smaller opens; BTN tightens; some jams at 20bb', 'Re-jam or call; small 3-bets vanish', 'Calling a jam needs a hand ahead of their range', 'Top pair good kicker = stack off; bet small'],
    ['10–20bb', 'Min-raise premiums; open-shove the middle hands', 'Re-jam or fold (BB can call a min-raise)', 'Call shoves with hands ahead of the jam range', 'After a min-raise: any pair or good draw'],
    ['Under 10bb', 'Push or fold; wider the later and shorter', '—', 'Call wider against shorter shoves', '—'],
  ];
  const p1 = `<section class="card-page">
    <h1>Stack depth quick card</h1>
    <p class="sub">Use the <b>effective stack</b>. Same number of hands, different hands; weaker hands get all in as stacks shrink.</p>
    <table class="qc"><thead><tr><th>Stack</th><th>Open</th><th>Facing an open</th><th>Facing a 3-bet or jam</th><th>Postflop</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><th>${r[0]}</th>${r.slice(1).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
    ${figSPR()}
    ${figValue()}
  </section>`;
  const p2 = `<section class="card-page">
    <h1>Bubble quick card</h1>
    <p class="sub">Chips lost cost more than chips won are worth. Required equity = pot odds + risk premium.</p>
    ${figRisk()}
    <table class="qc"><tbody>
      <tr><th>Big stack</th><td>Open, 3-bet and defend wider; small bets postflop; fold when clearly behind or nobody folds.</td></tr>
      <tr><th>Medium stack</th><td>Avoid big stacks (tighten with one on your left); pressure medium and short stacks.</td></tr>
      <tr><th>Short stack</th><td>Shove, don't min-raise and call off; fold marginal call-offs; pressure other short stacks.</td></tr>
      <tr><th>Bluffs</th><td>Hold an ace: it blocks the hands that call or jam.</td></tr>
      <tr><th>Example</th><td>10bb BB vs 40bb SB jam: need ~56% (44+, A6s+, A8o+, K6s+, K8o+, Q8s+, JTs).</td></tr>
      <tr><th>Payouts</th><td>Care about pay jumps that matter; don't lock up early for a min-cash.</td></tr>
    </tbody></table>
    <h2>Top mistakes</h2>
    <ol class="tight">${MISTAKES.slice(0, 6).map(([a, b]) => `<li><b>${a}</b> ${b}</li>`).join('')}</ol>
  </section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stack depth &amp; bubble quick card</title><style>${CSS}</style></head><body class="card">${p1}${p2}</body></html>`;
}

async function pdf(htmlPath, title) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.log('playwright not found; open the HTML and print to PDF'); return; }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: htmlPath.replace(/\.html$/, '.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font-size:7px;color:#888;padding:0 0.55in;display:flex;justify-content:space-between"><span>${esc(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
  await browser.close();
  console.log('wrote', htmlPath.replace(/\.html$/, '.pdf'));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const g = path.join(OUT, 'players-guide.html');
  fs.writeFileSync(g, guideHTML());
  console.log('wrote', g);
  await pdf(g, "Stack Depth & Bubble Strategy · Player's guide");
  const c = path.join(OUT, 'quick-card.html');
  fs.writeFileSync(c, cardHTML());
  console.log('wrote', c);
  await pdf(c, 'Stack depth & bubble quick card');
})();
