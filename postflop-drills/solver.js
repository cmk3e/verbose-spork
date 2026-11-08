/* Solver flop drill: graded against precomputed postflop-solver strategies.
 * Loads solver-data/<spot>/index.json and one <flop>.json at a time. */
(function () {
  'use strict';
  const E = window.PFEngine;
  // Solved spots; each has solver-data/<id>/index.json. Add new spots here.
  const SPOTS = [
    { id: 'btn-bb-50', name: 'BTN vs BB', depth: 50, raiser: 'BTN', caller: 'BB', open: 2.2 },
    { id: 'btn-bb-30', name: 'BTN vs BB', depth: 30, raiser: 'BTN', caller: 'BB', open: 2.3 },
    { id: 'btn-bb-20', name: 'BTN vs BB', depth: 20, raiser: 'BTN', caller: 'BB', open: 2 },
    { id: 'hj-bb-50', name: 'HJ vs BB', depth: 50, raiser: 'HJ', caller: 'BB', open: 2.2 },
    { id: 'sb-bb-50', name: 'BB vs SB', depth: 50, raiser: 'SB', caller: 'BB', open: 3.5 },
  ];
  SPOTS.forEach((sp) => { sp.label = `${sp.name} ${sp.depth}bb`; });

  // Preflop frequency (0-1) of a hand class for the hero's preflop action in this spot,
  // from the chart data (ranges-data.js). Null when the chart is unavailable.
  function preflopFreq(sp, heroIsRaiser, cls) {
    const D = window.PF_RANGE_DATA;
    const d = D && D.depths[String(sp.depth)];
    if (!d) return null;
    const str = heroIsRaiser ? d.open[sp.raiser] : d.call[sp.caller + '>' + sp.raiser];
    const i = D.order.indexOf(cls);
    if (!str || i < 0) return null;
    return str[i] === 'X' ? 1 : +str[i] / 10;
  }
  const RANKS = 'AKQJT98765432';
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };

  // Which exported solver nodes are drilled, by whether the preflop raiser is in position.
  // root = OOP acts first; b1/b2 = IP facing OOP's bets; x = IP after a check; x-b1/x-b2 = OOP facing IP's bets.
  const DRILL_NODES = {
    raiserIP: { x: 'cbet', 'x-b1': 'vsSmall', 'x-b2': 'vsBig' },
    raiserOOP: { root: 'cbet', b1: 'vsSmall', b2: 'vsBig', x: 'stab' },
  };
  const TYPES = {
    cbet: 'Raiser: c-bet or check',
    vsSmall: 'Caller: facing a ⅓-pot c-bet',
    vsBig: 'Caller: facing a ¾-pot c-bet',
    stab: 'Caller: bet or check after the raiser checks',
  };
  const typeLabel = (t, sp) => TYPES[t].replace('Raiser', sp.raiser).replace('Caller', sp.caller);
  const drillNodes = (sp, index) => DRILL_NODES[index.ip === sp.raiser ? 'raiserIP' : 'raiserOOP'];

  const store = {
    get(k, d) { try { const v = localStorage.getItem('psd:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('psd:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const rand = (n) => Math.floor(Math.random() * n);

  const state = {
    indexes: {}, spot: null, index: null, cache: {}, flop: null, nodeName: null, node: null, combo: null, answered: false,
    settings: migrateSettings(store.get('settings', {})),
    stats: migrateStats(store.get('stats', {})),
    session: { right: 0, total: 0, streak: 0, hands: 0, evLoss: 0 },
  };

  // ------------------------------------------------------------ helpers
  // stats are kept per spot and node type ("btn-bb-50:vsSmall"); older saves had type only
  function migrateStats(st) {
    const out = {};
    for (const [k, v] of Object.entries(st)) out[(k.includes(':') ? k : SPOTS[0].id + ':' + k).replace('ipCheck', 'cbet')] = v;
    return out;
  }
  function migrateSettings(s) {
    const out = Object.assign({ types: Object.keys(TYPES), spots: SPOTS.map((x) => x.id) }, s);
    if (!s.v) {
      // v1 had no "stab" type and called the c-bet type "ipCheck"; new spots start enabled
      out.types = out.types.map((t) => (t === 'ipCheck' ? 'cbet' : t)).concat(['stab']);
      out.spots = Array.from(new Set(out.spots.concat(['sb-bb-50'])));
    }
    if ((s.v || 1) < 3) out.spots = Array.from(new Set(out.spots.concat(['btn-bb-30', 'btn-bb-20'])));
    if (out.mainOnly == null) out.mainOnly = false;
    out.types = Object.keys(TYPES).filter((t) => out.types.includes(t));
    out.v = 3;
    return out;
  }
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
  async function loadFlop(spot, f) {
    const key = spot + '/' + f;
    if (!state.cache[key]) state.cache[key] = await loadJSON('solver-data/' + key + '.json');
    return state.cache[key];
  }
  const loadedSpots = () => SPOTS.filter((x) => state.indexes[x.id]);

  // ------------------------------------------------------------ deal
  async function deal() {
    const types = state.settings.types.length ? state.settings.types : Object.keys(TYPES);
    const namesFor = (sp) => Object.entries(drillNodes(sp, state.indexes[sp.id])).filter(([, t]) => types.includes(t)).map(([n]) => n);
    let avSpots = loadedSpots().filter((x) => state.settings.spots.includes(x.id) && namesFor(x).length);
    if (!avSpots.length) avSpots = loadedSpots().filter((x) => namesFor(x).length);
    if (!avSpots.length) avSpots = loadedSpots();
    const spot = avSpots[rand(avSpots.length)];
    const index = state.indexes[spot.id];
    const flopName = index.flops[rand(index.flops.length)];
    const flop = await loadFlop(spot.id, flopName);
    let avail = namesFor(spot).filter((n) => flop.nodes[n]);
    if (!avail.length) avail = Object.keys(drillNodes(spot, index)).filter((n) => flop.nodes[n]);
    const nodeName = avail[rand(avail.length)];
    const node = flop.nodes[nodeName];
    // deal a combo in proportion to how often it reaches this spot; optionally only hands
    // the hero's preflop chart plays at least half the time
    let entries = Object.entries(node.hands);
    if (state.settings.mainOnly) {
      const heroIsRaiser = (node.player === 'IP' ? index.ip : index.oop) === spot.raiser;
      const main = entries.filter(([c]) => { const f = preflopFreq(spot, heroIsRaiser, handClass(c)); return f == null || f >= 0.5; });
      if (main.length) entries = main;
    }
    let total = 0;
    for (const [, v] of entries) total += v[0];
    let x = Math.random() * total, combo = entries[0][0];
    for (const [c, v] of entries) { x -= v[0]; if (x <= 0) { combo = c; break; } }
    Object.assign(state, { spot, index, flop, nodeName, node, combo, answered: false });
    state.session.hands++;
    render();
  }

  // ------------------------------------------------------------ render
  function render() {
    const { flop, node, nodeName, combo } = state;
    const { ip, oop } = state.index;
    const sp = state.spot;
    const heroIP = node.player === 'IP';
    const hero = heroIP ? ip : oop;
    $('#spotChip').textContent = sp.label;
    $('#typeChip').textContent = `You: ${hero} (${heroIP ? 'in' : 'out of'} position)`;
    $('#depthChip').textContent = Math.round(flop.stack + sp.open) + 'bb deep';
    $('#pot').textContent = node.pot.toFixed(1) + 'bb';
    const verb = sp.raiser === 'SB' ? 'raise' : 'open';
    const preflop = hero === sp.raiser
      ? `<b>You (${sp.raiser})</b> ${verb} to ${sp.open}bb, ${sp.caller} calls.`
      : `${sp.raiser} ${verb}s to ${sp.open}bb, <b>you (${sp.caller})</b> call.`;
    const betText = (from, i) => actionText(flop.nodes[from].actions.filter((a) => /^Bet/.test(a))[i], flop.pot).replace('Bet', 'bets');
    let line;
    if (nodeName === 'root') line = 'you act first.';
    else if (nodeName === 'x') line = `${oop} checks to you.`;
    else if (nodeName === 'b1' || nodeName === 'b2') line = `${oop} ${betText('root', nodeName === 'b1' ? 0 : 1)}.`;
    else line = `you check, ${ip} ${betText('x', nodeName === 'x-b1' ? 0 : 1)}.`;
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
    const type = state.index.id + ':' + drillNodes(state.spot, state.index)[nodeName];
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
    $('#chartTitle').textContent = `Solver strategy for the whole ${state.node.player === 'IP' ? state.index.ip : state.index.oop} range on ${state.flop.flop}`;
    $('#chartWrap').hidden = false;
  }

  function renderScore() {
    const ss = state.session;
    $('#score').textContent = `${ss.right}/${ss.total}`;
    $('#streak').textContent = ss.streak;
    $('#evloss').textContent = ss.total ? fmt(ss.evLoss / ss.total) : '0.00';
  }

  function renderSettings() {
    const sbox = $('#spotToggles');
    sbox.innerHTML = '';
    loadedSpots().forEach((sp) => {
      const lab = el('label', 'tog', `<input type="checkbox"><span>${sp.label}</span>`);
      sbox.appendChild(lab);
      const cb = lab.querySelector('input');
      cb.checked = state.settings.spots.includes(sp.id);
      cb.onchange = () => {
        const set = new Set(state.settings.spots);
        cb.checked ? set.add(sp.id) : set.delete(sp.id);
        if (!SPOTS.some((x) => set.has(x.id) && state.indexes[x.id])) { cb.checked = true; return; }
        state.settings.spots = SPOTS.map((x) => x.id).filter((x) => set.has(x));
        store.set('settings', state.settings);
      };
    });
    const mo = $('#mainOnly');
    mo.checked = !!state.settings.mainOnly;
    mo.onchange = () => { state.settings.mainOnly = mo.checked; store.set('settings', state.settings); };
    const tbox = $('#typeToggles');
    tbox.innerHTML = '';
    Object.keys(TYPES).forEach((t) => {
      const lab = el('label', 'tog', `<input type="checkbox" id="stype-${t}"><span>${TYPES[t]}</span>`);
      if (t === 'stab' && !loadedSpots().some((sp) => Object.values(drillNodes(sp, state.indexes[sp.id])).includes('stab'))) return;
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
    loadedSpots().forEach((sp) => Object.values(drillNodes(sp, state.indexes[sp.id])).forEach((t) => {
      const st = state.stats[sp.id + ':' + t] || { right: 0, total: 0, loss: 0 };
      const p = st.total ? Math.round((st.right / st.total) * 100) : null;
      const tr = el('tr');
      tr.innerHTML = `<td>${sp.label} · ${typeLabel(t, sp)}</td><td class="num">${st.right}/${st.total}</td>
        <td class="num">${st.total ? fmt(st.loss / st.total) + 'bb' : '–'}</td>
        <td class="barcell"><div class="bar"><i style="width:${p || 0}%"></i></div><span class="num">${p == null ? '–' : p + '%'}</span></td>`;
      tb.appendChild(tr);
    }));
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
    await Promise.all(SPOTS.map((sp) => loadJSON('solver-data/' + sp.id + '/index.json')
      .then((ix) => { state.indexes[sp.id] = ix; }).catch(() => {})));
    renderSettings();
    try {
      const ls = loadedSpots();
      if (!ls.length) throw new Error('no spots');
      const names = Array.from(new Set(ls.map((x) => x.name)));
      const depths = ls.map((x) => x.depth);
      const lo = Math.min(...depths), hi = Math.max(...depths);
      $('#spotList').textContent = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
      $('#depthList').textContent = lo === hi ? lo + 'bb' : `${lo}–${hi}bb`;
      $('#flopCount').textContent = ls.reduce((n, x) => n + state.indexes[x.id].flops.length, 0);
      await deal();
    } catch (err) {
      $('#action').textContent = 'Could not load the solver data. Open this page from the website (not a saved file) and refresh.';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
