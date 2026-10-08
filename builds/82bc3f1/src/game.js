// Game rules. The entire match lives in one plain JSON-serializable `state`
// object, and the ONLY way to change it is applyIntent(state, catalog, player, intent).
//
// That is deliberate groundwork for Phase 3 (host-authoritative multiplayer):
//   - the local UI, the bot, and (later) the remote guest all send the same intents
//   - the host runs applyIntent, which validates everything (guest input is untrusted)
//   - the host then broadcasts the resulting state to both clients
//
// Intents:
//   { type: 'chooseLeader', leader }          pick a leader before round 1
//   { type: 'buy', slot }                     buy shop slot 0..SHOP_SIZE-1
//   { type: 'sell', uid }                     sell an owned unit
//   { type: 'reroll' }                        new shop for REROLL_COST gold
//   { type: 'move', uid, to }                 to = { area: 'board', x, y } | { area: 'bench', index }
//   { type: 'ready' }                         lock in planning; combat starts when all are ready
//   { type: 'continue' }                      done watching combat; next round starts when all continue

import { randInt } from './rng.js?v=82bc3f1';
import { simulate, COLS, HALF } from './combat.js?v=82bc3f1';

export const SHOP_SIZE = 5;
export const BENCH_SIZE = 8;
export const START_HP = 100;
export const REROLL_COST = 2;
export const BASE_INCOME = 5;
export const WIN_BONUS = 1;
export const MAX_INTEREST = 5;
export const MAX_STAR = 3;

// [first round, shop odds (%) for cost 1, 2, 3]
const TIER_ODDS = [
  [11, [25, 45, 30]],
  [8, [40, 40, 20]],
  [5, [55, 35, 10]],
  [3, [75, 25, 0]],
  [1, [100, 0, 0]],
];

export const boardCap = (round) => Math.min(8, 3 + Math.floor((round - 1) / 2));
export const interest = (gold) => Math.min(MAX_INTEREST, Math.floor(gold / 10));
export const sellValue = (catalog, inst) => catalog[inst.unitId].cost * 3 ** (inst.star - 1);
export const tierOdds = (round) => TIER_ODDS.find(([from]) => round >= from)[1];
export const leaderIds = (catalog) => Object.keys(catalog).filter((id) => catalog[id].leader).sort();
// Units counting toward the board cap. The leader is always on the field for free.
export const fieldCount = (player) => player.board.filter((u) => !u.leader).length;

const OK = Object.freeze({ ok: true });
const fail = (error) => ({ ok: false, error });
const isIndex = (v, n) => Number.isInteger(v) && v >= 0 && v < n;

