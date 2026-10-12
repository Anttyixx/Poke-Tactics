// Balance testing: plays thousands of complete bot-vs-bot games (team pick,
// shop, placement, every round to 0 HP) and records what each Pokémon did.
//
//   node tools/balance.mjs [games=4000] [out=tools/out/balance.json] [patch.json] [--random-only]
//
// patch.json tries a stat change without editing units.json: an object of
// Pokémon id -> fields to replace, e.g. {"mawile": {"hp": [720, 1300, 2350, 4240]}};
// "ability" is merged field by field. tools/sweep.mjs uses this to test tweaks.
//
// Two kinds of games:
//   random     - both teams are 6 random Pokémon. Every Pokémon shows up equally
//                often against everything, so win rates compare fairly.
//   archetype  - hand-built teams with a plan (see ARCHETYPES), every archetype
//                against every other, both sides of the board.
// The bot buys and places for both players (melee in front, ranged behind,
// levelling up first, then the priciest Pokémon), so results show what the
// numbers do with sensible but simple play, not expert play.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cpus } from 'node:os';
import { createGame, applyIntent, troopIds } from '../src/game.js';
import { botTurn } from '../src/bot.js';
import { hashSeed } from '../src/rng.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
export function applyPatch(cat, patch = {}) {
  for (const [id, fields] of Object.entries(patch)) {
    if (!cat[id]) throw new Error(`Patch names unknown Pokémon "${id}"`);
    for (const [k, v] of Object.entries(fields)) cat[id][k] = k === 'ability' ? { ...cat[id].ability, ...v } : v;
  }
  return cat;
}
const MAX_ROUNDS = 60; // safety net; real games end long before

// Teams built around an idea. Edit freely; ids must be troops in units.json.
export const ARCHETYPES = {
  'Tanks + healer': ['coalossal', 'torterra', 'golem', 'minior', 'lilligant', 'decidueye'],
  'Ranged backline': ['decidueye', 'vespiquen', 'beheeyem', 'greninja', 'lilligant', 'tapukoko'],
  'Divers': ['hoopa', 'tapukoko', 'infernape', 'mawile', 'greninja', 'beheeyem'],
  'Stun lock': ['beheeyem', 'coalossal', 'torterra', 'mawile', 'tapukoko', 'golem'],
  'Cheap & wide': ['beheeyem', 'lilligant', 'ditto', 'hoopa', 'vespiquen', 'infernape'],
  'Big hitters': ['coalossal', 'mawile', 'toxtricity', 'decidueye', 'greninja', 'minior'],
};

// ---- one game ----------------------------------------------------------------

function playGame(seed, teams) {
  const state = createGame({ seed, catalog, names: ['A', 'B'] });
  teams.forEach((troops, p) => {
    const res = applyIntent(state, catalog, p, { type: 'chooseTeam', troops });
    if (!res.ok) throw new Error(`Bad team ${troops}: ${res.error}`);
  });
  const fights = [];
  while (state.phase !== 'gameover' && state.round <= MAX_ROUNDS) {
    if (state.phase === 'planning') {
      for (const p of [0, 1]) if (!state.players[p].ready) botTurn(state, catalog, p, (i) => applyIntent(state, catalog, p, i));
    } else if (state.phase === 'combat') {
      fights.push(summarizeFight(state.combat.result, state.round, state.players.map((pl) => pl.coins)));
      for (const p of [0, 1]) applyIntent(state, catalog, p, { type: 'continue' });
    } else throw new Error(`Stuck in phase ${state.phase}`);
  }
  return { winner: state.phase === 'gameover' ? state.winner : null, rounds: state.round, hp: state.players.map((p) => p.hp), fights };
}

