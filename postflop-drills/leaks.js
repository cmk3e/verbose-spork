/* "My leaks" report: reads the shared answer history (history.js) and the checklist's
 * saved accuracy, and shows where you lose the most. Everything stays in this browser. */
(function () {
  'use strict';
  const H = window.PFHistory;
  const E = window.PFEngine;
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2);
  const pc = (x) => Math.round(x * 100) + '%';
  const DRILL_NAMES = { flop: 'Solver flop drill', turn: 'Solver turn drill', preflop: 'Preflop trainer', pushfold: '12bb push/fold' };
  const PAGES = { flop: 'solver.html', turn: 'turn.html', preflop: 'preflop.html', pushfold: 'pushfold.html' };
  const GROUPS = (E && E.HAND_GROUPS) || {};
  const QUESTIONS = {
    position: 'In position or out of position?', topCard: 'Who does the top card favour?', connected: 'Connected or disconnected?',
    dynamic: 'Static or dynamic?', rangeAdv: 'Who has the range advantage?', nutAdv: 'Who has the nut advantage?', handStrength: 'How strong is my hand?',
  };

  function bar(p) {
    return `<div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div>`;
  }
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return m + 'm ago';
    if (m < 60 * 24) return Math.round(m / 60) + 'h ago';
    return Math.round(m / 1440) + 'd ago';
  }

  function group(list, keyFn) {
    const out = new Map();
    for (const e of list) {
      const k = keyFn(e);
      if (k == null) continue;
      const g = out.get(k) || { k, n: 0, wrong: 0, loss: 0, pct: 0, entries: [] };
      g.n++; if (!e.ok) g.wrong++; g.loss += e.loss || 0; g.pct += e.pct || 0; g.entries.push(e);
      out.set(k, g);
    }
    return [...out.values()];
  }

  function render() {
    const all = H ? H.all() : [];
    const by = (d) => all.filter((e) => e.d === d);

    // summary tiles
    const tiles = $('#summary');
    tiles.innerHTML = Object.keys(DRILL_NAMES).map((d) => {
      const l = by(d);
      const right = l.filter((e) => e.ok).length;
      const loss = l.reduce((a, e) => a + (e.loss || 0), 0);
      const extra = d === 'flop' || d === 'turn' ? `<small>${l.length ? fmt(loss / l.length) + 'bb lost / hand' : ''}</small>` : '';
      return `<div class="tile"><span>${DRILL_NAMES[d]}</span><b>${l.length ? pc(right / l.length) : '–'}</b><small>${l.length} hands</small>${extra}</div>`;
    }).join('');

    // solver leaks: by spot + decision, ranked by total EV lost
    const solverRows = group(all.filter((e) => e.d === 'flop' || e.d === 'turn'), (e) => e.d + '|' + e.k)
      .filter((g) => g.n >= 3)
      .sort((a, b) => b.loss - a.loss);
    $('#solverLeaks').innerHTML = solverRows.length ? solverRows.slice(0, 15).map((g) => {
      const e0 = g.entries[g.entries.length - 1];
      const d = e0.d;
      const byGroup = group(g.entries, (e) => e.g).sort((a, b) => b.loss - a.loss);
      const sub = byGroup.map((x) => `<tr><td>${esc(GROUPS[x.k] || x.k)}</td><td class="num">${x.n}</td><td class="num">${pc(1 - x.wrong / x.n)}</td><td class="num">${fmt(x.loss / x.n)}bb</td></tr>`).join('');
      return `<details class="leak"><summary>
          <span class="leak-name">${esc(e0.lab)}<small>${DRILL_NAMES[d]} · ${g.n} hands · ${pc(1 - g.wrong / g.n)} right</small></span>
          <span class="leak-num"><b>${fmt(g.loss / g.n)}bb</b><small>lost / hand</small></span>
        </summary>
        <table class="stats subt"><thead><tr><th>Hand type</th><th class="num">Hands</th><th class="num">Right</th><th class="num">Lost / hand</th></tr></thead><tbody>${sub}</tbody></table>
        <div class="btnrow"><a class="btn" href="${PAGES[d]}?only=${encodeURIComponent(e0.k)}">Drill this spot</a></div>
      </details>`;
    }).join('') : '<p class="note">Play at least 3 hands of a solver spot to see it here.</p>';

    // preflop / push-fold leaks: by spot type + seat, ranked by mistakes
    const pfRows = group(all.filter((e) => e.d === 'preflop' || e.d === 'pushfold'), (e) => e.d + '|' + e.k)
      .filter((g) => g.n >= 3 && g.wrong > 0)
      .sort((a, b) => (b.wrong / b.n) * Math.sqrt(b.n) - (a.wrong / a.n) * Math.sqrt(a.n));
    $('#pfLeaks').innerHTML = pfRows.length ? `<table class="stats"><thead><tr><th>Spot</th><th class="num">Hands</th><th>Right</th><th></th></tr></thead><tbody>` +
      pfRows.slice(0, 15).map((g) => {
        const e0 = g.entries[g.entries.length - 1];
        const acc = 1 - g.wrong / g.n;
        return `<tr><td>${esc(e0.lab)}<br><small class="muted">${DRILL_NAMES[e0.d]}</small></td><td class="num">${g.n}</td>
          <td class="barcell">${bar(acc)}<span class="num">${pc(acc)}</span></td>
          <td><a href="${PAGES[e0.d]}?only=${encodeURIComponent(e0.k)}">Drill</a></td></tr>`;
      }).join('') + '</tbody></table>' : '<p class="note">No preflop mistakes logged yet (needs 3+ hands of a spot).</p>';

    // flop checklist: saved accuracy per question
    let cl = {};
    try { cl = JSON.parse(localStorage.getItem('pfd:stats') || '{}'); } catch (e) { cl = {}; }
    const qs = Object.keys(QUESTIONS).filter((q) => cl[q] && cl[q].total).sort((a, b) => cl[a].right / cl[a].total - cl[b].right / cl[b].total);
    $('#checklist').innerHTML = qs.length ? '<table class="stats"><tbody>' + qs.map((q) => {
      const acc = cl[q].right / cl[q].total;
      return `<tr><td>${QUESTIONS[q]}</td><td class="num">${cl[q].right}/${cl[q].total}</td><td class="barcell">${bar(acc)}<span class="num">${pc(acc)}</span></td></tr>`;
    }).join('') + '</tbody></table>' : '<p class="note">No flop checklist answers yet.</p>';

    // recent mistakes
    const misses = all.filter((e) => !e.ok).slice(-50).reverse().slice(0, state.shown);
    const more = Math.min(50, all.filter((e) => !e.ok).length) > state.shown;
    $('#more').hidden = !more;
    $('#mistakes').innerHTML = misses.length ? '<ul class="misses">' + misses.map((e) => `<li>
        <span><b>${esc(e.hand || '')}</b><small>${esc(e.lab || '')} · ${esc(e.v || '')} · ${ago(e.t)}</small></span>
        ${e.link ? `<a class="btn ghost" href="${esc(e.link)}">Replay</a>` : ''}</li>`).join('') + '</ul>'
      : '<p class="note">No mistakes logged yet.</p>';
    $('#count').textContent = all.length;
  }

  const state = { shown: 20 };
  function init() {
    $('#more').addEventListener('click', () => { state.shown = 50; render(); });
    $('#clear').addEventListener('click', () => {
      if (confirm('Clear your answer history from every drill? Accuracy stats inside each drill are kept.')) { H.clear(); render(); }
    });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
