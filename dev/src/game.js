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
// you already field levels that one up instead (1 copy = ★, 2 = ★★, 3 = ★★★, 4 = shiny; stored as star 0-3).
//
// Intents:
//   { type: 'chooseTeam', troops }            before round 1; troops = TEAM_SIZE distinct troop ids
//   { type: 'buy', slot, x, y }               buy shop slot onto empty own square (x, y); if that troop is
//                                             already on the board it levels up instead (x, y ignored).
//                                             The shop then refreshes for free.
//   { type: 'sell', uid }                     sell a troop; its copies go back to the pool
//   { type: 'reroll' }                        new shop for REROLL_COST coins
//   { type: 'move', uid, x, y }               move on the board; onto another unit = swap
//   { type: 'ready' }                         lock in planning; combat starts when all are ready
//   { type: 'continue' }                      done watching combat; next round starts when all continue

import { randInt, rand, hashSeed } from './rng.js?v=58129a3';
import { simulate, COLS, HALF } from './combat.js?v=58129a3';

export const TEAM_SIZE = 6;
// Arena: ARENA_SIZE players, paired up in 1v1 fights each round (a new
// opponent whenever possible; with an odd number left, one sits the round out).
// The last one standing wins.
export const ARENA_SIZE = 4;
export const COPIES_PER_TROOP = 4;
export const SHOP_SIZE = 3;
export const START_HP = 100;
// Economy: coins carry over between rounds with no cap. Round 1 starts with
// START_COINS. Every later buy phase pays ROUND_COINS plus LOST_COIN for each
// of the player's Pokémon knocked out in the battle just fought (summons
// don't count). Buying refreshes the shop for free; a reroll costs REROLL_COST.
export const START_COINS = 10;
export const ROUND_COINS = 5;
export const LOST_COIN = 1;
export const REROLL_COST = 1;
export const MAX_STAR = COPIES_PER_TROOP - 1; // stars = copies - 1

