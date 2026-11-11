/* Preflop trainer. Depends on preflop-data.js (window.PF_PREFLOP_DATA).
 * Set window.PF_TRAINER_MODE = 'pushfold' before loading for the 12bb push/fold drill. */
(function () {
  'use strict';
  const DATA = window.PF_PREFLOP_DATA;
  const H = window.PFHistory;
  const ORDER = DATA.order;
  const DIG = '0123456789abcdefghijk';
  const SUIT_SYM = ['♠', '♥', '♦', '♣'];
  const SUIT_CLASS = ['s', 'h', 'd', 'c'];
  const ACTION_ORDER = ['fold', 'call', 'raise', 'allin'];

  const PUSHFOLD = window.PF_TRAINER_MODE === 'pushfold';
  const PF_DEPTH = '12';
  const POSITIONS = ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const TYPES = PUSHFOLD ? {
    open: 'Open: shove, min-raise or fold',
    rejam: 'Facing an open: rejam, call or fold',
    callShove: 'Facing an open-shove: call or fold',
    vsRejam: 'You opened and got rejammed: call or fold',
    vsLimp: 'BB vs SB limp',
  } : {
    rfi: 'Open (folded to you)',
    vsOpen: 'Facing an open',
    vsLimp: 'Facing a limp',
    vs3bet: 'Facing a 3-bet',
    vs4bet: 'Facing a 4-bet',
    vsShove: 'Facing an all-in',
  };

  const PREFIX = PUSHFOLD ? 'ppf:' : 'pft:';
  // drill category of a spot (push/fold mode groups the chart types differently)
  function catOf(p) {
    if (!PUSHFOLD) return p.type;
    if (p.type === 'rfi') return 'open';
    if (p.type === 'vsOpen') return 'rejam';
    if (p.type === 'vsLimp') return 'vsLimp';
    if (p.type === 'vsShove') return p.sub === 'open' ? 'callShove' : p.sub === '3bet' ? 'vsRejam' : null;
    return null;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rand(a.length)];

  // ------------------------------------------------------------ spots
  function parseTitle(t) {
    let m;
    if ((m = t.match(/^(\S+) · RFI$/))) return { type: 'rfi', hero: m[1] };
    if ((m = t.match(/^BB vs SB · Limp$/))) return { type: 'vsLimp', hero: 'BB', villain: 'SB' };
    if ((m = t.match(/^(\S+) vs (\S+) · RFI$/))) return { type: 'vsOpen', hero: m[1], villain: m[2] };
    if ((m = t.match(/^(\S+) vs (\S+) · All-In$/))) return { type: 'vsShove', sub: 'open', hero: m[1], villain: m[2] };
    if ((m = t.match(/^(\S+) vs (\S+) · 3-Bet$/))) return { type: 'vs3bet', hero: m[1], villain: m[2] };
    if ((m = t.match(/^(\S+) vs (\S+) · 3-Bet All-In$/))) return { type: 'vsShove', sub: '3bet', hero: m[1], villain: m[2] };
    if ((m = t.match(/^(\S+) vs (\S+) · 4-Bet$/))) return { type: 'vs4bet', hero: m[1], villain: m[2] };
    if ((m = t.match(/^(\S+) vs (\S+) · 4-Bet All-In$/))) return { type: 'vsShove', sub: '4bet', hero: m[1], villain: m[2] };
    return null;
  }

  const ALL_SPOTS = [];
  for (const depth of Object.keys(DATA.depths)) {
    if (PUSHFOLD && depth !== PF_DEPTH) continue;
    const D = DATA.depths[depth];
    for (const title of Object.keys(D.charts)) {
      const p = parseTitle(title);
      if (!p) continue;
      p.cat = catOf(p);
      if (!p.cat) continue;
      const chart = D.charts[title];
      // actions the chart actually uses (e.g. BB never folds to a limp)
      const acts = ACTION_ORDER.filter((a) => chart[a] && /[1-9a-k]/.test(chart[a]));
      // per-hand frequencies
      const freqs = ORDER.map((h, i) => {
        const f = {};
        let any = 0;
        for (const a of acts) { f[a] = DIG.indexOf(chart[a][i]) / 20; any += f[a]; }
        return any > 0 ? f : null;
      });
      // share of all hands (by combos) taking each action, for the range summary
      const share = {};
      let inRange = 0;
      ORDER.forEach((h, i) => {
        const f = freqs[i];
        if (!f) return;
        const n = h.length === 2 ? 6 : h[2] === 's' ? 4 : 12;
        inRange += n;
        for (const a of acts) share[a] = (share[a] || 0) + n * f[a];
      });
      ALL_SPOTS.push(Object.assign({ depth, title, acts, freqs, D, share, inRange }, p));
    }
  }

  function actionLabel(spot, a) {
    const t = spot.type;
    if (a === 'fold') return 'Fold';
    if (a === 'allin') {
      if (!PUSHFOLD) return 'All-in';
      return t === 'vsOpen' ? `Rejam ${spot.depth}bb` : `Shove ${spot.depth}bb`;
    }
    if (a === 'call') return t === 'rfi' ? 'Limp' : t === 'vsLimp' ? 'Check' : 'Call';
    // raise
    if (t === 'rfi') {
      const size = spot.hero === 'SB' ? spot.D.sbOpenSize : spot.D.openSize;
      return size ? `Raise ${size}bb` : PUSHFOLD ? 'Min-raise' : 'Raise';
    }
    if (t === 'vsOpen') return '3-bet';
    if (t === 'vs3bet') return '4-bet';
    if (t === 'vs4bet') return '5-bet';
    return 'Raise';
  }

  function openSize(spot, pos) {
    const s = pos === 'SB' ? spot.D.sbOpenSize : spot.D.openSize;
    return s ? `${s}bb` : 'a min-raise';
  }

  function actionText(spot) {
    const { type, hero: h, villain: v, depth } = spot;
    switch (type) {
      case 'rfi': return `Folds to you in the <b>${h}</b>.`;
      case 'vsLimp': return `SB limps. Your option in the <b>BB</b>.`;
      case 'vsOpen': return PUSHFOLD && !spot.D.openSize
        ? `${v} min-raises. Folds to you in the <b>${h}</b>.`
        : `${v} opens to ${openSize(spot, v)}. Folds to you in the <b>${h}</b>.`;
      case 'vs3bet': return `You open from the <b>${h}</b> and ${v} 3-bets. Action is back on you.`;
      case 'vs4bet': return `${v} opens, you 3-bet from the <b>${h}</b>, and ${v} 4-bets. Action is on you.`;
      case 'vsShove':
        if (spot.sub === 'open') return `${v} opens all-in for ${depth}bb. Folds to you in the <b>${h}</b>.`;
        if (spot.sub === '3bet') return PUSHFOLD
          ? `You min-raise from the <b>${h}</b> and ${v} rejams all-in for ${depth}bb.`
          : `You open from the <b>${h}</b> and ${v} 3-bets all-in.`;
        return `${v} opens, you 3-bet from the <b>${h}</b>, and ${v} 4-bets all-in.`;
    }
    return '';
  }

  // ------------------------------------------------------------ state
  const state = {
    settings: Object.assign({ depth: PUSHFOLD ? PF_DEPTH : 'any', types: Object.keys(TYPES), positions: POSITIONS.slice(), focus: false }, store.get('settings', {})),
    stats: store.get('stats', {}),
    session: { right: 0, total: 0, streak: 0, hands: 0 },
    spot: null, handIdx: 0, cards: null, answered: false,
  };

  // ?depth=30 (links from the guides) drills one stack depth for this visit
  const urlDepth = new URLSearchParams(location.search).get('depth');
  if (!PUSHFOLD && urlDepth && DATA.depths[urlDepth]) state.settings.depth = urlDepth;

  function eligibleSpots() {
    return ALL_SPOTS.filter((s) =>
      (PUSHFOLD || state.settings.depth === 'any' || s.depth === state.settings.depth) &&
      (!PUSHFOLD || state.settings.positions.includes(s.hero)) &&
      state.settings.types.includes(s.cat));
  }

  function dealCards(hand) {
    const r1 = hand[0], r2 = hand[1];
    let s1 = rand(4), s2;
    if (hand.length === 2) { do { s2 = rand(4); } while (s2 === s1); }
    else if (hand[2] === 's') s2 = s1;
    else { do { s2 = rand(4); } while (s2 === s1); }
    return [[r1, s1], [r2, s2]];
  }

  const DRILL = PUSHFOLD ? 'pushfold' : 'preflop';
  const params = new URLSearchParams(location.search);
  const focusKey = (s) => s.cat + '|' + s.hero;
  function deal() {
    let spots = eligibleSpots();
    if (!spots.length) spots = ALL_SPOTS;
    // ?pf=<depth>|<chart title>|<hand> replays one hand (first deal only)
    const replay = !state.replayDone && (params.get('pf') || '').split('|');
    state.replayDone = true;
    if (replay && replay.length === 3) {
      const rs = ALL_SPOTS.find((x) => x.depth === replay[0] && x.title === replay[1]);
      const hi = ORDER.indexOf(replay[2]);
      if (rs && hi >= 0 && rs.freqs[hi]) return show(rs, hi);
    }
    // ?only=<category>|<position> (from the leaks page) drills just that spot type and seat
    const only = (params.get('only') || '').split('|');
    if (only[0]) {
      const os = ALL_SPOTS.filter((x) => x.cat === only[0] && (!only[1] || x.hero === only[1]));
      if (os.length) spots = os;
    }
    if (H && state.settings.focus && !only[0]) {
      // weight spot type + seat by how often you have been getting it wrong
      const st = H.statsBy(DRILL, 'k');
      const keys = Array.from(new Set(spots.map(focusKey)));
      const k = H.pickWeighted(keys, (key) => H.weight(st[key], false));
      spots = spots.filter((x) => focusKey(x) === k);
    } else if (PUSHFOLD) {
      // pick the kind of spot first so open shoves aren't swamped by the many facing-action charts
      const cat = pick(Array.from(new Set(spots.map((x) => x.cat))));
      spots = spots.filter((x) => x.cat === cat);
    }
    const spot = pick(spots);
    // Deal hands in this spot's range; pure folds come up less often.
    const items = [];
    let total = 0;
    spot.freqs.forEach((f, i) => {
      if (!f) return;
      const combos = ORDER[i].length === 2 ? 6 : ORDER[i][2] === 's' ? 4 : 12;
      const w = combos * ((f.fold || 0) >= 0.99 ? 0.2 : 1);
      total += w;
      items.push([i, total]);
    });
    const x = Math.random() * total;
    show(spot, items.find((it) => it[1] >= x)[0]);
  }

  function show(spot, handIdx) {
    state.spot = spot;
    state.handIdx = handIdx;
    state.cards = dealCards(ORDER[handIdx]);
    state.answered = false;
    state.session.hands++;
    render();
  }

  // ------------------------------------------------------------ render
  function cardEl(rank, suit) {
    const n = el('div', 'card small suit-' + SUIT_CLASS[suit]);
    const r = rank === 'T' ? '10' : rank;
    n.innerHTML = `<span class="rank">${r}</span><span class="pip">${SUIT_SYM[suit]}</span>`;
    return n;
  }

  function render() {
    const s = state.spot;
    $('#typeChip').textContent = TYPES[s.cat];
    $('#depthChip').textContent = s.depth + 'bb deep';
    $('#action').innerHTML = actionText(s);
    const hole = $('#hole');
    hole.innerHTML = '';
    state.cards.forEach(([r, su], i) => { const c = cardEl(r, su); c.style.setProperty('--i', i); hole.appendChild(c); });
    $('#handName').textContent = ORDER[state.handIdx];
    const opts = $('#options');
    opts.innerHTML = '';
    s.acts.forEach((a, i) => {
      const b = el('button', 'opt act-' + a);
      b.type = 'button';
      b.dataset.value = a;
      b.innerHTML = `<kbd>${i + 1}</kbd><span>${actionLabel(s, a)}</span>`;
      b.addEventListener('click', () => answer(a));
      opts.appendChild(b);
    });
    $('#feedback').hidden = true;
    $('#chartWrap').hidden = true;
    renderScore();
  }

  function verdict(f, best) {
    if (f >= 0.5 || (f > 0 && f >= best - 0.001)) return { ok: true, text: 'Correct', cls: 'ok' };
    if (f >= 0.15) return { ok: true, text: 'Correct (the chart mixes here)', cls: 'ok' };
    if (f > 0) return { ok: false, text: 'Rarely played this way', cls: 'bad' };
    return { ok: false, text: 'Mistake', cls: 'bad' };
  }

  function answer(a) {
    if (state.answered) return;
    state.answered = true;
    const s = state.spot;
    const f = s.freqs[state.handIdx];
    const best = Math.max(...s.acts.map((x) => f[x] || 0));
    const v = verdict(f[a] || 0, best);
    state.session.total++;
    if (v.ok) { state.session.right++; state.session.streak++; } else state.session.streak = 0;
    const st = state.stats[s.cat] || { right: 0, total: 0 };
    st.total++; if (v.ok) st.right++;
    state.stats[s.cat] = st;
    store.set('stats', state.stats);
    if (H) {
      const sym = (c) => (c[0] === 'T' ? '10' : c[0]) + SUIT_SYM[c[1]];
      H.log({
        d: DRILL, k: focusKey(s), lab: `${TYPES[s.cat]} · ${s.hero}`, g: s.hero,
        ok: v.ok, v: v.text, depth: s.depth,
        hand: `${state.cards.map(sym).join('')} (${ORDER[state.handIdx]}) · ${s.title.replace(' · ', ', ')} · ${s.depth}bb`,
        link: `${PUSHFOLD ? 'pushfold' : 'preflop'}.html?pf=${encodeURIComponent(s.depth + '|' + s.title + '|' + ORDER[state.handIdx])}`,
      });
    }

    document.querySelectorAll('#options .opt').forEach((b) => {
      b.disabled = true;
      const val = b.dataset.value;
      if ((f[val] || 0) >= 0.15) b.classList.add('is-answer');
      if (val === a && !v.ok) b.classList.add('picked-bad');
    });
    $('#verdict').textContent = v.text;
    $('#verdict').className = 'verdict ' + v.cls;
    const parts = s.acts.filter((x) => (f[x] || 0) > 0).sort((x, y) => f[y] - f[x])
      .map((x) => `${actionLabel(s, x)} ${Math.round(f[x] * 100)}%`);
    $('#explain').textContent = `${ORDER[state.handIdx]} here: ${parts.join(' · ')}.`;
    const sum = $('#rangeSummary');
    if (sum) {
      // e.g. "The whole chart: Shove 27% · Min-raise 11% · Fold 62% of hands"
      const base = s.type === 'vsShove' && s.sub === '3bet' ? s.inRange : 1326;
      const bits = s.acts.filter((x) => s.share[x] > 0).map((x) => `${actionLabel(s, x)} ${((s.share[x] / base) * 100).toFixed(1)}%`);
      sum.textContent = base === 1326
        ? `Whole chart: ${bits.join(' · ')} of all hands.`
        : `Whole chart: ${bits.join(' · ')} of the hands you min-raise with.`;
    }
    $('#feedback').hidden = false;
    renderChart();
    $('#next').focus();
    renderScore();
  }

  function renderChart() {
    const s = state.spot;
    const grid = $('#grid');
    grid.innerHTML = '';
    ORDER.forEach((h, i) => {
      const f = s.freqs[i];
      const cell = el('div', 'gcell' + (i === state.handIdx ? ' me' : '') + (f ? '' : ' out'), h);
      if (f) {
        let x = 0;
        const stops = [];
        for (const a of ['raise', 'allin', 'call', 'fold']) {
          if (!f[a]) continue;
          const c = `var(--act-${a})`;
          stops.push(`${c} ${x * 100}% ${(x + f[a]) * 100}%`);
          x += f[a];
        }
        cell.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
      }
      grid.appendChild(cell);
    });
    const legend = $('#gridLegend');
    legend.innerHTML = '';
    for (const a of ['raise', 'allin', 'call', 'fold']) {
      if (!s.acts.includes(a)) continue;
      legend.appendChild(el('span', 'lg', `<i style="background:var(--act-${a})"></i>${actionLabel(s, a)}`));
    }
    $('#chartTitle').textContent = PUSHFOLD
      ? `${s.hero}${s.villain ? ' vs ' + s.villain : ''} · ${TYPES[s.cat].split(':')[0]} (12bb chart)`
      : `${s.title.replace(' · ', ', ')} (${s.depth}bb)`;
    $('#chartWrap').hidden = false;
  }

  function renderScore() {
    const ss = state.session;
    $('#score').textContent = `${ss.right}/${ss.total}`;
    $('#streak').textContent = ss.streak;
    $('#hands').textContent = ss.hands;
  }

  function renderSettings() {
    const depths = Object.keys(DATA.depths).sort((a, b) => b - a);
    const dbox = $('#depthToggles');
    const fo = $('#focus');
    if (fo) {
      fo.checked = !!state.settings.focus;
      fo.onchange = () => { state.settings.focus = fo.checked; store.set('settings', state.settings); };
    }
    const pbox = $('#posToggles');
    if (pbox) {
      pbox.innerHTML = '';
      POSITIONS.forEach((pos) => {
        const lab = el('label', 'tog', `<input type="checkbox"><span>${pos}</span>`);
        pbox.appendChild(lab);
        const cb = lab.querySelector('input');
        cb.checked = state.settings.positions.includes(pos);
        cb.onchange = () => {
          const set = new Set(state.settings.positions);
          cb.checked ? set.add(pos) : set.delete(pos);
          if (!set.size) { cb.checked = true; return; }
          state.settings.positions = POSITIONS.filter((x) => set.has(x));
          store.set('settings', state.settings);
        };
      });
    }
    if (dbox) dbox.innerHTML = '';
    if (dbox) ['any'].concat(depths).forEach((d) => {
      const lab = el('label', 'tog', `<input type="radio" name="depth" id="pdepth-${d}" value="${d}"><span>${d === 'any' ? 'Mixed' : d + 'bb'}</span>`);
      dbox.appendChild(lab);
      const r = lab.querySelector('input');
      r.checked = state.settings.depth === d;
      r.onchange = () => { state.settings.depth = d; store.set('settings', state.settings); };
    });
    const tbox = $('#typeToggles');
    tbox.innerHTML = '';
    Object.keys(TYPES).forEach((t) => {
      const lab = el('label', 'tog', `<input type="checkbox" id="ptype-${t}"><span>${TYPES[t]}</span>`);
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
      const st = state.stats[t] || { right: 0, total: 0 };
      const p = st.total ? Math.round((st.right / st.total) * 100) : null;
      const tr = el('tr');
      tr.innerHTML = `<td>${TYPES[t]}</td><td class="num">${st.right}/${st.total}</td>
        <td class="barcell"><div class="bar"><i style="width:${p || 0}%"></i></div><span class="num">${p == null ? '–' : p + '%'}</span></td>`;
      tb.appendChild(tr);
    });
  }

  function init() {
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
    deal();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
