// Rebuild a real match from its match log (Menu → Match log → Copy, in the
// game) and analyse it with the real rules and battle engine.
//
//   node tools/replay.mjs <log.json> [--patch=patch.json] [--catalog=units.json] [--seeds=60] [--summary=notes.html]
//
// Writes tools/out/replay-<seed>.txt / .json and an easy-to-read web page,
// tools/out/replay-<seed>.html (--summary adds hand-written takeaways at the top).
//
// The log holds the game's seed and every move both players made, so the
// replay reproduces every shop, board and fight exactly. Then, for each fight:
//   - luck: the same two boards fought with other seeds (crits and turn order)
//     -> how often the actual winner wins them
//   - placement: could the loser have won by arranging the same Pokémon
//     differently? (searched with hindsight of the winner's actual board)
//   - --patch: the same boards with changed stats -> does the result change?
// The player's notes are printed at the top; the tool doesn't interpret them.
//
// Stats must match the build the match was played on. The log names that build;
// its units.json is read from git history. Use --catalog to supply it yourself.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createGame, applyIntent } from '../src/game.js';
import { simulate } from '../src/combat.js';
import { hashSeed } from '../src/rng.js';
import { summarizeFight, applyPatch } from './balance.mjs';
import { bestLayout } from './placer.mjs';
import { replayReport } from './replay-html.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('Usage: node tools/replay.mjs <log.json> [--patch=patch.json] [--catalog=units.json] [--seeds=60] [--summary=notes.html]'); process.exit(1); }
const log = JSON.parse(readFileSync(file, 'utf8'));
if (log.format !== 'poke-tactics-match') { console.error('That file is not a Poke Tactics match log.'); process.exit(1); }
const SEEDS = Number(flags.seeds ?? 60);

