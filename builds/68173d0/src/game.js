// Game rules. The entire match lives in one plain JSON-serializable `state`
// object, and the ONLY way to change it is applyIntent(state, catalog, player, intent).
//
// That is deliberate groundwork for Phase 3 (host-authoritative multiplayer):
//   - the local UI, the bot, and (later) the remote guest all send the same intents
//   - the host runs applyIntent, which validates everything (guest input is untrusted)
//   - the host then broadcasts the resulting state to both clients
//
// Flow: each player builds a team (1 leader + TEAM_SIZE troops). Every troop puts
// COPIES_PER_TROOP copies into that player's own pool. The shop shows SHOP_SIZE
// copies drawn from the pool; buying one places it straight onto the board and
// removes that copy from the pool. Placing a copy on the same troop combines them:
// 1 copy = 0★, 2 = 1★, 3 = 2★, 4 = 3★. There is no bench.
//
// Intents:
//   { type: 'chooseTeam', leader, troops }    before round 1; troops = TEAM_SIZE distinct troop ids
//   { type: 'buy', slot, x, y }               buy shop slot onto own square (x, y); same troop = combine
//   { type: 'sell', uid }                     sell a troop; its copies go back to the pool
//   { type: 'reroll' }                        new shop for REROLL_COST gold
//   { type: 'move', uid, x, y }               move on the board; same troop = combine, other = swap
//   { type: 'ready' }                         lock in planning; combat starts when all are ready
//   { type: 'continue' }                      done watching combat; next round starts when all continue

import { randInt } from './rng.js?v=68173d0';
import { simulate, COLS, HALF } from './combat.js?v=68173d0';

export const TEAM_SIZE = 5;
export const COPIES_PER_TROOP = 4;
export const SHOP_SIZE = 3;
export const START_HP = 100;
export const REROLL_COST = 2;
export const BASE_INCOME = 5;
export const WIN_BONUS = 1;
export const MAX_INTEREST = 5;
export const MAX_STAR = COPIES_PER_TROOP - 1; // stars = copies - 1

export const boardCap = (round) => Math.min(8, 3 + Math.floor((round - 1) / 2));
export const interest = (gold) => Math.min(MAX_INTEREST, Math.floor(gold / 10));
export const copiesOf = (inst) => inst.star + 1;
export const sellValue = (catalog, inst) => catalog[inst.unitId].cost * copiesOf(inst);
export const leaderIds = (catalog) => Object.keys(catalog).filter((id) => catalog[id].leader).sort();
export const troopIds = (catalog) => Object.keys(catalog).filter((id) => !catalog[id].leader).sort();
// How many troops a team needs (fewer only if the catalog doesn't have enough).
export const teamSize = (catalog) => Math.min(TEAM_SIZE, troopIds(catalog).length);
// Units counting toward the board cap. The leader is always on the field for free.
export const fieldCount = (player) => player.board.filter((u) => !u.leader).length;
export const poolSize = (player) => Object.values(player.pool).reduce((a, b) => a + b, 0);

const OK = Object.freeze({ ok: true });
const fail = (error) => ({ ok: false, error });
const isIndex = (v, n) => Number.isInteger(v) && v >= 0 && v < n;

