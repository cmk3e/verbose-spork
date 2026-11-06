/* Postflop Drills UI. Depends on engine.js (window.PFEngine). */
(function () {
  'use strict';
  const E = window.PFEngine;

  const QUESTION_META = {
    position: 'Position',
    topCard: 'Top card',
    connected: 'Connectedness',
    dynamic: 'Static / dynamic',
    rangeAdv: 'Range advantage',
    nutAdv: 'Nut advantage',
    handStrength: 'Hand strength',
  };
  const SUIT_SYM = ['♠', '♥', '♦', '♣'];
  const SUIT_CLASS = ['s', 'h', 'd', 'c'];

  // ------------------------------------------------------------ storage (best effort)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pfd:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pfd:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const state = {
    settings: Object.assign({ role: 'any', questions: E.QUESTION_IDS.slice() }, store.get('settings', {})),
    stats: store.get('stats', {}),
    session: { right: 0, total: 0, streak: 0, hands: 0 },
    scenario: null,
    qIndex: 0,
    answers: {},
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  function cardEl(c, size) {
    const r = E.rankChar(E.rOf(c));
    const s = E.sOf(c);
    const n = el('div', 'card suit-' + SUIT_CLASS[s] + (size ? ' ' + size : ''));
    n.setAttribute('aria-label', (r === 'T' ? '10' : r) + ' of ' + ['spades', 'hearts', 'diamonds', 'clubs'][s]);
    n.innerHTML = `<span class="rank">${r === 'T' ? '10' : r}</span><span class="pip">${SUIT_SYM[s]}</span>`;
    return n;
  }

  function activeQuestions() {
    const on = state.settings.questions.length ? state.settings.questions : E.QUESTION_IDS;
    return state.scenario.questions.filter((q) => on.includes(q.id));
  }

  // ------------------------------------------------------------ dealing
  function deal() {
    state.scenario = E.generateScenario({ role: state.settings.role });
    state.qIndex = 0;
    state.answers = {};
    state.session.hands++;
    renderScore();
    renderSpot();
    renderQuestion();
  }

  function renderSpot() {
    const s = state.scenario;
    const opener = s.spot.pfr, caller = s.spot.caller;
    const you = (pos) => (pos === s.heroPos ? `<b>You (${pos})</b>` : pos);
    $('#action').innerHTML =
      `${you(opener)} open${opener === s.heroPos ? '' : 's'} to ${s.open}bb · ${you(caller)} call${caller === s.heroPos ? '' : 's'} · everyone else folds`;
    $('#pot').textContent = s.pot + 'bb';
    $('#role').textContent = s.role === 'pfr' ? 'Preflop raiser' : 'Preflop caller';
    $('#seat').textContent = s.heroPos + ' vs ' + s.villPos;

    const board = $('#board');
    board.innerHTML = '';
    s.board.forEach((c, i) => { const n = cardEl(c); n.style.setProperty('--i', i); board.appendChild(n); });
    const hole = $('#hole');
    hole.innerHTML = '';
    s.hole.forEach((c, i) => { const n = cardEl(c, 'small'); n.style.setProperty('--i', i + 3); hole.appendChild(n); });
    $('#handLabel').textContent = 'Your hand';
    $('#review').hidden = true;
    $('#qcard').hidden = false;
  }

  function renderProgress() {
    const qs = activeQuestions();
    const wrap = $('#progress');
    wrap.innerHTML = '';
    qs.forEach((q, i) => {
      const a = state.answers[q.id];
      const cls = a ? (a.correct ? 'done ok' : 'done bad') : i === state.qIndex ? 'current' : '';
      const li = el('li', cls);
      li.innerHTML = `<span class="num">${i + 1}</span><span class="lbl">${QUESTION_META[q.id]}</span>`;
      wrap.appendChild(li);
    });
  }

  function renderQuestion() {
    const qs = activeQuestions();
    renderProgress();
    if (state.qIndex >= qs.length) return renderReview();
    const q = qs[state.qIndex];
    $('#qcount').textContent = `Question ${state.qIndex + 1} of ${qs.length}`;
    $('#qtext').textContent = q.prompt;
    const opts = $('#options');
    opts.innerHTML = '';
    q.options.forEach((o, i) => {
      const b = el('button', 'opt');
      b.type = 'button';
      b.dataset.value = o.value;
      b.innerHTML = `<kbd>${i + 1}</kbd><span>${o.label}</span>`;
      b.addEventListener('click', () => answer(q, o.value));
      opts.appendChild(b);
    });
    $('#feedback').hidden = true;
    const first = opts.querySelector('button');
    if (first && document.activeElement && document.activeElement.id === 'next') first.focus();
  }

  function answer(q, value) {
    if (state.answers[q.id]) return;
    const correct = E.isCorrect(q, value);
    state.answers[q.id] = { value, correct };
    state.session.total++;
    if (correct) { state.session.right++; state.session.streak++; } else state.session.streak = 0;
    const st = state.stats[q.id] || { right: 0, total: 0 };
    st.total++; if (correct) st.right++;
    state.stats[q.id] = st;
    store.set('stats', state.stats);

    document.querySelectorAll('#options .opt').forEach((b) => {
      b.disabled = true;
      const v = b.dataset.value;
      if (v === q.answer || (q.alsoAccept || []).includes(v)) b.classList.add('is-answer');
      if (v === value) b.classList.add(correct ? 'picked-ok' : 'picked-bad');
    });
    const fb = $('#feedback');
    const correctLabel = q.options.find((o) => o.value === q.answer).label;
    $('#verdict').textContent = correct ? 'Correct' : 'Not quite: ' + correctLabel;
    $('#verdict').className = 'verdict ' + (correct ? 'ok' : 'bad');
    $('#explain').textContent = q.explain;
    fb.hidden = false;
    if (q.id === 'handStrength') $('#handLabel').textContent = q.handLabel;
    const qs = activeQuestions();
    $('#next').textContent = state.qIndex + 1 >= qs.length ? 'See hand review' : 'Next question';
    $('#next').focus();
    renderScore();
    renderProgress();
  }

  function next() {
    const qs = activeQuestions();
    const q = qs[state.qIndex];
    if (!q || !state.answers[q.id]) return;
    state.qIndex++;
    renderQuestion();
  }

  function renderReview() {
    const s = state.scenario;
    $('#qcard').hidden = true;
    const r = $('#review');
    r.hidden = false;
    const qs = activeQuestions();
    const right = qs.filter((q) => state.answers[q.id] && state.answers[q.id].correct).length;
    $('#reviewScore').textContent = `${right} / ${qs.length} correct`;
    const list = $('#reviewList');
    list.innerHTML = '';
    qs.forEach((q) => {
      const a = state.answers[q.id];
      const lab = (v) => (q.options.find((o) => o.value === v) || {}).label;
      const row = el('div', 'rrow ' + (a.correct ? 'ok' : 'bad'));
      row.innerHTML = `<span class="rq">${QUESTION_META[q.id]}</span>
        <span class="ra">${lab(q.answer)}${a.correct ? '' : `<em>you said ${lab(a.value)}</em>`}</span>`;
      list.appendChild(row);
    });
    const plan = $('#plan');
    plan.innerHTML = '';
    s.plan.forEach((line) => plan.appendChild(el('li', null, line)));
    $('#handLabel').textContent = s.hand.label;
    $('#texture').textContent = E.describeBoard(s.board);
    $('#deal2').focus();
  }

  function renderScore() {
    const ss = state.session;
    $('#score').textContent = ss.total ? `${ss.right}/${ss.total}` : '0/0';
    $('#streak').textContent = ss.streak;
    $('#hands').textContent = ss.hands;
  }

  // ------------------------------------------------------------ settings + stats
  function renderSettings() {
    const box = $('#qtoggles');
    box.innerHTML = '';
    E.QUESTION_IDS.forEach((id) => {
      const lab = el('label', 'tog');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = 'q-' + id;
      cb.checked = state.settings.questions.includes(id);
      cb.addEventListener('change', () => {
        const set = new Set(state.settings.questions);
        cb.checked ? set.add(id) : set.delete(id);
        if (!set.size) { cb.checked = true; return; }
        state.settings.questions = E.QUESTION_IDS.filter((x) => set.has(x));
        store.set('settings', state.settings);
      });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, QUESTION_META[id]));
      box.appendChild(lab);
    });
    document.querySelectorAll('input[name="role"]').forEach((r) => {
      r.checked = r.value === state.settings.role;
      r.addEventListener('change', () => { state.settings.role = r.value; store.set('settings', state.settings); });
    });
    $('#onlyHand').addEventListener('click', () => {
      state.settings.questions = ['handStrength'];
      store.set('settings', state.settings);
      renderSettings();
      deal();
    });
    $('#allQs').addEventListener('click', () => {
      state.settings.questions = E.QUESTION_IDS.slice();
      store.set('settings', state.settings);
      renderSettings();
      deal();
    });
  }

  function renderStats() {
    const tb = $('#statsBody');
    tb.innerHTML = '';
    E.QUESTION_IDS.forEach((id) => {
      const st = state.stats[id] || { right: 0, total: 0 };
      const p = st.total ? Math.round((st.right / st.total) * 100) : null;
      const tr = el('tr');
      tr.innerHTML = `<td>${QUESTION_META[id]}</td><td class="num">${st.right}/${st.total}</td>
        <td class="barcell"><div class="bar"><i style="width:${p || 0}%"></i></div><span class="num">${p == null ? '–' : p + '%'}</span></td>`;
      tb.appendChild(tr);
    });
  }

  // ------------------------------------------------------------ wiring
  function init() {
    $('#next').addEventListener('click', next);
    $('#deal').addEventListener('click', deal);
    $('#deal2').addEventListener('click', deal);
    $('#statsBtn').addEventListener('toggle', renderStats);
    $('#resetStats').addEventListener('click', () => { state.stats = {}; store.set('stats', {}); renderStats(); });
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (/^[1-4]$/.test(e.key) && !$('#qcard').hidden) {
        const b = document.querySelectorAll('#options .opt')[+e.key - 1];
        if (b && !b.disabled) b.click();
      } else if (e.key === 'Enter' || e.key === 'n') {
        if (!$('#feedback').hidden && !$('#qcard').hidden && document.activeElement !== $('#next')) { e.preventDefault(); next(); }
        else if (!$('#review').hidden && document.activeElement !== $('#deal2')) { e.preventDefault(); deal(); }
      }
    });
    renderSettings();
    renderScore();
    deal();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
