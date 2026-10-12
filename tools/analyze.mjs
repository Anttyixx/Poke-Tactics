// Turns tools/balance.mjs output into balance stats.
//   node tools/analyze.mjs [in=tools/out/balance.json] [out=tools/out/summary.json]
//
// Win rates come from the random-team games (every Pokémon appears equally
// often against everything); archetype games only feed the archetype table.

import { readFileSync, writeFileSync } from 'node:fs';

const inPath = process.argv[2] ?? new URL('./out/balance.json', import.meta.url).pathname;
const outPath = process.argv[3] ?? new URL('./out/summary.json', import.meta.url).pathname;
const { catalog, archetypes, games } = JSON.parse(readFileSync(inPath, 'utf8'));
const troops = Object.keys(catalog).filter((id) => !catalog[id].summon);
const random = games.filter((g) => g.kind === 'random');
const decided = (list) => list.filter((g) => g.winner !== null);
const ci = (p, n) => (n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0); // 95% margin
const round3 = (x) => Math.round(x * 1000) / 1000;

// ---- per Pokémon -------------------------------------------------------------
const per = Object.fromEntries(troops.map((id) => [id, {
  id, name: catalog[id].name, cost: catalog[id].cost,
  games: 0, wins: 0, fights: 0, fightWins: 0, starSum: 0, dmg: 0, taken: 0, kills: 0, casts: 0, survived: 0, coinSum: 0, onTeamFights: 0,
}]));
for (const g of decided(random)) {
  g.teams.forEach((team, side) => {
    for (const id of team) {
      per[id].games++;
      if (g.winner === side) per[id].wins++;
      per[id].onTeamFights += g.fights.length;
    }
  });
  for (const f of g.fights) {
    for (const u of f.units) {
      const s = per[u.unitId];
      if (!s) continue;
      s.fights++;
      if (f.winner === u.side) s.fightWins++;
      s.starSum += u.star;
      s.dmg += u.dmg;
      s.taken += u.taken;
      s.kills += u.kills;
      s.casts += u.casts;
      s.survived += u.survived ? 1 : 0;
      s.coinSum += catalog[u.unitId].cost * (u.star + 1); // coins sunk into it
    }
  }
}
const pokemon = Object.values(per).map((s) => {
  const wr = s.wins / s.games;
  return {
    id: s.id, name: s.name, cost: s.cost, games: s.games,
    winRate: round3(wr), margin: round3(ci(wr, s.games)),
    fightWinRate: round3(s.fightWins / s.fights),
    fieldRate: round3(s.fights / s.onTeamFights), // how often the bot had it on the board
    avgStar: round3(s.starSum / s.fights),
    dmgPerFight: Math.round(s.dmg / s.fights),
    dmgPerCoin: Math.round(s.dmg / s.coinSum),
    takenPerFight: Math.round(s.taken / s.fights),
    killsPerFight: round3(s.kills / s.fights),
    castsPerFight: round3(s.casts / s.fights),
    survival: round3(s.survived / s.fights),
  };
}).sort((a, b) => b.winRate - a.winRate);

// ---- pairs: synergy (same team) and counters (A against B) ---------------------
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const same = new Map();
const vs = new Map();
for (const g of decided(random)) {
  g.teams.forEach((team, side) => {
    const won = g.winner === side ? 1 : 0;
    for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
      const k = pairKey(team[i], team[j]);
      const s = same.get(k) ?? { n: 0, w: 0 };
      s.n++; s.w += won; same.set(k, s);
    }
    for (const a of team) for (const b of g.teams[1 - side]) {
      if (a === b) continue;
      const k = `${a}>${b}`;
      const s = vs.get(k) ?? { n: 0, w: 0 };
      s.n++; s.w += won; vs.set(k, s);
    }
  });
}
const wrOf = Object.fromEntries(pokemon.map((p) => [p.id, p.winRate]));
const synergy = [...same.entries()].map(([k, s]) => {
  const [a, b] = k.split('|');
  const wr = s.w / s.n;
  const expected = 0.5 + (wrOf[a] - 0.5) + (wrOf[b] - 0.5);
  return { a, b, games: s.n, winRate: round3(wr), expected: round3(expected), lift: round3(wr - expected), margin: round3(ci(wr, s.n)) };
}).sort((x, y) => y.lift - x.lift);
const counters = [...vs.entries()].map(([k, s]) => {
  const [a, b] = k.split('>');
  return { a, b, games: s.n, winRate: round3(s.w / s.n), margin: round3(ci(s.w / s.n, s.n)) };
}).filter((c) => c.a < c.b || !vs.has(`${c.b}>${c.a}`)).sort((x, y) => Math.abs(y.winRate - 0.5) - Math.abs(x.winRate - 0.5));

