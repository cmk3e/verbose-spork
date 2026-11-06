const assert = require('assert');
const E = require('../engine.js');
const C = (s) => s.match(/../g).map(E.parseCard);
let n = 0;
const t = (name, fn) => { fn(); n++; };

t('range sizes', () => {
  assert.strictEqual(E.parseRange('22+').length, 78);
  assert.strictEqual(E.parseRange('AKs').length, 4);
  assert.strictEqual(E.parseRange('AKo').length, 12);
  assert.strictEqual(E.parseRange('A2s+').length, 48);
  assert.strictEqual(E.parseRange('A9o-AQo').length, 48);
  assert.strictEqual(E.parseRange('22-JJ').length, 60);
  for (const k of Object.keys(E.RANGES)) assert.ok(E.rangeCombos(k).length > 50, k);
});

t('evaluator ordering', () => {
  const v = (s) => E.evaluate(C(s));
  assert.ok(v('AsKsQsJsTs') > v('9h9d9c9s2h'));
  assert.ok(v('5h4d3c2sAh') > v('KhKdKc2s3h'));
  assert.strictEqual(E.catOf(v('5h4d3c2sAh')), 4);
  assert.strictEqual(E.catOf(v('AhKhQh2h3h')), 5);
  assert.strictEqual(E.catOf(v('AhAdKhKd2c3c4s')), 2);
  assert.strictEqual(E.catOf(v('AhAdAcKhKd')), 6);
});

t('classify', () => {
  const k = (h, b) => E.classify(C(h), C(b));
  assert.strictEqual(k('7h7d', 'Ks7c2d').tier, 'premium'); // set
  assert.strictEqual(k('AhKd', 'Ks7c2d').tier, 'premium'); // TPGK
  assert.strictEqual(k('Kh5d', 'Ks7c2d').tier, 'marginal'); // TP weak kicker
  assert.strictEqual(k('8h7d', 'Ks7c2d').tier, 'marginal'); // middle pair
  assert.strictEqual(k('AhQd', 'Ks7c2d').tier, 'marginal'); // strong ace high
  assert.strictEqual(k('9h8h', 'Ks7c2d').tier, 'air');
  assert.strictEqual(k('AhQh', 'Kh7h2d').tier, 'draw'); // NFD
  assert.ok(/nut flush draw/i.test(k('AhQh', 'Kh7h2d').label));
  assert.strictEqual(k('9h8d', 'Ts7c2d').tier, 'draw'); // OESD
  assert.strictEqual(k('QhQd', 'Ts7c2d').tier, 'premium'); // overpair
  assert.strictEqual(k('8h7h', 'Kh7c2h').tier, 'draw'); // middle pair + FD
  assert.deepStrictEqual(k('8h7h', 'Kh7c2h').alsoAccept, ['marginal']);
  assert.strictEqual(k('AhKd', '7s7c2d').tier, 'marginal'); // board pair, AK high
  assert.strictEqual(k('Ah7d', '7s7c2d').tier, 'premium'); // trips
  assert.strictEqual(k('Ah2c', '7s7c2d').tier, 'marginal'); // pair of 2s under board pair
  assert.strictEqual(k('9h6d', '8s7c2d').tier, 'draw');
  assert.strictEqual(k('9h6d', 'Ts8c7d').tier, 'premium'); // straight
});

t('texture', () => {
  const x = (b) => E.texture(C(b));
  assert.strictEqual(x('Ks7c2d').connected, false);
  assert.strictEqual(x('Ks7c2d').dynamic, false);
  assert.strictEqual(x('9s8c6d').connected, true);
  assert.strictEqual(x('AsKc5d').connected, false);
  assert.strictEqual(x('AsKcQd').connected, true);
  assert.strictEqual(x('Ks7s2d').dynamic, false);
  assert.strictEqual(x('Ks7s6d').dynamic, true);
  assert.strictEqual(x('JsTc3d').dynamic, true);
  assert.strictEqual(x('9s9h4h').dynamic, false);
  assert.strictEqual(x('5s3c2d').connected, true);
});

