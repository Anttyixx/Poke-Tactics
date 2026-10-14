// Balance testing: plays thousands of complete bot-vs-bot games (team pick,
// shop, placement, every round to 0 HP) and records what each Pokémon did.
//
//   node tools/balance.mjs [games=4000] [out=tools/out/balance.json] [patch.json] [--random-only] [--smart[=classic]]
//
// Games run on every CPU core at once (about 10,000 games in 30s on 4 cores).
// --smart: both players reposition before every fight to counter the
// opponent's last lineup (tools/placer.mjs), like a real player would. Slower
// (about 0.1s of CPU per game: 10,000 games in about 4.5 minutes on 4 cores)
// but closer to real play. --smart=classic uses the older, slower search.
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
import { COLS, HALF } from '../src/combat.js';
import { bestLayout, quickLayout, applyLayout } from './placer.mjs';

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
  'Divers': ['hoopa', 'tapukoko', 'infernape', 'annihilape', 'greninja', 'beheeyem'],
  'Stun lock': ['beheeyem', 'coalossal', 'torterra', 'amoonguss', 'tapukoko', 'golem'],
  'Cheap & wide': ['beheeyem', 'lilligant', 'ditto', 'hoopa', 'vespiquen', 'infernape'],
  'Big hitters': ['coalossal', 'dragapult', 'toxtricity', 'decidueye', 'greninja', 'minior'],
};

// ---- one game ----------------------------------------------------------------

// placement[p]: 'default' = the game's bot layout (rule-based, src/bot.js);
// 'basic' = the old bot: units stay where they were bought (melee front, ranged back);
// 'smart' = rearrange before each fight to counter the opponent's last lineup
// (quickLayout); 'smart-classic' = the older, slower search (bestLayout).
// opts.explore = { player, unitId }: before every fight, put that player's
// `unitId` on a random square of its half (to map where it does best).
export function playGame(seed, teams, placement = ['default', 'default'], opts = {}) {
  const state = createGame({ seed, catalog, names: ['A', 'B'] });
  teams.forEach((troops, p) => {
    const res = applyIntent(state, catalog, p, { type: 'chooseTeam', troops });
    if (!res.ok) throw new Error(`Bad team ${troops}: ${res.error}`);
  });
  const fights = [];
  const memos = [{}, {}]; // quick placement remembers its last answer per player
  while (state.phase !== 'gameover' && state.round <= MAX_ROUNDS) {
    if (state.phase === 'planning') {
      for (const p of [0, 1]) {
        if (state.players[p].ready) continue;
        const send = (i) => applyIntent(state, catalog, p, i);
        // Shop like the bot, then (smart) reposition before locking in.
        botTurn(state, catalog, p, (i) => (i.type === 'ready' ? { ok: true } : send(i)), { arrange: placement[p] !== 'basic' });
        if (placement[p] === 'smart' || placement[p] === 'smart-classic') {
          const layout = placement[p] === 'smart' ? quickLayout(catalog, state, p, { memo: memos[p] }) : bestLayout(catalog, state, p);
          if (layout) applyLayout(layout, send);
        }
        const ex = opts.explore;
        if (ex && ex.player === p) {
          const unit = state.players[p].board.find((u) => u.unitId === ex.unitId);
          const k = hashSeed(`${seed}:${state.round}:explore`) % (COLS * HALF);
          if (unit) send({ type: 'move', uid: unit.uid, x: k % COLS, y: Math.floor(k / COLS) });
        }
        send({ type: 'ready' });
      }
    } else if (state.phase === 'combat') {
      fights.push(summarizeFight(state.combat.result, state.round, state.players.map((pl) => pl.coins)));
      for (const p of [0, 1]) applyIntent(state, catalog, p, { type: 'continue' });
    } else throw new Error(`Stuck in phase ${state.phase}`);
  }
  return { winner: state.phase === 'gameover' ? state.winner : null, rounds: state.round, hp: state.players.map((p) => p.hp), fights };
}

// Per-unit stats for one fight. Summoned units (Combee) count for their summoner.
export function summarizeFight(result, round) {
  const owner = new Map(); // unit id -> id of the Pokémon it counts for
  const units = new Map();
  for (const u of result.initial) {
    owner.set(u.id, u.id);
    // Start square in the owner's own coordinates (y 0 = front row, x as they see it).
    const ox = u.side === 0 ? u.x : COLS - 1 - u.x;
    const oy = u.side === 0 ? u.y - HALF : HALF - 1 - u.y;
    units.set(u.id, { side: u.side, unitId: u.unitId, star: u.star, x: ox, y: oy, dmg: 0, taken: 0, kills: 0, casts: 0, attacks: 0, healed: 0, healOffered: 0, healHits: 0, boosts: 0, boosted: 0, survived: true, killedBy: null, victims: [] });
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
      if (killer && units.has(e.id)) { killer.kills++; killer.victims.push(units.get(e.id).unitId); u.killedBy = killer.unitId; }
    } else if (e.type === 'cast') {
      const u = units.get(e.id);
      if (u) u.casts++;
    } else if (e.type === 'attack') {
      const u = units.get(e.id);
      if (u) u.attacks++;
    } else if (e.type === 'boost') {
      // Power charges given to allies, credited to the giver.
      const g = units.get(owner.get(e.by));
      if (g) { g.boosts++; g.boosted += e.amount; }
    } else if (e.type === 'heal') {
      // Healing done, credited to the healer: HP actually restored, HP it
      // offered (restored + wasted over max HP), and allies it reached.
      for (const [id, [got, offered]] of Object.entries(e.from ?? {})) {
        const h = units.get(owner.get(Number(id)));
        if (h) { h.healed += got; h.healOffered += offered; h.healHits++; }
      }
    }
  }
  return { round, winner: result.winner, ticks: result.ticks, units: [...units.values()] };
}

