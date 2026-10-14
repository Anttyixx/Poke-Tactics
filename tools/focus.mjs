// Everything about one Pokémon: full games where one team always has it.
//   node tools/focus.mjs <pokemon> [--games=4000] [--smart]
// writes tools/out/focus-<id>.json and tools/out/focus-<id>.html
//
// Half the games play normally (the bot, or --smart repositioning, decides
// where it stands): win rate, stats by star, best and worst opponents and
// teammates, who knocks it out. In the other half it's put on a random square
// of its half before every fight, to map which squares suit it best.
// Its teammates and the opposing team are random (the opponent never has it).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runJobs } from './balance.mjs';
import { hashSeed } from '../src/rng.js';
import { COLS, HALF } from '../src/combat.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const troops = Object.keys(catalog).filter((id) => !catalog[id].summon && !catalog[id].disabled);
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const key = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
const focus = troops.find((id) => key(id) === key(args.find((a) => !a.startsWith('--')) ?? '') || key(catalog[id].name) === key(args.find((a) => !a.startsWith('--')) ?? ''));
if (!focus) { console.error(`Usage: node tools/focus.mjs <pokemon> [--games=4000] [--smart]\nPokémon: ${troops.join(', ')}`); process.exit(1); }
const games = Number(flags.games ?? 4000);
const place = flags.smart ? 'smart' : 'default';
const name = (id) => catalog[id].name;