// `featured` (optional, for testing): a buyable unit id that is put in the first
// slot of every shop roll for every player, from round 1. Invalid ids are ignored.
export function createGame({ seed, catalog, names, featured = null }) {
  const state = {
    version: 1,
    seed: seed >>> 0,
    featured: Object.hasOwn(catalog, featured ?? '') && !catalog[featured].leader ? featured : null,
    round: 0,
    phase: 'leader', // leader -> planning -> combat -> planning ... -> gameover
    nextUid: 1,
    players: names.map((name, i) => ({
      name,
      hp: START_HP,
      gold: 0,
      shop: [],
      bench: Array(BENCH_SIZE).fill(null),
      board: [],
      ready: false,
      leader: null, // unitId of the chosen leader
      // Per-player RNG so one player's rerolls never change the other's shops,
      // regardless of the order the host receives intents in.
      rng: (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0,
    })),
    combat: null, // { round, result, damage: [p0, p1] } while phase === 'combat'
    winner: null, // player index, or null for a draw, once phase === 'gameover'
  };
  return state;
}

export function applyIntent(state, catalog, playerIndex, intent) {
  const player = state.players[playerIndex];
  if (!player) return fail('Unknown player');
  if (!intent || typeof intent !== 'object' || !Object.hasOwn(HANDLERS, intent.type)) return fail('Malformed intent');
  return HANDLERS[intent.type](state, catalog, player, intent);
}

const HANDLERS = {
  chooseLeader(state, catalog, player, { leader }) {
    if (state.phase !== 'leader') return fail('Leaders have already been chosen');
    if (player.ready) return fail('You already chose a leader');
    if (typeof leader !== 'string' || !Object.hasOwn(catalog, leader) || !catalog[leader].leader) return fail('Unknown leader');
    player.leader = leader;
    // Melee leaders start on the front line, ranged ones at the back, both centred.
    player.board = [{ uid: state.nextUid++, unitId: leader, star: 1, leader: true, x: Math.floor((COLS - 1) / 2), y: catalog[leader].range > 1 ? HALF - 1 : 0 }];
    player.ready = true;
    if (state.players.every((p) => p.ready)) startRound(state, catalog);
    return OK;
  },

  buy(state, catalog, player, { slot }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    if (!isIndex(slot, SHOP_SIZE) || !player.shop[slot]) return fail('Nothing to buy there');
    const unitId = player.shop[slot];
    const cost = catalog[unitId].cost;
    if (player.gold < cost) return fail('Not enough gold');
    const free = player.bench.indexOf(null);
    const copies = ownedUnits(player).filter((u) => u.unitId === unitId && u.star === 1);
    if (free === -1 && copies.length < 2) return fail('Bench is full');

    player.gold -= cost;
    player.shop[slot] = null;
    const inst = { uid: state.nextUid++, unitId, star: 1 };
    if (free !== -1) {
      player.bench[free] = inst;
      tryMerge(player, inst);
    } else {
      // Bench full but this copy completes a 3-of-a-kind: merge without placing it.
      combine(player, [inst, copies[0], copies[1]]);
    }
    return OK;
  },

  sell(state, catalog, player, { uid }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    const inst = ownedUnits(player).find((u) => u.uid === uid);
    if (!inst) return fail('You do not own that unit');
    if (inst.leader) return fail('Your leader cannot be sold');
    removeUnit(player, inst);
    player.gold += sellValue(catalog, inst);
    return OK;
  },

  reroll(state, catalog, player) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    if (player.gold < REROLL_COST) return fail('Not enough gold');
    player.gold -= REROLL_COST;
    rollShop(player, catalog, state.round, state.featured);
    return OK;
  },

  move(state, catalog, player, { uid, to }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    const inst = ownedUnits(player).find((u) => u.uid === uid);
    if (!inst) return fail('You do not own that unit');
    if (!to || typeof to !== 'object') return fail('Malformed move');
    const fromBoard = player.board.includes(inst);

    if (to.area === 'board') {
      const { x, y } = to;
      if (!isIndex(x, COLS) || !isIndex(y, HALF)) return fail('You can only place units on your half');
      const occupant = player.board.find((u) => u.x === x && u.y === y);
      if (occupant === inst) return OK;
      if (fromBoard) {
        if (occupant) { occupant.x = inst.x; occupant.y = inst.y; }
      } else {
        const benchIndex = player.bench.indexOf(inst);
        if (occupant?.leader) return fail('Your leader must stay on the field');
        if (occupant) {
          removeUnit(player, occupant);
          player.bench[benchIndex] = toBench(occupant);
        } else {
          if (fieldCount(player) >= boardCap(state.round)) return fail(`Board is full (${boardCap(state.round)} units this round)`);
          player.bench[benchIndex] = null;
        }
        player.board.push(inst);
      }
      inst.x = x;
      inst.y = y;
      return OK;
    }

    if (to.area === 'bench') {
      const { index } = to;
      if (!isIndex(index, BENCH_SIZE)) return fail('Invalid bench slot');
      const occupant = player.bench[index];
      if (occupant === inst) return OK;
      if (inst.leader) return fail('Your leader must stay on the field');
      if (fromBoard) {
        removeUnit(player, inst);
        if (occupant) {
          occupant.x = inst.x;
          occupant.y = inst.y;
          player.bench[index] = null;
          player.board.push(occupant);
        }
        player.bench[index] = toBench(inst);
      } else {
        player.bench[player.bench.indexOf(inst)] = occupant;
        player.bench[index] = inst;
      }
      return OK;
    }

    return fail('Malformed move');
  },

  ready(state, catalog, player) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    player.ready = true;
    if (state.players.every((p) => p.ready)) beginCombat(state, catalog);
    return OK;
  },

  continue(state, catalog, player) {
    if (state.phase !== 'combat') return fail('No combat to continue from');
    if (player.ready) return fail('Already continued');
    player.ready = true;
    if (state.players.every((p) => p.ready)) endRound(state, catalog);
    return OK;
  },
};