// ---- archetypes ------------------------------------------------------------------------
const names = Object.keys(archetypes);
const arch = Object.fromEntries(names.map((a) => [a, Object.fromEntries(names.map((b) => [b, { n: 0, w: 0 }]))]));
for (const g of games.filter((x) => x.kind === 'archetype')) {
  const [a, b] = g.arche;
  if (g.winner === null) continue;
  arch[a][b].n++; arch[b][a].n++;
  if (g.winner === 0) arch[a][b].w++; else arch[b][a].w++;
}
const archetypeTable = names.map((a) => {
  const row = names.map((b) => (a === b ? null : round3(arch[a][b].w / arch[a][b].n)));
  const n = names.reduce((s, b) => s + (a === b ? 0 : arch[a][b].n), 0);
  const w = names.reduce((s, b) => s + (a === b ? 0 : arch[a][b].w), 0);
  return { name: a, team: archetypes[a], vs: row, winRate: round3(w / n), games: n };
});

// ---- overall --------------------------------------------------------------------------
const allFights = random.flatMap((g) => g.fights);
const overall = {
  randomGames: random.length,
  archetypeGames: games.length - random.length,
  draws: round3(random.filter((g) => g.winner === null).length / random.length),
  side0WinRate: round3(decided(random).filter((g) => g.winner === 0).length / decided(random).length),
  avgRounds: round3(random.reduce((s, g) => s + g.rounds, 0) / random.length),
  avgFightSeconds: round3(allFights.reduce((s, f) => s + f.ticks, 0) / allFights.length / 10),
  suddenDeathShare: round3(allFights.filter((f) => f.ticks > 300).length / allFights.length),
};
const byCost = [...new Set(pokemon.map((p) => p.cost))].sort().map((cost) => {
  const list = pokemon.filter((p) => p.cost === cost);
  return { cost, pokemon: list.map((p) => p.id), winRate: round3(list.reduce((s, p) => s + p.winRate, 0) / list.length) };
});

const summary = { when: new Date().toISOString(), overall, pokemon, byCost, archetypes: archetypeTable, archetypeNames: names, synergy, counters: counters.slice(0, 40) };
writeFileSync(outPath, JSON.stringify(summary, null, 1));

// Console digest.
console.log(overall);
console.log('\nPokémon (random teams), best first:');
for (const p of pokemon) console.log(`${p.name.padEnd(12)} cost ${p.cost}  win ${(p.winRate * 100).toFixed(1)}% ±${(p.margin * 100).toFixed(1)}  fight ${(p.fightWinRate * 100).toFixed(0)}%  dmg/fight ${String(p.dmgPerFight).padStart(5)}  dmg/coin ${String(p.dmgPerCoin).padStart(4)}  surv ${(p.survival * 100).toFixed(0)}%  ★${p.avgStar.toFixed(2)}  casts ${p.castsPerFight}`);
console.log('\nArchetypes:');
for (const a of archetypeTable) console.log(`${a.name.padEnd(16)} ${(a.winRate * 100).toFixed(1)}%`);
console.log('\nBest pairs:', synergy.slice(0, 5).map((s) => `${s.a}+${s.b} ${(s.lift * 100).toFixed(1)}`).join(', '));
console.log('Worst pairs:', synergy.slice(-5).map((s) => `${s.a}+${s.b} ${(s.lift * 100).toFixed(1)}`).join(', '));
console.log('Most lopsided matchups:', counters.slice(0, 6).map((c) => `${c.a} vs ${c.b} ${(c.winRate * 100).toFixed(0)}%`).join(', '));
