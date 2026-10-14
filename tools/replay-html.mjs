// The match analysis as a web page, written by tools/replay.mjs next to the
// text report. Fully self-contained: the Pokémon sprites are embedded, so the
// file can be opened anywhere, offline too.
//
// `summary` is optional hand-written HTML (--summary=file.html) shown at the
// top: the takeaways in words.

import { readFileSync } from 'node:fs';
import { COLS, HALF } from '../src/combat.js';

const ROOT = new URL('../', import.meta.url);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const num = (n) => Math.round(n).toLocaleString('en-US');
// The game's level marks: ★ bronze, ★★ silver, ★★★ gold, ✦ shiny.
const mark = (star) => (star >= 3 ? '<span class="lv s3">✦</span>' : `<span class="lv s${star}">${'★'.repeat(star + 1)}</span>`);

export function replayReport({ log, rounds, totals, catalog, winner, finalHp, summary = '' }) {
  const N = log.names;
  const me = Math.max(0, N.indexOf(log.viewer)); // shown at the bottom of each board
  const them = 1 - me;
  const name = (id) => catalog[id]?.name ?? id;
  // Each sprite sheet once, as a CSS class with the image embedded.
  const used = new Set([...rounds.flatMap((r) => r.boards.flat().map((u) => u.unitId)), ...totals.flatMap((t) => Object.keys(t))]);
  const spriteCss = [...used].filter((id) => catalog[id]?.sprite).map((id) => {
    let data = '';
    try { data = readFileSync(new URL(catalog[id].sprite, ROOT)).toString('base64'); } catch {}
    return data ? `.sp-${id} { background-image: url(data:image/png;base64,${data}); }` : '';
  }).join('\n');

  // HP after each round, for the chart.
  const hp = [[100, 100]];
  for (const r of rounds) hp.push(r.hpBefore.map((h, i) => Math.max(0, h - r.damage[i])));

  const W = 640, H = 220, padL = 34, padR = 12, padT = 12, padB = 26;
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, hp.length - 1);
  const y = (v) => padT + ((100 - v) * (H - padT - padB)) / 100;
  const line = (p) => hp.map((h, i) => `${x(i).toFixed(1)},${y(h[p]).toFixed(1)}`).join(' ');
  const chart = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Player HP after each round">
    ${[0, 25, 50, 75, 100].map((v) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${hp.map((_, i) => `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${i ? `R${i}` : 'Start'}</text>`).join('')}
    <polyline class="hp p${me}" points="${line(me)}"/><polyline class="hp p${them}" points="${line(them)}"/>
    ${hp.map((h, i) => [me, them].map((p) => `<circle class="dot p${p}" cx="${x(i)}" cy="${y(h[p])}" r="3.5"><title>${esc(N[p])}: ${h[p]} HP</title></circle>`).join('')).join('')}
  </svg>`;

  // A fight's board as the game shows it: the viewer's side at the bottom.
  function arena(boards, highlight = null) {
    const cells = Array.from({ length: HALF * 2 }, () => Array(COLS).fill(null));
    boards.forEach((board, side) => {
      for (const u of board) {
        const row = side === me ? HALF + u.y : HALF - 1 - u.y;
        const col = side === me ? u.x : COLS - 1 - u.x;
        cells[row][col] = { ...u, side };
      }
    });
    return `<div class="arena">${cells.map((row, r) => row.map((c) => {
      const cls = `cell ${r < HALF ? 'foe' : 'own'}${c && highlight === c.side ? ' moved' : ''}`;
      if (!c) return `<div class="${cls}"></div>`;
      return `<div class="${cls}" data-type="${catalog[c.unitId]?.type ?? ''}" title="${esc(`${N[c.side]}: ${name(c.unitId)}`)}">
        <span class="spr sp-${c.unitId}"></span>${mark(c.star)}</div>`;
    }).join('')).join('')}</div>`;
  }

  const roundCards = rounds.map((r) => {
    const w = r.winner;
    const top = [...r.fight.units].sort((a, b) => b.dmg - a.dmg)[0];
    const result = w === null ? 'Draw' : `${esc(N[w])} won`;
    const better = r.better && r.better.winChance > 0.5 ? r.better : null;
    const luck = r.luck === null ? '' : r.luck < 0.5 ? `<span class="tag warn">Lucky win: ${pct(r.luck)} with other rolls</span>` : r.luck < 0.7 ? `<span class="tag">Close: ${pct(r.luck)} with other rolls</span>` : `<span class="tag ok">Decided by the boards: ${pct(r.luck)}</span>`;
    return `<article class="round ${w === me ? 'win' : w === them ? 'loss' : ''}">
      <header><h3>Round ${r.round}</h3><span class="res">${result}</span>
        <span class="meta">${(r.ticks / 10).toFixed(1)}s · ${esc(N[me])} −${r.damage[me]} HP · ${esc(N[them])} −${r.damage[them]} HP</span></header>
      <div class="round-body">
        <figure>${arena(r.boards)}<figcaption>${esc(N[them])} on top, ${esc(N[me])} below. Front rows meet in the middle.</figcaption></figure>
        <div class="round-notes">
          ${luck}
          ${top ? `<p><b>Top damage:</b> ${esc(name(top.unitId))} ${mark(top.star)} (${esc(N[top.side])}) <span class="num">${num(top.dmg)}</span></p>` : ''}
          ${better ? `<p><b>${esc(N[better.player])} could have won ${pct(better.winChance)} of the time</b> with the same Pokémon placed like this:</p>
            <figure>${arena(better.player === 0 ? [better.layout, r.boards[1]] : [r.boards[0], better.layout], better.player)}<figcaption>Suggested layout (highlighted side).</figcaption></figure>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');

  const pokeTable = (p) => {
    const rows = Object.entries(totals[p]).sort((a, b) => b[1].dmg - a[1].dmg);
    return `<div class="panel"><h3>${esc(N[p])}</h3><div class="scroll"><table>
      <tr><th>Pokémon</th><th>Fights</th><th>Max</th><th>Damage / fight</th><th>Taken</th><th>KOs</th><th>Survived</th></tr>
      ${rows.map(([id, t]) => `<tr><td><span class="mini sp-${id}"></span>${esc(name(id))}</td><td class="num">${t.fights}</td><td>${mark(t.maxStar)}</td><td class="num">${num(t.dmg / t.fights)}</td><td class="num">${num(t.taken)}</td><td class="num">${t.kills}</td><td class="num">${t.survived}/${t.fights}</td></tr>`).join('')}
    </table></div></div>`;
  };

  const won = [0, 1].map((p) => rounds.filter((r) => r.winner === p).length);
  const title = `${N[0]} vs ${N[1]}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Match Analysis</title>
<style>
:root { --bg: #0e1220; --panel: #161b2c; --panel-2: #1e2438; --line: #2a3150; --ink: #eef1fb; --ink-2: #c9cfe6; --muted: #8e97b7; --gold: #ffc93c; --good: #3ddc84; --bad: #ff5a6e; --p${me}: #4f9dff; --p${them}: #ff5a6e;
  --warrior: #e08a45; --ranger: #57b85c; --mage: #7a86ff; --rogue: #b26ae0; --cleric: #e8c14e; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg: #f3f5fa; --panel: #fff; --panel-2: #eaeef6; --line: #d9dfec; --ink: #131a2e; --ink-2: #39415e; --muted: #6b7596; --gold: #9a6a00; color-scheme: light; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.page { max-width: 980px; margin: 0 auto; padding: 28px 16px 60px; display: grid; gap: 26px; }
h1 { margin: 0; font-size: 30px; } h2 { margin: 0 0 10px; font-size: 20px; } h3 { margin: 0; font-size: 17px; }
.eyebrow { font: 600 12px ui-monospace, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--gold); }
.muted { color: var(--muted); } .num { font-variant-numeric: tabular-nums; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.tile b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
.summary { border-left: 4px solid var(--gold); } .summary h2 { margin-top: 0; } .summary :is(ul, ol) { margin: 6px 0; padding-left: 20px; } .summary li { margin: 4px 0; }
.chart { width: 100%; height: auto; display: block; }
.chart .grid { stroke: var(--line); } .chart .axis { fill: var(--muted); font-size: 11px; }
.chart .hp { fill: none; stroke-width: 3; stroke-linejoin: round; } .chart .dot { stroke: var(--panel); stroke-width: 1.5; }
.p0 { stroke: var(--p0); fill: var(--p0); } .p1 { stroke: var(--p1); fill: var(--p1); } .chart .hp.p0, .chart .hp.p1 { fill: none; }
.legend { display: flex; gap: 16px; font-size: 14px; } .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.rounds { display: grid; gap: 14px; }
.round { background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.round.win { border-left-color: var(--p${me}); } .round.loss { border-left-color: var(--p${them}); }
.round header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 10px; }
.round .res { font-weight: 800; } .round.win .res { color: var(--p${me}); } .round.loss .res { color: var(--p${them}); }
.round .meta { color: var(--muted); font-size: 13px; margin-left: auto; }
.round-body { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; align-items: start; }
.round-notes { display: grid; gap: 8px; } .round-notes p { margin: 0; } .round-notes figure { max-width: 240px; }
figure { margin: 0; } figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
.arena { display: grid; grid-template-columns: repeat(${COLS}, 1fr); gap: 2px; padding: 4px; border-radius: 10px; background: var(--panel-2); }
.cell { position: relative; aspect-ratio: 1; border-radius: 5px; background: color-mix(in srgb, var(--p${me}) 8%, transparent); }
.cell.foe { background: color-mix(in srgb, var(--p${them}) 8%, transparent); }
.cell[data-type] { background: color-mix(in srgb, var(--type) 26%, var(--panel)); }
.cell.moved[data-type] { outline: 2px solid var(--good); outline-offset: -2px; }
[data-type="warrior"] { --type: var(--warrior); } [data-type="ranger"] { --type: var(--ranger); } [data-type="mage"] { --type: var(--mage); } [data-type="rogue"] { --type: var(--rogue); } [data-type="cleric"] { --type: var(--cleric); }
.spr, .mini { display: block; background-size: 400% 400%; background-position: 0 0; image-rendering: pixelated; }
.spr { position: absolute; inset: 4%; }
.mini { display: inline-block; width: 28px; height: 28px; vertical-align: middle; margin-right: 6px; }
.cell .lv { position: absolute; left: 0; right: 0; top: -2px; text-align: center; font-size: 9px; line-height: 1; letter-spacing: -1px; text-shadow: 0 1px 1px #000; }
.lv.s0 { color: #e3a46a; } .lv.s1 { color: #dfe4f2; } .lv.s2 { color: #ffc93c; }
.lv.s3 { background: linear-gradient(110deg, #ff5f6d, #ffb347, #ffe66d, #6dffa0, #5fd3ff, #8f7bff); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; font-size: 1.25em; }
.cell .lv.s3 { font-size: 12px; }
.tag { display: inline-block; justify-self: start; padding: 2px 10px; border-radius: 99px; font-size: 13px; font-weight: 700; background: var(--panel-2); border: 1px solid var(--line); }
.tag.ok { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, var(--line)); }
.tag.warn { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 40%, var(--line)); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }
table { border-collapse: collapse; width: 100%; } th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; } th { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.scroll { overflow-x: auto; }
${spriteCss}
@media (max-width: 640px) { .round-body { grid-template-columns: 1fr; } .round-body > figure { max-width: 260px; } .cols { grid-template-columns: 1fr; } .round .meta { margin-left: 0; } }
</style></head><body><div class="page">
<header><div class="eyebrow">Match analysis · build ${esc(log.build)} · ${rounds.length} rounds</div><h1>${esc(title)}</h1>
<p class="muted">${winner === null ? 'Draw.' : `<b style="color:var(--p${winner})">${esc(N[winner])}</b> won the match.`} Final HP ${finalHp[me]} – ${finalHp[them]} (${esc(N[me])} – ${esc(N[them])}).</p></header>
<section class="tiles">
  <div class="panel tile"><b>${won[me]} – ${won[them]}</b>rounds won (${esc(N[me])} – ${esc(N[them])})</div>
  <div class="panel tile"><b>${rounds.filter((r) => r.luck !== null && r.luck < 0.7).length}</b>rounds close or decided by luck</div>
  <div class="panel tile"><b>${rounds.filter((r) => r.better && r.better.winChance > 0.5).length}</b>rounds the loser could have won by placing differently</div>
</section>
${summary ? `<section class="panel summary">${summary}</section>` : ''}
<section class="panel"><h2>HP over the match</h2>
  <div class="legend"><span><i style="background:var(--p${me})"></i>${esc(N[me])}</span><span><i style="background:var(--p${them})"></i>${esc(N[them])}</span></div>
  ${chart}</section>
<section><h2>Round by round</h2><p class="muted">"Decided by the boards" means the same two boards were re-fought with other random rolls (crits, turn order) and the winner still won that share of them.</p>
  <div class="rounds">${roundCards}</div></section>
<section><h2>Pokémon over the match</h2><p class="muted">Summoned Pokémon (like Combee) count toward the Pokémon that summoned them.</p><div class="cols">${pokeTable(me)}${pokeTable(them)}</div></section>
</div></body></html>`;
}