// Per-unit stats for one fight. Summoned units (Combee) count for their summoner.
function summarizeFight(result, round) {
  const owner = new Map(); // unit id -> id of the Pokémon it counts for
  const units = new Map();
  for (const u of result.initial) {
    owner.set(u.id, u.id);
    units.set(u.id, { side: u.side, unitId: u.unitId, star: u.star, dmg: 0, taken: 0, kills: 0, casts: 0, survived: true });
  }
  const lastHit = new Map();
  for (const e of result.events) {
    if (e.type === 'summon') owner.set(e.unit.id, owner.get(e.id));
    else if (e.type === 'damage') {
      const src = units.get(owner.get(e.src));
      const dealt = e.amount; // HP + shield removed
      if (src) src.dmg += dealt;
      const tgt = units.get(e.id);
      if (tgt) tgt.taken += dealt;
      lastHit.set(e.id, e.src);
    } else if (e.type === 'death') {
      const u = units.get(e.id);
      if (u) u.survived = false;
      const killer = units.get(owner.get(lastHit.get(e.id)));
      if (killer && units.has(e.id)) killer.kills++;
    } else if (e.type === 'cast') {
      const u = units.get(e.id);
      if (u) u.casts++;
    }
  }
  return { round, winner: result.winner, ticks: result.ticks, units: [...units.values()] };
}

// ---- jobs ------------------------------------------------------------------------

export function makeJobs(games, { randomOnly = false } = {}) {
  const troops = troopIds(catalog);
  for (const [name, team] of Object.entries(ARCHETYPES)) {
    if (team.length !== 6 || new Set(team).size !== 6 || !team.every((t) => troops.includes(t))) throw new Error(`Archetype "${name}" is not 6 distinct troops`);
  }
  const jobs = [];
  // Random teams: a seeded shuffle per game.
  for (let i = 0; i < games; i++) {
    const seed = hashSeed(`random-${i}`);
    const pick = (salt) => [...troops].map((t, k) => [hashSeed(`${seed}-${salt}-${t}-${k}`), t]).sort((a, b) => a[0] - b[0]).slice(0, 6).map((x) => x[1]);
    jobs.push({ kind: 'random', seed, teams: [pick('a'), pick('b')] });
  }
  if (randomOnly) return jobs;
  // Archetypes: every ordered pair (so each plays both sides), several seeds.
  const names = Object.keys(ARCHETYPES);
  const per = Math.max(10, Math.round(games / 40));
  for (const a of names) for (const b of names) {
    if (a === b) continue;
    for (let k = 0; k < per; k++) jobs.push({ kind: 'archetype', seed: hashSeed(`arch-${a}-${b}-${k}`), teams: [ARCHETYPES[a], ARCHETYPES[b]], arche: [a, b] });
  }
  return jobs;
}

// ---- workers -----------------------------------------------------------------------

// Play `jobs` across all CPU cores, with an optional stat patch.
export async function runJobs(jobs, patch = null) {
  const n = Math.max(1, cpus().length);
  const chunks = Array.from({ length: n }, (_, i) => jobs.filter((_, k) => k % n === i));
  return (await Promise.all(chunks.map((chunk) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { jobs: chunk, patch } });
    w.once('message', resolve);
    w.once('error', reject);
  })))).flat();
}

if (!isMainThread) {
  applyPatch(catalog, workerData.patch ?? {});
  const out = workerData.jobs.map((job) => ({ ...job, ...playGame(job.seed, job.teams) }));
  parentPort.postMessage(out);
} else if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const games = Number(args[0] ?? 4000);
  const outPath = args[1] ?? new URL('./out/balance.json', import.meta.url).pathname;
  const patch = args[2] ? JSON.parse(readFileSync(args[2], 'utf8')) : null;
  const jobs = makeJobs(games, { randomOnly: process.argv.includes('--random-only') });
  const t0 = Date.now();
  const results = await runJobs(jobs, patch);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), catalog: applyPatch(catalog, patch ?? {}), archetypes: ARCHETYPES, games: results }));
  console.log(`${results.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outPath}`);
}
