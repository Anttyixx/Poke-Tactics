// Play two specific teams against each other many times, with the real game
// rules and battle engine, and report who wins and what each Pokémon did.
//
//   node tools/match.mjs <team A> <team B> [--games=500] [--place=smart|default] [--place-a=..] [--place-b=..]
//
// Teams are 6 Pokémon, comma-separated ids or names, e.g.
//   node tools/match.mjs "beheeyem,infernape,ditto,vespiquen,lilligant,hoopa" \
//                        "coalossal,torterra,golem,minior,mawile,decidueye" --place=smart
// Each team plays half the games from each side of the board.
// --place=smart: both players rearrange before every fight to counter the
// opponent's lineup from the round before (see placer.mjs); default: the game
// bot's layout (melee in front, ranged behind). Set each side separately with
// --place-a / --place-b to measure what good positioning is worth.

import { readFileSync } from 'node:fs';
import { runJobs } from './balance.mjs';
import { hashSeed } from '../src/rng.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const troops = Object.keys(catalog).filter((id) => !catalog[id].summon);
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [teamA, teamB] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(parseTeam);
if (!teamA || !teamB) { console.error('Usage: node tools/match.mjs "<6 Pokémon>" "<6 Pokémon>" [--games=500] [--place=smart]'); process.exit(1); }

function parseTeam(text) {
  const key = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
  const byKey = Object.fromEntries(troops.flatMap((id) => [[key(id), id], [key(catalog[id].name), id]]));
  const team = text.split(',').map((s) => byKey[key(s)] ?? s.trim());
  const bad = team.filter((t) => !troops.includes(t));
  if (bad.length) { console.error(`Unknown Pokémon: ${bad.join(', ')}\nChoose from: ${troops.join(', ')}`); process.exit(1); }
  if (team.length !== 6 || new Set(team).size !== 6) { console.error(`A team is 6 different Pokémon: ${text}`); process.exit(1); }
  return team;
}

const games = Number(flags.games ?? 500);
const placeA = flags['place-a'] ?? flags.place ?? 'default';
const placeB = flags['place-b'] ?? flags.place ?? 'default';
const jobs = Array.from({ length: games }, (_, i) => {
  const aFirst = i % 2 === 0;
  return {
    kind: 'match', seed: hashSeed(`match-${teamA}-${teamB}-${i}`), aSide: aFirst ? 0 : 1,
    teams: aFirst ? [teamA, teamB] : [teamB, teamA],
    placement: aFirst ? [placeA, placeB] : [placeB, placeA],
  };
});

const t0 = Date.now();
const results = await runJobs(jobs);
const label = ['A', 'B'];
const tally = { wins: [0, 0], draws: 0, rounds: 0, fights: 0, fightWins: [0, 0], hpLeft: [0, 0] };
const per = [{}, {}]; // team -> unitId -> stats
for (const g of results) {
  const teamOfSide = (side) => (side === g.aSide ? 0 : 1);
  if (g.winner === null) tally.draws++; else tally.wins[teamOfSide(g.winner)]++;
  tally.rounds += g.rounds;
  g.hp.forEach((hp, side) => { tally.hpLeft[teamOfSide(side)] += hp; });
  for (const f of g.fights) {
    tally.fights++;
    if (f.winner !== null) tally.fightWins[teamOfSide(f.winner)]++;
    for (const u of f.units) {
      const s = (per[teamOfSide(u.side)][u.unitId] ??= { fights: 0, dmg: 0, taken: 0, kills: 0, casts: 0, survived: 0, stars: 0 });
      s.fights++; s.dmg += u.dmg; s.taken += u.taken; s.kills += u.kills; s.casts += u.casts; s.survived += u.survived ? 1 : 0; s.stars += u.star;
    }
  }
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const n = results.length;
console.log(`${n} games in ${((Date.now() - t0) / 1000).toFixed(1)}s  (placement: A ${placeA}, B ${placeB})\n`);
[teamA, teamB].forEach((team, t) => {
  console.log(`Team ${label[t]}: wins ${pct(tally.wins[t] / n)}  fights won ${pct(tally.fightWins[t] / tally.fights)}  avg HP left ${(tally.hpLeft[t] / n).toFixed(0)}`);
  console.log(`  ${'Pokémon'.padEnd(12)} ${'on board'.padStart(9)} ${'avg ★'.padStart(6)} ${'damage'.padStart(7)} ${'taken'.padStart(7)} ${'KOs'.padStart(5)} ${'survives'.padStart(9)} ${'powers'.padStart(7)}`);
  for (const id of team) {
    const s = per[t][id];
    if (!s) { console.log(`  ${catalog[id].name.padEnd(12)} never on the board`); continue; }
    console.log(`  ${catalog[id].name.padEnd(12)} ${pct(s.fights / tally.fights).padStart(9)} ${(s.stars / s.fights).toFixed(2).padStart(6)} ${String(Math.round(s.dmg / s.fights)).padStart(7)} ${String(Math.round(s.taken / s.fights)).padStart(7)} ${(s.kills / s.fights).toFixed(2).padStart(5)} ${pct(s.survived / s.fights).padStart(9)} ${(s.casts / s.fights).toFixed(2).padStart(7)}`);
  }
  console.log('');
});
console.log(`Draws ${pct(tally.draws / n)} · ${(tally.rounds / n).toFixed(1)} rounds per game`);