export const copiesOf = (inst) => inst.star + 1;
export const sellValue = (catalog, inst) => catalog[inst.unitId].cost * copiesOf(inst);
// Pokémon players can pick; summoned-only units (e.g. Combee) are never in a team.
// Pokémon you can pick. "disabled": true in units.json takes one out of the game for now.
export const troopIds = (catalog) => Object.keys(catalog).filter((id) => !catalog[id].summon && !catalog[id].disabled).sort();
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
// `avatars` (optional): each player's profile picture id, for display only.
export function createGame({ seed, catalog, names, avatars = [], featured = null, mode = 'duel' }) {
  const arena = mode === 'arena';
  return {
    version: 3,
    mode: arena ? 'arena' : 'duel',
    ...(arena && { pairs: [], bye: null, met: {}, byes: {}, out: [] }),
    seed: seed >>> 0,
    featured: troopIds(catalog).includes(featured) ? featured : null,
    round: 0,
    phase: 'team', // team -> planning -> combat -> planning ... -> gameover
    nextUid: 1,
    players: names.map((name, i) => ({
      name,
      avatar: avatars[i] ?? null,
      hp: START_HP,
      coins: START_COINS,
      shopRolls: 0, // counts shop refreshes (the UI deals new cards in when it changes)
      lastIncome: null, // { base, lost } paid at the start of this buy phase
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
    combat: null, // { round, result, damage: [p0, p1] } while phase === 'combat' (arena: { round, fights: [{ pair, seed, result, damage }], bye })
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
    rollShop(player, state.featured); // a fresh shop after every purchase, free
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
    if (player.coins < REROLL_COST) return fail('Not enough coins to reroll');
    player.coins -= REROLL_COST;
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
  if (state.mode === 'arena' && player.hp <= 0) return fail('You are out of this match');
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
  player.shopRolls = (player.shopRolls ?? 0) + 1;
}

function startRound(state, catalog) {
  state.round++;
  state.phase = 'planning';
  state.combat = null;
  for (const p of state.players) {
    p.ready = false;
    rollShop(p, state.featured);
  }
  if (state.mode === 'arena') {
    for (const p of state.players) if (p.hp <= 0) p.ready = true; // out: nothing left to do
    pairUp(state);
  }
}

// ---- arena -------------------------------------------------------------------

const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
export const aliveIn = (state) => state.players.map((p, i) => (p.hp > 0 ? i : -1)).filter((i) => i >= 0);

// This round's fights: a new opponent whenever possible (never last round's if
// there's any other way), then whoever has met least often. With an odd number
// left, one player sits out: never the same one twice in a row, fewest byes first.
// Ties are broken by the match seed, so pairings replay exactly.
function pairUp(state) {
  const tie = { rng: hashSeed(`${state.seed}:${state.round}:pairs`) };
  const order = aliveIn(state).map((i) => [rand(tie), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  let pool = order;
  let bye = null;
  if (order.length % 2) {
    const byes = (i) => state.byes[i] ?? 0;
    bye = [...order].sort((a, b) => (a === state.bye) - (b === state.bye) || byes(a) - byes(b))[0];
    pool = order.filter((i) => i !== bye);
    state.byes[bye] = byes(bye) + 1;
  }
  const last = new Set(state.pairs.map(([a, b]) => pairKey(a, b)));
  const cost = (pairs) => pairs.reduce((sum, [a, b]) => sum + (last.has(pairKey(a, b)) ? 100 : 0) + (state.met[pairKey(a, b)] ?? 0), 0);
  let best = null;
  for (const pairs of matchings(pool)) if (!best || cost(pairs) < cost(best)) best = pairs;
  state.pairs = (best ?? []).map(([a, b]) => (a < b ? [a, b] : [b, a]));
  state.bye = bye;
}
// Every way to split `list` into pairs (in the list's order, so the first found wins ties).
function* matchings(list) {
  if (list.length < 2) { yield []; return; }
  const [first, ...rest] = list;
  for (let k = 0; k < rest.length; k++) {
    for (const more of matchings(rest.filter((_, j) => j !== k))) yield [[first, rest[k]], ...more];
  }
}

// Arena: a player who leaves is knocked out on the spot. Returns true if that
// ended the match.
export function forfeit(state, catalog, index) {
  const p = state.players[index];
  if (state.mode !== 'arena' || !p || p.hp <= 0 || state.phase === 'gameover') return false;
  p.hp = 0;
  p.ready = true;
  state.out.push([index]);
  if (aliveIn(state).length <= 1) {
    state.phase = 'gameover';
    state.winner = aliveIn(state)[0] ?? null;
    return true;
  }
  // Their leaving may be all that everyone else was waiting for.
  if (state.players.every((q) => q.ready)) {
    if (state.phase === 'planning') beginCombat(state, catalog);
    else if (state.phase === 'combat') endRound(state, catalog);
    else if (state.phase === 'team') startRound(state, catalog);
  }
  return false;
}

// Where a player finished: 1 for the winner, then by when they were knocked out
// (players knocked out in the same round share a place). null while still in.
export function arenaPlace(state, index) {
  if (state.mode !== 'arena') return null;
  if (state.phase === 'gameover' && state.winner === index) return 1;
  let after = 0; // players knocked out after this one, or still standing
  // A winner decided on HP after everyone left went out together isn't standing, but is ahead.
  const ahead = state.phase === 'gameover' && state.winner !== null && state.players[state.winner].hp <= 0 ? 1 : 0;
  for (let g = state.out.length - 1; g >= 0; g--) {
    if (state.out[g].includes(index)) return 1 + after + aliveIn(state).length + ahead;
    after += state.out[g].length;
  }
  return null;
}

export function roundDamage(result, round) {
  if (result.winner === null) return [Math.ceil(round / 2), Math.ceil(round / 2)];
  const damage = [0, 0];
  const copies = result.survivors.reduce((sum, u) => sum + u.star + 1, 0);
  damage[1 - result.winner] = round + 2 * copies;
  return damage;
}

// How many of player `side`'s own Pokémon were knocked out in a battle.
export function lostCount(result, side) {
  const fielded = result.initial.filter((u) => u.side === side && !u.summoned).length;
  const standing = result.survivors.filter((u) => u.side === side).length;
  return fielded - standing;
}

function beginCombat(state, catalog) {
  // Per-round combat seed derived from the match seed, so fights replay exactly.
  const seed = (state.seed + Math.imul(state.round, 0x9e3779b9)) >>> 0;
  if (state.mode === 'arena') return beginArenaCombat(state, catalog, seed);
  const result = simulate(catalog, state.players.map((p) => p.board), seed);
  state.combat = { round: state.round, seed, result, damage: roundDamage(result, state.round) };
  for (const p of state.players) p.lastBoard = p.board.map(({ unitId, star, x, y }) => ({ unitId, star, x, y }));
  state.phase = 'combat';
  for (const p of state.players) p.ready = false;
}

function beginArenaCombat(state, catalog, seed) {
  // A pair whose player left in the planning phase doesn't fight: the other one sits out instead.
  const fights = state.pairs.filter(([a, b]) => state.players[a].hp > 0 && state.players[b].hp > 0).map(([a, b], k) => {
    const fseed = (seed + Math.imul(k + 1, 0x85ebca6b)) >>> 0;
    const result = simulate(catalog, [state.players[a].board, state.players[b].board], fseed);
    state.met[pairKey(a, b)] = (state.met[pairKey(a, b)] ?? 0) + 1;
    return { pair: [a, b], seed: fseed, result, damage: roundDamage(result, state.round) };
  });
  state.combat = { round: state.round, fights, bye: state.bye };
  for (const p of state.players) p.lastBoard = p.board.map(({ unitId, star, x, y }) => ({ unitId, star, x, y }));
  state.phase = 'combat';
  // Only the players who fought have a battle to watch.
  const fighting = new Set(fights.flatMap((f) => f.pair));
  state.players.forEach((p, i) => { p.ready = !fighting.has(i); });
  if (!fighting.size) endRound(state, catalog);
}

function endArenaRound(state, catalog) {
  const before = aliveIn(state);
  const hpBefore = state.players.map((p) => p.hp);
  const fought = new Set();
  for (const { pair, result, damage } of state.combat.fights) {
    pair.forEach((i, side) => {
      const p = state.players[i];
      fought.add(i);
      p.hp = Math.max(0, p.hp - damage[side]);
      const lost = lostCount(result, side);
      p.lastIncome = { base: ROUND_COINS, lost: lost * LOST_COIN };
      p.coins += ROUND_COINS + lost * LOST_COIN;
    });
  }
  for (const i of before) {
    if (fought.has(i)) continue;
    const p = state.players[i]; // sat out: the round's coins, nothing lost
    p.lastIncome = { base: ROUND_COINS, lost: 0 };
    p.coins += ROUND_COINS;
  }
  const knocked = before.filter((i) => state.players[i].hp <= 0);
  if (knocked.length) state.out.push(knocked);
  const alive = aliveIn(state);
  if (alive.length <= 1) {
    state.phase = 'gameover';
    // Everyone left knocked out at once: whoever had the most HP going in wins
    // (a draw only if that's a tie too).
    const top = Math.max(...knocked.map((i) => hpBefore[i]));
    const best = knocked.filter((i) => hpBefore[i] === top);
    state.winner = alive[0] ?? (best.length === 1 ? best[0] : null);
    if (alive.length === 0 && state.winner !== null) state.out[state.out.length - 1] = knocked.filter((i) => i !== state.winner);
    return;
  }
  startRound(state, catalog);
}

// Damage is applied only after everyone has watched the fight, so the HUD
// never spoils the result while combat is still animating.
function endRound(state, catalog) {
  if (state.mode === 'arena') return endArenaRound(state, catalog);
  const { result, damage } = state.combat;
  state.players.forEach((p, i) => {
    p.hp = Math.max(0, p.hp - damage[i]);
    const lost = lostCount(result, i);
    p.lastIncome = { base: ROUND_COINS, lost: lost * LOST_COIN };
    p.coins += ROUND_COINS + lost * LOST_COIN;
  });
  const alive = state.players.map((p, i) => (p.hp > 0 ? i : -1)).filter((i) => i !== -1);
  if (alive.length < state.players.length) {
    state.phase = 'gameover';
    state.winner = alive.length === 1 ? alive[0] : null;
    return;
  }
  startRound(state, catalog);
}

// What one arena player sees, shaped like a duel so the same screens work:
// `players` is [this player, their opponent] in fight order (`viewer` says
// which one is them), `combat` is their own fight. Sitting out a battle looks
// like waiting, locked in; being knocked out looks like game over. `arena`
// adds the standings for everyone. A duel comes back unchanged.
export function viewFor(state, me) {
  if (state.mode !== 'arena') return { view: state, viewer: me };
  const P = state.players;
  const empty = (name) => ({ name, avatar: null, hp: 0, coins: 0, team: [], pool: {}, shop: [], board: [], lastBoard: [], ready: true, empty: true });
  const pairOf = (i) => (state.phase === 'combat' ? state.combat.fights.map((f) => f.pair) : state.pairs).find((pr) => pr.includes(i)) ?? null;
  const standings = P.map((p, i) => {
    const pr = state.phase === 'planning' || state.phase === 'combat' ? pairOf(i) : null;
    return { index: i, name: p.name, avatar: p.avatar, hp: p.hp, out: p.hp <= 0, place: arenaPlace(state, i), opponent: pr ? pr.find((j) => j !== i) : null, bye: (state.phase === 'planning' || state.phase === 'combat') && p.hp > 0 && !pr };
  });
  const arena = { you: me, standings, place: arenaPlace(state, me), left: aliveIn(state).length, size: P.length };
  const base = { ...state, arena };
  if (state.phase === 'gameover' || P[me].hp <= 0) {
    const champ = state.winner ?? null;
    const other = champ !== null && champ !== me ? P[champ] : empty(state.phase === 'gameover' ? 'Nobody' : `${arena.left} still fighting`);
    return { view: { ...base, phase: 'gameover', players: [P[me], other], winner: champ === me ? 0 : champ === null && state.phase === 'gameover' ? null : 1, combat: null }, viewer: 0 };
  }
  if (state.phase === 'team') return { view: { ...base, players: [P[me], empty('3 rivals')] }, viewer: 0 };
  const pr = pairOf(me);
  if (!pr) {
    // Sitting out this round: planning as usual; during the battles, locked in and waiting.
    const sit = empty('Sitting out');
    if (state.phase === 'combat') return { view: { ...base, phase: 'planning', combat: null, players: [{ ...P[me], ready: true }, sit] }, viewer: 0 };
    return { view: { ...base, players: [P[me], sit] }, viewer: 0 };
  }
  const players = [P[pr[0]], P[pr[1]]];
  const viewer = pr.indexOf(me);
  if (state.phase !== 'combat') return { view: { ...base, players }, viewer };
  const fight = state.combat.fights.find((f) => f.pair === pr);
  return { view: { ...base, players, combat: { round: state.combat.round, seed: fight.seed, result: fight.result, damage: fight.damage } }, viewer };
}
