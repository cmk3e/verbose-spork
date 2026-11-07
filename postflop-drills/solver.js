/* Solver flop drill: graded against precomputed postflop-solver strategies.
 * Loads solver-data/<spot>/index.json and one <flop>.json at a time. */
(function () {
  'use strict';
  const E = window.PFEngine;
  const SPOT_DIR = 'solver-data/btn-bb-50/';
  const RANKS = 'AKQJT98765432';
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };

  const NODE_INFO = {
    x: { hero: 'BTN', label: 'BB checks to you', type: 'ipCheck' },
    'x-b1': { hero: 'BB', label: 'You check, BTN bets small', type: 'vsSmall' },
    'x-b2': { hero: 'BB', label: 'You check, BTN bets big', type: 'vsBig' },
  };
  const TYPES = { ipCheck: 'BTN: c-bet or check back', vsSmall: 'BB: facing a ⅓-pot bet', vsBig: 'BB: facing a ¾-pot bet' };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('psd:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('psd:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const rand = (n) => Math.floor(Math.random() * n);

  const state = {
    index: null, cache: {}, flop: null, nodeName: null, node: null, combo: null, answered: false,
    settings: Object.assign({ types: Object.keys(TYPES) }, store.get('settings', {})),
    stats: store.get('stats', {}),
    session: { right: 0, total: 0, streak: 0, hands: 0, evLoss: 0 },
  };

  // ------------------------------------------------------------ helpers
  const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2);
  function handClass(combo) {
    const r1 = combo[0], s1 = combo[1], r2 = combo[2], s2 = combo[3];
    const [a, b] = RANKS.indexOf(r1) <= RANKS.indexOf(r2) ? [r1, r2] : [r2, r1];
    if (a === b) return a + b;
    return a + b + (s1 === s2 ? 's' : 'o');
  }
  function classIndex(cls) {
    const i = RANKS.indexOf(cls[0]), j = RANKS.indexOf(cls[1]);
    if (cls.length === 2) return i * 13 + i;
    return cls[2] === 's' ? i * 13 + j : j * 13 + i;
  }
  function cardEl(str, small) {
    const r = str[0], s = str[1];
    const n = el('div', 'card suit-' + s + (small ? ' small' : ''));
    n.innerHTML = `<span class="rank">${r === 'T' ? '10' : r}</span><span class="pip">${SUIT_SYM[s]}</span>`;
    return n;
  }
  function actionText(a, pot) {
    const m = a.match(/^(Bet|Raise|All-in) ([\d.]+)$/);
    if (!m) return a;
    const amt = +m[2];
    if (m[1] === 'Bet') return `Bet ${amt}bb (${Math.round((amt / pot) * 100)}%)`;
    return `${m[1]} to ${amt}bb`;
  }

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(path + ': ' + r.status);
    return r.json();
  }
  async function loadFlop(f) {
    if (!state.cache[f]) state.cache[f] = await loadJSON(SPOT_DIR + f + '.json');
    return state.cache[f];
  }

  // ------------------------------------------------------------ deal
  async function deal() {
    const types = state.settings.types.length ? state.settings.types : Object.keys(TYPES);
    const names = Object.keys(NODE_INFO).filter((n) => types.includes(NODE_INFO[n].type));
    const flopName = state.index.flops[rand(state.index.flops.length)];
    const flop = await loadFlop(flopName);
    const avail = names.filter((n) => flop.nodes[n]);
    const nodeName = avail[rand(avail.length)];
    const node = flop.nodes[nodeName];
    // deal a combo in proportion to how often it reaches this spot
    const entries = Object.entries(node.hands);
    let total = 0;
    for (const [, v] of entries) total += v[0];
    let x = Math.random() * total, combo = entries[0][0];
    for (const [c, v] of entries) { x -= v[0]; if (x <= 0) { combo = c; break; } }
    Object.assign(state, { flop, nodeName, node, combo, answered: false });
    state.session.hands++;
    render();
  }

  // ------------------------------------------------------------ render
  function render() {
    const { flop, node, nodeName, combo } = state;
    const info = NODE_INFO[nodeName];
    $('#typeChip').textContent = info.hero === 'BTN' ? 'You: BTN (in position)' : 'You: BB (out of position)';
    $('#depthChip').textContent = '50bb deep';
    $('#pot').textContent = node.pot.toFixed(1) + 'bb';
    const preflop = info.hero === 'BTN' ? '<b>You (BTN)</b> open 2.2bb, BB calls.' : 'BTN opens 2.2bb, <b>you (BB)</b> call.';
    let line = info.label + '.';
    if (nodeName !== 'x') {
      const bet = state.flop.nodes.x.actions[nodeName === 'x-b1' ? 1 : 2];
      line = `You check, BTN ${actionText(bet, flop.pot).replace('Bet', 'bets')}.`;
    }
    $('#action').innerHTML = `${preflop} Flop: ${line}`;
    const board = $('#board');
    board.innerHTML = '';
    flop.flop.match(/../g).forEach((c, i) => { const n = cardEl(c); n.style.setProperty('--i', i); board.appendChild(n); });
    const hole = $('#hole');
    hole.innerHTML = '';
    [combo.slice(0, 2), combo.slice(2)].forEach((c, i) => { const n = cardEl(c, true); n.style.setProperty('--i', i + 3); hole.appendChild(n); });
    $('#texture').textContent = E ? 'Board: ' + E.describeBoard(flop.flop.match(/../g).map(E.parseCard)) : '';
    const opts = $('#options');
    opts.innerHTML = '';
    node.actions.forEach((a, i) => {
      const b = el('button', 'opt');
      b.type = 'button';
      b.innerHTML = `<kbd>${i + 1}</kbd><span>${actionText(a, node.pot)}</span>`;
      b.addEventListener('click', () => answer(i));
      opts.appendChild(b);
    });
    $('#feedback').hidden = true;
    $('#chartWrap').hidden = true;
    renderScore();
  }

  function answer(i) {
    if (state.answered) return;
    state.answered = true;
    const { node, combo, nodeName } = state;
    const k = node.actions.length;
    const v = node.hands[combo];
    const freqs = v.slice(1, 1 + k), evs = v.slice(1 + k);
    const best = Math.max(...evs);
    const loss = Math.max(0, best - evs[i]);
    const lossPct = (loss / node.pot) * 100;
    let verdict, ok;
    if (freqs[i] >= 50 || loss <= 0.05) { verdict = 'Best'; ok = true; }
    else if (freqs[i] >= 15 || lossPct <= 2) { verdict = 'Good (the solver mixes here)'; ok = true; }
    else if (lossPct <= 6) { verdict = `Inaccuracy: −${fmt(loss)}bb`; ok = false; }
    else if (lossPct <= 15) { verdict = `Mistake: −${fmt(loss)}bb`; ok = false; }
    else { verdict = `Blunder: −${fmt(loss)}bb`; ok = false; }

    const ss = state.session;
    ss.total++; ss.evLoss += loss;
    if (ok) { ss.right++; ss.streak++; } else ss.streak = 0;
    const type = NODE_INFO[nodeName].type;
    const st = state.stats[type] || { right: 0, total: 0, loss: 0 };
    st.total++; st.loss += loss; if (ok) st.right++;
    state.stats[type] = st;
    store.set('stats', state.stats);

    document.querySelectorAll('#options .opt').forEach((b, j) => {
      b.disabled = true;
      if (freqs[j] >= 15 || evs[j] >= best - 0.05) b.classList.add('is-answer');
      if (j === i && !ok) b.classList.add('picked-bad');
    });
    $('#verdict').textContent = verdict;
    $('#verdict').className = 'verdict ' + (ok ? 'ok' : 'bad');
    const tbody = $('#handTable');
    tbody.innerHTML = '';
    node.actions.forEach((a, j) => {
      const tr = el('tr', j === i ? 'mine' : '');
      tr.innerHTML = `<td>${actionText(a, node.pot)}</td><td class="num">${freqs[j]}%</td><td class="num">${fmt(evs[j])}bb</td>
        <td class="num">${evs[j] >= best - 0.005 ? 'best' : '−' + fmt(best - evs[j])}</td>`;
      tbody.appendChild(tr);
    });
    $('#explain').textContent = `${combo.slice(0, 2)} ${combo.slice(2)}: the solver's mix for this exact hand and what each choice is worth.`;
    $('#feedback').hidden = false;
    renderRange();
    renderScore();
    $('#next').focus();
  }

  const ACT_COLORS = (a) => (a === 'Check' ? 'var(--act-call)' : a === 'Call' ? 'var(--act-call)' : a === 'Fold' ? 'var(--act-fold)' : null);

  function renderRange() {
    const { node, combo } = state;
    const k = node.actions.length;
    // colours: check/call green, fold blue, bets/raises from light to dark red
    const aggr = node.actions.map((a, j) => ({ a, j })).filter((x) => !ACT_COLORS(x.a));
    const reds = ['#f08a7e', '#e5483f', '#a32620', '#7a1d1a'];
    const color = (j) => ACT_COLORS(node.actions[j]) || reds[aggr.findIndex((x) => x.j === j) + (aggr.length === 1 ? 1 : 0)];

    const cls = new Array(169).fill(null).map(() => ({ w: 0, f: new Array(k).fill(0) }));
    const tot = new Array(k).fill(0);
    let W = 0;
    for (const [c, v] of Object.entries(node.hands)) {
      const idx = classIndex(handClass(c));
      cls[idx].w += v[0];
      W += v[0];
      for (let j = 0; j < k; j++) { cls[idx].f[j] += v[0] * v[1 + j]; tot[j] += v[0] * v[1 + j]; }
    }
    const grid = $('#grid');
    grid.innerHTML = '';
    const mine = classIndex(handClass(combo));
    for (let i = 0; i < 169; i++) {
      const r = Math.floor(i / 13), c = i % 13;
      const name = r === c ? RANKS[r] + RANKS[r] : r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o';
      const cell = el('div', 'gcell' + (i === mine ? ' me' : '') + (cls[i].w > 0 ? '' : ' out'), name);
      if (cls[i].w > 0) {
        let x = 0;
        const stops = [];
        for (let j = 0; j < k; j++) {
          const f = cls[i].f[j] / cls[i].w / 100;
          if (f <= 0) continue;
          stops.push(`${color(j)} ${x * 100}% ${(x + f) * 100}%`);
          x += f;
        }
        cell.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
      }
      grid.appendChild(cell);
    }
    const legend = $('#gridLegend');
    legend.innerHTML = '';
    node.actions.forEach((a, j) => {
      legend.appendChild(el('span', 'lg', `<i style="background:${color(j)}"></i>${actionText(a, node.pot)} <b class="num">${Math.round(tot[j] / W)}%</b>`));
    });
    $('#chartTitle').textContent = `Solver strategy for the whole ${NODE_INFO[state.nodeName].hero} range on ${state.flop.flop}`;
    $('#chartWrap').hidden = false;
  }

  function renderScore() {
    const ss = state.session;
    $('#score').textContent = `${ss.right}/${ss.total}`;
    $('#streak').textContent = ss.streak;
    $('#evloss').textContent = ss.total ? fmt(ss.evLoss / ss.total) : '0.00';
  }

  function renderSettings() {
    const tbox = $('#typeToggles');
    tbox.innerHTML = '';
    Object.keys(TYPES).forEach((t) => {
      const lab = el('label', 'tog', `<input type="checkbox" id="stype-${t}"><span>${TYPES[t]}</span>`);
      tbox.appendChild(lab);
      const cb = lab.querySelector('input');
      cb.checked = state.settings.types.includes(t);
      cb.onchange = () => {
        const set = new Set(state.settings.types);
        cb.checked ? set.add(t) : set.delete(t);
        if (!set.size) { cb.checked = true; return; }
        state.settings.types = Object.keys(TYPES).filter((x) => set.has(x));
        store.set('settings', state.settings);
      };
    });
  }

  function renderStats() {
    const tb = $('#statsBody');
    tb.innerHTML = '';
    Object.keys(TYPES).forEach((t) => {
      const st = state.stats[t] || { right: 0, total: 0, loss: 0 };
      const p = st.total ? Math.round((st.right / st.total) * 100) : null;
      const tr = el('tr');
      tr.innerHTML = `<td>${TYPES[t]}</td><td class="num">${st.right}/${st.total}</td>
        <td class="num">${st.total ? fmt(st.loss / st.total) + 'bb' : '–'}</td>
        <td class="barcell"><div class="bar"><i style="width:${p || 0}%"></i></div><span class="num">${p == null ? '–' : p + '%'}</span></td>`;
      tb.appendChild(tr);
    });
  }

  async function init() {
    $('#next').addEventListener('click', deal);
    $('#deal').addEventListener('click', deal);
    $('#statsBox').addEventListener('toggle', renderStats);
    $('#resetStats').addEventListener('click', () => { state.stats = {}; store.set('stats', {}); renderStats(); });
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (/^[1-4]$/.test(e.key)) {
        const b = document.querySelectorAll('#options .opt')[+e.key - 1];
        if (b && !b.disabled) b.click();
      } else if ((e.key === 'Enter' || e.key === 'n') && state.answered && document.activeElement !== $('#next')) {
        e.preventDefault(); deal();
      }
    });
    renderSettings();
    try {
      state.index = await loadJSON(SPOT_DIR + 'index.json');
      $('#flopCount').textContent = state.index.flops.length;
      await deal();
    } catch (err) {
      $('#action').textContent = 'Could not load the solver data. Open this page from the website (not a saved file) and refresh.';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
