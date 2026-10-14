// Smart placement for simulated players: before a fight, try many arrangements
// of your own Pokémon against the opponent's lineup from last round (what a
// real player sees on the board) and keep the one that does best, judged by the
// real battle engine. Moves go through the game's own 'move' intent.

import { simulate, COLS, HALF } from '../src/combat.js';
import { hashSeed } from '../src/rng.js';
import { planLayout } from '../src/bot.js';

const CELLS = [];
for (let y = 0; y < HALF; y++) for (let x = 0; x < COLS; x++) CELLS.push({ x, y });

// Small deterministic RNG so simulated games replay exactly.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How good `mine` is against `theirs` for player `p`: a win counts 1 plus the
// share of HP left standing; a loss -1 minus the enemy's share left.
function score(catalog, p, mine, theirs, seeds) {
  let total = 0;
  for (const seed of seeds) {
    const boards = p === 0 ? [mine, theirs] : [theirs, mine];
    const r = simulate(catalog, boards, seed, { record: false });
    const hpShare = r.survivors.reduce((s, u) => s + u.hp / u.maxHp, 0) / Math.max(1, (r.winner === p ? mine : theirs).length);
    total += r.winner === null ? 0 : r.winner === p ? 1 + hpShare : -1 - hpShare;
  }
  return total / seeds.length;
}

// Candidate layouts: the current one, random ones (half with melee in front,
// ranged behind), then small improvements (move or swap one Pokémon). Each is
// scored with one trial fight; the best few get `seeds` more before choosing.
export function bestLayout(catalog, state, p, { tries = 16, climb = 20, finalists = 4, seeds = 2 } = {}) {
  const me = state.players[p];
  const foe = state.players[1 - p];
  if (!me.board.length || !foe.lastBoard?.length) return null; // nothing to react to yet
  const theirs = foe.lastBoard.map((u, i) => ({ ...u, uid: 100000 + i }));
  const rand = rng(hashSeed(`${state.seed}:${state.round}:${p}:place`));
  const fightSeeds = Array.from({ length: seeds + 1 }, (_, i) => hashSeed(`${state.seed}:${state.round}:${p}:${i}`));
  const units = me.board.map((u) => ({ ...u }));
  const layoutOf = (cells) => units.map((u, i) => ({ ...u, x: cells[i].x, y: cells[i].y }));
  const keyOf = (cells) => cells.map((c) => c.y * COLS + c.x).join(',');
  const tried = new Map(); // layout -> { cells, score } (one trial fight each)

  let best = units.map((u) => ({ x: u.x, y: u.y }));
  let bestScore = -Infinity;
  const consider = (cells) => {
    const key = keyOf(cells);
    if (tried.has(key)) return;
    const s = score(catalog, p, layoutOf(cells), theirs, fightSeeds.slice(0, 1));
    tried.set(key, { cells, score: s });
    if (s > bestScore) { best = cells; bestScore = s; }
  };
  consider(best);
  const shuffled = () => [...CELLS].sort(() => rand() - 0.5);
  for (let k = 0; k < tries; k++) {
    if (k % 2 === 0) {
      consider(shuffled().slice(0, units.length));
    } else {
      // Melee near the front, ranged near the back.
      const front = shuffled().sort((a, b) => a.y - b.y);
      const back = [...front].reverse();
      const used = new Set();
      const take = (list) => { const c = list.find((q) => !used.has(q.y * COLS + q.x)); used.add(c.y * COLS + c.x); return c; };
      consider(units.map((u) => take(catalog[u.unitId].range <= 1 ? front : back)));
    }
  }
  for (let k = 0; k < climb; k++) {
    const cells = best.map((c) => ({ ...c }));
    const i = Math.floor(rand() * units.length);
    const target = CELLS[Math.floor(rand() * CELLS.length)];
    const j = cells.findIndex((c) => c.x === target.x && c.y === target.y);
    if (j >= 0) cells[j] = { ...cells[i] };
    cells[i] = { ...target };
    consider(cells);
  }
  // Double-check the leaders with more fights (crits and turn order vary by seed).
  const leaders = [...tried.values()].sort((a, b) => b.score - a.score).slice(0, finalists);
  let pick = leaders[0];
  let pickScore = -Infinity;
  for (const c of leaders) {
    const s = (c.score + seeds * score(catalog, p, layoutOf(c.cells), theirs, fightSeeds.slice(1))) / (seeds + 1);
    if (s > pickScore) { pick = c; pickScore = s; }
  }
  return units.map((u, i) => ({ uid: u.uid, x: pick.cells[i].x, y: pick.cells[i].y }));
}

// Rearrange the board into `layout` with the game's move intent. Moving onto a
// Pokémon swaps the two; since no two Pokémon share a target square, nobody who
// is already in place gets swapped out again, so one pass is enough.
export function applyLayout(layout, send) {
  for (const { uid, x, y } of layout) send({ type: 'move', uid, x, y });
}