// ---- the stats the match was played with ----
function loadCatalogText() {
  if (flags.catalog) return readFileSync(flags.catalog, 'utf8');
  const tries = [];
  if (/^[0-9a-f]{7,40}$/.test(log.build)) tries.push(() => execFileSync('git', ['show', `${log.build}:data/units.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  tries.push(() => readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
  for (const t of tries) {
    try { const text = t(); if (!log.catalogHash || hashSeed(text) === log.catalogHash) return text; } catch {}
  }
  console.error(`Couldn't find the Pokémon stats this match was played with (build ${log.build}). Pass them with --catalog=<units.json from that build>.`);
  process.exit(1);
}
const catalog = JSON.parse(loadCatalogText());
const patched = flags.patch ? applyPatch(structuredClone(catalog), JSON.parse(readFileSync(flags.patch, 'utf8'))) : null;
const name = (id) => catalog[id]?.name ?? id;

// ---- replay ----
const state = createGame({ seed: log.seed, catalog, names: log.names, featured: log.featured ?? null });
const rounds = [];
const problems = [];
log.intents.forEach(([player, intent], i) => {
  const before = state.phase;
  const res = applyIntent(state, catalog, player, intent);
  if (!res.ok) problems.push(`move ${i + 1} (${log.names[player]}: ${intent.type}) was refused: ${res.error}`);
  if (before !== 'combat' && state.phase === 'combat') {
    rounds.push({
      round: state.round,
      boards: state.players.map((p) => p.board.map(({ uid, unitId, star, x, y }) => ({ uid, unitId, star, x, y }))),
      hpBefore: state.players.map((p) => p.hp),
      damage: state.combat.damage,
      result: state.combat.result,
      fight: summarizeFight(state.combat.result, state.round),
    });
  }
});

// ---- per-fight analysis ----
const winsOver = (cat, boards, seeds, side) => {
  let w = 0;
  for (let k = 0; k < seeds; k++) if (simulate(cat, boards, hashSeed(`replay:${log.seed}:${k}`), { record: false }).winner === side) w++;
  return w / seeds;
};
for (const r of rounds) {
  const winner = r.result.winner;
  // Luck: how often the actual winner wins the same matchup.
  r.luck = winner === null ? null : winsOver(catalog, r.boards, SEEDS, winner);
  // Placement: best rearrangement for the loser, knowing the winner's board.
  if (winner !== null) {
    const loser = 1 - winner;
    const fake = { seed: log.seed, round: r.round, players: [] };
    fake.players[loser] = { board: r.boards[loser] };
    fake.players[winner] = { lastBoard: r.boards[winner] };
    const layout = r.boards[loser].length && r.boards[winner].length ? bestLayout(catalog, fake, loser, { tries: 40, climb: 40, finalists: 6, seeds: 4 }) : null;
    if (layout) {
      const moved = r.boards[loser].map((u) => ({ ...u, ...layout.find((l) => l.uid === u.uid) }));
      const boards = loser === 0 ? [moved, r.boards[1]] : [r.boards[0], moved];
      r.better = { player: loser, layout: moved, winChance: winsOver(catalog, boards, SEEDS, loser) };
    }
  }
  if (patched) {
    const res = simulate(patched, r.boards, (log.seed + Math.imul(r.round, 0x9e3779b9)) >>> 0);
    r.patched = { winner: res.winner, fight: summarizeFight(res, r.round), winChance: winner === null ? null : winsOver(patched, r.boards, SEEDS, winner) };
  }
}

// Totals per Pokémon, per player.
const totals = [{}, {}];
for (const r of rounds) for (const u of r.fight.units) {
  const t = (totals[u.side][u.unitId] ??= { fights: 0, dmg: 0, taken: 0, kills: 0, survived: 0, casts: 0, maxStar: 0 });
  t.fights++; t.dmg += u.dmg; t.taken += u.taken; t.kills += u.kills; t.survived += u.survived ? 1 : 0; t.casts += u.casts; t.maxStar = Math.max(t.maxStar, u.star);
}

// ---- output ----
const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const stars = (n) => (n ? '★'.repeat(n) : '');
const boardText = (b) => b.map((u) => `${name(u.unitId)}${stars(u.star)}`).join(', ') || '(empty)';
const N = log.names;
const out = [];
out.push(`MATCH  ${N[0]} vs ${N[1]}  (${log.mode ?? 'pvp'}, build ${log.build}, ${log.intents.length} moves, ${rounds.length} rounds)`);
out.push(`Winner: ${state.phase === 'gameover' ? (state.winner === null ? 'draw' : N[state.winner]) : 'match unfinished'}  ·  final HP ${state.players.map((p) => p.hp).join(' – ')}`);
if (log.notes) out.push(`\nNOTES from ${log.viewer ?? 'the player'}:\n  ${log.notes.replace(/\n/g, '\n  ')}`);
if (problems.length) out.push(`\nWARNING: the replay didn't match the original game:\n  ${problems.slice(0, 5).join('\n  ')}`);
out.push('\nROUND BY ROUND');
for (const r of rounds) {
  const w = r.result.winner;
  out.push(`\nRound ${r.round}: ${w === null ? 'draw' : `${N[w]} won`} (${(r.result.ticks / 10).toFixed(1)}s) · damage to players ${r.damage.join(' / ')} · HP after ${r.hpBefore.map((h, i) => Math.max(0, h - r.damage[i])).join(' / ')}`);
  for (const p of [0, 1]) out.push(`  ${N[p].padEnd(12)} ${boardText(r.boards[p])}`);
  const top = [...r.fight.units].sort((a, b) => b.dmg - a.dmg)[0];
  if (top) out.push(`  Top damage: ${name(top.unitId)}${stars(top.star)} (${N[top.side]}) ${top.dmg}`);
  if (r.luck !== null) out.push(`  Same boards, other seeds: ${N[w]} wins ${pct(r.luck)}${r.luck < 0.5 ? '  ← lucky win' : r.luck < 0.7 ? '  (close)' : ''}`);
  if (r.better && r.better.winChance > 0.5) out.push(`  ${N[r.better.player]} could have won ${pct(r.better.winChance)} of the time with: ${r.better.layout.map((u) => `${name(u.unitId)} @${u.x},${u.y}`).join(', ')}  (x 0-4 left→right, y 0 = front row)`);
  if (r.patched) out.push(`  With the patch: ${r.patched.winner === null ? 'draw' : `${N[r.patched.winner]} wins`}${r.patched.winner !== w ? '  ← RESULT CHANGES' : ''} · actual winner wins ${pct(r.patched.winChance)} over seeds`);
}
out.push('\nPOKÉMON OVER THE MATCH');
for (const p of [0, 1]) {
  out.push(`\n${N[p]}:`);
  out.push(`  ${'Pokémon'.padEnd(12)} ${'fights'.padStart(6)} ${'max ★'.padStart(6)} ${'damage'.padStart(7)} ${'per fight'.padStart(9)} ${'taken'.padStart(7)} ${'KOs'.padStart(4)} ${'survived'.padStart(8)} ${'powers'.padStart(6)}`);
  for (const [id, t] of Object.entries(totals[p]).sort((a, b) => b[1].dmg - a[1].dmg)) {
    out.push(`  ${name(id).padEnd(12)} ${String(t.fights).padStart(6)} ${String(t.maxStar).padStart(6)} ${String(t.dmg).padStart(7)} ${String(Math.round(t.dmg / t.fights)).padStart(9)} ${String(t.taken).padStart(7)} ${String(t.kills).padStart(4)} ${`${t.survived}/${t.fights}`.padStart(8)} ${String(t.casts).padStart(6)}`);
  }
}
const text = out.join('\n');
console.log(text);
const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}replay-${log.seed}.txt`, text);
writeFileSync(`${outDir}replay-${log.seed}.json`, JSON.stringify({ log: { ...log, intents: undefined }, rounds: rounds.map(({ result, ...r }) => ({ ...r, winner: result.winner, ticks: result.ticks })), totals }, null, 1));
writeFileSync(`${outDir}replay-${log.seed}.html`, replayReport({
  log, catalog, totals,
  rounds: rounds.map(({ result, ...r }) => ({ ...r, winner: result.winner, ticks: result.ticks })),
  winner: state.phase === 'gameover' ? state.winner : null,
  finalHp: state.players.map((p) => p.hp),
  summary: flags.summary ? readFileSync(flags.summary, 'utf8') : '',
}));
console.log(`\nReport: ${outDir}replay-${log.seed}.html`);
