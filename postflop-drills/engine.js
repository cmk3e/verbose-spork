/*
 * Postflop Drills engine.
 * Pure logic: cards, ranges, hand evaluation, board texture, range stats,
 * scenario generation and answer keys. No DOM access, so it runs in the
 * browser (window.PFEngine) and in Node (require('./engine.js')) for tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- cards
  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const RANK_NAME = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
  const RANK_PLURAL = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };

  const cardId = (r, s) => (r - 2) * 4 + s;
  const rOf = (c) => (c >> 2) + 2;
  const sOf = (c) => c & 3;
  const rankChar = (r) => RANKS[r - 2];
  const cardStr = (c) => rankChar(rOf(c)) + SUITS[sOf(c)];
  const parseCard = (str) => cardId(RANKS.indexOf(str[0].toUpperCase()) + 2, SUITS.indexOf(str[1].toLowerCase()));

  // ---------------------------------------------------------------- rng
  let rand = Math.random;
  function setSeed(seed) {
    // mulberry32, for reproducible tests
    let a = seed >>> 0;
    rand = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const randInt = (n) => Math.floor(rand() * n);
  const pick = (arr) => arr[randInt(arr.length)];

  // ---------------------------------------------------------------- ranges
  const rv = (ch) => RANKS.indexOf(ch) + 2;

  function addCombos(out, r1, r2, type) {
    if (r1 === r2) {
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) out.set(key(cardId(r1, a), cardId(r1, b)), [cardId(r1, a), cardId(r1, b)]);
      return;
    }
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        if (type === 's' && a !== b) continue;
        if (type === 'o' && a === b) continue;
        const c1 = cardId(r1, a), c2 = cardId(r2, b);
        out.set(key(c1, c2), [c1, c2]);
      }
    }
  }
  const key = (a, b) => (a < b ? a * 52 + b : b * 52 + a);

  /** Parse range notation such as "22+,A2s+,KTo+,T9s,A9o-AQo" into combos. */
  function parseRange(str) {
    const out = new Map();
    for (const raw of str.split(',')) {
      const tok = raw.trim();
      if (!tok) continue;
      let m;
      if ((m = tok.match(/^([2-9TJQKA])\1(\+)?$/))) {
        const r = rv(m[1]);
        for (let x = r; x <= (m[2] ? 14 : r); x++) addCombos(out, x, x);
      } else if ((m = tok.match(/^([2-9TJQKA])\1-([2-9TJQKA])\2$/))) {
        const a = rv(m[1]), b = rv(m[2]);
        for (let x = Math.min(a, b); x <= Math.max(a, b); x++) addCombos(out, x, x);
      } else if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)(\+)?$/))) {
        let hi = rv(m[1]), k = rv(m[2]);
        if (k > hi) [hi, k] = [k, hi];
        const kmax = m[4] ? hi - 1 : k;
        for (let x = k; x <= kmax; x++) addCombos(out, hi, x, m[3]);
      } else if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)-([2-9TJQKA])([2-9TJQKA])([so]?)$/))) {
        const hi = rv(m[1]), k1 = rv(m[2]), k2 = rv(m[5]);
        for (let x = Math.min(k1, k2); x <= Math.max(k1, k2); x++) addCombos(out, hi, x, m[3]);
      } else {
        throw new Error('Bad range token: ' + tok);
      }
    }
    return [...out.values()];
  }

  // Fallback ranges, used only when ranges-data.js (the chart data) is not loaded.
  // Simplified 8-max MTT ranges (~40bb, BB ante, 2.2bb opens; SB opens 3bb).
  // Calling ranges exclude the hands that would usually 3-bet.
  const RANGES = {
    UTG_open: '66+,A9s+,A5s-A4s,KTs+,QTs+,JTs,T9s,98s,AJo+,KQo',
    'UTG+1_open': '55+,A8s+,A5s-A3s,K9s+,Q9s+,J9s+,T9s,98s,87s,ATo+,KJo+',
    LJ_open: '44+,A7s+,A5s-A2s,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,ATo+,KJo+,QJo',
    HJ_open: '33+,A2s+,K8s+,Q9s+,J8s+,T8s+,97s+,87s,76s,65s,A9o+,KTo+,QJo',
    CO_open: '22+,A2s+,K5s+,Q7s+,J8s+,T7s+,97s+,86s+,75s+,65s,54s,A7o+,A5o,KTo+,QTo+,JTo',
    BTN_open: '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K8o+,Q9o+,J8o+,T8o+,98o,87o',
    SB_open: '22+,A2s+,K2s+,Q5s+,J7s+,T7s+,96s+,86s+,75s+,64s+,54s,A2o+,K9o+,Q9o+,J9o+,T9o',
    BB_vs_EP: '22-JJ,A2s-AQs,K6s+,Q8s+,J8s+,T8s+,97s+,86s+,76s,65s,54s,A9o-AQo,KTo+,QTo+,JTo',
    BB_vs_MP: '22-JJ,A2s-AQs,K4s+,Q6s+,J7s+,T7s+,96s+,86s+,75s+,64s+,54s,A7o-AQo,K9o+,QTo+,JTo,T9o',
    BB_vs_LP: '22-TT,A2s-AJs,K2s+,Q2s+,J2s+,T2s+,92s+,84s+,73s+,62s+,52s+,42s+,32s,A2o-AJo,K5o+,Q7o+,J7o+,T7o+,97o+,86o+,75o+,64o+,54o',
    BB_vs_SB: '22-99,A2s-AJs,K2s+,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,A2o-AJo,K2o+,Q5o+,J6o+,T6o+,96o+,85o+,74o+,64o+,53o+,43o',
    BTN_vs_EP: '22-JJ,ATs-AQs,A5s-A4s,KTs+,QTs+,JTs,T9s,98s,87s,AQo,KQo',
    BTN_vs_MP: '22-JJ,A9s-AQs,A5s-A3s,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,AJo-AQo,KQo',
    BTN_vs_CO: '22-TT,A7s-AJs,A5s-A2s,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,65s,ATo-AJo,KJo+,QJo',
  };

  const FALLBACK_SPOTS = [
    ['UTG', 'BB', 'UTG_open', 'BB_vs_EP'], ['UTG+1', 'BB', 'UTG+1_open', 'BB_vs_EP'],
    ['LJ', 'BB', 'LJ_open', 'BB_vs_MP'], ['HJ', 'BB', 'HJ_open', 'BB_vs_MP'],
    ['CO', 'BB', 'CO_open', 'BB_vs_LP'], ['BTN', 'BB', 'BTN_open', 'BB_vs_LP'],
    ['SB', 'BB', 'SB_open', 'BB_vs_SB'], ['UTG', 'BTN', 'UTG_open', 'BTN_vs_EP'],
    ['HJ', 'BTN', 'HJ_open', 'BTN_vs_MP'], ['CO', 'BTN', 'CO_open', 'BTN_vs_CO'],
  ];

  // Postflop action order (first to act → last).
  const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN'];
  const PREFLOP_ORDER = ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

  // Weighted combos: each combo is [card1, card2] with a .w frequency (0–1).
  const withWeight = (c, w) => { const x = [c[0], c[1]]; x.w = w; return x; };
  const totalWeight = (combos) => combos.reduce((a, c) => a + c.w, 0);

  const parsedCache = {};
  function rangeCombos(name) {
    if (!parsedCache[name]) parsedCache[name] = parseRange(RANGES[name]).map((c) => withWeight(c, 1));
    return parsedCache[name];
  }

  const rangeData = () => root.PF_RANGE_DATA || null;

  /** Decode a 169-character frequency string from ranges-data.js into weighted combos. */
  function decodeChart(str) {
    const order = rangeData().order;
    const out = [];
    for (let i = 0; i < order.length; i++) {
      const ch = str[i];
      const q = ch === 'X' ? 10 : +ch;
      if (!q) continue;
      const h = order[i];
      const r1 = rv(h[0]), r2 = rv(h[1]);
      const m = new Map();
      addCombos(m, Math.max(r1, r2), Math.min(r1, r2), h[2] || '');
      for (const c of m.values()) out.push(withWeight(c, q / 10));
    }
    return out;
  }

  /** Stack depths available from the chart data, deepest first (empty if no data). */
  function availableDepths() {
    const d = rangeData();
    return d ? Object.keys(d.depths).sort((a, b) => b - a) : [];
  }

  const spotCache = {};
  /** All single-raised-pot spots for a depth, each with weighted ranges and a frequency weight. */
  function spotsFor(depth) {
    const d = rangeData();
    const key = d && d.depths[depth] ? depth : 'fallback';
    if (spotCache[key]) return spotCache[key];
    let spots;
    if (key === 'fallback') {
      spots = FALLBACK_SPOTS.map(([pfr, caller, a, b]) => ({
        pfr, caller, depth: null, open: pfr === 'SB' ? 3 : 2.2,
        pfrCombos: rangeCombos(a), callerCombos: rangeCombos(b), weight: 1,
      }));
    } else {
      const D = d.depths[depth];
      spots = [];
      for (const k of Object.keys(D.call)) {
        const [caller, pfr] = k.split('>');
        if (!D.open[pfr]) continue;
        const pfrCombos = decodeChart(D.open[pfr]);
        const callerCombos = decodeChart(D.call[k]);
        if (totalWeight(pfrCombos) < 1 || totalWeight(callerCombos) < 1) continue;
        // How often the spot comes up: open frequency x flat frequency (square-rooted so
        // rarer spots still appear now and then).
        const weight = Math.sqrt(totalWeight(pfrCombos) * totalWeight(callerCombos));
        spots.push({ pfr, caller, depth, open: pfr === 'SB' ? D.sbOpenSize : D.openSize, pfrCombos, callerCombos, weight });
      }
    }
    spotCache[key] = spots;
    return spots;
  }

  function pickWeighted(items, weightOf) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let x = rand() * total;
    for (const it of items) { x -= weightOf(it); if (x <= 0) return it; }
    return items[items.length - 1];
  }

  // ---------------------------------------------------------------- evaluator
  function straightHigh(mask) {
    if (mask & (1 << 14)) mask |= 1 << 1; // ace plays low
    for (let h = 14; h >= 5; h--) {
      const need = 0b11111 << (h - 4);
      if ((mask & need) === need) return h;
    }
    return 0;
  }
  function score(cat, ks) {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] || 0);
    return v;
  }
  const CAT_DIV = Math.pow(16, 5);
  const catOf = (v) => Math.floor(v / CAT_DIV);
  const CAT_NAMES = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  /** Evaluate the best 5-card hand from 5–7 card ids. Higher is better. */
  function evaluate(cards) {
    const rc = new Array(15).fill(0);
    const sc = [0, 0, 0, 0];
    let mask = 0;
    for (const c of cards) {
      const r = rOf(c);
      rc[r]++;
      sc[sOf(c)]++;
      mask |= 1 << r;
    }
    let flushRanks = null;
    for (let s = 0; s < 4; s++) {
      if (sc[s] >= 5) {
        const fr = cards.filter((c) => sOf(c) === s).map(rOf).sort((a, b) => b - a);
        let fm = 0;
        for (const r of fr) fm |= 1 << r;
        const sf = straightHigh(fm);
        if (sf) return score(8, [sf]);
        flushRanks = fr.slice(0, 5);
      }
    }
    const quads = [], trips = [], pairs = [], singles = [];
    for (let r = 14; r >= 2; r--) {
      if (rc[r] === 4) quads.push(r);
      else if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r);
      else if (rc[r] === 1) singles.push(r);
    }
    if (quads.length) {
      const kick = Math.max(trips[0] || 0, pairs[0] || 0, singles[0] || 0);
      return score(7, [quads[0], kick]);
    }
    if (trips.length && (trips.length > 1 || pairs.length)) {
      return score(6, [trips[0], Math.max(trips[1] || 0, pairs[0] || 0)]);
    }
    if (flushRanks) return score(5, flushRanks);
    const st = straightHigh(mask);
    if (st) return score(4, [st]);
    if (trips.length) return score(3, [trips[0], ...singles.slice(0, 2)]);
    if (pairs.length >= 2) {
      const kick = Math.max(pairs[2] || 0, singles[0] || 0);
      return score(2, [pairs[0], pairs[1], kick]);
    }
    if (pairs.length) return score(1, [pairs[0], ...singles.slice(0, 3)]);
    return score(0, singles.slice(0, 5));
  }

  /**
   * Count the two-card rank holdings (not pairing the board) that make a straight
   * or an 8-out straight draw (open-ended or double gutshot) on this flop.
   */
  function straightDrawCount(distinct) {
    const br = new Set(distinct);
    let draws = 0, made = 0;
    const examples = [];
    for (let r2 = 14; r2 >= 2; r2--) {
      for (let r1 = r2 - 1; r1 >= 2; r1--) {
        if (br.has(r1) || br.has(r2)) continue;
        let mask = 0;
        for (const r of [...br, r1, r2]) mask |= 1 << r;
        if (straightHigh(mask)) { made++; continue; }
        let outs = 0;
        for (let r = 2; r <= 14; r++) if (!(mask & (1 << r)) && straightHigh(mask | (1 << r))) outs++;
        if (outs >= 2) { draws++; if (examples.length < 3) examples.push(rankChar(r2) + rankChar(r1)); }
      }
    }
    return { draws, made, examples };
  }

  // ---------------------------------------------------------------- board texture
  function texture(board) {
    const ranks = board.map(rOf);
    const distinct = [...new Set(ranks)].sort((a, b) => b - a);
    const suitCounts = [0, 0, 0, 0];
    board.forEach((c) => suitCounts[sOf(c)]++);
    const maxSuit = Math.max(...suitCounts);
    const suitTexture = maxSuit === 3 ? 'monotone' : maxSuit === 2 ? 'two-tone' : 'rainbow';

    let straightPossible = false;
    if (distinct.length === 3) {
      for (let low = 1; low <= 10 && !straightPossible; low++) {
        straightPossible = distinct.every((r) => (r >= low && r <= low + 4) || (r === 14 && low === 1));
      }
    }
    // Two non-ace cards within two ranks of each other leave open-ended draws.
    let closePair = null;
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const a = distinct[i], b = distinct[j];
        if (a !== 14 && b !== 14 && a - b <= 2 && !closePair) closePair = [a, b];
      }
    }
    const connected = straightPossible || !!closePair;
    let connectLevel;
    if (straightPossible) connectLevel = 'straight-possible';
    else if (closePair) connectLevel = 'draws';
    else connectLevel = 'disconnected';

    const paired = distinct.length < 3;
    const flushDraws = suitTexture !== 'rainbow';
    // Dynamic score: how much the turn and river can change the best hand.
    const sd = straightDrawCount(distinct);
    const dynFactors = [];
    if (suitTexture === 'monotone') dynFactors.push({ pts: 2, why: 'monotone: flush draws are everywhere and any card of that suit changes who has the flush' });
    else if (suitTexture === 'two-tone') dynFactors.push({ pts: 1, why: 'two-tone, so flush draws exist' });
    if (sd.made) dynFactors.push({ pts: 2, why: 'straights are already possible and many turns add more straight draws' });
    else if (sd.draws >= 3) dynFactors.push({ pts: 2, why: `${sd.draws} different two-card holdings (like ${sd.examples.join(', ')}) make open-ended or double-gutshot straight draws` });
    else if (sd.draws >= 1) dynFactors.push({ pts: 1, why: `a few holdings (like ${sd.examples.join(', ')}) make strong straight draws` });
    if (distinct[0] <= 9) {
      const overs = (14 - distinct[0]) * 4;
      dynFactors.push({ pts: 1, why: `it is ${rankChar(distinct[0])}-high, so ${overs} of the 47 unseen cards are overcards that can change who is ahead` });
    }
    if (paired) dynFactors.push({ pts: -1, why: 'the paired card cuts the number of draws' });
    const dynScore = dynFactors.reduce((a, f) => a + f.pts, 0);
    const dynamic = dynScore >= 2;

    return {
      ranks, distinct, top: distinct[0], suitTexture, straightPossible, closePair,
      connected, connectLevel, paired, trips: distinct.length === 1, flushDraws, dynamic, dynScore, dynFactors,
    };
  }

  function describeBoard(board) {
    const t = texture(board);
    const bits = [];
    bits.push(t.top >= 12 ? 'high' : t.top >= 9 ? 'middling' : 'low');
    if (t.paired) bits.push('paired');
    bits.push(t.suitTexture);
    if (t.connectLevel === 'straight-possible') bits.push('connected');
    else if (t.connectLevel === 'draws') bits.push('semi-connected');
    else bits.push('disconnected');
    return bits.join(', ');
  }

  // ---------------------------------------------------------------- hand classification
  const TIERS = {
    premium: 'Premium / strong made hand',
    draw: 'High-equity draw',
    marginal: 'Marginal made hand',
    air: 'Junk / air',
  };

  function straightOuts(cards) {
    let mask = 0;
    for (const c of cards) mask |= 1 << rOf(c);
    if (straightHigh(mask)) return { outs: 0, open: false, ranks: [] };
    const ranks = [];
    for (let r = 2; r <= 14; r++) {
      if (mask & (1 << r)) continue;
      if (straightHigh(mask | (1 << r))) ranks.push(r);
    }
    let open = false;
    if (ranks.length >= 2) {
      // four consecutive ranks with both ends live
      let m = mask;
      if (m & (1 << 14)) m |= 2;
      for (let lo = 2; lo <= 10; lo++) {
        const need = 0b1111 << lo;
        if ((m & need) === need && lo - 1 >= 1 && lo + 4 <= 14) open = true;
      }
    }
    return { outs: ranks.length, open, ranks };
  }

  function flushDraw(hole, board) {
    const all = hole.concat(board);
    for (let s = 0; s < 4; s++) {
      const n = all.filter((c) => sOf(c) === s).length;
      const heroHas = hole.some((c) => sOf(c) === s);
      if (n === 4 && heroHas) {
        // Nut draw: hero holds the highest card of the suit that is not on the board.
        const boardSuit = new Set(board.filter((c) => sOf(c) === s).map(rOf));
        let best = 14;
        while (boardSuit.has(best)) best--;
        const nut = hole.some((c) => sOf(c) === s && rOf(c) === best);
        return { suit: s, nut };
      }
    }
    return null;
  }

  /**
   * Classify a hole-card combo on a flop into one of the four strength tiers.
   * Returns { tier, label, nutty, alsoAccept, reason }.
   */
  function classify(hole, board) {
    const all = hole.concat(board);
    const v = evaluate(all);
    const cat = catOf(v);
    const hr = hole.map(rOf).sort((a, b) => b - a);
    const t = texture(board);
    const bd = t.distinct;
    const boardCount = {};
    board.forEach((c) => (boardCount[rOf(c)] = (boardCount[rOf(c)] || 0) + 1));
    const pocket = hr[0] === hr[1];

    let made = null; // { tier, label, nutty }
    if (cat >= 4) {
      made = { tier: 'premium', label: CAT_NAMES[cat], nutty: true };
    } else if (cat === 3 && !t.trips) {
      made = pocket
        ? { tier: 'premium', label: 'Set of ' + RANK_PLURAL[hr[0]], nutty: true }
        : { tier: 'premium', label: 'Trips (' + RANK_PLURAL[t.distinct.find((r) => boardCount[r] === 2)] + ')', nutty: true };
    } else if (cat === 2 && !t.paired) {
      made = { tier: 'premium', label: 'Two pair (' + rankChar(hr[0]) + rankChar(hr[1]) + ')', nutty: true };
    } else if (pocket) {
      const p = hr[0];
      if (p > bd[0]) made = { tier: 'premium', label: 'Overpair (' + rankChar(p) + rankChar(p) + ')', nutty: false, reason: 'An overpair beats every one-pair hand on this board.' };
      else if (p < bd[bd.length - 1]) made = { tier: 'marginal', label: 'Underpair (' + rankChar(p) + rankChar(p) + ')', nutty: false, reason: 'A pocket pair below every board card has showdown value but loses to any pair.' };
      else made = { tier: 'marginal', label: 'Pocket pair below the top card (' + rankChar(p) + rankChar(p) + ')', nutty: false, reason: 'Plays like middle pair: beats bluffs, loses to any top pair.' };
    } else {
      const pairedRank = hr.find((r) => boardCount[r]);
      if (pairedRank && !(t.paired && boardCount[pairedRank] === 2)) {
        const kicker = hr[0] === pairedRank ? hr[1] : hr[0];
        const idx = bd.indexOf(pairedRank);
        if (idx === 0) {
          const good = kicker >= 11;
          made = good
            ? { tier: 'premium', label: 'Top pair, good kicker (' + rankChar(hr[0]) + rankChar(hr[1]) + ')', nutty: false, reason: 'Top pair with a J-or-better kicker is a strong value hand.' }
            : { tier: 'marginal', label: 'Top pair, weak kicker (' + rankChar(hr[0]) + rankChar(hr[1]) + ')', nutty: false, reason: 'Top pair with a kicker below a Jack is often out-kicked when big money goes in.' };
        } else if (idx === bd.length - 1 && bd.length === 3) {
          made = { tier: 'marginal', label: 'Bottom pair (' + RANK_PLURAL[pairedRank] + ')', nutty: false, reason: 'Bottom pair has some showdown value but is easily outdrawn and out-kicked.' };
        } else {
          made = { tier: 'marginal', label: 'Middle pair (' + RANK_PLURAL[pairedRank] + ')', nutty: false, reason: 'Middle pair beats bluffs and weak hands but loses to any top pair.' };
        }
      } else if (hr[0] === 14 && hr[1] >= 10) {
        made = { tier: 'marginal', label: 'Strong ace high (A' + rankChar(hr[1]) + ')', nutty: false, reason: 'Ace high with a big kicker often wins at showdown against missed draws.' };
      }
    }

    // draws
    let draw = null;
    if (cat < 4) {
      const fd = flushDraw(hole, board);
      const so = straightOuts(all);
      const sdName = so.outs >= 2 ? (so.open ? 'open-ended straight draw' : 'double-gutshot straight draw') : so.outs === 1 ? 'gutshot' : null;
      if (fd && so.outs >= 1) draw = { strong: true, label: 'Combo draw (' + (fd.nut ? 'nut ' : '') + 'flush draw + ' + sdName + ')' };
      else if (fd) draw = { strong: true, label: (fd.nut ? 'Nut flush draw' : 'Flush draw') };
      else if (so.outs >= 2) draw = { strong: true, label: sdName[0].toUpperCase() + sdName.slice(1) };
      else if (so.outs === 1) draw = { strong: false, label: 'Gutshot' };
    }

    let tier, label, alsoAccept = [], reason;
    if (made && made.tier === 'premium') {
      tier = 'premium';
      label = made.label + (draw && draw.strong ? ' + ' + draw.label.toLowerCase() : '');
      reason = made.reason || 'This hand is near the top of your range here. You want to get value from worse hands.';
    } else if (draw && draw.strong) {
      tier = 'draw';
      label = made ? made.label + ' + ' + draw.label.toLowerCase() : draw.label;
      if (made) {
        alsoAccept = ['marginal'];
        reason = 'You have a made hand plus a strong draw. The draw gives you lots of equity, so it is usually played like a high-equity draw. Calling it a marginal made hand also counts.';
      } else {
        reason = 'Roughly 8–15 outs, so about 32–55% equity by the river. Strong enough to bet or raise as a semi-bluff.';
      }
    } else if (made) {
      tier = 'marginal';
      label = made.label + (draw ? ' + gutshot' : '');
      reason = made.reason;
    } else {
      tier = 'air';
      const hi = hr[0];
      label = (draw ? 'Gutshot, ' : '') + RANK_NAME[hi] + ' high';
      if (t.paired && hr.some((r) => boardCount[r])) label = 'No real pair (board pair only), ' + RANK_NAME[hi].toLowerCase() + ' high';
      reason = draw
        ? 'A lone gutshot (4 outs, ~16% by the river) is a weak draw. Treat it as air with a little backup equity.'
        : 'No pair and no meaningful draw. This hand only wins by bluffing.';
    }
    return { tier, label, nutty: !!(made && made.nutty), alsoAccept, reason };
  }

  /**
   * Backdoor flush draw: exactly three cards of one suit on the flop, at least one of them
   * in the hand (needs that suit on both turn and river). level: 'nut' when the hand holds
   * the best missing card of the suit, 'second' for the next one, otherwise 'weak'.
   */
  function backdoorFlush(hole, board) {
    for (let s = 0; s < 4; s++) {
      const mine = hole.filter((c) => sOf(c) === s).map(rOf);
      const onBoard = board.filter((c) => sOf(c) === s).map(rOf);
      if (!mine.length || mine.length + onBoard.length !== 3) continue;
      const missing = [];
      for (let r = 14; r >= 2; r--) if (!onBoard.includes(r)) missing.push(r);
      const pos = missing.indexOf(Math.max(...mine));
      return { suit: s, rank: Math.max(...mine), level: pos === 0 ? 'nut' : pos === 1 ? 'second' : 'weak' };
    }
    return null;
  }

  const HAND_GROUPS = {
    strong: 'Strong made hands',
    draw: 'Strong draws',
    marginal: 'Marginal made hands',
    weakdraw: 'Weak draws (gutshots, backdoor flush draws)',
    air: 'Air (no pair, no draw)',
  };

  /** classify() plus backdoor flush draws, grouped for explaining solver strategies. */
  function handFeatures(hole, board) {
    const cls = classify(hole, board);
    const bd = backdoorFlush(hole, board);
    let group = { premium: 'strong', draw: 'draw', marginal: 'marginal', air: 'air' }[cls.tier];
    if (group === 'air' && (bd || /^Gutshot/.test(cls.label))) group = 'weakdraw';
    let label = cls.label;
    if (bd && group !== 'strong' && group !== 'draw') label += ` + ${bd.level === 'nut' ? 'nut' : bd.level === 'second' ? 'second-nut' : rankChar(bd.rank) + '-high'} backdoor flush draw`;
    return { tier: cls.tier, group, label, backdoor: bd };
  }

  // ---------------------------------------------------------------- range stats
  function rangeStats(combos, board) {
    const dead = new Set(board);
    const live = combos.filter((c) => !dead.has(c[0]) && !dead.has(c[1]));
    const t = texture(board);
    let topHits = 0, nutty = 0, total = 0;
    const tiers = { premium: 0, draw: 0, marginal: 0, air: 0 };
    const byTier = { premium: [], draw: [], marginal: [], air: [] };
    for (const h of live) {
      const w = h.w == null ? 1 : h.w;
      total += w;
      if (rOf(h[0]) === t.top || rOf(h[1]) === t.top) topHits += w;
      const cl = classify(h, board);
      if (cl.nutty) nutty += w;
      tiers[cl.tier] += w;
      byTier[cl.tier].push(h);
    }
    const n = total || 1;
    return {
      live, byTier,
      combos: total,
      topFrac: topHits / n,
      nuttyFrac: nutty / n,
      tierFrac: { premium: tiers.premium / n, draw: tiers.draw / n, marginal: tiers.marginal / n, air: tiers.air / n },
    };
  }

  /**
   * Nut advantage: pool both ranges (each weighted to the same total), take the
   * strongest 5% of made hands on this flop, and report how much of each range
   * lands in that band.
   */
  function nutStats(a, b, board, band) {
    band = band || 0.05;
    const rows = [];
    const wa = totalWeight(a), wb = totalWeight(b);
    for (const h of a) rows.push({ h, v: evaluate([h[0], h[1]].concat(board)), w: h.w / wa, side: 0 });
    for (const h of b) rows.push({ h, v: evaluate([h[0], h[1]].concat(board)), w: h.w / wb, side: 1 });
    rows.sort((x, y) => y.v - x.v);
    let acc = 0, threshold = rows[0].v, cutRow = rows[0];
    for (const r of rows) {
      acc += r.w;
      threshold = r.v; cutRow = r;
      if (acc >= band * 2) break;
    }
    let ia = 0, ib = 0;
    for (const r of rows) {
      if (r.v < threshold) break;
      if (r.side === 0) ia += r.w; else ib += r.w;
    }
    return { aFrac: ia, bFrac: ib, cutLabel: classify(cutRow.h, board).label };
  }

  /** Monte Carlo equity of range A vs range B on a flop (runs out turn + river). */
  function rangeEquity(a, b, board, iters) {
    iters = iters || 6000;
    const dead = new Set(board);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
    const sampler = (arr) => {
      const cum = new Float64Array(arr.length);
      let t = 0;
      for (let i = 0; i < arr.length; i++) { t += arr[i].w == null ? 1 : arr[i].w; cum[i] = t; }
      return () => {
        const x = rand() * t;
        let lo = 0, hi = arr.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
        return arr[lo];
      };
    };
    const drawA = sampler(a), drawB = sampler(b);
    let wins = 0, ties = 0, n = 0, guard = 0;
    const ca = new Array(7), cb = new Array(7);
    ca[2] = cb[2] = board[0]; ca[3] = cb[3] = board[1]; ca[4] = cb[4] = board[2];
    while (n < iters && guard < iters * 5) {
      guard++;
      const ha = drawA(), hb = drawB();
      if (ha[0] === hb[0] || ha[0] === hb[1] || ha[1] === hb[0] || ha[1] === hb[1]) continue;
      let t1, t2;
      do { t1 = deck[randInt(deck.length)]; } while (t1 === ha[0] || t1 === ha[1] || t1 === hb[0] || t1 === hb[1]);
      do { t2 = deck[randInt(deck.length)]; } while (t2 === t1 || t2 === ha[0] || t2 === ha[1] || t2 === hb[0] || t2 === hb[1]);
      ca[0] = ha[0]; ca[1] = ha[1]; ca[5] = t1; ca[6] = t2;
      cb[0] = hb[0]; cb[1] = hb[1]; cb[5] = t1; cb[6] = t2;
      const ea = evaluate(ca), eb = evaluate(cb);
      if (ea > eb) wins++;
      else if (ea === eb) ties++;
      n++;
    }
    return (wins + ties / 2) / (n || 1);
  }

  // ---------------------------------------------------------------- scenario
  const QUESTION_IDS = ['position', 'topCard', 'connected', 'dynamic', 'rangeAdv', 'nutAdv', 'handStrength'];

  const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';

  function potSize(spot) {
    const open = spot.open;
    let dead = 1; // BB ante
    if (spot.pfr !== 'SB' && spot.caller !== 'SB') dead += 0.5;
    if (spot.pfr !== 'BB' && spot.caller !== 'BB') dead += 1;
    return { open, pot: +(open * 2 + dead).toFixed(1) };
  }

  /**
   * Build a full drill scenario.
   * opts.role: 'any' | 'pfr' | 'caller'
   * opts.depth: '80' | '50' | '30' | '20' | 'any' (needs ranges-data.js)
   */
  function generateScenario(opts) {
    opts = opts || {};
    const role = opts.role && opts.role !== 'any' ? opts.role : pick(['pfr', 'caller']);
    const depths = availableDepths();
    const depth = opts.depth && opts.depth !== 'any' && depths.includes(String(opts.depth)) ? String(opts.depth) : (depths.length ? pick(depths) : null);
    const spot = pickWeighted(spotsFor(depth), (s) => s.weight);
    const deck = [];
    for (let c = 0; c < 52; c++) deck.push(c);
    for (let i = deck.length - 1; i > 0; i--) { const j = randInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const board = deck.slice(0, 3).sort((x, y) => rOf(y) - rOf(x));

    const pfrStats = rangeStats(spot.pfrCombos, board);
    const callerStats = rangeStats(spot.callerCombos, board);
    const heroStats = role === 'pfr' ? pfrStats : callerStats;
    const villStats = role === 'pfr' ? callerStats : pfrStats;

    // Pick hero's hand: choose a strength tier evenly so every category gets practice.
    const tiersAvail = Object.keys(heroStats.byTier).filter((k) => heroStats.byTier[k].length);
    const tier = opts.tier && heroStats.byTier[opts.tier] && heroStats.byTier[opts.tier].length ? opts.tier : pick(tiersAvail);
    const holeCombo = pickWeighted(heroStats.byTier[tier], (c) => c.w);
    const hole = [holeCombo[0], holeCombo[1]].sort((x, y) => rOf(y) - rOf(x) || sOf(x) - sOf(y));

    const heroPos = role === 'pfr' ? spot.pfr : spot.caller;
    const villPos = role === 'pfr' ? spot.caller : spot.pfr;
    const heroIP = POSTFLOP_ORDER.indexOf(heroPos) > POSTFLOP_ORDER.indexOf(villPos);

    const pfrEquity = rangeEquity(pfrStats.live, callerStats.live, board, opts.iters || 6000);
    const heroEquity = role === 'pfr' ? pfrEquity : 1 - pfrEquity;
    const nuts = nutStats(heroStats.live, villStats.live, board);

    const tex = texture(board);
    const hand = classify(hole, board);
    const { open, pot } = potSize(spot);

    const scenario = {
      spot, role, depth, rangeSource: depth ? 'charts' : 'built-in', heroPos, villPos, heroIP, board, hole, pot, open,
      texture: tex, hand, heroEquity,
      nutCut: nuts.cutLabel,
      hero: { topFrac: heroStats.topFrac, nuttyFrac: nuts.aFrac, tierFrac: heroStats.tierFrac, combos: heroStats.combos },
      villain: { topFrac: villStats.topFrac, nuttyFrac: nuts.bFrac, tierFrac: villStats.tierFrac, combos: villStats.combos },
    };
    scenario.questions = buildQuestions(scenario);
    scenario.plan = buildPlan(scenario);
    return scenario;
  }

  function compare(heroVal, villVal, ratioNeeded, minDiff) {
    const hi = Math.max(heroVal, villVal), lo = Math.min(heroVal, villVal);
    if (hi - lo < minDiff) return 'neutral';
    if (lo === 0 ? hi > 0 : hi / lo >= ratioNeeded) return heroVal > villVal ? 'me' : 'opp';
    return 'neutral';
  }

  const SIDE_OPTS = [
    { value: 'me', label: 'Me' },
    { value: 'opp', label: 'My opponent' },
    { value: 'neutral', label: 'Roughly even' },
  ];

  function buildQuestions(s) {
    const t = s.texture;
    const topName = RANK_NAME[t.top];
    const heroRoleName = s.role === 'pfr' ? 'the preflop raiser' : 'the preflop caller';
    const qs = [];

    // 1. Position
    qs.push({
      id: 'position',
      prompt: 'Am I in position or out of position?',
      options: [{ value: 'ip', label: 'In position' }, { value: 'oop', label: 'Out of position' }],
      answer: s.heroIP ? 'ip' : 'oop',
      explain: `Postflop the order is SB → BB → UTG → … → BTN. You are in the ${s.heroPos} and your opponent is in the ${s.villPos}, so you act ${s.heroIP ? 'last on every street. You are in position.' : 'first on every street. You are out of position.'}` +
        (s.heroPos === 'SB' ? ' Raising from the SB still leaves you out of position against the BB.' : ''),
    });

    // 2. Top card
    const topAns = compare(s.hero.topFrac, s.villain.topFrac, 1.2, 0.02);
    qs.push({
      id: 'topCard',
      prompt: `Who does the top card (${topName}) favor?`,
      options: SIDE_OPTS,
      answer: topAns,
      explain: `${pct(s.hero.topFrac)} of your range holds ${t.top === 14 || t.top === 8 ? 'an' : 'a'} ${topName.toLowerCase()} versus ${pct(s.villain.topFrac)} of your opponent's. ` +
        (t.top >= 12
          ? 'Big cards like A, K and Q usually favor the preflop raiser, whose range is full of broadways and big aces. A caller who 3-bets their best broadways has fewer of them.'
          : t.top <= 9
            ? 'Low and middle cards usually favor the caller, especially a wide BB defense full of suited connectors and gappers.'
            : 'Tens and jacks are in between. Both ranges hold plenty of them.') +
        (topAns === 'neutral' ? ' The gap is small here, so call it roughly even.' : ''),
    });

    // 3. Connected
    let connExplain;
    if (t.connectLevel === 'straight-possible') connExplain = 'All three ranks fit inside a five-card window, so straights are already possible with two hole cards.';
    else if (t.connectLevel === 'draws') connExplain = `The ${rankChar(t.closePair[0])} and ${rankChar(t.closePair[1])} are close together. Lots of hands have open-ended straight draws, even though no straight is possible yet.`;
    else connExplain = 'The cards are spread apart. No straight is possible, and open-ended straight draws need very specific holdings.';
    qs.push({
      id: 'connected',
      prompt: 'Is the board connected or disconnected?',
      options: [{ value: 'connected', label: 'Connected' }, { value: 'disconnected', label: 'Disconnected' }],
      answer: t.connected ? 'connected' : 'disconnected',
      explain: connExplain,
    });

    // 4. Static vs dynamic
    const plus = t.dynFactors.filter((f) => f.pts > 0).map((f) => f.why);
    const minus = t.dynFactors.filter((f) => f.pts < 0).map((f) => f.why);
    let dynExplain;
    if (t.dynamic) {
      dynExplain = `Dynamic: ${plus.join('; ')}. Many turn cards shift the equities, so protection and bet sizing matter more.`;
    } else {
      dynExplain = 'Static: ' + (plus.length ? `${plus.join('; ')}, but that is not enough to make it volatile` : 'rainbow and disconnected, with no real draws') +
        (minus.length ? `, and ${minus.join('; ')}` : '') + '. The best hand on the flop is usually still best on the river.';
    }
    dynExplain += ` (Texture score ${t.dynScore}: 2 or more counts as dynamic.)`;
    qs.push({
      id: 'dynamic',
      prompt: 'Is the board static or dynamic?',
      options: [{ value: 'static', label: 'Static' }, { value: 'dynamic', label: 'Dynamic' }],
      answer: t.dynamic ? 'dynamic' : 'static',
      explain: dynExplain,
    });

    // 5. Range advantage
    const eq = s.heroEquity;
    const raAns = eq >= 0.53 ? 'me' : eq <= 0.47 ? 'opp' : 'neutral';
    qs.push({
      id: 'rangeAdv',
      prompt: 'Who has the range advantage?',
      options: SIDE_OPTS,
      answer: raAns,
      explain: `Your whole range has about ${pct(eq)} equity against your opponent's whole range on this flop. ` +
        `Strong made hands (top pair good kicker, overpairs and better): you ${pct(s.hero.tierFrac.premium)} vs them ${pct(s.villain.tierFrac.premium)}. ` +
        (raAns === 'neutral' ? 'That is within 47–53%, so neither side has a real edge.' : raAns === 'me' ? 'Above 53% means the advantage is yours.' : 'Below 47% means your opponent has the advantage.') +
        ' Equities come from a quick simulation, so they can move a point or so between runs.',
    });

    // 6. Nut advantage
    const naAns = compare(s.hero.nuttyFrac, s.villain.nuttyFrac, 1.3, 0.015);
    qs.push({
      id: 'nutAdv',
      prompt: 'Who has the nut advantage?',
      options: SIDE_OPTS,
      answer: naAns,
      explain: `Take the strongest 5% of hands on this flop (here, roughly ${s.nutCut} or better). ${pct(s.hero.nuttyFrac)} of your range is in that group vs ${pct(s.villain.nuttyFrac)} of your opponent's. ` +
        (naAns === 'neutral'
          ? 'Those numbers are close, so neither side has many more nutted hands.'
          : (naAns === 'me' ? 'You' : 'Your opponent') + ' can make the strongest hands more often, which supports bigger bets and raises.') +
        (s.role === 'caller' && naAns === 'me' ? ' Callers often have the nut advantage on low, connected boards because they hold more sets and two pairs of low cards.' : '') +
        (s.role === 'pfr' && t.top >= 12 && naAns === 'me' ? ' The caller 3-bets the biggest pairs and broadways, so they are capped on high boards.' : ''),
    });

    // 7. Hand strength
    qs.push({
      id: 'handStrength',
      prompt: 'How strong is my hand?',
      options: Object.keys(TIERS).map((k) => ({ value: k, label: TIERS[k] })),
      answer: s.hand.tier,
      alsoAccept: s.hand.alsoAccept,
      explain: `You have: ${s.hand.label}. ${s.hand.reason}`,
      handLabel: s.hand.label,
    });

    return qs;
  }

  function buildPlan(s) {
    const q = Object.fromEntries(s.questions.map((x) => [x.id, x.answer]));
    const lines = [];
    const dyn = s.texture.dynamic;
    if (s.role === 'pfr') {
      if (q.rangeAdv === 'me' && !dyn) lines.push('You raised preflop and have the range advantage on a static board. This is a classic spot to c-bet small (25–33% pot) with most of your range.');
      else if (q.rangeAdv === 'me') lines.push('You have the range advantage, but the board is dynamic. C-bet less often and size up (50–75%) with value hands and strong draws so draws pay to see the turn.');
      else if (q.nutAdv === 'me') lines.push('Your range is not ahead overall, but you hold more of the nuts. Use a polarized strategy: bet big with strong hands and good draws, and check your medium hands.');
      else lines.push('This board does not favor you. Check more, especially out of position. When you do bet, use a bigger size and bet only strong hands and good draws.');
      if (!s.heroIP) lines.push('You are out of position, so check more than you would in position, and protect your checking range with some strong hands.');
    } else {
      if (s.heroIP) lines.push('Expect a c-bet. Call with marginal made hands and draws that can continue, and raise with nutted hands and your best draws. If the raiser checks, bet often, since checking usually means a weak range.');
      else lines.push('Check to the preflop raiser by default. ' + (q.nutAdv === 'me' ? 'You have the nut advantage, so this is a good board to check-raise with sets, two pair and combo draws.' : 'Mostly check-call your hands with showdown value. Check-raise only your strongest hands and draws.'));
    }
    const handLine = {
      premium: 'With a strong made hand, build the pot. Bet or raise for value, and on dynamic boards charge the draws.',
      draw: 'With a high-equity draw, play aggressively as a semi-bluff when you have fold equity. If the action gets heavy, calling is fine.',
      marginal: 'With a marginal hand, control the pot: check and call to get to showdown rather than inflating the pot.',
      air: 'With air, bluff only for a reason (range advantage, backdoor draws, good blockers). Otherwise give up cheaply.',
    }[s.hand.tier];
    lines.push(handLine);
    return lines;
  }

  function isCorrect(question, value) {
    return value === question.answer || (question.alsoAccept || []).includes(value);
  }

  const api = {
    RANKS, SUITS, RANGES, TIERS, QUESTION_IDS, POSTFLOP_ORDER, PREFLOP_ORDER,
    cardId, rOf, sOf, cardStr, parseCard, rankChar,
    parseRange, rangeCombos, evaluate, catOf, texture, describeBoard, classify,
    backdoorFlush, handFeatures, HAND_GROUPS,
    rangeStats, rangeEquity, nutStats, availableDepths, spotsFor, generateScenario, isCorrect, setSeed,
  };
  root.PFEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