function planningGuard(state, player) {
  if (state.phase !== 'planning') return fail('Not in the planning phase');
  if (player.ready) return fail('You are locked in for this round');
  return null;
}

export function ownedUnits(player) {
  return [...player.board, ...player.bench.filter(Boolean)];
}

function toBench(inst) {
  delete inst.x;
  delete inst.y;
  return inst;
}

function removeUnit(player, inst) {
  const b = player.board.indexOf(inst);
  if (b !== -1) player.board.splice(b, 1);
  const s = player.bench.indexOf(inst);
  if (s !== -1) player.bench[s] = null;
}

// Three copies of the same unit at the same star level combine into one of the
// next star level. The upgraded unit stays on the board if any copy was there.
function tryMerge(player, inst) {
  if (inst.star >= MAX_STAR) return;
  const copies = ownedUnits(player).filter((u) => u !== inst && u.unitId === inst.unitId && u.star === inst.star);
  if (copies.length >= 2) combine(player, [inst, copies[0], copies[1]]);
}

function combine(player, group) {
  const keeper = group.find((u) => player.board.includes(u)) ?? group.find((u) => player.bench.includes(u));
  for (const u of group) if (u !== keeper) removeUnit(player, u);
  keeper.star++;
  tryMerge(player, keeper);
}

function rollShop(player, catalog, round, featured) {
  const odds = tierOdds(round);
  const total = odds.reduce((a, b) => a + b, 0);
  const ids = Object.keys(catalog).filter((id) => !catalog[id].leader).sort();
  player.shop = Array.from({ length: SHOP_SIZE }, () => {
    let roll = randInt(player, total);
    let tier = 0;
    while (roll >= odds[tier]) roll -= odds[tier++];
    const pool = ids.filter((id) => catalog[id].cost === tier + 1);
    return pool[randInt(player, pool.length)];
  });
  if (featured) player.shop[0] = featured;
}

function startRound(state, catalog) {
  state.round++;
  state.phase = 'planning';
  state.combat = null;
  for (const p of state.players) {
    p.gold += BASE_INCOME + interest(p.gold);
    p.ready = false;
    rollShop(p, catalog, state.round, state.featured);
  }
}

export function roundDamage(result, round) {
  if (result.winner === null) return [Math.ceil(round / 2), Math.ceil(round / 2)];
  const damage = [0, 0];
  const stars = result.survivors.reduce((sum, u) => sum + u.star, 0);
  damage[1 - result.winner] = round + 2 * stars;
  return damage;
}

function beginCombat(state, catalog) {
  const result = simulate(catalog, state.players.map((p) => p.board));
  state.combat = { round: state.round, result, damage: roundDamage(result, state.round) };
  state.phase = 'combat';
  for (const p of state.players) p.ready = false;
}

// Damage is applied only after everyone has watched the fight, so the HUD
// never spoils the result while combat is still animating.
function endRound(state, catalog) {
  const { result, damage } = state.combat;
  state.players.forEach((p, i) => {
    p.hp = Math.max(0, p.hp - damage[i]);
    if (result.winner === i) p.gold += WIN_BONUS;
  });
  const alive = state.players.map((p, i) => (p.hp > 0 ? i : -1)).filter((i) => i !== -1);
  if (alive.length < state.players.length) {
    state.phase = 'gameover';
    state.winner = alive.length === 1 ? alive[0] : null;
    return;
  }
  startRound(state, catalog);
}
