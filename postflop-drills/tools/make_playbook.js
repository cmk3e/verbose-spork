/* One-page strategy playbook for the Wildhorse Fall Poker Round Up main event (Nov 14-15, 2026).
 *
 * usage (from postflop-drills/):  node tools/make_playbook.js
 * writes resources/roundup-main-playbook.html and .pdf
 *
 * Event facts from public listings (CardPlayer, Wildhorse's 2026 fall packet as quoted by search):
 * $550 main, 2 days, 25,000 chips + 5,000 dealer-appreciation add-on = 30,000, 60-minute levels, late reg through level 6, one re-entry
 * before level 4, Day 1 plays to the money bubble, Day 2 restarts 11am Nov 15.
 * The blind schedule is Wildhorse's posted Round Up structure (spring 2026 sheet); the
 * fall sheet could not be fetched, so the page says to confirm it at the desk.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources');

const STACK = 30000;
const LEVELS = [
  [1, 100, 200, 200], [2, 150, 300, 300], [3, 200, 400, 400], [4, 300, 600, 600], [5, 400, 800, 800],
  [6, 500, 1000, 1000], [7, 600, 1200, 1200], [8, 800, 1600, 1600], [9, 1000, 2000, 2000], [10, 1500, 3000, 3000],
];
const phase = (bb) => (bb >= 60 ? ['Deep', '80bb charts'] : bb >= 35 ? ['Middle', '50bb charts'] : bb >= 22 ? ['Re-jam zone', '30bb charts'] : bb >= 15 ? ['Short', '20bb charts'] : ['Push/fold', '12bb charts']);
const k = (n) => (n >= 1000 ? (n / 1000).toString().replace(/\.0$/, '') + 'k' : String(n));
const note = {
  1: 'Deep: see flops with pairs and suited connectors',
  3: 'Break after level 3',
  4: 'Re-entry closes at the start of level 4',
  6: 'Late reg closes · break after level 6',
  9: 'Dinner break after level 9 (1h 15m)',
  10: 'Bubble pressure builds; Day 1 ends when it bursts',
};
const rows = LEVELS.map(([l, sb, bb, a]) => {
  const d = STACK / bb;
  const [p, c] = phase(d);
  return `<tr class="p-${p.split(' ')[0].replace('/', '').toLowerCase()}"><td>${l}</td><td>${k(sb)}/${k(bb)} <span class="m">(${k(a)})</span></td><td class="n"><b>${Math.round(d)}bb</b></td><td>${p} · ${c}</td><td class="m">${note[l] || ''}</td></tr>`;
}).join('');

const CSS = `
@page { size: Letter; margin: 0.35in 0.4in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Public Sans", "Helvetica Neue", Arial, sans-serif; color: #15211b; font-size: 7.9pt; line-height: 1.33; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 16pt; margin: 0; }
h2 { font-size: 9.6pt; margin: 6px 0 3px; color: #1d5640; text-transform: uppercase; letter-spacing: .04em; }
.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1d5640; padding-bottom: 3px; margin-bottom: 5px; }
.facts { font-size: 7.6pt; color: #3b4a42; text-align: right; }
.grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 2.2px 4px; border-bottom: 1px solid #d3dbd6; vertical-align: top; }
thead th { font-size: 6.6pt; text-transform: uppercase; letter-spacing: .05em; color: #5a6a61; border-bottom: 2px solid #15211b; }
.n { text-align: right; } .m { color: #5a6a61; font-size: 7pt; }
tr.p-deep td:first-child { box-shadow: inset 4px 0 #2f8a46; }
tr.p-middle td:first-child { box-shadow: inset 4px 0 #8fbf5a; }
tr.p-re-jam td:first-child { box-shadow: inset 4px 0 #e0a43a; }
tr.p-short td:first-child { box-shadow: inset 4px 0 #e5483f; }
tr.p-pushfold td:first-child { box-shadow: inset 4px 0 #8f1f1a; }
ul { margin: 0 0 3px; padding-left: 13px; } li { margin-bottom: 1.6px; }
.box { background: #f4f6f5; border-radius: 6px; padding: 4px 8px 3px; margin-bottom: 5px; }
.hot { background: #fbefe9; }
.src { font-size: 6.4pt; color: #7a8780; margin-top: 4px; }
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Round Up main event playbook</title><style>${CSS}</style></head><body>
<div class="top">
  <div><h1>Main Event Playbook · Fall Poker Round Up</h1><div class="m">Wildhorse Resort &amp; Casino, Pendleton · $550 NLH · Day 1 Sat Nov 14 · Day 2 Sun Nov 15, 11am</div></div>
  <div class="facts">30k chips (25k + 5k dealer add-on) · 60-min levels<br>Late reg through level 6 · one re-entry before level 4<br>Day 1 plays to the money bubble: everyone who bags is paid</div>
</div>
<div class="grid">
<div>
  <h2>Your stack by level (if you hold 30k)</h2>
  <table><thead><tr><th>Lvl</th><th>Blinds (BB ante)</th><th>Stack</th><th>Phase · use</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="m" style="margin:2px 0 0">Blinds from Wildhorse's posted Round Up structure; confirm the fall sheet at the desk. Always count your stack in big blinds against the <b>effective</b> stack.</p>

  <h2>Preflop by depth</h2>
  <table><thead><tr><th>Stack</th><th>Open</th><th>3-bet</th><th>Key adjustment</th></tr></thead><tbody>
    <tr><td><b>60bb+</b></td><td>2.3bb (+1 per limper; live, iso 4–5bb)</td><td>3× IP, 4× OOP</td><td>Call opens with small pairs and suited connectors in position: implied odds are big</td></tr>
    <tr><td><b>35–60</b></td><td>2.2bb</td><td>6.6 IP / 8.8 OOP</td><td>Small pairs and 65s–87s mostly fold to opens; offsuit broadways and suited aces in</td></tr>
    <tr><td><b>22–35</b></td><td>2.3bb</td><td>Often all in</td><td>Re-jam over late opens (66, ATo, A5s vs BTN); don't open hands you'd fold to a jam</td></tr>
    <tr><td><b>15–22</b></td><td>2bb or jam</td><td>All in</td><td>Raise-or-fold; calling a 3-bet is rarely right</td></tr>
    <tr><td><b>&lt;15</b></td><td>Jam / min-raise</td><td>All in</td><td>12bb push/fold charts; SB limp-or-jam</td></tr>
  </tbody></table>

  <div class="box hot"><h2 style="margin-top:2px">Late Day 1: the bubble</h2><ul>
    <li><b>Big stack:</b> open and 3-bet medium stacks relentlessly; they can't call without a big hand.</li>
    <li><b>Medium stack:</b> fold marginal calls (AJo/KQo vs a jam); attack shorter stacks, avoid the big stack on your left.</li>
    <li><b>Short stack:</b> jam rather than min-raise; prefer jams with an ace (it blocks calls).</li>
    <li>Calling a jam on the bubble needs about 10–15% more equity than normal. Shoving still works.</li>
    <li>Bagging any stack = cashing. A min-cash beats busting on a 55/45 flip, so take the low-variance line.</li>
  </ul></div>
</div>

<div>
  <h2>Postflop (from the solved spots)</h2>
  <div class="box"><ul>
    <li><b>C-bet small (⅓) a lot</b> on A/K-high dry boards when you opened: your range is far ahead.</li>
    <li><b>Check more</b> on low, connected boards (7-6-5, 6-4-3) vs the big blind: they hold the straights and two pairs.</li>
    <li><b>Bet big (¾)</b> only with a polar range: sets and top pair+, plus draws and no-showdown hands like QJ on 8-7-4.</li>
    <li><b>Check-raise small bets, call big ones.</b> BB check-raises about 20% vs ⅓ pot, 9% vs ¾ pot.</li>
    <li><b>Out of position raise draws; in position call them.</b> Middle pairs and weak top pair: call, don't raise.</li>
    <li><b>Shallow (20–30bb):</b> top pair, good kicker is a raise-or-get-it-in hand. In 3-bet pots (SPR 2–3) get it in on the flop.</li>
    <li><b>Turn:</b> raise less; turn raises are mostly two pair or better.</li>
  </ul></div>

  <h2>Live-field adjustments</h2>
  <div class="box"><ul>
    <li><b>Iso limpers bigger</b> (4–5bb +1 per limper) with strong hands; play pots in position.</li>
    <li><b>Value bet thinner.</b> Recreational players call too much: bet top pair for three streets, size up with nuts.</li>
    <li><b>Bluff less vs stations,</b> more vs tight regulars. Multiway: c-bet only with real hands or strong draws.</li>
    <li><b>Respect big turn/river raises</b> from passive players: they under-bluff. Fold one-pair hands.</li>
    <li>Note who limps, who 3-bets light, who folds to c-bets, and who is short; adjust ranges accordingly.</li>
  </ul></div>

  <h2>Game plan</h2>
  <div class="box"><ul>
    <li><b>Register by level 3</b> to play 75–150bb deep, your biggest edge with 60-minute levels. Entering at level 7 is 25bb. Take the dealer add-on: 5k chips is 20% more stack.</li>
    <li><b>Re-entry:</b> only before level 4. If you bust early, re-enter; you still start with 75bb or more.</li>
    <li><b>Levels 1–4:</b> low-risk, see flops, value-bet weak players. Avoid stacking off with one pair deep (SPR &gt; 5).</li>
    <li><b>Levels 5–8:</b> stacks drop to about 20–40bb; steal and re-jam. Antes make every orbit costly: 1.5bb + 1bb ante.</li>
    <li><b>Levels 9+:</b> push/fold and bubble rules. Bag chips; Day 2 restarts at 11am.</li>
    <li>Eat at the dinner break, hydrate, and review a few hands each break: what did they show down?</li>
  </ul></div>
  <p class="src">Sources: CardPlayer (2026 Fall Poker Round Up, Nov 5–15, $550 main, $6,000 added); Wildhorse 2026 fall packet (2-day main, 60-min rounds, late reg through round 6, re-entry before round 4, plays to the money bubble, restart 11am 11/15). Strategy: your charts and the site's solved spots. Confirm all details at the tournament desk.</p>
</div>
</div>
</body></html>`;

(async () => {
  const file = path.join(OUT, 'roundup-main-playbook.html');
  fs.writeFileSync(file, html);
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + file);
  await page.pdf({ path: file.replace(/\.html$/, '.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log('wrote', file);
})();
