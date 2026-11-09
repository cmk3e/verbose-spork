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
    indexes: {}, adv: {}, spot: null, index: null, cache: {}, flop: null, nodeName: null, node: null, combo: null, answered: false,
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
    if (out.showAdv == null) out.showAdv = true;
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

  // A "facing a bet" node is only drilled when the bettor actually uses that size at least
  // 5% of the time on this flop; for sizes the solver almost never picks, the responses
  // are barely converged and the EVs can be misleading.
  const PARENT = { 'x-b1': ['x', 0], 'x-b2': ['x', 1], b1: ['root', 0], b2: ['root', 1] };
  function betUsed(flop, name) {
    const par = PARENT[name];
    if (!par) return true;
    const pn = flop.nodes[par[0]];
    if (!pn) return true;
    const j = pn.actions.map((a, i) => [a, i]).filter(([a]) => /^Bet/.test(a))[par[1]];
    if (!j) return false;
    let w = 0, f = 0;
    for (const v of Object.values(pn.hands)) { w += v[0]; f += v[0] * v[1 + j[1]]; }
    return w > 0 && f / w >= 5;
  }

  // ------------------------------------------------------------ deal
  async function deal() {
    const types = state.settings.types.length ? state.settings.types : Object.keys(TYPES);
    const namesFor = (sp) => Object.entries(drillNodes(sp, state.indexes[sp.id])).filter(([, t]) => types.includes(t)).map(([n]) => n);
    let avSpots = loadedSpots().filter((x) => state.settings.spots.includes(x.id) && namesFor(x).length);
    if (!avSpots.length) avSpots = loadedSpots().filter((x) => namesFor(x).length);
    if (!avSpots.length) avSpots = loadedSpots();
    // ?hand=<spot>/<flop>/<node>/<combo> opens one specific hand (first deal only)
    const forced = !state.forcedDone && (new URLSearchParams(location.search).get('hand') || '').split('/');
    state.forcedDone = true;
    const fSpot = forced && forced.length === 4 && loadedSpots().find((x) => x.id === forced[0]);
    const spot = fSpot || avSpots[rand(avSpots.length)];
    const index = state.indexes[spot.id];
    const flopName = fSpot && index.flops.includes(forced[1]) ? forced[1] : index.flops[rand(index.flops.length)];
    const flop = await loadFlop(spot.id, flopName);
    if (fSpot && flop.nodes[forced[2]] && flop.nodes[forced[2]].hands[forced[3]]) {
      Object.assign(state, { spot, index, flop, nodeName: forced[2], node: flop.nodes[forced[2]], combo: forced[3], answered: false });
      state.session.hands++;
      render();
      return;
    }
    let avail = namesFor(spot).filter((n) => flop.nodes[n] && betUsed(flop, n));
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
    renderAdv();
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
    $('#explain').textContent = '';
    try { renderWhy(i, freqs, evs, loss); } catch (e) { $('#why').innerHTML = ''; }
    $('#feedback').hidden = false;
    $('#adv').hidden = false;
    renderRange();
    renderScore();
    $('#next').focus();
  }

  // ------------------------------------------------------------ range / nut advantage
  // Same measures and thresholds as the flop checklist: whole-range equity (53%+ is an
  // edge) and each range's share of the strongest 5% of hands (1.3x and 1.5 points apart).
  // Starting ranges come from the solve: OOP = root node, IP = the node after OOP checks.
  function advantages() {
    const { flop, spot, index } = state;
    const key = spot.id + '/' + flop.flop;
    if (state.adv[key]) return state.adv[key];
    if (!E || !E.rangeEquity || !flop.nodes.root || !flop.nodes.x) return null;
    const toRange = (hands) => Object.entries(hands).map(([c, v]) => {
      const h = [E.parseCard(c.slice(0, 2)), E.parseCard(c.slice(2))];
      h.w = v[0];
      return h;
    });
    const board = flop.flop.match(/../g).map(E.parseCard);
    const oop = toRange(flop.nodes.root.hands), ip = toRange(flop.nodes.x.hands);
    const eqIP = E.rangeEquity(ip, oop, board, 5000);
    const nuts = E.nutStats(ip, oop, board, 0.05);
    const side = (a, b, ratio, minDiff) => {
      const hi = Math.max(a, b), lo = Math.min(a, b);
      if (hi - lo < minDiff) return null;
      if (lo === 0 ? hi > 0 : hi / lo >= ratio) return a > b ? 'ip' : 'oop';
      return null;
    };
    const res = {
      ip: index.ip, oop: index.oop, eqIP,
      range: eqIP >= 0.53 ? 'ip' : eqIP <= 0.47 ? 'oop' : null,
      nutIP: nuts.aFrac, nutOOP: nuts.bFrac, nutCut: nuts.cutLabel,
      nut: side(nuts.aFrac, nuts.bFrac, 1.3, 0.015),
    };
    state.adv[key] = res;
    return res;
  }

  function renderAdv() {
    const box = $('#adv');
    let a = null;
    try { a = advantages(); } catch (e) { a = null; }
    if (!a) { box.hidden = true; return; }
    const heroSide = state.node.player === 'IP' ? 'ip' : 'oop';
    const who = (sd) => (sd === heroSide ? `You (${a[sd]})` : a[sd]);
    const pc = (x) => Math.round(x * 100) + '%';
    const eqHero = heroSide === 'ip' ? a.eqIP : 1 - a.eqIP;
    const nutHero = heroSide === 'ip' ? a.nutIP : a.nutOOP, nutOpp = heroSide === 'ip' ? a.nutOOP : a.nutIP;
    const opp = heroSide === 'ip' ? a.oop : a.ip;
    box.innerHTML = `
      <div><span class="adv-k">Range advantage</span><b class="adv-v ${a.range === heroSide ? 'me' : a.range ? 'opp' : ''}">${a.range ? who(a.range) : 'Roughly even'}</b>
        <small>Your range has ${pc(eqHero)} equity against ${opp}'s range.</small></div>
      <div><span class="adv-k">Nut advantage</span><b class="adv-v ${a.nut === heroSide ? 'me' : a.nut ? 'opp' : ''}">${a.nut ? who(a.nut) : 'Roughly even'}</b>
        <small>Top 5% of hands (about ${a.nutCut.replace(/ \(.*\)$/, '').toLowerCase()} or better): you ${pc(nutHero)} of your range, ${opp} ${pc(nutOpp)}.</small></div>`;
    box.hidden = !state.settings.showAdv && !state.answered;
  }

  // ------------------------------------------------------------ explanation
  const prettyCombo = (c) => c[0].replace('T', '10') + SUIT_SYM[c[1]] + c[2].replace('T', '10') + SUIT_SYM[c[3]];
  const kindOf = (a) => (/^(Bet|Raise|All-in)/.test(a) ? 'aggr' : a === 'Fold' ? 'fold' : 'passive');
  const shortAct = (a, pot) => {
    const m = a.match(/^Bet ([\d.]+)$/);
    if (m) {
      const pc = Math.round((+m[1] / pot) * 100);
      const frac = pc >= 31 && pc <= 35 ? '⅓' : pc >= 64 && pc <= 68 ? '⅔' : pc >= 73 && pc <= 77 ? '¾' : pc + '%';
      return `Bet ${frac} pot`;
    }
    return a.replace(/ [\d.]+$/, '');
  };
  const mixText = (f, actions, pot) => actions.map((a, j) => [shortAct(a, pot), Math.round(f[j])]).filter(([, x]) => x >= 1).map(([a, x]) => `${a} ${x}%`).join(' · ');

  // Why-text for the dominant kind of action a hand group takes. {a} = bet/raise, {p} = check/call.
  const RATIONALE = {
    strong: { aggr: 'Strong made hands mostly {a} for value and to charge draws.', passive: 'Strong made hands often {p} here: they keep worse hands in and protect your {p}ing range.' },
    draw: { aggr: 'Strong draws like to {a} as semi-bluffs: they can win the pot right away and still have lots of equity when called.', passive: 'Strong draws can {p}: they have enough equity to continue without growing the pot.', fold: 'Even strong draws fold here: the price is too high for the equity.' },
    marginal: { aggr: 'Marginal made hands {a} here for thin value and protection.', passive: 'Marginal made hands mostly {p}: they have showdown value but don\'t want a big pot.', fold: 'Marginal made hands often fold to this bet: they rarely beat the hands that bet this way.' },
    weakdraw: { aggr: 'Weak draws make the best bluffs: they seldom win at showdown, but they have outs when called.', passive: 'Weak draws mostly {p} to see the next card cheaply.', fold: 'Weak draws often fold: the price is too high for the outs they have.' },
    air: { aggr: 'Even pure air {a}s some of the time here as a bluff.', passive: 'Hands with no pair and no draw mostly give up and {p}.', fold: 'Hands with no pair and no draw fold.' },
  };

  function renderWhy(picked, freqs, evs, loss) {
    const { node, combo, flop } = state;
    const box = $('#why');
    box.innerHTML = '';
    if (!E || !E.handFeatures) return;
    const k = node.actions.length;
    const facing = node.actions.includes('Fold');
    const verbs = { a: facing ? 'raise' : 'bet', p: facing ? 'call' : 'check' };
    const board = flop.flop.match(/../g).map(E.parseCard);
    const toCards = (c) => [E.parseCard(c.slice(0, 2)), E.parseCard(c.slice(2))];
    const hero = E.handFeatures(toCards(combo), board);
    const heroCls = handClass(combo);

    // aggregate the range by hand group, and the hero's hand class by exact features
    const groups = {}, sib = {};
    let W = 0;
    for (const [c, v] of Object.entries(node.hands)) {
      const f = E.handFeatures(toCards(c), board);
      const g = groups[f.group] || (groups[f.group] = { w: 0, f: new Array(k).fill(0) });
      g.w += v[0]; W += v[0];
      for (let j = 0; j < k; j++) g.f[j] += v[0] * v[1 + j];
      if (handClass(c) === heroCls) {
        const s = sib[f.label] || (sib[f.label] = { w: 0, f: new Array(k).fill(0), combos: [] });
        s.w += v[0]; s.combos.push(c);
        for (let j = 0; j < k; j++) s.f[j] += v[0] * v[1 + j];
      }
    }
    const norm = (g) => g.f.map((x) => x / g.w);
    const kindMix = (f) => {
      const m = { aggr: 0, passive: 0, fold: 0 };
      node.actions.forEach((a, j) => { m[kindOf(a)] += f[j]; });
      return m;
    };
    const topKind = (m) => Object.keys(m).sort((x, y) => m[y] - m[x])[0];

    const parts = [];
    parts.push(`<p><b>Your hand:</b> ${hero.label}.</p>`);

    // EV context
    const spread = Math.max(...evs) - Math.min(...evs);
    if (spread <= Math.max(0.05, node.pot * 0.01)) {
      parts.push(`<p>Every option is within ${fmt(spread)}bb here, so the solver is close to indifferent and mixes. Any of them is fine.</p>`);
    } else if (loss > 0.005) {
      parts.push(`<p>Your choice gives up ${fmt(loss)}bb (${((loss / node.pot) * 100).toFixed(1)}% of the pot) compared with the best play.</p>`);
    }

    // what hands like this do, and why
    const hg = groups[hero.group];
    if (hg) {
      const gm = kindMix(norm(hg));
      const gk = topKind(gm);
      const text = (RATIONALE[hero.group][gk] || '').replace(/\{a\}/g, verbs.a).replace(/\{p\}/g, verbs.p);
      if (text) parts.push(`<p><b>${E.HAND_GROUPS[hero.group]}:</b> ${mixText(norm(hg), node.actions, node.pot)}. ${text}</p>`);
      const mine = kindMix(freqs);
      if (topKind(mine) !== gk && Math.abs(mine[gk] - gm[gk]) > 30) {
        parts.push(`<p>Your exact combo plays differently from most hands of its type. Compare it with the same hand in other suits below.</p>`);
      }
    }

    // same hand class, other suits (only when the suits change the strategy)
    const sibRows = Object.entries(sib).map(([label, g]) => ({ label, g, f: norm(g) }));
    const differs = sibRows.length > 1 && node.actions.some((_, j) => {
      const xs = sibRows.map((r) => r.f[j]);
      return Math.max(...xs) - Math.min(...xs) >= 25;
    });
    if (differs) {
      sibRows.sort((x, y) => kindMix(y.f).aggr - kindMix(x.f).aggr);
      const rows = sibRows.map((r) => {
        const isMine = r.g.combos.includes(combo);
        const list = r.g.combos.slice(0, 4).map(prettyCombo).join(', ') + (r.g.combos.length > 4 ? '…' : '');
        return `<li${isMine ? ' class="mine"' : ''}><span>${r.label}<small>${list}</small></span><b>${mixText(r.f, node.actions, node.pot)}</b></li>`;
      }).join('');
      parts.push(`<p class="why-h">Same hand, other suits</p><ul class="sibs">${rows}</ul>`);
    }

    // range by hand group
    const order = Object.keys(E.HAND_GROUPS).filter((g) => groups[g]);
    const rows = order.map((g) => {
      const f = norm(groups[g]);
      let x = 0;
      const stops = [];
      for (let j = 0; j < k; j++) { const q = f[j] / 100; if (q > 0) { stops.push(`${actionColor(node, j)} ${x * 100}% ${(x + q) * 100}%`); x += q; } }
      return `<tr${g === hero.group ? ' class="mine"' : ''}><td>${E.HAND_GROUPS[g]}</td><td class="num">${Math.round((groups[g].w / W) * 100)}%</td>
        <td class="mixcell"><div class="mixbar" style="background:linear-gradient(90deg, ${stops.join(', ')})"></div><small>${mixText(f, node.actions, node.pot)}</small></td></tr>`;
    }).join('');
    const who = node.player === 'IP' ? state.index.ip : state.index.oop;
    parts.push(`<p class="why-h">How ${who} plays each hand type here</p>
      <table class="stats grouptable"><thead><tr><th>Hand type</th><th class="num">Range</th><th>Solver mix</th></tr></thead><tbody>${rows}</tbody></table>`);
    box.innerHTML = parts.join('');
  }

  const ACT_COLORS = (a) => (a === 'Check' ? 'var(--act-call)' : a === 'Call' ? 'var(--act-call)' : a === 'Fold' ? 'var(--act-fold)' : null);

  function actionColor(node, j) {
    const aggr = node.actions.map((a, i) => ({ a, i })).filter((x) => !ACT_COLORS(x.a));
    const reds = ['#f08a7e', '#e5483f', '#a32620', '#7a1d1a'];
    return ACT_COLORS(node.actions[j]) || reds[aggr.findIndex((x) => x.i === j) + (aggr.length === 1 ? 1 : 0)];
  }

  function renderRange() {
    const { node, combo } = state;
    const k = node.actions.length;
    // colours: check/call green, fold blue, bets/raises from light to dark red
    const color = (j) => actionColor(node, j);

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
    const sa = $('#showAdv');
    sa.checked = !!state.settings.showAdv;
    sa.onchange = () => { state.settings.showAdv = sa.checked; store.set('settings', state.settings); if (!state.answered) $('#adv').hidden = !sa.checked; };
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