// ---- Quick placement (what the balance tools use) -------------------------------
// The same idea as bestLayout, about 3x cheaper:
//  - nothing to do when neither board changed since last round (memo);
//  - it starts from good layouts: the current one, the rule-based bot's plan
//    (src/bot.js), both mirrored left-right, last round's best, plus `tries`
//    random ones (half with melee in front, ranged behind);
//  - candidates are judged by a short fight (`horizon` ticks): the share of HP
//    each side has left, or the result if it ends sooner;
//  - a short hill climb (move or swap one Pokémon), then the two best get
//    `seeds` full-length fights each before choosing.
// `memo` is one object per player per game; it remembers the last answer.
export function quickLayout(catalog, state, p, { climb = 10, horizon = 150, tries = 4, seeds = 1, memo = {} } = {}) {
  const me = state.players[p];
  const foe = state.players[1 - p];
  if (!me.board.length || !foe.lastBoard?.length) return null;
  const units = [...me.board].sort((a, b) => a.uid - b.uid).map((u) => ({ ...u }));
  const key = `${units.map((u) => `${u.uid}:${u.unitId}:${u.star}`).join(',')}|${foe.lastBoard.map((u) => `${u.unitId}:${u.star}:${u.x}:${u.y}`).sort().join(',')}`;
  if (memo.key === key) return memo.layout;
  const theirs = foe.lastBoard.map((u, i) => ({ ...u, uid: 100000 + i }));
  const rand = rng(hashSeed(`${state.seed}:${state.round}:${p}:quick`));
  const quickSeed = hashSeed(`${state.seed}:${state.round}:${p}:q0`);
  const fullSeeds = Array.from({ length: seeds }, (_, i) => hashSeed(`${state.seed}:${state.round}:${p}:q${i + 1}`));
  const layoutOf = (cells) => units.map((u, i) => ({ ...u, x: cells[i].x, y: cells[i].y }));
  const keyOf = (cells) => cells.map((c) => c.y * COLS + c.x).join(',');
  const fight = (cells, seed, maxTicks) => {
    const mine = layoutOf(cells);
    const r = simulate(catalog, p === 0 ? [mine, theirs] : [theirs, mine], seed, { record: false, maxTicks });
    if (r.cut) return r.hpShare[p] - r.hpShare[1 - p];
    const share = r.survivors.reduce((sum, u) => sum + u.hp / u.maxHp, 0) / Math.max(1, (r.winner === p ? mine : theirs).length);
    return r.winner === null ? 0 : r.winner === p ? 1 + share : -1 - share;
  };
  const tried = new Map();
  let best = null;
  let bestScore = -Infinity;
  const consider = (cells) => {
    if (!cells || cells.length !== units.length) return;
    const k = keyOf(cells);
    if (tried.has(k) || new Set(cells.map((c) => c.y * COLS + c.x)).size !== cells.length) return;
    const s = fight(cells, quickSeed, horizon);
    tried.set(k, { cells, score: s });
    if (s > bestScore) { best = cells; bestScore = s; }
  };
  const current = units.map((u) => ({ x: u.x, y: u.y }));
  const mirror = (cells) => cells.map((c) => ({ x: COLS - 1 - c.x, y: c.y }));
  const planned = (() => {
    const cells = current.map((c) => ({ ...c }));
    for (const m of planLayout(state, catalog, p)) { const i = units.findIndex((u) => u.uid === m.uid); if (i >= 0) cells[i] = { x: m.x, y: m.y }; }
    return cells;
  })();
  const last = memo.layout && (() => {
    const at = new Map(memo.layout.map((l) => [l.uid, l]));
    const cells = units.map((u) => (at.has(u.uid) ? { x: at.get(u.uid).x, y: at.get(u.uid).y } : { x: u.x, y: u.y }));
    return new Set(cells.map((c) => c.y * COLS + c.x)).size === cells.length ? cells : null;
  })();
  for (const cells of [current, planned, mirror(planned), mirror(current), last]) consider(cells);
  const shuffled = () => [...CELLS].sort(() => rand() - 0.5);
  for (let k = 0; k < tries; k++) {
    if (k % 2 === 0) { consider(shuffled().slice(0, units.length)); continue; }
    const front = shuffled().sort((a, b) => a.y - b.y);
    const back = [...front].reverse();
    const used = new Set();
    const take = (list) => { const c = list.find((q) => !used.has(q.y * COLS + q.x)); used.add(c.y * COLS + c.x); return c; };
    consider(units.map((u) => take(catalog[u.unitId].range <= 1 ? front : back)));
  }
  for (let k = 0; k < climb; k++) {
    const cells = best.map((c) => ({ ...c }));
    const i = Math.floor(rand() * units.length);
    const target = CELLS[Math.floor(rand() * CELLS.length)];
    const j = cells.findIndex((c) => c.x === target.x && c.y === target.y);
    if (j >= 0) cells[j] = { ...cells[i] };
    cells[i] = { ...target };
    consider(cells);
  }
  const leaders = [...tried.values()].sort((a, b) => b.score - a.score).slice(0, 2);
  let pick = leaders[0];
  let pickScore = -Infinity;
  for (const c of leaders) {
    let s = c.score;
    for (const fs of fullSeeds) s += fight(c.cells, fs);
    if (s > pickScore) { pick = c; pickScore = s; }
  }
  const layout = units.map((u, i) => ({ uid: u.uid, x: pick.cells[i].x, y: pick.cells[i].y }));
  memo.key = key;
  memo.layout = layout;
  return layout;
}
