/* Shared answer history for all drills (localStorage, this browser only).
 * Each entry: { t, d (drill), k (spot/decision key), lab (label), g (hand group or position),
 *   ok, loss (bb, solver drills), pct (loss as % of pot), v (verdict), hand (text), link }.
 * Also computes "focus" weights so drills can deal more of the spots you get wrong. */
(function (root) {
  'use strict';
  const KEY = 'pfh:log';
  const MAX = 3000;

  function all() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch (e) { /* storage full or blocked */ }
  }
  function log(entry) {
    const list = all();
    list.push(Object.assign({ t: Date.now() }, entry));
    save(list);
  }
  function clear(drill) {
    save(drill ? all().filter((e) => e.d !== drill) : []);
  }

  /** Per-key stats over the most recent `recent` entries of a drill: { n, wrong, loss, pct }. */
  function statsBy(drill, field, recent) {
    const out = {};
    const list = all().filter((e) => e.d === drill).slice(-(recent || 600));
    for (const e of list) {
      const key = typeof field === 'function' ? field(e) : e[field];
      if (key == null) continue;
      const s = out[key] || (out[key] = { n: 0, wrong: 0, loss: 0, pct: 0 });
      s.n++;
      if (!e.ok) s.wrong++;
      s.loss += e.loss || 0;
      s.pct += e.pct || 0;
    }
    return out;
  }

  /**
   * Focus weight for a key: more weight for spots you get wrong or lose EV in, and a bonus
   * for spots with few answers yet so they get explored. EV-graded drills use the average
   * loss (% of pot); chart drills use the error rate.
   */
  function weight(s, evGraded) {
    if (!s || s.n < 4) return 2;
    const err = s.wrong / s.n;
    const leak = evGraded ? Math.min(4, s.pct / s.n / 1.5) : 4 * err;
    return 0.5 + leak + (evGraded ? 1.5 * err : 0);
  }

  function pickWeighted(items, w) {
    let total = 0;
    const cum = items.map((it) => (total += Math.max(0, w(it))));
    if (!total) return items[Math.floor(Math.random() * items.length)];
    const x = Math.random() * total;
    return items[cum.findIndex((c) => c >= x)];
  }

  root.PFHistory = { log, all, clear, statsBy, weight, pickWeighted };
})(typeof window !== 'undefined' ? window : globalThis);
