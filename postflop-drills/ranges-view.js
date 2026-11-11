/* Range viewer: pick an opener and a responder on a table, see both charts. */
(function () {
  'use strict';
  const DATA = window.PF_PREFLOP_DATA;
  const E = window.PFEngine;
  // the 30 flops used by the solver drill, high to low
  const FLOPS = ['AhAd7c', 'AhKd5c', 'AsQs6d', 'AsJh9s', 'As7d2c', 'Ad5d4c', 'KsKd4h', 'KhQd4c', 'KsJs8s', 'Kd9d5s', 'Ks7d2c',
    'QsTd8c', 'Qh9c4d', 'Qd6d2s', 'JhTd3c', 'Js8d6h', 'Jc7c2h', 'Th9h8c', 'Tc8c4c', 'Td5c2s', '9s9h4h', '9d8d6s', '9s6h4c',
    '8h7c4h', '8d5s2h', '7d7c2s', '7c6d5s', '7h4h2h', '6s4d3c', '5h3c2d'];
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const advCache = {};
  const ORDER = DATA.order;
  const DIG = '0123456789abcdefghijk';
  const SEATS = ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const DRAW_ORDER = ['raise', 'allin', 'call', 'fold'];
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  const state = { depth: '50', opener: null, resp: null, flop: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('prv:state') || '{}');
    if (saved.depth && DATA.depths[saved.depth]) state.depth = saved.depth;
    if (saved.opener) state.opener = saved.opener;
    if (saved.resp) state.resp = saved.resp;
    if (saved.flop && FLOPS.includes(saved.flop)) state.flop = saved.flop;
  } catch (e) { /* ignore */ }
  // ?depth=50&open=LJ&resp=BB&flop=As7d2c (links from the guides) override the saved state
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('depth') && DATA.depths[q.get('depth')]) state.depth = q.get('depth');
    if (q.has('open')) { state.opener = q.get('open') || null; state.resp = q.get('resp') || null; }
    if (q.has('flop')) state.flop = FLOPS.includes(q.get('flop')) ? q.get('flop') : '';
  } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem('prv:state', JSON.stringify(state)); } catch (e) { /* ignore */ } };

  const charts = () => DATA.depths[state.depth].charts;
  const openChart = (pos) => charts()[`${pos} · RFI`] || null;
  const respChart = (resp, opener) => charts()[`${resp} vs ${opener} · RFI`] || null;

  function openSize(pos) {
    const D = DATA.depths[state.depth];
    const s = pos === 'SB' ? D.sbOpenSize : D.openSize;
    return s ? `${s}bb` : 'min-raise';
  }
  function label(kind, a, pos) {
    if (a === 'fold') return 'Fold';
    if (a === 'allin') return 'All-in';
    if (kind === 'open') return a === 'raise' ? `Raise ${openSize(pos)}` : 'Limp';
    return a === 'raise' ? '3-bet' : 'Call';
  }

  // ---------------------------------------------------------------- table
  function renderSeats() {
    const box = $('#seats');
    box.innerHTML = '';
    const oi = SEATS.indexOf(state.opener);
    SEATS.forEach((pos, i) => {
      const b = el('button', 'seat seat-' + i);
      b.type = 'button';
      let role = '';
      if (pos === state.opener) { b.classList.add('is-opener'); role = 'Opens'; }
      else if (pos === state.resp) { b.classList.add('is-resp'); role = 'Responds'; }
      else if (oi >= 0 && i < oi) { b.classList.add('is-folded'); role = 'Folds'; }
      else if (oi >= 0 && state.resp && i < SEATS.indexOf(state.resp)) { b.classList.add('is-folded'); role = 'Folds'; }
      const canOpen = !!openChart(pos);
      if (oi < 0 && !canOpen) b.classList.add('is-disabled');
      b.innerHTML = `<b>${pos}</b><small>${role || (pos === 'BTN' ? 'Dealer' : '&nbsp;')}</small>`;
      if (pos === 'BTN') b.insertAdjacentHTML('beforeend', '<i class="dealer">D</i>');
      b.setAttribute('aria-pressed', pos === state.opener || pos === state.resp ? 'true' : 'false');
      b.addEventListener('click', () => pickSeat(pos));
      box.appendChild(b);
    });
    $('#hint').textContent = !state.opener
      ? 'Tap the seat that opens'
      : !state.resp ? `${state.opener} opens. Tap a later seat to see its response.` : `${state.opener} opens, ${state.resp} responds. Tap the opener to start over.`;
  }

  function pickSeat(pos) {
    const oi = SEATS.indexOf(state.opener), pi = SEATS.indexOf(pos);
    if (pos === state.opener) { state.opener = null; state.resp = null; }
    else if (state.opener && pi > oi) state.resp = pos === state.resp ? null : pos;
    else if (openChart(pos)) { state.opener = pos; state.resp = null; }
    save();
    render();
  }

  // ---------------------------------------------------------------- charts
  function decode(chart) {
    const acts = DRAW_ORDER.filter((a) => chart[a] && /[1-9a-k]/.test(chart[a]));
    const freqs = ORDER.map((h, i) => {
      const f = {};
      let any = 0;
      for (const a of acts) { f[a] = DIG.indexOf(chart[a][i]) / 20; any += f[a]; }
      return any > 0 ? f : null;
    });
    const share = {};
    ORDER.forEach((h, i) => {
      if (!freqs[i]) return;
      const n = h.length === 2 ? 6 : h[2] === 's' ? 4 : 12;
      for (const a of acts) share[a] = (share[a] || 0) + n * freqs[i][a];
    });
    return { acts, freqs, share };
  }

  function drawChart(prefix, chart, kind, pos, highlight) {
    const { acts, freqs, share } = decode(chart);
    const grid = $(`#${prefix}Grid`);
    grid.innerHTML = '';
    ORDER.forEach((h, i) => {
      const f = freqs[i];
      const cell = el('div', 'gcell' + (f ? '' : ' out'), h);
      if (f) {
        let x = 0;
        const stops = [];
        for (const a of DRAW_ORDER) {
          if (!f[a]) continue;
          const dim = highlight && a !== highlight;
          const c = dim ? 'var(--line)' : `var(--act-${a})`;
          stops.push(`${c} ${x * 100}% ${(x + f[a]) * 100}%`);
          x += f[a];
        }
        cell.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
        if (highlight && !(f[highlight] > 0)) cell.classList.add('dim');
      }
      grid.appendChild(cell);
    });
    const legend = $(`#${prefix}Legend`);
    legend.innerHTML = '';
    for (const a of DRAW_ORDER) {
      if (!acts.includes(a)) continue;
      legend.appendChild(el('span', 'lg', `<i style="background:var(--act-${a})"></i>${label(kind, a, pos)} <b class="num">${((share[a] || 0) / 1326 * 100).toFixed(1)}%</b>`));
    }
  }

  function render() {
    renderSeats();
    const op = state.opener && openChart(state.opener);
    $('#openPanel').hidden = !op;
    if (op) {
      $('#openTitle').textContent = `${state.opener} open range · ${state.depth}bb`;
      drawChart('open', op, 'open', state.opener, null);
    }
    const rp = state.opener && state.resp && respChart(state.resp, state.opener);
    $('#respPanel').hidden = !(state.opener && state.resp);
    if (state.opener && state.resp) {
      if (rp) {
        $('#respTitle').textContent = `${state.resp} vs ${state.opener} open · ${state.depth}bb`;
        drawChart('resp', rp, 'resp', state.resp, $('#callsOnly').checked ? 'call' : null);
      } else {
        $('#respTitle').textContent = `No ${state.resp} vs ${state.opener} chart at ${state.depth}bb`;
        $('#respGrid').innerHTML = '';
        $('#respLegend').innerHTML = '';
      }
    }
    $('#charts').classList.toggle('two', !!(op && state.resp));
    renderFlop(op, rp);
  }

  // ---------------------------------------------------------------- flop advantages
  // combos of a chart action, weighted by frequency, without the board cards
  function rangeOf(chart, action, board) {
    const out = [];
    if (!chart || !chart[action]) return out;
    const S = 'shdc';
    ORDER.forEach((h, i) => {
      const f = DIG.indexOf(chart[action][i]) / 20;
      if (!(f > 0)) return;
      const r1 = h[0], r2 = h[1];
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          if (h.length === 2) { if (b <= a) continue; }
          else if (h[2] === 's') { if (a !== b) continue; }
          else if (a === b) continue;
          const c1 = E.parseCard(r1 + S[a]), c2 = E.parseCard(r2 + S[b]);
          if (board.includes(c1) || board.includes(c2)) continue;
          const combo = [c1, c2];
          combo.w = f;
          out.push(combo);
        }
      }
    });
    return out;
  }

  function renderFlop(op, rp) {
    const panel = $('#flopPanel');
    panel.hidden = !(op && rp && E);
    if (panel.hidden) return;
    const sel = $('#flop');
    sel.value = state.flop;
    const cards = $('#flopCards');
    cards.innerHTML = '';
    const adv = $('#flopAdv');
    const note = $('#flopNote');
    if (!state.flop) {
      adv.hidden = true;
      note.textContent = 'Pick a flop to see who has the range advantage and the nut advantage.';
      return;
    }
    state.flop.match(/../g).forEach((c) => {
      const n = el('div', 'card small suit-' + c[1], `<span class="rank">${c[0] === 'T' ? '10' : c[0]}</span><span class="pip">${SUIT_SYM[c[1]]}</span>`);
      cards.appendChild(n);
    });
    const board = state.flop.match(/../g).map(E.parseCard);
    const key = [state.depth, state.opener, state.resp, state.flop].join('|');
    let a = advCache[key];
    if (!a) {
      const R = rangeOf(op, 'raise', board), C = rangeOf(rp, 'call', board);
      if (!R.length || !C.length) {
        adv.hidden = true;
        note.textContent = !C.length ? `${state.resp} never just calls this open at ${state.depth}bb, so there's no flop to compare.` : `${state.opener} has no non-all-in open at ${state.depth}bb.`;
        return;
      }
      const eq = E.rangeEquity(R, C, board, 6000);
      const nuts = E.nutStats(R, C, board, 0.05);
      const hi = Math.max(nuts.aFrac, nuts.bFrac), lo = Math.min(nuts.aFrac, nuts.bFrac);
      const nutSide = hi - lo < 0.015 ? null : (lo === 0 ? hi > 0 : hi / lo >= 1.3) ? (nuts.aFrac > nuts.bFrac ? 'opener' : 'resp') : null;
      a = advCache[key] = { eq, range: eq >= 0.53 ? 'opener' : eq <= 0.47 ? 'resp' : null, nutO: nuts.aFrac, nutR: nuts.bFrac, nut: nutSide, cut: nuts.cutLabel };
    }
    // who is in position after the flop: the blinds act first, otherwise the later seat
    const blinds = ['SB', 'BB'];
    const respIP = !blinds.includes(state.resp) || (state.resp === 'BB' && state.opener === 'SB');
    const name = (side) => (side === 'opener' ? state.opener : state.resp);
    const role = (side) => `${side === 'opener' ? 'raiser' : 'caller'}, ${(side === 'resp') === respIP ? 'in position' : 'out of position'}`;
    const pc = (x) => Math.round(x * 100) + '%';
    note.textContent = `${E.describeBoard(board)[0].toUpperCase() + E.describeBoard(board).slice(1)} flop. ${state.opener} (${role('opener')}) vs ${state.resp} (${role('resp')}).`;
    adv.innerHTML = `
      <div><span class="adv-k">Range advantage</span><b class="adv-v ${a.range ? 'side-' + a.range : ''}">${a.range ? name(a.range) : 'Roughly even'}</b>
        <small>${state.opener}'s range has ${pc(a.eq)} equity against ${state.resp}'s (${pc(1 - a.eq)}).</small></div>
      <div><span class="adv-k">Nut advantage</span><b class="adv-v ${a.nut ? 'side-' + a.nut : ''}">${a.nut ? name(a.nut) : 'Roughly even'}</b>
        <small>Strongest 5% of hands (about ${a.cut.replace(/ \(.*\)$/, '').toLowerCase()} or better): ${state.opener} ${pc(a.nutO)} of its range, ${state.resp} ${pc(a.nutR)}.</small></div>`;
    adv.hidden = false;
  }

  function init() {
    const sel = $('#depth');
    Object.keys(DATA.depths).sort((a, b) => b - a).forEach((d) => {
      const o = el('option', null, d + 'bb');
      o.value = d;
      sel.appendChild(o);
    });
    sel.value = state.depth;
    sel.addEventListener('change', () => {
      state.depth = sel.value;
      if (state.opener && !openChart(state.opener)) { state.opener = null; state.resp = null; }
      save();
      render();
    });
    $('#callsOnly').addEventListener('change', render);
    const fsel = $('#flop');
    FLOPS.forEach((f) => {
      const o = el('option', null, f.match(/../g).map((c) => (c[0] === 'T' ? '10' : c[0]) + SUIT_SYM[c[1]]).join(' '));
      o.value = f;
      fsel.appendChild(o);
    });
    fsel.addEventListener('change', () => { state.flop = fsel.value; save(); render(); });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
