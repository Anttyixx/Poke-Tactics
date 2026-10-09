// Game rules. The entire match lives in one plain JSON-serializable `state`
// object, and the ONLY way to change it is applyIntent(state, catalog, player, intent).
//
// That is deliberate groundwork for Phase 3 (host-authoritative multiplayer):
//   - the local UI, the bot, and (later) the remote guest all send the same intents
//   - the host runs applyIntent, which validates everything (guest input is untrusted)
//   - the host then broadcasts the resulting state to both clients
//
// Flow: each player builds a team of TEAM_SIZE troops. Every troop puts
// COPIES_PER_TROOP copies into that player's own pool. The shop shows SHOP_SIZE
// copies drawn from the pool; buying one places it straight onto the board and
// removes that copy from the pool. There is no bench and no limit on how many
// troops are on the board (which starts empty), but each troop can only be there once: buying a troop
// you already field levels that one up instead (1 copy = 0★, 2 = 1★, 3 = 2★, 4 = 3★).
//
// Intents:
//   { type: 'chooseTeam', troops }            before round 1; troops = TEAM_SIZE distinct troop ids
//   { type: 'buy', slot, x, y }               buy shop slot onto empty own square (x, y); if that troop is
//                                             already on the board it levels up instead (x, y ignored)
//   { type: 'sell', uid }                     sell a troop; its copies go back to the pool
//   { type: 'reroll' }                        new shop; uses one of the player's free rerolls
//   { type: 'move', uid, x, y }               move on the board; onto another unit = swap
//   { type: 'ready' }                         lock in planning; combat starts when all are ready
//   { type: 'continue' }                      done watching combat; next round starts when all continue

import { randInt } from './rng.js';
import { simulate, COLS, HALF } from './combat.js';

export const TEAM_SIZE = 6;
export const COPIES_PER_TROOP = 4;
export const SHOP_SIZE = 3;
export const START_HP = 100;
// Economy: coins carry over between rounds with no cap. After each battle the
// winner earns WIN_COINS and the loser LOSS_COINS (a draw pays both LOSS_COINS).
export const START_COINS = 6;
export const WIN_COINS = 6;
export const LOSS_COINS = 9;
// Rerolls are free but limited: start with MAX_REROLLS, +1 each new round, capped.
export const MAX_REROLLS = 3;
export const REROLLS_PER_ROUND = 1;
export const MAX_STAR = COPIES_PER_TROOP - 1; // stars = copies - 1

export const copiesOf = (inst) => inst.star + 1;
export const sellValue = (catalog, inst) => catalog[inst.unitId].cost * copiesOf(inst);
// Pokémon players can pick; summoned-only units (e.g. Combee) are never in a team.
export const troopIds = (catalog) => Object.keys(catalog).filter((id) => !catalog[id].summon).sort();
// How many troops a team needs (fewer only if the catalog doesn't have enough).
export const teamSize = (catalog) => Math.min(TEAM_SIZE, troopIds(catalog).length);
// The troop of this species already on the board, if any (never more than one).
export const fielded = (player, unitId) => player.board.find((u) => u.unitId === unitId);
export const poolSize = (player) => Object.values(player.pool).reduce((a, b) => a + b, 0);

const OK = Object.freeze({ ok: true });
const fail = (error) => ({ ok: false, error });
const isIndex = (v, n) => Number.isInteger(v) && v >= 0 && v < n;

// `featured` (optional, for testing): a troop id that is put in the first shop
// slot whenever the player's pool still has a copy of it. Invalid ids are ignored.
export function createGame({ seed, catalog, names, featured = null }) {
  return {
    version: 3,
    seed: seed >>> 0,
    featured: troopIds(catalog).includes(featured) ? featured : null,
    round: 0,
    phase: 'team', // team -> planning -> combat -> planning ... -> gameover
    nextUid: 1,
    players: names.map((name, i) => ({
      name,
      hp: START_HP,
      coins: START_COINS,
      rerolls: MAX_REROLLS,
      team: [], // chosen troop ids
      pool: {}, // troop id -> copies left to buy
      shop: [],
      board: [],
      // The lineup this player fought with last round. Public: both players
      // watched that fight, so the planning screen can show it to the opponent.
      lastBoard: [],
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
  chooseTeam(state, catalog, player, { troops }) {
    if (state.phase !== 'team') return fail('Teams have already been chosen');
    if (player.ready) return fail('You already chose your team');
    const available = troopIds(catalog);
    const need = teamSize(catalog);
    if (!Array.isArray(troops) || troops.length !== need || new Set(troops).size !== need
      || !troops.every((t) => available.includes(t))) return fail(`Pick ${need} different troops`);

    player.team = [...troops].sort();
    player.pool = Object.fromEntries(player.team.map((t) => [t, COPIES_PER_TROOP]));
    player.board = [];
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
    if (player.coins < cost) return fail('Not enough coins');
    if (!(player.pool[unitId] > 0)) return fail('No copies left in your pool');

    const existing = fielded(player, unitId);
    if (existing) {
      // No duplicates on the field: the copy levels up the one already there.
      existing.star++; // can't pass MAX_STAR: only COPIES_PER_TROOP copies exist
    } else {
      if (!isIndex(x, COLS) || !isIndex(y, HALF)) return fail('Place troops on your half of the board');
      if (unitAt(player, x, y)) return fail('That square is taken. Pick an empty square');
      player.board.push({ uid: state.nextUid++, unitId, star: 0, x, y });
    }
    player.coins -= cost;
    player.pool[unitId]--;
    player.shop[slot] = null;
    return OK;
  },

  sell(state, catalog, player, { uid }) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    const inst = player.board.find((u) => u.uid === uid);
    if (!inst) return fail('You do not own that unit');
    player.board.splice(player.board.indexOf(inst), 1);
    player.coins += sellValue(catalog, inst);
    player.pool[inst.unitId] += copiesOf(inst);
    return OK;
  },

  reroll(state, catalog, player) {
    const blocked = planningGuard(state, player);
    if (blocked) return blocked;
    if (player.rerolls <= 0) return fail('No rerolls left this round');
    player.rerolls--;
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
    if (state.round > 1) p.rerolls = Math.min(MAX_REROLLS, p.rerolls + REROLLS_PER_ROUND);
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
  for (const p of state.players) p.lastBoard = p.board.map(({ unitId, star, x, y }) => ({ unitId, star, x, y }));
  state.phase = 'combat';
  for (const p of state.players) p.ready = false;
}

// Damage is applied only after everyone has watched the fight, so the HUD
// never spoils the result while combat is still animating.
function endRound(state, catalog) {
  const { result, damage } = state.combat;
  state.players.forEach((p, i) => {
    p.hp = Math.max(0, p.hp - damage[i]);
    p.coins += result.winner === i ? WIN_COINS : LOSS_COINS;
  });
  const alive = state.players.map((p, i) => (p.hp > 0 ? i : -1)).filter((i) => i !== -1);
  if (alive.length < state.players.length) {
    state.phase = 'gameover';
    state.winner = alive.length === 1 ? alive[0] : null;
    return;
  }
  startRound(state, catalog);
}
