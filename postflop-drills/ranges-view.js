/* Range viewer: pick an opener and a responder on a table, see both charts. */
(function () {
  'use strict';
  const DATA = window.PF_PREFLOP_DATA;
  const ORDER = DATA.order;
  const DIG = '0123456789abcdefghijk';
  const SEATS = ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const DRAW_ORDER = ['raise', 'allin', 'call', 'fold'];
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  const state = { depth: '50', opener: null, resp: null };
  try {
    const saved = JSON.parse(localStorage.getItem('prv:state') || '{}');
    if (saved.depth && DATA.depths[saved.depth]) state.depth = saved.depth;
    if (saved.opener) state.opener = saved.opener;
    if (saved.resp) state.resp = saved.resp;
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
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
