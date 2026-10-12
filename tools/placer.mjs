// Smart placement for simulated players: before a fight, try many arrangements
// of your own Pokémon against the opponent's lineup from last round (what a
// real player sees on the board) and keep the one that does best, judged by the
// real battle engine. Moves go through the game's own 'move' intent.

import { simulate, COLS, HALF } from '../src/combat.js';
import { hashSeed } from '../src/rng.js';

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
    const r = simulate(catalog, boards, seed);
    const hpShare = r.survivors.reduce((s, u) => s + u.hp / u.maxHp, 0) / Math.max(1, (r.winner === p ? mine : theirs).length);
    total += r.winner === null ? 0 : r.winner === p ? 1 + hpShare : -1 - hpShare;
  }
  return total / seeds.length;
}

// Candidate layouts: the current one, random ones (half with melee in front,
// ranged behind), then small improvements (move or swap one Pokémon).
export function bestLayout(catalog, state, p, { tries = 24, climb = 24, seeds = 2 } = {}) {
  const me = state.players[p];
  const foe = state.players[1 - p];
  if (!me.board.length || !foe.lastBoard?.length) return null; // nothing to react to yet
  const theirs = foe.lastBoard.map((u, i) => ({ ...u, uid: 100000 + i }));
  const rand = rng(hashSeed(`${state.seed}:${state.round}:${p}:place`));
  const fightSeeds = Array.from({ length: seeds }, (_, i) => hashSeed(`${state.seed}:${state.round}:${p}:${i}`));
  const units = me.board.map((u) => ({ ...u }));
  const layoutOf = (cells) => units.map((u, i) => ({ ...u, x: cells[i].x, y: cells[i].y }));
  const evalCells = (cells) => score(catalog, p, layoutOf(cells), theirs, fightSeeds);

  let best = units.map((u) => ({ x: u.x, y: u.y }));
  let bestScore = evalCells(best);
  const consider = (cells) => {
    const s = evalCells(cells);
    if (s > bestScore) { best = cells; bestScore = s; }
  };
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
  return units.map((u, i) => ({ uid: u.uid, x: best[i].x, y: best[i].y }));
}

// Rearrange the board into `layout` with the game's move intent. Moving onto a
// Pokémon swaps the two; since no two Pokémon share a target square, nobody who
// is already in place gets swapped out again, so one pass is enough.
export function applyLayout(layout, send) {
  for (const { uid, x, y } of layout) send({ type: 'move', uid, x, y });
}