t('scenarios + range sanity', () => {
  E.setSeed(42);
  for (let i = 0; i < 200; i++) {
    const s = E.generateScenario({ iters: 1500 });
    assert.strictEqual(s.questions.length, 7);
    for (const q of s.questions) assert.ok(q.options.some((o) => o.value === q.answer), q.id);
  }
  // UTG vs BB on A72r: UTG should have range + nut advantage and the top card.
  const board = C('Ad7c2h');
  const u = E.rangeStats(E.rangeCombos('UTG_open'), board);
  const b = E.rangeStats(E.rangeCombos('BB_vs_EP'), board);
  const eq = E.rangeEquity(u.live, b.live, board, 20000);
  console.log('UTG vs BB A72r equity', eq.toFixed(3), 'top', u.topFrac.toFixed(2), b.topFrac.toFixed(2), 'nut', u.nuttyFrac.toFixed(3), b.nuttyFrac.toFixed(3));
  assert.ok(eq > 0.55);
  assert.ok(u.topFrac > b.topFrac * 1.2);
  // BTN vs BB on 765 two-tone: BB nut advantage
  const b2 = C('7h6h5c');
  const bt = E.rangeStats(E.rangeCombos('BTN_open'), b2);
  const bb = E.rangeStats(E.rangeCombos('BB_vs_LP'), b2);
  const eq2 = E.rangeEquity(bt.live, bb.live, b2, 20000);
  console.log('BTN vs BB 765tt equity', eq2.toFixed(3), 'nut', bt.nuttyFrac.toFixed(3), bb.nuttyFrac.toFixed(3));
});

console.log(n + ' test groups passed');
{
  const C2 = (s) => s.match(/../g).map(E.parseCard);
  const show = (pfr, cal, b) => {
    const board = C2(b);
    const a = E.rangeStats(E.rangeCombos(pfr), board).live, c = E.rangeStats(E.rangeCombos(cal), board).live;
    const ns = E.nutStats(a, c, board);
    console.log(pfr, cal, b, 'eq', E.rangeEquity(a, c, board, 8000).toFixed(3), 'nuts', ns.aFrac.toFixed(3), ns.bFrac.toFixed(3), ns.cutLabel);
    return ns;
  };
  const a72 = show('UTG_open', 'BB_vs_EP', 'Ad7c2h');
  assert.ok(a72.aFrac > a72.bFrac * 1.3);
  const lo = show('BTN_open', 'BB_vs_LP', '7h6h5c');
  show('UTG_open', 'BB_vs_EP', '8h6d5c');
  show('BTN_open', 'BB_vs_LP', 'Ks8d3c');
  show('CO_open', 'BTN_vs_CO', 'Qh9h4c');
  show('SB_open', 'BB_vs_SB', '9s9d4c');
  show('UTG_open', 'BTN_vs_EP', 'JhTd3c');
}

// Chart data (ranges-data.js) — only if the file is present.
{
  let ok = true;
  try { require('../ranges-data.js'); } catch (e) { ok = false; console.log('ranges-data.js not present; skipping chart tests'); }
  if (ok) {
    const depths = E.availableDepths();
    assert.deepStrictEqual(depths, ['80', '50', '30', '20']);
    const tw = (cs) => cs.reduce((a, c) => a + c.w, 0) / 1326 * 100;
    const sp = E.spotsFor('80');
    const utgBB = sp.find((s) => s.pfr === 'UTG' && s.caller === 'BB');
    console.log('80bb UTG open %', tw(utgBB.pfrCombos).toFixed(2), '(chart 16.20)', 'BB call %', tw(utgBB.callerCombos).toFixed(2), '(parsed 45.55)');
    assert.ok(Math.abs(tw(utgBB.pfrCombos) - 16.2) < 0.6);
    console.log('spots per depth', depths.map((d) => d + ':' + E.spotsFor(d).length).join(' '));
    E.setSeed(3);
    const seen = {};
    for (let i = 0; i < 300; i++) {
      const s = E.generateScenario({ iters: 800 });
      assert.ok(s.depth);
      seen[s.spot.pfr + ' v ' + s.spot.caller] = (seen[s.spot.pfr + ' v ' + s.spot.caller] || 0) + 1;
      for (const q of s.questions) assert.ok(q.options.some((o) => o.value === q.answer));
    }
    console.log('spot mix', Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x.join('=')).join(', '));
    const s20 = E.generateScenario({ depth: '20', iters: 500 });
    assert.strictEqual(s20.depth, '20');
  }
}