// `featured` (optional, for testing): a troop id that is put in the first shop
// slot whenever the player's pool still has a copy of it. Invalid ids are ignored.
export function createGame({ seed, catalog, names, featured = null }) {
  return {
    version: 2,
    seed: seed >>> 0,
    featured: troopIds(catalog).includes(featured) ? featured : null,
    round: 0,
    phase: 'team', // team -> planning -> combat -> planning ... -> gameover
    nextUid: 1,
    players: names.map((name, i) => ({
      name,
      hp: START_HP,
      gold: 0,
      leader: null, // unitId of the chosen leader
      team: [], // chosen troop ids
      pool: {}, // troop id -> copies left to buy
      shop: [],
      board: [],
      ready: false,
      // Per-player RNG so one player's rerolls never change the other's shops,
      // regardless of the order the host receives intents in.
      rng: (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0,
    })),
    combat: null, // { round, result, damage: [p0, p1] } while phase === 'combat'
    winner: null, // player index, or null for a draw, once phase === 'gameover'
  };
}

export function applyIntent(state, catalog, playerIndex, intent) {
  const player = state.players[playerIndex];
  if (!player) return fail('Unknown player');
  if (!intent || typeof intent !== 'object' || !Object.hasOwn(HANDLERS, intent.type)) return fail('Malformed intent');
  return HANDLERS[intent.type](state, catalog, player, intent);
}

const HANDLERS = {
  chooseTeam(state, catalog, player, { leader, troops }) {
    if (state.phase !== 'team') return fail('Teams have already been chosen');
    if (player.ready) return fail('You already chose your team');
    if (!leaderIds(catalog).includes(leader)) return fail('Pick a leader');
    const available = troopIds(catalog);
    const need = teamSize(catalog);
    if (!Array.isArray(troops) || troops.length !== need || new Set(troops).size !== need
      || !troops.every((t) => available.includes(t))) return fail(`Pick ${need} different troops`);

    player.leader = leader;
    player.team = [...troops].sort();
    player.pool = Object.fromEntries(player.team.map((t) => [t, COPIES_PER_TROOP]));
    // Melee leaders start on the front line, ranged ones at the back, both centred.
    player.board = [{ uid: state.nextUid++, unitId: leader, star: 0, leader: true, x: Math.floor((COLS - 1) / 2), y: catalog[leader].range > 1 ? HALF - 1 : 0 }];
    player.ready = true;
    if (state.players.every((p) => p.ready)) startRound(state, catalog);
    return OK;
  },

  buy(state, catalog, player, { slot, x, y }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    if (!isIndex(slot, SHOP_SIZE) || !player.shop[slot]) return fail('Nothing to buy there');
    const unitId = player.shop[slot];
    const { cost } = catalog[unitId];
    if (player.gold < cost) return fail('Not enough gold');
    if (!(player.pool[unitId] > 0)) return fail('No copies left in your pool');
    if (!isIndex(x, COLS) || !isIndex(y, HALF)) return fail('Place troops on your half of the board');

    const occupant = unitAt(player, x, y);
    if (occupant) {
      if (occupant.leader || occupant.unitId !== unitId) return fail(`That square is taken. Place it on an empty square or on a ${catalog[unitId].name}`);
      occupant.star++; // can't pass MAX_STAR: only COPIES_PER_TROOP copies exist
    } else {
      if (fieldCount(player) >= boardCap(state.round)) return fail(`Board is full (${boardCap(state.round)} troops this round)`);
      player.board.push({ uid: state.nextUid++, unitId, star: 0, x, y });
    }
    player.gold -= cost;
    player.pool[unitId]--;
    player.shop[slot] = null;
    return OK;
  },

  sell(state, catalog, player, { uid }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    const inst = player.board.find((u) => u.uid === uid);
    if (!inst) return fail('You do not own that unit');
    if (inst.leader) return fail('Your leader cannot be sold');
    player.board.splice(player.board.indexOf(inst), 1);
    player.gold += sellValue(catalog, inst);
    player.pool[inst.unitId] += copiesOf(inst);
    return OK;
  },

  reroll(state, catalog, player) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    if (player.gold < REROLL_COST) return fail('Not enough gold');
    player.gold -= REROLL_COST;
    rollShop(player, state.featured);
    return OK;
  },

  move(state, catalog, player, { uid, x, y }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    const inst = player.board.find((u) => u.uid === uid);
    if (!inst) return fail('You do not own that unit');
    if (!isIndex(x, COLS) || !isIndex(y, HALF)) return fail('You can only place units on your half');
    const occupant = unitAt(player, x, y);
    if (occupant === inst) return OK;
    if (occupant && !occupant.leader && !inst.leader && occupant.unitId === inst.unitId) {
      // Combine: all copies end up on the target square.
      occupant.star += copiesOf(inst);
      player.board.splice(player.board.indexOf(inst), 1);
      return OK;
    }
    if (occupant) { occupant.x = inst.x; occupant.y = inst.y; }
    inst.x = x;
    inst.y = y;
    return OK;
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

const unitAt = (player, x, y) => player.board.find((u) => u.x === x && u.y === y);

// Draw SHOP_SIZE different copies from the pool (without replacement), so the
// shop never offers more copies of a troop than the pool holds.
function rollShop(player, featured) {
  const bag = Object.keys(player.pool).sort().flatMap((id) => Array(player.pool[id]).fill(id));
  const shop = [];
  if (featured && bag.includes(featured)) shop.push(...bag.splice(bag.indexOf(featured), 1));
  while (shop.length < SHOP_SIZE && bag.length) shop.push(...bag.splice(randInt(player, bag.length), 1));
  while (shop.length < SHOP_SIZE) shop.push(null);
  player.shop = shop;
}

function startRound(state, catalog) {
  state.round++;
  state.phase = 'planning';
  state.combat = null;
  for (const p of state.players) {
    p.gold += BASE_INCOME + interest(p.gold);
    p.ready = false;
    rollShop(p, state.featured);
  }
}

export function roundDamage(result, round) {
  if (result.winner === null) return [Math.ceil(round / 2), Math.ceil(round / 2)];
  const damage = [0, 0];
  const copies = result.survivors.reduce((sum, u) => sum + u.star + 1, 0);
  damage[1 - result.winner] = round + 2 * copies;
  return damage;
}

function beginCombat(state, catalog) {
  // Per-round combat seed derived from the match seed, so fights replay exactly.
  const result = simulate(catalog, state.players.map((p) => p.board), (state.seed + Math.imul(state.round, 0x9e3779b9)) >>> 0);
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