// ---- jobs ------------------------------------------------------------------------

export function makeJobs(games, { randomOnly = false, smart = false } = {}) {
  const mode = smart === 'classic' ? 'smart-classic' : smart ? 'smart' : 'default';
  const placement = [mode, mode];
  const troops = troopIds(catalog);
  for (const [name, team] of Object.entries(ARCHETYPES)) {
    if (team.length !== 6 || new Set(team).size !== 6 || !team.every((t) => troops.includes(t))) throw new Error(`Archetype "${name}" is not 6 distinct troops`);
  }
  const jobs = [];
  // Random teams: a seeded shuffle per game.
  for (let i = 0; i < games; i++) {
    const seed = hashSeed(`random-${i}`);
    const pick = (salt) => [...troops].map((t, k) => [hashSeed(`${seed}-${salt}-${t}-${k}`), t]).sort((a, b) => a[0] - b[0]).slice(0, 6).map((x) => x[1]);
    jobs.push({ kind: 'random', seed, teams: [pick('a'), pick('b')], placement });
  }
  if (randomOnly) return jobs;
  // Archetypes: every ordered pair (so each plays both sides), several seeds.
  const names = Object.keys(ARCHETYPES);
  const per = Math.max(10, Math.round(games / 40));
  for (const a of names) for (const b of names) {
    if (a === b) continue;
    for (let k = 0; k < per; k++) jobs.push({ kind: 'archetype', seed: hashSeed(`arch-${a}-${b}-${k}`), teams: [ARCHETYPES[a], ARCHETYPES[b]], arche: [a, b], placement });
  }
  return jobs;
}

// ---- workers -----------------------------------------------------------------------

// Play `jobs` across all CPU cores, with an optional stat patch. Each core
// pulls small batches from a shared queue as it finishes the last, so a core
// that drew long games never holds everyone else up. Results come back in job
// order. onProgress(done, total) is called after each batch.
export async function runJobs(jobs, patch = null, { onProgress } = {}) {
  const n = Math.max(1, Math.min(cpus().length, jobs.length));
  const batch = Math.max(1, Math.min(25, Math.ceil(jobs.length / (n * 8))));
  const results = new Array(jobs.length);
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { patch } });
    const feed = () => {
      if (next >= jobs.length) { w.terminate(); resolve(); return; }
      const from = next;
      next = Math.min(jobs.length, next + batch);
      w.postMessage({ from, jobs: jobs.slice(from, next) });
    };
    w.on('message', ({ from, out }) => {
      out.forEach((r, i) => { results[from + i] = r; });
      done += out.length;
      onProgress?.(done, jobs.length);
      feed();
    });
    w.once('error', reject);
    feed();
  })));
  return results;
}

// A progress line on the terminal (only when there is one to draw on).
export function progressBar(label = 'games') {
  if (!process.stderr.isTTY) return undefined;
  const t0 = Date.now();
  let shown = 0;
  return (done, total) => {
    if (done < total && Date.now() - shown < 250) return;
    shown = Date.now();
    const secs = (Date.now() - t0) / 1000;
    const eta = done ? Math.round((secs * (total - done)) / done) : 0;
    process.stderr.write(`\r${done}/${total} ${label} · ${secs.toFixed(0)}s${done < total ? ` · about ${eta}s left` : ''}   ${done === total ? '\n' : ''}`);
  };
}

if (!isMainThread) {
  applyPatch(catalog, workerData.patch ?? {});
  parentPort.on('message', ({ from, jobs }) => {
    const out = jobs.map((job) => ({ ...job, ...playGame(job.seed, job.teams, job.placement, { explore: job.explore }) }));
    parentPort.postMessage({ from, out });
  });
} else if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const games = Number(args[0] ?? 4000);
  const outPath = args[1] ?? new URL('./out/balance.json', import.meta.url).pathname;
  const patch = args[2] ? JSON.parse(readFileSync(args[2], 'utf8')) : null;
  const smartArg = process.argv.find((a) => a.startsWith('--smart'));
  const jobs = makeJobs(games, { randomOnly: process.argv.includes('--random-only'), smart: smartArg === '--smart=classic' ? 'classic' : Boolean(smartArg) });
  const t0 = Date.now();
  const results = await runJobs(jobs, patch, { onProgress: progressBar() });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), catalog: applyPatch(catalog, patch ?? {}), archetypes: ARCHETYPES, games: results }));
  console.log(`${results.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outPath}`);
}
