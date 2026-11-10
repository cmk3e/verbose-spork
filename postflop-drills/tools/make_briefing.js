/* Build a printable briefing (HTML + PDF) from a Markdown source in resources/src/.
 *
 * usage (from postflop-drills/):  node tools/make_briefing.js [name]
 *   default name: stack-size-briefing  ->  resources/stack-size-briefing.html / .pdf
 *
 * Handles the Markdown the briefings use: #/## headings, paragraphs, "- " bullets,
 * pipe tables and **bold**.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const name = process.argv[2] || 'stack-size-briefing';
const src = fs.readFileSync(path.join(ROOT, 'resources', 'src', name + '.md'), 'utf8');

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/([♥♦])/g, '<span class="red">$1</span>');

function toHTML(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let title = '';
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('# ')) { title = l.slice(2); out.push(`<h1>${inline(title)}</h1>`); i++; continue; }
    if (l.startsWith('## ')) { out.push(`<h2>${inline(l.slice(3))}</h2>`); i++; continue; }
    if (l.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      // keep short tables on one page; let long ones (like the cheat sheet) break between rows
      out.push(`<table${body.length <= 12 ? ' class="keep"' : ''}><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c, j) => `<td${j === 0 ? ' class="first"' : ''}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|- |\|)/.test(lines[i])) para.push(lines[i++]);
    const p = para.join(' ');
    const isFormula = /^\*\*[^*]+\*\*$/.test(p) && /=/.test(p);
    out.push(isFormula ? `<p class="formula">${inline(p.replace(/\*\*/g, ''))}</p>` : `<p>${inline(p)}</p>`);
  }
  return { title, body: out.join('\n') };
}

const CSS = `
@page { size: Letter; margin: 0.55in 0.6in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Public Sans", "Helvetica Neue", Arial, sans-serif; color: #15211b; font-size: 9.6pt; line-height: 1.42; }
h1 { font-size: 21pt; line-height: 1.15; margin: 0 0 6px; }
h1 + p { color: #5a6a61; font-size: 9.6pt; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1.5px solid #15211b; }
h2 { font-size: 13pt; margin: 18px 0 6px; padding-top: 4px; break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 7px; }
ul { margin: 0 0 8px; padding-left: 18px; }
li { margin: 0 0 3px; }
b { font-weight: 700; }
.red { color: #c4302b; }
.formula { font-size: 10.5pt; background: #f1f4f2; border-left: 3px solid #1d5640; padding: 6px 10px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; font-size: 8.4pt; line-height: 1.32; break-inside: auto; }
tr { break-inside: avoid; page-break-inside: avoid; }
table.keep { break-inside: avoid; page-break-inside: avoid; }
th { text-align: left; font-size: 7.6pt; text-transform: uppercase; letter-spacing: .04em; color: #5a6a61; border-bottom: 1.5px solid #15211b; padding: 4px 5px; vertical-align: bottom; }
td { padding: 4px 5px; border-bottom: .5px solid #d3dbd6; vertical-align: top; }
td.first { font-weight: 600; }
tbody tr:nth-child(even) td { background: #f4f6f5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

(async () => {
  const { title, body } = toHTML(src);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
  const htmlPath = path.join(ROOT, 'resources', name + '.html');
  fs.writeFileSync(htmlPath, html);
  console.log('wrote', htmlPath);
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.log('playwright not found: open the HTML and print to PDF'); return; }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath);
  const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
  await page.pdf({
    path: pdfPath, format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font-size:7px;color:#888;padding:0 0.6in;display:flex;justify-content:space-between"><span>Postflop Framework Drills · ${esc(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
  await browser.close();
  console.log('wrote', pdfPath);
})();