// ---- jobs ----
const others = troops.filter((t) => t !== focus);
const pick = (seed, salt, from, n) => [...from].map((t, k) => [hashSeed(`${seed}-${salt}-${t}-${k}`), t]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
const jobs = Array.from({ length: games }, (_, i) => {
  const seed = hashSeed(`focus-${focus}-${i}`);
  const mine = [focus, ...pick(seed, 'mate', others, 5)];
  const theirs = pick(seed, 'foe', others, 6);
  const side = i % 2; // which side of the board the focus team plays
  const explore = i % 4 >= 2; // half the games: random square every fight
  return {
    kind: 'focus', seed, focusSide: side, explored: explore,
    teams: side === 0 ? [mine, theirs] : [theirs, mine],
    placement: [place, place],
    explore: explore ? { player: side, unitId: focus } : undefined,
  };
});

const t0 = Date.now();
const results = await runJobs(jobs);
const secs = (Date.now() - t0) / 1000;

// ---- analysis ----
const ratio = (w, n) => (n ? w / n : null);
const ci = (p, n) => (n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0);
const natural = results.filter((g) => !g.explored && g.winner !== null);
const explored = results.filter((g) => g.explored);
const won = (g) => g.winner === g.focusSide;

const overall = { games: natural.length, wins: natural.filter(won).length };
overall.winRate = ratio(overall.wins, overall.games);
overall.margin = ci(overall.winRate, overall.games);

// Fight-level stats for the focus Pokémon.
function fightRows(list) {
  const rows = [];
  for (const g of list) for (const f of g.fights) {
    const me = f.units.find((u) => u.side === g.focusSide && u.unitId === focus);
    if (me) rows.push({ g, f, me, win: f.winner === g.focusSide });
  }
  return rows;
}
const nat = fightRows(natural);
const agg = (rows) => {
  const n = rows.length;
  if (!n) return null;
  const sum = (k) => rows.reduce((s, r) => s + r.me[k], 0);
  return {
    fights: n, fightWinRate: rows.filter((r) => r.win).length / n,
    dmg: sum('dmg') / n, taken: sum('taken') / n, kills: sum('kills') / n, casts: sum('casts') / n,
    attacks: sum('attacks') / n, boosts: sum('boosts') / n, boosted: sum('boosted') / n, healed: sum('healed') / n, healOffered: sum('healOffered') / n, healHits: sum('healHits') / n,
    survival: rows.filter((r) => r.me.survived).length / n,
  };
};
const stats = agg(nat);
const byStar = [0, 1, 2, 3].map((star) => ({ star, ...agg(nat.filter((r) => r.me.star === star)) })).filter((s) => s.fights);

// Squares: where it does best (random placement) and where it usually stands.
const grid = (rows, fn) => Array.from({ length: HALF }, (_, y) => Array.from({ length: COLS }, (_, x) => fn(rows.filter((r) => r.me.x === x && r.me.y === y))));
const exp = fightRows(explored);
const squares = grid(exp, (rows) => agg(rows));
const usual = grid(nat, (rows) => rows.length / Math.max(1, nat.length));
const rowsSummary = Array.from({ length: HALF }, (_, y) => ({ row: y, ...agg(exp.filter((r) => r.me.y === y)) }));
const edge = (x) => (x === 0 || x === COLS - 1 ? 'edge' : x === (COLS - 1) / 2 ? 'centre' : 'inner');
const colsSummary = ['edge', 'inner', 'centre'].map((c) => ({ col: c, ...agg(exp.filter((r) => edge(r.me.x) === c)) }));

// Opponents and teammates (game win rate with each present).
const withEach = (list, which) => others.map((id) => {
  const gs = list.filter((g) => g.teams[which(g)].includes(id));
  const w = gs.filter(won).length;
  return { id, name: name(id), games: gs.length, winRate: ratio(w, gs.length), margin: ci(ratio(w, gs.length) ?? 0, gs.length) };
}).filter((r) => r.games).sort((a, b) => a.winRate - b.winRate);
const opponents = withEach(natural, (g) => 1 - g.focusSide); // worst for it first
const teammates = withEach(natural, (g) => g.focusSide).reverse(); // best first

// Who knocks it out, and who it knocks out (per fight that Pokémon was in).
const koBy = {}, kos = {};
for (const r of nat) {
  const foes = new Set(r.f.units.filter((u) => u.side !== r.g.focusSide).map((u) => u.unitId));
  for (const id of foes) { (koBy[id] ??= { fights: 0, n: 0 }).fights++; (kos[id] ??= { fights: 0, n: 0 }).fights++; }
  if (r.me.killedBy && koBy[r.me.killedBy]) koBy[r.me.killedBy].n++;
  for (const v of r.me.victims) if (kos[v]) kos[v].n++;
}
const perFoe = (m) => Object.entries(m).map(([id, s]) => ({ id, name: name(id), fights: s.fights, rate: s.n / s.fights })).sort((a, b) => b.rate - a.rate);
const knockedOutBy = perFoe(koBy);
const knocksOut = perFoe(kos);

const summary = { focus, name: name(focus), cost: catalog[focus].cost, games, placement: place, seconds: secs, overall, stats, byStar, squares, usual, rowsSummary, colsSummary, opponents, teammates, knockedOutBy, knocksOut };
const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}focus-${focus}.json`, JSON.stringify(summary, null, 1));
writeFileSync(`${outDir}focus-${focus}.html`, report(summary));

// ---- console ----
const pct = (x) => (x === null || x === undefined ? '  –  ' : `${(x * 100).toFixed(1)}%`);
console.log(`${name(focus)}: ${games} games in ${secs.toFixed(0)}s (placement ${place})`);
console.log(`Teams with it win ${pct(overall.winRate)} ±${(overall.margin * 100).toFixed(1)}  ·  fights won ${pct(stats.fightWinRate)}  ·  survives ${pct(stats.survival)}  ·  ${stats.dmg.toFixed(0)} damage, ${stats.kills.toFixed(2)} KOs, ${stats.casts.toFixed(2)} powers per fight`);
if (stats.boosts) console.log(`Boost: ${stats.boosts.toFixed(1)} allies boosted, ${stats.boosted.toFixed(1)} charges given per fight · ${stats.casts.toFixed(2)} casts`);
if (stats.healOffered) console.log(`Healing: ${stats.healed.toFixed(0)} HP restored per fight (${pct(stats.healed / stats.healOffered)} of ${stats.healOffered.toFixed(0)} offered) · ${stats.healHits.toFixed(1)} heals landed · ${stats.attacks.toFixed(1)} attacks per fight`);
console.log('\nBy star:', byStar.map((s) => `★${s.star}: wins ${pct(s.fightWinRate)} of ${s.fights} fights`).join(' · '));
console.log('\nFight win rate by square (random placement; front row first, as its player sees it):');
for (let y = 0; y < HALF; y++) console.log('  ' + squares[y].map((s) => pct(s?.fightWinRate).padStart(7)).join(' '));
console.log('\nBy row:', rowsSummary.map((r) => `${['front', '2nd', '3rd', 'back'][r.row]} ${pct(r.fightWinRate)}`).join(' · '));
console.log('By column:', colsSummary.map((c) => `${c.col} ${pct(c.fightWinRate)}`).join(' · '));
console.log('\nHardest opponents:', opponents.slice(0, 4).map((o) => `${o.name} ${pct(o.winRate)}`).join(', '));
console.log('Easiest opponents:', opponents.slice(-4).reverse().map((o) => `${o.name} ${pct(o.winRate)}`).join(', '));
console.log('Best teammates:', teammates.slice(0, 4).map((o) => `${o.name} ${pct(o.winRate)}`).join(', '));
console.log('Knocked out most by:', knockedOutBy.slice(0, 3).map((o) => `${o.name} (${pct(o.rate)} of fights)`).join(', '));
console.log(`\nReport: ${outDir}focus-${focus}.html`);

// ---- HTML report (self-contained, opens in any browser) ----
function report(s) {
  const P = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(0)}%`);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cells = s.squares.flatMap((row) => row.map((c) => c?.fightWinRate)).filter((v) => v !== undefined && v !== null);
  const lo = Math.min(...cells), hi = Math.max(...cells);
  const heat = (v) => (v === null || v === undefined ? 'var(--surface-2)' : `color-mix(in oklab, var(--pos) ${Math.round(((v - lo) / Math.max(0.01, hi - lo)) * 75)}%, var(--surface-2))`);
  const rowName = ['Front row', '2nd row', '3rd row', 'Back row'];
  const list = (rows, val) => rows.map((r) => `<li><span>${esc(r.name)}</span><span class="num">${val(r)}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.name)} Focus Study</title>
<style>
:root { --bg: #f3f5fa; --surface: #fff; --surface-2: #eaeef6; --line: #d9dfec; --ink: #131a2e; --ink-2: #444e6e; --muted: #6b7596; --pos: #2a78d6; --gold: #9a6a00; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e1220; --surface: #161b2c; --surface-2: #1e2438; --line: #2a3150; --ink: #eef1fb; --ink-2: #b6bdd8; --muted: #8e97b7; --pos: #3987e5; --gold: #ffc93c; color-scheme: dark; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.page { max-width: 900px; margin: 0 auto; padding: 28px 18px 60px; display: grid; gap: 28px; }
h1 { margin: 0; font-size: 32px; } h2 { margin: 0 0 10px; font-size: 20px; }
.eyebrow { font: 600 12px ui-monospace, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--gold); }
.muted { color: var(--muted); } .num { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tile b { display: block; font: 600 24px ui-monospace, Menlo, monospace; }
.board { display: grid; grid-template-columns: auto repeat(${COLS}, minmax(44px, 1fr)); gap: 4px; align-items: center; }
.sq { aspect-ratio: 1.3; border-radius: 6px; display: grid; place-items: center; font: 600 13px ui-monospace, Menlo, monospace; }
.lbl { font-size: 12px; color: var(--muted); padding-right: 6px; white-space: nowrap; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 5px; } li { display: flex; justify-content: space-between; gap: 10px; }
table { border-collapse: collapse; width: 100%; } th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: right; } th:first-child, td:first-child { text-align: left; }
th { font: 600 11px ui-monospace, Menlo, monospace; color: var(--muted); text-transform: uppercase; }
.scroll { overflow-x: auto; }
</style></head><body><div class="page">
<header><div class="eyebrow">Focus study · ${s.games.toLocaleString()} games · placement: ${s.placement}</div><h1>${esc(s.name)}</h1>
<p class="muted">Every game had ${esc(s.name)} (${s.cost} coins) on one team with 5 random teammates, against a random team without it.</p></header>
<section class="tiles">
<div class="panel tile"><b>${P(s.overall.winRate)}</b>games won (±${(s.overall.margin * 100).toFixed(1)})</div>
<div class="panel tile"><b>${P(s.stats.fightWinRate)}</b>fights won when on the board</div>
<div class="panel tile"><b>${P(s.stats.survival)}</b>of fights it survives</div>
<div class="panel tile"><b>${Math.round(s.stats.dmg).toLocaleString()}</b>damage per fight</div>
<div class="panel tile"><b>${s.stats.casts.toFixed(2)}</b>powers per fight</div>
${s.stats.healOffered ? `<div class="panel tile"><b>${Math.round(s.stats.healed).toLocaleString()}</b>HP healed per fight (${P(s.stats.healed / s.stats.healOffered)} of what it offered; the rest was over max HP)</div>` : ''}
</section>
<section><h2>Where to place it</h2><p class="muted">Fight win rate when put on each square at random (from ${exp.length.toLocaleString()} fights). Shown as its own player sees the board: front row (next to the enemy) on top. Darker = wins more.</p>
<div class="panel"><div class="board">
${s.squares.map((row, y) => `<div class="lbl">${rowName[y]}</div>${row.map((c) => `<div class="sq" style="background:${heat(c?.fightWinRate)}" title="${c ? `${c.fights} fights · survives ${P(c.survival)} · ${Math.round(c.dmg)} damage` : 'no data'}">${P(c?.fightWinRate)}</div>`).join('')}`).join('')}
</div></div>
<div class="cols" style="margin-top:12px">
<div class="panel"><h2>By row</h2><table><tr><th>Row</th><th>Fights won</th><th>Survives</th><th>Damage</th></tr>${s.rowsSummary.map((r) => `<tr><td>${rowName[r.row]}</td><td class="num">${P(r.fightWinRate)}</td><td class="num">${P(r.survival)}</td><td class="num">${Math.round(r.dmg ?? 0)}</td></tr>`).join('')}</table></div>
<div class="panel"><h2>By column</h2><table><tr><th>Column</th><th>Fights won</th><th>Survives</th><th>Damage</th></tr>${s.colsSummary.map((r) => `<tr><td>${r.col}</td><td class="num">${P(r.fightWinRate)}</td><td class="num">${P(r.survival)}</td><td class="num">${Math.round(r.dmg ?? 0)}</td></tr>`).join('')}</table></div>
</div></section>
<section class="cols">
<div class="panel"><h2>Hardest opponents</h2><p class="muted">Games won when the enemy team has…</p><ol>${list(s.opponents.slice(0, 6), (r) => P(r.winRate))}</ol></div>
<div class="panel"><h2>Easiest opponents</h2><p class="muted">Games won when the enemy team has…</p><ol>${list(s.opponents.slice(-6).reverse(), (r) => P(r.winRate))}</ol></div>
<div class="panel"><h2>Best teammates</h2><p class="muted">Games won with…</p><ol>${list(s.teammates.slice(0, 6), (r) => P(r.winRate))}</ol></div>
<div class="panel"><h2>Worst teammates</h2><p class="muted">Games won with…</p><ol>${list(s.teammates.slice(-6).reverse(), (r) => P(r.winRate))}</ol></div>
<div class="panel"><h2>Knocked out by</h2><p class="muted">Share of fights against it where it lands the KO</p><ol>${list(s.knockedOutBy.slice(0, 6), (r) => P(r.rate))}</ol></div>
<div class="panel"><h2>Knocks out</h2><p class="muted">Share of fights against it where ${esc(s.name)} KOs it</p><ol>${list(s.knocksOut.slice(0, 6), (r) => P(r.rate))}</ol></div>
</section>
<section><h2>By star level</h2><div class="panel scroll"><table><tr><th>Star</th><th>Fights</th><th>Fights won</th><th>Survives</th><th>Damage</th><th>KOs</th><th>Powers</th></tr>
${s.byStar.map((r) => `<tr><td>${r.star ? '★'.repeat(r.star) : '0★'}</td><td class="num">${r.fights.toLocaleString()}</td><td class="num">${P(r.fightWinRate)}</td><td class="num">${P(r.survival)}</td><td class="num">${Math.round(r.dmg)}</td><td class="num">${r.kills.toFixed(2)}</td><td class="num">${r.casts.toFixed(2)}</td></tr>`).join('')}
</table></div></section>
</div></body></html>`;
}
