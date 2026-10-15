// Zero-dependency test runner: `node tests/run.js` (or `npm test`).
// Focuses on the properties Phase 3 depends on: determinism, JSON-serializable
// state, and applyIntent rejecting anything invalid. Plus the team/pool rules.

import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  createGame, applyIntent, fielded, troopIds, teamSize, poolSize, TEAM_SIZE,
  COPIES_PER_TROOP, MAX_STAR, SHOP_SIZE, START_COINS, ROUND_COINS, LOST_COIN, REROLL_COST, lostCount,
} from '../src/game.js';
import {
  simulate, MAX_TICKS, COLS, HALF, SUDDEN_DEATH_TICK, SUDDEN_DEATH_HP_PER_SECOND, MOVE_SPEEDS, STEP_TICKS, CRIT_PCT, STAT_SCALE, TICK_SECONDS,
} from '../src/combat.js';
import { botTurn, planLayout } from '../src/bot.js';
import { fightSummary } from '../src/matchlog.js';
import { loadProfile, saveProfile, recordMatch, recordBattle, favouriteTroop, addFriend, removeFriend, AVATARS, DEFAULT_AVATAR, NAME_MAX } from '../src/profile.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (v) => JSON.parse(JSON.stringify(v));
const TROOPS = troopIds(catalog);
// A fixed default team, so tests don't depend on which Pokémon sort first.
const DEFAULT_TEAM = ['infernape', 'beheeyem', 'coalossal', 'toxtricity', 'vespiquen', 'decidueye'];
const team = (troops = DEFAULT_TEAM) => ({ type: 'chooseTeam', troops });
// Test-only movement tier for units that must never move.
MOVE_SPEEDS.statue = 1000;

// A game past team building, in round 1 planning.
function startedGame(seed = 7, opts = {}) {
  const s = createGame({ seed, catalog, names: ['A', 'B'], ...opts });
  for (const p of [0, 1]) assert.ok(applyIntent(s, catalog, p, team()).ok);
  return s;
}

// Two bots play a full match. If `roundTrip` is set, state is JSON-cloned
// between every turn, as if each snapshot had been sent over the network.
function playMatch(seed, { roundTrip = false, maxRounds = 60 } = {}) {
  let state = createGame({ seed, catalog, names: ['A', 'B'] });
  const send = (p) => (intent) => applyIntent(state, catalog, p, intent);
  while (state.phase !== 'gameover' && state.round <= maxRounds) {
    for (const p of [0, 1]) {
      if (state.phase === 'combat') send(p)({ type: 'continue' });
      else if (state.phase !== 'gameover') botTurn(state, catalog, p, send(p));
      if (roundTrip) state = clone(state);
    }
  }
  return state;
}

// Every team troop always has exactly COPIES_PER_TROOP copies between board and pool.
function assertCopiesConserved(player) {
  for (const t of player.team) {
    const onBoard = player.board.filter((u) => u.unitId === t).reduce((n, u) => n + u.star + 1, 0);
    assert.equal(onBoard + player.pool[t], COPIES_PER_TROOP, `${t}: ${onBoard} on board + ${player.pool[t]} in pool`);
  }
}

// ---- catalog --------------------------------------------------------------

test('unit catalog is well formed, and every unit has a sprite that exists', () => {
  const kinds = new Set(['empower', 'snipe', 'summon', 'stealth', 'haste', 'opening', 'quake', 'transform', 'splashHeal', 'selfdestruct', 'copy', 'chill', 'treat', 'boost', 'bind', 'taunt', 'rage', 'darts']);
  // Powers that fire on a counter of attacks need `energy`; the rest (battle
  // start, passives, knockout or low-HP triggers) have none.
  const counted = (a) => ['empower', 'snipe', 'summon', 'stealth', 'haste', 'quake', 'treat', 'boost', 'bind', 'taunt'].includes(a.kind) || (a.kind === 'transform' && !a.trigger);
  for (const [id, u] of Object.entries(catalog)) {
    for (const k of ['hp', 'damage']) {
      const v = u[k];
      assert.ok(Array.isArray(v) && v.length === COPIES_PER_TROOP, `${id}.${k} lists 0-${MAX_STAR}★`);
      // Summons may keep the same stats at every level (Dreepy).
      assert.ok(v.every((n, i) => n > 0 && (!i || n > v[i - 1] || (u.summon && n === v[i - 1]))), `${id}.${k} must be positive and increase with stars`);
    }
    assert.ok(u.secPerHit > 0, `${id}.secPerHit must be positive`);
    assert.ok(Object.hasOwn(MOVE_SPEEDS, u.moveSpeed) && u.moveSpeed !== 'statue', `${id}.moveSpeed "${u.moveSpeed}"`);
    assert.ok(u.critChance >= 0 && u.critChance <= 100, `${id}.critChance is a percent`);
    assert.ok(Number.isInteger(u.range) && u.range > 0, `${id}.range must be a positive integer`);
    assert.ok(!('leader' in u), `${id}: there are no leaders any more`);
    if (u.summon) {
      assert.ok(u.cost === 0 && !TROOPS.includes(id), `${id}: summons are never bought or picked`);
    } else {
      assert.ok(Number.isInteger(u.cost) && u.cost > 0, `${id}.cost`);
      assert.ok(kinds.has(u.ability?.kind), `${id} power kind`);
      // Dragon Darts may have a counter (attacks needed between pairs) or not.
  const optional = (a) => a?.kind === 'darts';
  assert.ok(optional(u.ability) ? Number.isInteger(u.energy) && u.energy >= 0 : counted(u.ability) ? Number.isInteger(u.energy) && u.energy > 0 : u.energy === 0, `${id}.energy`);
      if (u.ability.form) {
        const f = u.ability.form;
        assert.ok(existsSync(new URL(`../${f.sprite}`, import.meta.url)) && Object.hasOwn(MOVE_SPEEDS, f.moveSpeed) && f.damage.length === COPIES_PER_TROOP, `${id} form`);
      }
      if (u.ability.kind === 'summon') assert.ok(catalog[u.ability.unit]?.summon, `${id} summons a summon-only unit`);
    }
    assert.ok(u.sprite && existsSync(new URL(`../${u.sprite}`, import.meta.url)), `${id}: missing sprite ${u.sprite}`);
  }
  assert.equal(teamSize(catalog), TEAM_SIZE);
  assert.ok(TROOPS.length >= TEAM_SIZE);
});

// ---- whole matches ----------------------------------------------------------

test('full bot-vs-bot match is deterministic for a seed', () => {
  assert.deepEqual(playMatch(1234), playMatch(1234));
});

test('state survives a JSON round trip between turns', () => {
  assert.deepEqual(playMatch(99, { roundTrip: true }), playMatch(99));
});

test('matches finish, and copies are conserved throughout', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = playMatch(seed);
    assert.equal(s.phase, 'gameover', `seed ${seed}`);
    s.players.forEach(assertCopiesConserved);
  }
});

// ---- team building ----------------------------------------------------------

test('team phase: pick 6 different Pokémon; round 1 starts with an empty board and full pools', () => {
  const s = createGame({ seed: 7, catalog, names: ['A', 'B'] });
  assert.equal(s.phase, 'team');
  const need = teamSize(catalog);
  const bad = [
    { type: 'buy', slot: 0, x: 0, y: 0 }, { type: 'ready' },
    team(TROOPS.slice(0, need - 1)), // too few
    team(TROOPS.slice(0, need + 1)), // too many
    team([...TROOPS.slice(0, need - 1), TROOPS[0]]), // duplicate
    team([...TROOPS.slice(0, need - 1), 'toString']), // not a Pokémon
    team('infernape'), team(null),
  ];
  for (const intent of bad) {
    const before = clone(s);
    assert.equal(applyIntent(s, catalog, 0, intent).ok, false, JSON.stringify(intent));
    assert.deepEqual(s, before);
  }
  assert.ok(applyIntent(s, catalog, 0, team()).ok);
  assert.equal(applyIntent(s, catalog, 0, team()).ok, false, 'cannot choose twice');
  assert.equal(s.phase, 'team');
  assert.ok(applyIntent(s, catalog, 1, team(TROOPS.slice(-need))).ok);
  assert.equal(s.phase, 'planning');
  assert.equal(s.round, 1);
  for (const p of s.players) {
    assert.deepEqual(p.board, [], 'nobody starts on the board');
    assert.equal(p.team.length, need);
    assert.equal(poolSize(p), need * COPIES_PER_TROOP);
    assert.ok(p.team.every((t) => p.pool[t] === COPIES_PER_TROOP));
    assert.equal(p.shop.length, SHOP_SIZE);
  }
});

// ---- shop and pool ----------------------------------------------------------

test('shop only offers troops from your own pool, never more copies than it holds', () => {
  const s = startedGame();
  const p = s.players[0];
  for (let i = 0; i < 300; i++) {
    p.coins = 99;
    assert.ok(applyIntent(s, catalog, 0, { type: 'reroll' }).ok);
    const counts = {};
    for (const id of p.shop.filter(Boolean)) counts[id] = (counts[id] ?? 0) + 1;
    for (const [id, n] of Object.entries(counts)) {
      assert.ok(p.team.includes(id), id);
      assert.ok(n <= p.pool[id], `${id} offered ${n}x with ${p.pool[id]} in pool`);
    }
  }
  // Nearly empty pool: shop shows only what's left.
  p.pool = Object.fromEntries(p.team.map((t) => [t, 0]));
  p.pool[p.team[0]] = 1;
  p.coins = 99;
  applyIntent(s, catalog, 0, { type: 'reroll' });
  assert.deepEqual(p.shop, [p.team[0], null, null]);
});

test('buying places onto the chosen square and removes the copy from the pool', () => {
  const s = startedGame();
  const p = s.players[0];
  p.coins = 99;
  const id = p.shop[0];
  const before = p.pool[id];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 0, y: 1 }).ok);
  const placed = p.board.find((u) => u.x === 0 && u.y === 1);
  assert.deepEqual([placed.unitId, placed.star], [id, 0]);
  assert.equal(p.pool[id], before - 1);
  assert.equal(p.coins, 99 - catalog[id].cost);
  assertCopiesConserved(p);
  p.shop = [null, null, null];
  assert.equal(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 1, y: 1 }).ok, false, 'an empty slot');
});

test('no duplicates on the field: buying a troop you already have levels it up (1-4 copies = 0-3 stars)', () => {
  const s = startedGame();
  const p = s.players[0];
  const id = 'infernape';
  const other = DEFAULT_TEAM.find((t) => t !== id); // in this player's pool
  p.coins = 99;
  p.shop = [id, id, other];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 0, y: 0 }).ok);
  // A second copy aimed at a different empty square still levels up the first one.
  p.shop = [id, id, other];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 1, x: 4, y: 2 }).ok);
  p.shop = [id, id, other];
  assert.deepEqual(p.board.filter((u) => u.unitId === id).map((u) => [u.star, u.x, u.y]), [[1, 0, 0]]);
  assert.equal(applyIntent(s, catalog, 0, { type: 'buy', slot: 2, x: 0, y: 0 }).ok, false, 'a new troop cannot go on a taken square');
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 2, x: 1, y: 0 }).ok, 'a different troop gets its own square');
  // Two more copies, even without coordinates: 3★ (all 4 copies), still one Mawile.
  for (let i = 0; i < 2; i++) {
    p.shop = [id, null, null];
    assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0 }).ok);
  }
  assert.equal(fielded(p, id).star, MAX_STAR);
  assert.equal(p.board.filter((u) => u.unitId === id).length, 1);
  assert.equal(p.pool[id], 0);
  assertCopiesConserved(p);
  // Moving onto another troop swaps them (there is never a same-troop stack to merge).
  const a = fielded(p, id);
  const b = fielded(p, other);
  assert.ok(applyIntent(s, catalog, 0, { type: 'move', uid: a.uid, x: b.x, y: b.y }).ok);
  assert.deepEqual([a.x, a.y, b.x, b.y], [1, 0, 0, 0]);
});

test('selling refunds coins per copy and returns every copy to the pool', () => {
  const s = startedGame();
  const p = s.players[0];
  p.coins = 99;
  p.shop = ['beheeyem', 'beheeyem', null];
  applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 0, y: 3 });
  p.shop = ['beheeyem', 'beheeyem', null];
  applyIntent(s, catalog, 0, { type: 'buy', slot: 1, x: 0, y: 3 });
  const unit = p.board.find((u) => u.unitId === 'beheeyem');
  assert.equal(unit.star, 1);
  const coins = p.coins;
  assert.ok(applyIntent(s, catalog, 0, { type: 'sell', uid: unit.uid }).ok);
  assert.equal(p.coins, coins + 2 * catalog.beheeyem.cost);
  assert.equal(p.pool.beheeyem, COPIES_PER_TROOP);
  assertCopiesConserved(p);
});

test('no troop limit: every troop of the team can be on the board; enemy half is off limits', () => {
  const s = startedGame();
  const p = s.players[0];
  p.coins = 999;
  p.team.forEach((id, i) => {
    p.shop = [id, null, null];
    assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: i % COLS, y: Math.floor(i / COLS) }).ok, `${id} placed`);
  });
  assert.equal(p.board.length, p.team.length, 'the whole team');
  const someone = p.board[0];
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: someone.uid, x: 0, y: HALF }).ok, false);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: someone.uid, x: -1, y: 0 }).ok, false);
});

test('rejects invalid and out-of-phase intents without changing state', () => {
  const s = startedGame();
  const bad = [
    [5, { type: 'reroll' }],
    [0, null],
    [0, { type: 'hack' }],
    [0, { type: 'toString' }],
    [0, { type: 'buy', slot: 99, x: 0, y: 0 }],
    [0, { type: 'buy', slot: '0', x: 0, y: 0 }],
    [0, { type: 'buy', slot: 0 }],
    [0, { type: 'buy', slot: 0, x: 0, y: HALF }],
    [0, { type: 'sell', uid: 12345 }],
    [0, { type: 'move', uid: 12345, x: 0, y: 0 }],
    [0, { type: 'continue' }],
    [0, team()],
  ];
  for (const [p, intent] of bad) {
    const before = clone(s);
    assert.equal(applyIntent(s, catalog, p, intent).ok, false, JSON.stringify(intent));
    assert.deepEqual(s, before, 'rejected intent must not change state');
  }
});

test('economy: start with START_COINS; each round +ROUND_COINS +1 per own Pokémon knocked out; coins carry over uncapped', () => {
  const s = startedGame();
  assert.deepEqual(s.players.map((p) => p.coins), [START_COINS, START_COINS]);
  const [a, b] = s.players;
  a.coins = 50; b.coins = 50; // whatever isn't spent carries over to the next round
  a.shop = ['infernape', 'coalossal', null];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 2, y: 0 }).ok);
  b.shop = ['infernape', null, null];
  assert.ok(applyIntent(s, catalog, 1, { type: 'buy', slot: 0, x: 2, y: 0 }).ok);
  const before = s.players.map((q) => q.coins);
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'ready' });
  const { result } = s.combat;
  const lost = [0, 1].map((i) => lostCount(result, i));
  assert.ok(lost.some((n) => n > 0), 'someone lost a Pokémon');
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'continue' });
  assert.equal(s.round, 2);
  s.players.forEach((q, i) => assert.equal(q.coins, before[i] + ROUND_COINS + LOST_COIN * lost[i], `player ${i}`));
  assert.ok(s.players.every((q) => q.coins > 50), 'no cap on coins');
});

test('lost Pokémon: the loser lost its whole board, the winner the ones knocked out; summons never count', () => {
  const r = { initial: [{ side: 0 }, { side: 0 }, { side: 0, summoned: true }, { side: 1 }, { side: 1 }, { side: 1 }], survivors: [{ side: 0 }] };
  assert.equal(lostCount(r, 0), 1);
  assert.equal(lostCount(r, 1), 3);
});

test('shop: refreshes for free after every purchase and after every battle; a reroll costs a coin', () => {
  const s = startedGame();
  const p = s.players[0];
  p.coins = 3;
  assert.ok(applyIntent(s, catalog, 0, { type: 'reroll' }).ok);
  assert.equal(p.coins, 3 - REROLL_COST, 'rerolls cost coins');
  p.coins = 0;
  assert.equal(applyIntent(s, catalog, 0, { type: 'reroll' }).ok, false, 'not without coins');
  p.coins = 99;
  const rolls = p.shopRolls;
  const coins = p.coins;
  const id = p.shop[0];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 0, y: 0 }).ok);
  assert.equal(p.coins, coins - catalog[id].cost, 'only the Pokémon is paid for');
  assert.equal(p.shopRolls, rolls + 1, 'the shop refreshed');
  assert.ok(p.shop.every(Boolean), 'a full shop again');
  p.shop = [null, null, null];
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'ready' });
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'continue' });
  assert.ok(p.shop.some(Boolean), 'shop is refreshed automatically after the battle');
});

test('locked-in players cannot act; combat starts when both are ready', () => {
  const s = startedGame();
  assert.ok(applyIntent(s, catalog, 0, { type: 'ready' }).ok);
  assert.equal(applyIntent(s, catalog, 0, { type: 'reroll' }).ok, false);
  assert.equal(s.phase, 'planning');
  assert.ok(applyIntent(s, catalog, 1, { type: 'ready' }).ok);
  assert.equal(s.phase, 'combat');
  assert.ok(s.combat.result.events.length > 0);
});

test("each player's lineup from the last fight is kept for the next planning phase", () => {
  const s = startedGame();
  assert.deepEqual(s.players.map((p) => p.lastBoard), [[], []], 'nothing before the first fight');
  const p = s.players[1];
  p.coins = 99;
  p.shop = ['infernape', 'coalossal', null];
  applyIntent(s, catalog, 1, { type: 'buy', slot: 0, x: 1, y: 0 });
  p.shop = ['infernape', 'coalossal', null];
  applyIntent(s, catalog, 1, { type: 'buy', slot: 1, x: 3, y: 2 });
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'ready' });
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'continue' });
  assert.equal(s.phase, 'planning');
  assert.deepEqual(p.lastBoard, [{ unitId: 'infernape', star: 0, x: 1, y: 0 }, { unitId: 'coalossal', star: 0, x: 3, y: 2 }]);
  // Changing the board now doesn't change what the opponent sees from last round.
  applyIntent(s, catalog, 1, { type: 'move', uid: p.board[0].uid, x: 0, y: 3 });
  assert.deepEqual(p.lastBoard[0], { unitId: 'infernape', star: 0, x: 1, y: 0 });
});

test('featured troop leads the shop while its pool has copies; bad ids are ignored', () => {
  const s = startedGame(3, { featured: 'beheeyem' });
  for (const p of s.players) assert.equal(p.shop[0], 'beheeyem');
  const p = s.players[0];
  for (let i = 0; i < 5; i++) {
    p.coins = 99;
    assert.ok(applyIntent(s, catalog, 0, { type: 'reroll' }).ok);
    assert.equal(p.shop[0], 'beheeyem');
  }
  for (const bad of ['nope', 'toString', '', null]) {
    assert.equal(createGame({ seed: 3, catalog, names: ['A', 'B'], featured: bad }).featured, null, String(bad));
  }
});

// ---- combat -----------------------------------------------------------------

test('simulate does not mutate its inputs and is repeatable', () => {
  const boards = [
    [{ uid: 1, unitId: 'mawile', star: 0, x: 2, y: 0 }, { uid: 2, unitId: 'toxtricity', star: 2, x: 1, y: 3 }],
    [{ uid: 3, unitId: 'coalossal', star: 1, x: 2, y: 0 }, { uid: 4, unitId: 'beheeyem', star: 0, x: 3, y: 3 }],
  ];
  const before = clone(boards);
  const a = simulate(catalog, boards, 42);
  assert.deepEqual(boards, before);
  assert.deepEqual(a, simulate(catalog, clone(boards), 42));
  assert.ok(a.ticks <= MAX_TICKS);
  assert.equal(a.events.at(-1).type, 'end');
});

test('empty boards resolve immediately', () => {
  const unit = [{ uid: 1, unitId: 'mawile', star: 0, x: 0, y: 0 }];
  assert.equal(simulate(catalog, [[], []]).winner, null);
  assert.equal(simulate(catalog, [unit, []]).winner, 0);
  assert.equal(simulate(catalog, [[], unit]).winner, 1);
});

test('combat is fair: identical mirrored armies never favour a side', () => {
  // Every unit 1v1 against itself from every square: must always be a draw.
  for (const id of Object.keys(catalog)) {
    for (let x = 0; x < COLS; x++) for (let y = 0; y < HALF; y++) {
      const r = simulate(catalog, [[{ uid: 1, unitId: id, star: 0, x, y }], [{ uid: 2, unitId: id, star: 0, x, y }]], x * 7 + y);
      assert.equal(r.winner, null, `${id} at (${x},${y}) won for side ${r.winner}`);
    }
  }
  // Random mirrored armies: wins (if any) split evenly.
  const ids = Object.keys(catalog);
  const wins = [0, 0];
  for (let i = 0; i < 300; i++) {
    const army = [];
    const used = new Set();
    for (let k = 0; k < 1 + (i % 5); k++) {
      const x = (i * 3 + k * 7) % COLS;
      const y = (i + k * 3) % HALF;
      if (used.has(`${x},${y}`)) continue;
      used.add(`${x},${y}`);
      army.push({ unitId: ids[(i + k) % ids.length], star: (i + k) % 4, x, y });
    }
    const r = simulate(catalog, [army.map((u, k) => ({ ...u, uid: 2 * k + 1 })), army.map((u, k) => ({ ...u, uid: 2 * k + 2 }))], i);
    if (r.winner !== null) wins[r.winner]++;
  }
  assert.ok(Math.abs(wins[0] - wins[1]) <= 10, `mirror wins split ${wins}`);
});

// ---- powers -----------------------------------------------------------------
// Test dummies: `wall` never moves (everything is in its range) and hits once
// for 1; `stalker` walks and pecks for 1.
const powerCat = () => {
  const cat = clone(catalog);
  const big = [1e6, 1e6, 1e6, 1e6];
  const one = [1, 1, 1, 1];
  cat.wall = { ...clone(catalog.mawile), moveSpeed: 'statue', range: 99, secPerHit: 1000, hp: big, damage: one, critChance: 0, energy: 0, ability: null, summon: true, cost: 0 };
  cat.stalker = { ...cat.wall, range: 1, moveSpeed: 'fast', secPerHit: 1 };
  return cat;
};
const unitOf = (r, uid) => r.initial.find((u) => u.uid === uid);
const evs = (r, type, id) => r.events.filter((e) => e.type === type && (id === undefined || e.id === id));

test('Jaw Lock (Mawile): after 8 attacks the next one hits 30% harder and stuns', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'mawile', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  const m = unitOf(r, 1).id;
  const cast = evs(r, 'cast', m)[0];
  assert.equal(evs(r, 'attack', m).filter((e) => e.t < cast.t).length, catalog.mawile.energy);
  const hit = r.events.find((e) => e.type === 'damage' && e.src === m && e.t === cast.t);
  assert.equal(hit.amount, Math.floor((catalog.mawile.damage[0] * 130) / 100));
  assert.ok(r.events.some((e) => e.type === 'stun' && e.t === cast.t && e.duration === catalog.mawile.ability.stun));
});

// Alcremie with only one flavour, an ally in front of it and an enemy brute
// hitting that ally: Alcremie (combat 2,5) shoots the brute (2,3) over the ally (2,4).
function treatFight(flavor, ally, brute = {}) {
  const cat = powerCat();
  const a = catalog.alcremie.ability;
  cat.alcremie = { ...clone(catalog.alcremie), ability: { ...a, flavors: a.flavors.filter((f) => f.flavor === flavor) } };
  cat.ally = { ...cat.wall, hp: [1e5, 1e5, 1e5, 1e5], ...ally };
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [200, 200, 200, 200], ...brute };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'alcremie', star: 0, x: 2, y: 1 }, { uid: 2, unitId: 'ally', star: 0, x: 2, y: 0 }],
    [{ uid: 3, unitId: 'brute', star: 0, x: 2, y: 0 }],
  ], 1);
  const al = unitOf(r, 1).id;
  const treat = evs(r, 'treat', al)[0];
  return { r, cat, al, ally: unitOf(r, 2).id, brute: unitOf(r, 3).id, treat };
}

test('Sweet Treat (Alcremie): after 4 attacks it changes flavour; Matcha heals the most hurt ally over 3 seconds', () => {
  const { r, al, ally, treat } = treatFight('heal');
  assert.equal(evs(r, 'attack', al).filter((e) => e.t <= treat.t).length, catalog.alcremie.energy, 'charged by 4 attacks');
  const form = evs(r, 'transform', al)[0];
  assert.deepEqual([form.name, form.sprite], ['Alcremie (Matcha Cream)', 'assets/sprites/alcremie-matcha.png']);
  assert.equal(treat.target, ally, 'the ally losing HP, not Alcremie at full HP');
  const healPct = catalog.alcremie.ability.flavors.find((f) => f.flavor === 'heal').healPct;
  const per = Math.floor((Math.round(catalog.alcremie.damage[0] * STAT_SCALE) * healPct) / 100 / 3);
  const heals = evs(r, 'heal', ally).filter((h) => h.from?.[al] && h.t > treat.t && h.t <= treat.t + 30);
  assert.deepEqual(heals.map((h) => [h.t - treat.t, h.from[al][1]]), [[10, per], [20, per], [30, per]], 'a chunk every second for 3 seconds');
});

test('Sweet Treat (Alcremie): Ruby Cream makes the hardest-hitting ally attack faster for 3 seconds', () => {
  const { r, ally, treat } = treatFight('haste', { range: 1, secPerHit: 1, damage: [300, 300, 300, 300] });
  assert.equal(treat.target, ally, 'the ally hitting harder than Alcremie');
  assert.ok(evs(r, 'haste', ally).some((h) => h.t === treat.t), 'hasted');
  const times = evs(r, 'attack', ally).map((e) => e.t);
  const gap = (from, to) => { const ts = times.filter((x) => x > from && x <= to); return ts[1] - ts[0]; };
  assert.equal(gap(0, treat.t), 10, 'every second before');
  assert.equal(gap(treat.t, treat.t + 30), 5, 'twice as often during the treat');
});

test('Sweet Treat (Alcremie): Mint Cream shields the ally under attack: less damage, and a stun only breaks the shield', () => {
  const guardPct = catalog.alcremie.ability.flavors.find((f) => f.flavor === 'guard').guardPct;
  // A brute that stuns with every other attack.
  const { r, ally, brute, treat } = treatFight('guard', {}, { energy: 1, ability: { name: 'Bash', kind: 'empower', damagePct: 100, stun: 10 } });
  assert.equal(treat.target, ally, 'the ally the brute is attacking');
  const g = evs(r, 'guard', ally)[0];
  const hits = r.events.filter((e) => e.type === 'damage' && e.src === brute && e.id === ally);
  const broke = evs(r, 'guardBreak', ally)[0];
  const during = hits.filter((e) => e.t > g.t && e.t <= broke.t);
  assert.ok(during.length && during.every((e) => e.amount === Math.floor((200 * (100 - guardPct)) / 100)), `${guardPct}% less damage while shielded`);
  assert.ok(broke && broke.t > g.t && broke.t <= g.t + g.duration, 'the first stun breaks the shield early');
  assert.ok(!evs(r, 'stun', ally).some((e) => e.t === broke.t), 'and does not stun');
  const after = hits.find((e) => e.t > broke.t);
  assert.equal(after.amount, 200, 'full damage once it is broken');
});

test('match log: each fight lists its seed and what happened by chance (Alcremie\'s flavour and who got it)', () => {
  const { r, cat } = treatFight('guard');
  const f = fightSummary({ result: r, round: 3, seed: 1 }, cat, ['Ann', 'Bo']);
  assert.equal(f.round, 3);
  assert.equal(f.seed, 1);
  assert.ok(f.chance.some((c) => /Alcremie \(Ann\) rolled shield -> Ally \(Ann\)|Alcremie \(Ann\) rolled shield -> \S+ \(Ann\)/.test(c)), f.chance.join(' | '));
  assert.deepEqual(Object.keys(f.crits), ['Ann', 'Bo']);
});

test('a shield also stops a shove: a Heat Crash breaks it instead of knocking the Pokémon back and stunning it', () => {
  const cat = powerCat();
  const a = catalog.alcremie.ability;
  cat.alcremie = { ...clone(catalog.alcremie), energy: 1, ability: { ...a, flavors: a.flavors.filter((f) => f.flavor === 'guard') } };
  cat.ally = { ...cat.wall, hp: [1e5, 1e5, 1e5, 1e5] };
  // Alcremie (charged by every attack) shields the ally; then the enemy's Heat
  // Crash, which knocks back and stuns, hits that ally.
  cat.crasher = { ...cat.wall, range: 9, secPerHit: 1, damage: [1, 1, 1, 1], energy: 3, ability: { name: 'Heat Crash', kind: 'empower', damagePct: 100, knockback: 2, stun: 10 } };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'alcremie', star: 0, x: 2, y: 1 }, { uid: 2, unitId: 'ally', star: 0, x: 2, y: 0 }],
    [{ uid: 3, unitId: 'crasher', star: 0, x: 2, y: 0 }],
  ], 1);
  const ally = unitOf(r, 2).id;
  const g = evs(r, 'guard', ally)[0];
  const crash = evs(r, 'cast', unitOf(r, 3).id).find((e) => e.t > g.t);
  assert.ok(crash && crash.t <= g.t + 30, 'a Heat Crash lands while shielded');
  assert.ok(evs(r, 'guardBreak', ally).some((e) => e.t === crash.t), 'the shield breaks');
  assert.ok(!evs(r, 'knock', ally).some((e) => e.t === crash.t) && !evs(r, 'stun', ally).some((e) => e.t === crash.t), 'neither the knockback nor the stun lands');
});

test('Psywave (Beheeyem): at the start, the first enemy in its column is knocked to the far end; anyone there is pushed aside', () => {
  const r = simulate(powerCat(), [
    [{ uid: 1, unitId: 'beheeyem', star: 0, x: 2, y: 3 }], // combat (2, 7)
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 2, y: 3 }], // combat (2, 3) and (2, 0)
  ], 1);
  const b = unitOf(r, 1).id;
  const first = unitOf(r, 2).id;
  const blocker = unitOf(r, 3).id;
  const cast = evs(r, 'cast', b)[0];
  assert.deepEqual([cast.t, cast.target], [1, first]);
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === first).amount, Math.floor(catalog.beheeyem.damage[0] / 2));
  assert.deepEqual(evs(r, 'knock', blocker).map((e) => [e.x, e.y]), [[3, 0]], 'pushed to its own left');
  assert.deepEqual(evs(r, 'knock', first).map((e) => [e.x, e.y]), [[2, 0]], 'knocked to the end of the column');
  assert.equal(evs(r, 'cast', b).length, 1, 'only once per battle');
  // Riding the wave: neither moved unit does anything until it has landed.
  const landed = 1 + 3 + 7; // wind-up + a tick per square from row 7 to row 0
  for (const id of [first, blocker]) {
    assert.ok(!r.events.some((e) => e.id === id && ['move', 'attack'].includes(e.type) && e.t <= landed), `unit ${id} acted mid-air`);
  }
  // The one it hit is stunned for 1s once it lands; the one shoved aside isn't.
  const [st] = evs(r, 'stun', first);
  assert.ok(st && st.t >= landed - 1 && st.t <= landed && st.duration === catalog.beheeyem.ability.stun, `stunned on landing: ${JSON.stringify(st)}`);
  assert.equal(evs(r, 'stun', blocker).length, 0);
  assert.ok(!r.events.some((e) => e.id === first && ['move', 'attack'].includes(e.type) && e.t <= st.t + st.duration), 'stays put while stunned');
});

test('snipe powers (no Pokémon uses one right now): every 8th attack also zaps the farthest enemy for 80%', () => {
  const cat = powerCat();
  cat.zapper = { ...cat.wall, range: 1, secPerHit: 1.42, damage: [110, 187, 319, 539], critChance: 0, energy: 8, ability: { name: 'Thunderbolt', kind: 'snipe', damagePct: 80 } };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'zapper', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 0, y: 3 }],
  ], 1);
  const tx = unitOf(r, 1).id;
  const far = unitOf(r, 3).id;
  const cast = evs(r, 'cast', tx)[0];
  assert.equal(cast.target, far);
  assert.equal(evs(r, 'attack', tx).filter((e) => e.t <= cast.t).length, 8, 'fires with the 8th attack');
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === far).amount, Math.floor((Math.round(110 * STAT_SCALE) * 80) / 100));
});

test('Overdrive (Toxtricity): every 3 attacks, allies left, right, in front and behind gain +2 power charges; diagonals and Pokémon without a counter do not', () => {
  const cat = powerCat();
  // Allies with a long power counter that never fills during the test.
  cat.charger = { ...cat.wall, energy: 50, ability: { name: 'Big', kind: 'haste', hastePct: 10, duration: 10 } };
  cat.plain = { ...cat.wall }; // no power counter
  // Toxtricity at combat (2,5) shoots the wall at (2,3); allies at (2,4) front, (1,5) side,
  // (2,6) behind, (1,4) diagonal, and a counter-less one at (3,5).
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'toxtricity', star: 0, x: 2, y: 1 },
      { uid: 2, unitId: 'charger', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'charger', star: 0, x: 1, y: 1 },
      { uid: 4, unitId: 'charger', star: 0, x: 2, y: 2 }, { uid: 5, unitId: 'charger', star: 0, x: 1, y: 0 },
      { uid: 6, unitId: 'plain', star: 0, x: 3, y: 1 }],
    [{ uid: 9, unitId: 'wall', star: 0, x: 2, y: 0 }],
  ], 1);
  const tx = unitOf(r, 1).id;
  const cast = evs(r, 'cast', tx)[0];
  assert.equal(evs(r, 'attack', tx).filter((e) => e.t <= cast.t).length, catalog.toxtricity.energy, 'every 3 attacks');
  const boosted = evs(r, 'boost').filter((e) => e.t === cast.t && e.by === tx);
  assert.deepEqual(boosted.map((e) => e.id).sort(), [2, 3, 4].map((uid) => unitOf(r, uid).id).sort(), 'the plus, not the diagonal or a Pokémon without a counter');
  assert.ok(boosted.every((e) => e.amount === catalog.toxtricity.ability.charges && e.mana === catalog.toxtricity.ability.charges), '+2 each, from empty');
});


test('Attack Order (Vespiquen): always summons 2 Combee at its own star, sides first; they never count as survivors', () => {
  const cat = powerCat();
  cat.target = { ...cat.wall, hp: [1500, 1500, 1500, 1500] };
  // Vespiquen at combat (2,6), the target far up the board out of everyone's way.
  const fight = (star, extra = [], foe = 'wall') => simulate(cat, [[{ uid: 1, unitId: 'vespiquen', star, x: 2, y: 2 }, ...extra], [{ uid: 2, unitId: foe, star: 0, x: 2, y: 0 }]], 1);
  const v0 = unitOf(fight(0), 1).id;
  for (const star of [0, 1, 2, 3]) {
    const r = fight(star);
    const first = evs(r, 'summon', v0).filter((e, _, all) => e.t === all[0].t);
    assert.equal(first.length, 2, `2 Combee at star ${star}`);
    assert.ok(first.every((e) => e.unit.unitId === 'combee' && e.unit.star === star && e.unit.summoned), 'Combee at Vespiquen\'s star');
    // Order around (2,6) for side 0: left (1,6), right (3,6).
    assert.deepEqual(first.map((e) => [e.unit.x, e.unit.y]), [[1, 6], [3, 6]]);
    assert.equal(evs(r, 'attack', v0).filter((e) => e.t <= first[0].t).length, catalog.vespiquen.energy);
  }
  // Sides taken: behind, then in front, then diagonals back to front.
  const walls = [[1, 6], [3, 6]].map(([x, y], i) => ({ uid: 30 + i, unitId: 'wall', star: 0, x, y: y - HALF }));
  const r = fight(3, walls);
  assert.deepEqual(evs(r, 'summon', v0).slice(0, 2).map((e) => [e.unit.x, e.unit.y]), [[2, 7], [2, 5]]);
  // Combee fight, but never count as survivors.
  const r2 = fight(1, [], 'target');
  assert.ok(evs(r2, 'summon', v0).some((s) => evs(r2, 'attack', s.unit.id).length > 0), 'Combee attack');
  assert.equal(r2.winner, 0);
  assert.deepEqual(r2.survivors.map((u) => u.unitId), ['vespiquen']);
});

test('Heat Crash (Coalossal): the attack after 6 knocks the target back 2 squares and stuns it', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'coalossal', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  const c = unitOf(r, 1).id;
  const w = unitOf(r, 2).id;
  const cast = evs(r, 'cast', c)[0];
  assert.equal(evs(r, 'attack', c).filter((e) => e.t < cast.t).length, catalog.coalossal.energy);
  assert.deepEqual(evs(r, 'knock', w).slice(0, 1).map((e) => [e.t, e.x, e.y]), [[cast.t, 2, 1]], 'from row 3 to row 1');
  assert.ok(evs(r, 'stun', w).some((e) => e.t === cast.t));
  // Someone on the landing square is displaced; the target still lands there.
  const r2 = simulate(powerCat(), [[{ uid: 1, unitId: 'coalossal', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 2, y: 2 }]], 1);
  assert.deepEqual(evs(r2, 'knock', unitOf(r2, 2).id).slice(0, 1).map((e) => [e.x, e.y]), [[2, 1]]);
});

test('a Pokémon launched onto an occupied square displaces it: left, right, back, forward, then diagonals', () => {
  // Coalossal at combat (2,4) knocks the enemy at (2,3) back to (2,1), where an
  // enemy blocker stands. The blocker is on side 1, so its own left is +x and
  // its back is -y. Fill squares around (2,1) one by one and check where it goes.
  const toOwn = ([x, y]) => ({ x: COLS - 1 - x, y: HALF - 1 - y }); // side 1: combat -> own coordinates
  const order = [[3, 1], [1, 1], [2, 0], [2, 2], [3, 0], [1, 0], [3, 2], [1, 2]];
  for (let filled = 0; filled <= order.length; filled++) {
    const fillers = order.slice(0, filled).map((c, i) => ({ uid: 20 + i, unitId: 'wall', star: 0, ...toOwn(c) }));
    const r = simulate(powerCat(), [
      [{ uid: 1, unitId: 'coalossal', star: 0, x: 2, y: 0 }],
      [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, ...toOwn([2, 1]) }, ...fillers],
    ], 1);
    const target = evs(r, 'knock', unitOf(r, 2).id)[0];
    const blocker = evs(r, 'knock', unitOf(r, 3).id)[0];
    if (filled < order.length) {
      assert.deepEqual([blocker.x, blocker.y], order[filled], `with ${filled} squares taken`);
      assert.equal(blocker.t, target.t);
      assert.deepEqual([target.x, target.y], [2, 1], 'the launched Pokémon takes the square');
    } else {
      assert.equal(blocker, undefined, 'nowhere to go: stays put');
      // ...and the launched one lands on the closest free square instead (here,
      // with everything around (2,1) taken, that's where it already stands).
      assert.ok(!target || target.x !== 2 || target.y !== 1, 'it does not land on the blocker');
    }
  }
});

test('when a stun wears off, a Pokémon picks the nearest enemy instead of its old target', () => {
  // Decidueye (range 4) starts shooting a wall 4 squares away. A stunner walks up
  // next to it and stuns it; once the stun ends it should turn on the stunner.
  const cat = powerCat();
  cat.stunner = { ...cat.wall, range: 1, moveSpeed: 'fast', secPerHit: 1, energy: 1, ability: { name: 'Test', kind: 'empower', damagePct: 100, stun: 10 } };
  cat.archer = { ...clone(catalog.decidueye), energy: 0, ability: null, hp: [1e6, 1e6, 1e6, 1e6] };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'archer', star: 0, x: 2, y: 3 }], // combat (2,7)
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'stunner', star: 0, x: 4, y: 3 }], // (2,3) and (0,0)
  ], 1);
  const d = unitOf(r, 1).id;
  const wall = unitOf(r, 2).id;
  const stunner = unitOf(r, 3).id;
  const st = evs(r, 'stun', d)[0];
  assert.ok(st, 'it gets stunned');
  const before = evs(r, 'attack', d).filter((e) => e.t < st.t);
  assert.ok(before.length && before.every((e) => e.target === wall), 'locked on the wall before the stun');
  const after = evs(r, 'attack', d).find((e) => e.t > st.t + st.duration);
  assert.equal(after.target, stunner, 'new target after the stun');
});

test('Phantom Force (Decidueye): after 8 attacks it turns invisible and faster; enemies cannot target it', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'decidueye', star: 0, x: 2, y: 3 }], [{ uid: 2, unitId: 'stalker', star: 0, x: 2, y: 0 }]], 1);
  const d = unitOf(r, 1).id;
  const s = unitOf(r, 2).id;
  const st = evs(r, 'stealth', d)[0];
  assert.ok(st && evs(r, 'haste', d).some((e) => e.t === st.t));
  const end = st.t + catalog.decidueye.ability.duration;
  assert.ok(evs(r, 'attack', s).some((e) => e.t < st.t), 'the stalker reached it before');
  assert.ok(!evs(r, 'attack', s).some((e) => e.t > st.t && e.t <= end), 'no attacks while invisible');
  assert.ok(evs(r, 'attack', s).some((e) => e.t > end), 'found again afterwards');
  const times = evs(r, 'attack', d).map((e) => e.t).filter((x) => x > st.t && x <= end);
  const gap = Math.round(Math.round(catalog.decidueye.secPerHit / TICK_SECONDS) * 100 / 130);
  assert.ok(times.length >= 2 && times.slice(1).every((x, i) => x - times[i] === gap), `attacks every ${gap} ticks: ${times}`);
});

test('teleport powers (no Pokémon uses one right now): the attack after 6 teleports to the farthest enemy, hits 30% harder and heals 10%', () => {
  const cat = powerCat();
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [40, 40, 40, 40] };
  // Hoopa's old Hyperspace Hole.
  cat.porter = { ...cat.wall, range: 1, secPerHit: 1.11, damage: [75, 125, 195, 315], critChance: 0, moveSpeed: 'medium', energy: 6, ability: { name: 'Hyperspace Hole', kind: 'empower', damagePct: 130, teleport: 'farthest', lifestealPct: 10 } };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'porter', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'brute', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 0, y: 3 }], // far one at combat (4, 0)
  ], 1);
  const g = unitOf(r, 1).id;
  const far = unitOf(r, 3).id;
  const cast = evs(r, 'cast', g)[0];
  assert.equal(cast.target, far);
  const tp = evs(r, 'teleport', g)[0];
  assert.equal(tp.t, cast.t);
  assert.equal(Math.abs(tp.x - 4) + Math.abs(tp.y - 0), 1, 'lands next to the farthest enemy');
  const dealt = Math.floor((Math.round(75 * STAT_SCALE) * 130) / 100);
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === far).amount, dealt);
  assert.equal(evs(r, 'heal', g).find((e) => e.t === cast.t).amount, Math.floor(dealt / 10));
});

test('Binding Ring (Hoopa): after 5 attacks it binds the Pokémon it is attacking; it still attacks but can\'t move, and breaks free after 3 tries to move', () => {
  const cat = powerCat();
  cat.walker = { ...cat.wall, range: 1, moveSpeed: 'super slow' };
  cat.hoopa = { ...cat.hoopa, range: 9, moveSpeed: 'statue' }; // shoots from where it stands
  // Hoopa at combat (2,5); a walker starts at (2,0) and slowly walks toward it.
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'hoopa', star: 0, x: 2, y: 1 }],
    [{ uid: 2, unitId: 'walker', star: 0, x: 2, y: 3 }],
  ], 1);
  const h = unitOf(r, 1).id;
  const w = unitOf(r, 2).id;
  const p = catalog.hoopa.ability;
  const energy = catalog.hoopa.energy;
  assert.equal(unitOf(r, 1).mana, 0, 'starts empty');
  assert.equal(evs(r, 'transform', h).length, 0, 'no Hoopa Unbound form');
  const bind = evs(r, 'bind')[0];
  assert.ok(bind, 'it binds');
  const attacks = evs(r, 'attack', h).filter((a) => a.t <= bind.t);
  assert.equal(attacks.length, energy, `after ${energy} attacks`);
  assert.equal(bind.id, attacks[attacks.length - 1].target, 'the Pokémon it was attacking');
  assert.equal(bind.by, h);
  const free = evs(r, 'unbind', w)[0];
  assert.ok(free && free.why === 'broke', 'it breaks free by trying to move');
  assert.equal(evs(r, 'bindStrain', w).filter((e) => e.t > bind.t && e.t < free.t).length, p.breakAfter - 1, `on its ${p.breakAfter}th try`);
  assert.ok(!evs(r, 'move', w).some((m) => m.t > bind.t && m.t <= free.t), 'no steps while bound');
  const again = evs(r, 'bind', w).find((b) => b.t > free.t);
  assert.ok(evs(r, 'move', w).some((m) => m.t > free.t && (!again || m.t < again.t)) || again, 'once free it walks again (unless Hoopa, charged again, binds it first)');
  if (again) assert.equal(evs(r, 'bindStrain', w).find((e) => e.t > again.t)?.tries ?? 1, 1, 'a new bind starts over at full strength');
});

test('Binding Ring (Hoopa): a bound Pokémon that is knocked to another square breaks free at once', () => {
  const cat = powerCat();
  cat.crasher = { ...cat.wall, range: 9, secPerHit: 1, damage: [1, 1, 1, 1], energy: 3, ability: { name: 'Heat Crash', kind: 'empower', damagePct: 100, knockback: 1 } };
  cat.target = { ...cat.wall, moveSpeed: 'slow' };
  // Hoopa at combat (2,5) and a crasher at (2,4) both hit the target at (2,3).
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'hoopa', star: 0, x: 2, y: 1 }, { uid: 2, unitId: 'crasher', star: 0, x: 2, y: 0 }],
    [{ uid: 3, unitId: 'target', star: 0, x: 2, y: 0 }],
  ], 1);
  const t3 = unitOf(r, 3).id;
  const bind = evs(r, 'bind', t3)[0];
  assert.ok(bind, 'it is bound');
  const knock = evs(r, 'knock', t3).find((k) => k.t >= bind.t);
  assert.ok(knock, 'then knocked back');
  const free = evs(r, 'unbind', t3).find((u) => u.t >= bind.t);
  assert.ok(free && free.why === 'moved' && free.t === knock.t, 'the rings snap as it is knocked away');
});

test('Rage Powder (Amoonguss): every 2 attacks, the hardest hitter within the 5x5 that is attacking someone else must attack Amoonguss', () => {
  const cat = powerCat();
  cat.decoy = { ...cat.wall, hp: [1e5, 1e5, 1e5, 1e5] };
  cat.hitter = { ...cat.wall, range: 1, moveSpeed: 'fast', secPerHit: 1, damage: [10, 10, 10, 10], hp: [1e5, 1e5, 1e5, 1e5] };
  // Amoonguss at combat (2,4) hits a wall at (2,3); the hitter at (0,3) is
  // beating on the decoy at (0,4), two squares from Amoonguss.
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'amoonguss', star: 0, x: 2, y: 0 }, { uid: 2, unitId: 'decoy', star: 0, x: 0, y: 0 }],
    [{ uid: 3, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 4, unitId: 'hitter', star: 0, x: 4, y: 0 }],
  ], 1);
  const am = unitOf(r, 1).id;
  const hitter = unitOf(r, 4).id;
  const taunt = evs(r, 'taunt', hitter)[0];
  assert.ok(taunt && taunt.by === am, 'the hitter is pulled');
  assert.equal(evs(r, 'attack', am).filter((e) => e.t <= taunt.t).length, catalog.amoonguss.energy, 'after 2 attacks');
  assert.equal(taunt.duration, catalog.amoonguss.ability.duration);
  const during = evs(r, 'attack', hitter).filter((e) => e.t > taunt.t && e.t <= taunt.t + taunt.duration);
  assert.ok(during.length > 0 && during.every((e) => e.target === am), 'it only attacks Amoonguss while taunted');
  assert.ok(evs(r, 'attack', hitter).some((e) => e.t < taunt.t && e.target === unitOf(r, 2).id), 'it was attacking the decoy before');
});

test('Rage Fist (Annihilape): each attack in a row without moving makes the next ones faster, up to the cap', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'annihilape', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  const a = unitOf(r, 1).id;
  const p = catalog.annihilape.ability;
  const cd = Math.round(catalog.annihilape.secPerHit / TICK_SECONDS);
  const times = evs(r, 'attack', a).map((e) => e.t).slice(0, p.maxStacks + 4);
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  // The first attack starts the streak (0 stacks); each one after adds a stack.
  gaps.forEach((g, k) => assert.equal(g, Math.round((cd * 100) / (100 + Math.min(k, p.maxStacks) * p.stackPct)), `gap ${k}`));
  assert.equal(Math.max(...evs(r, 'rage', a).map((e) => e.stacks)), p.maxStacks);
});

test('Dragon Darts (Dragapult): each full charge fires one Dreepy at the farthest enemy, which crashes in, stuns and shoves it, and must be attacked; at most 2 are out at once', () => {
  const cat = powerCat();
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'dragapult', star: 0, x: 2, y: 2 }], // combat (2,6)
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 0, y: 3 }, { uid: 4, unitId: 'wall', star: 0, x: 4, y: 3 }], // (2,3), (4,0), (0,0)
  ], 1);
  const d = unitOf(r, 1).id;
  const p = catalog.dragapult.ability;
  const energy = catalog.dragapult.energy;
  const darts = evs(r, 'summon', d).filter((e) => e.dart);
  const attacks = evs(r, 'attack', d);
  assert.ok(darts.length >= p.count, 'it fires');
  assert.equal(new Set(darts.map((e) => e.t)).size, darts.length, `${p.perShot} Dreepy per shot`);
  // The bar fills with an attack, and the Dreepy goes `fireDelay` ticks later.
  const filled = attacks.filter((a) => a.mana === energy && a.t < darts[0].t)[0];
  assert.equal(attacks.filter((a) => a.t <= filled.t).length, energy, `full after ${energy} attacks`);
  if (p.fireDelay !== undefined) {
    assert.equal(darts[0].t, filled.t + p.fireDelay, `fired ${p.fireDelay / 10}s after the bar filled`);
    const refill = attacks.filter((a) => a.t > darts[0].t && a.mana === energy)[0];
    assert.equal(darts[1].t, refill.t + p.fireDelay, 'and again after it filled again');
  } else {
    assert.equal(attacks.filter((a) => a.t > darts[0].t && a.t < darts[1].t).length, energy, `and ${energy} more for the next`);
  }
  assert.ok([unitOf(r, 3).id, unitOf(r, 4).id].includes(darts[0].target), 'at one of the farthest');
  assert.notEqual(darts[1].target, darts[0].target, 'the next at another one');
  // The walls don't knock Dreepy out, so after two it waits with a full charge.
  const out = (t) => darts.filter((x) => x.t < t && !r.events.some((k) => k.type === 'death' && k.id === x.unit.id && k.t < t)).length;
  assert.ok(darts.every((x) => out(x.t) < p.count), `never more than ${p.count} out at once`);
  const third = darts[2]?.t ?? Infinity;
  const firstDown = Math.min(...r.events.filter((k) => k.type === 'death' && darts.some((x) => x.unit.id === k.id)).map((k) => k.t), third);
  const waiting = attacks.filter((a) => a.t > darts[1].t && a.t < firstDown).slice(p.chargeHome ? 0 : energy);
  if (p.chargeHome) assert.ok(waiting.length > 0 && waiting.every((a) => a.mana === 0), 'with both out, its attacks don\'t charge its power');
  else assert.ok(waiting.length > 0 && waiting.every((a) => a.mana === energy), 'its charge waits, full, while two are out');
  const e = darts[0];
  const hit = Math.round(p.impactDamage[0] * STAT_SCALE);
  assert.ok(r.events.some((x) => x.type === 'damage' && x.src === e.unit.id && x.id === e.target && x.amount === hit && x.t === e.t), 'the Dreepy hits its target as it lands');
  assert.ok(r.events.some((x) => x.type === 'stun' && x.id === e.target && x.duration === p.impactStun && x.t === e.t), 'and stuns it');
  const shove = r.events.find((x) => x.type === 'knock' && x.id === e.target && x.by === e.unit.id && x.t === e.t);
  assert.ok(shove, 'the target is shoved aside');
  assert.equal(Math.max(Math.abs(shove.x - e.unit.x), Math.abs(shove.y - e.unit.y)), 1, 'to a square next to where the Dreepy landed');
  assert.ok(r.events.some((x) => x.type === 'taunt' && x.dart && x.id === e.target && x.by === e.unit.id && x.t === e.t), 'it must attack the Dreepy until it faints');
});

test('Dragon Darts (Dragapult): a knocked-out Dreepy flies home, freeing a slot for the next charge', () => {
  const cat = powerCat();
  const oneShot = catalog.dreepy.hp[0];
  cat.biter = { ...cat.wall, range: 1, secPerHit: 1, damage: [oneShot, oneShot + 1, oneShot + 2, oneShot + 3] };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'dragapult', star: 0, x: 2, y: 2 }], // combat (2,6)
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'biter', star: 0, x: 0, y: 3 }, { uid: 4, unitId: 'biter', star: 0, x: 4, y: 3 }],
  ], 1);
  const d = unitOf(r, 1).id;
  const p = catalog.dragapult.ability;
  const darts = evs(r, 'summon', d).filter((e) => e.dart);
  const back = evs(r, 'dartReturn', d);
  assert.ok(back.length >= 1, 'a knocked-out Dreepy flies back');
  assert.ok(back.every((h) => h.duration === Math.round(p.returnSec * 10)));
  assert.ok(darts.length > p.count, 'so Dragapult keeps firing');
  const attacks = evs(r, 'attack', d);
  if (p.fireDelay === undefined) assert.ok(!darts.some((e) => attacks.some((a) => a.t === e.t)), 'a shot takes the place of an attack');
});

test('Dragon Darts (Dragapult): never at an enemy in the 3x3 around it: one far enemy gets one Dreepy, and with only close ones it just attacks', () => {
  const cat = powerCat();
  const p = catalog.dragapult.ability;
  if (!p.outside) return;
  const one = simulate(cat, [
    [{ uid: 1, unitId: 'dragapult', star: 0, x: 2, y: 0 }], // combat (2,4)
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 2, y: 2 }], // (2,3) next to it, (2,1) farther
  ], 1);
  const d = unitOf(one, 1).id;
  const darts = evs(one, 'summon', d).filter((e) => e.dart);
  assert.ok(darts.length >= 1);
  assert.equal(darts.filter((e) => e.t === darts[0].t).length, 1, 'one Dreepy for one enemy outside the 3x3');
  assert.ok(darts.every((e) => e.target === unitOf(one, 3).id), 'never at the one next to it');
  const close = simulate(cat, [
    [{ uid: 1, unitId: 'dragapult', star: 0, x: 2, y: 0 }], // combat (2,4)
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }], // (2,3), right next to it
  ], 1);
  const d2 = unitOf(close, 1).id;
  assert.equal(evs(close, 'summon', d2).length, 0, 'no Dreepy at a Pokémon next to it');
  assert.ok(evs(close, 'attack', d2).length > 0, 'it attacks normally');
});

test('Earthquake (Torterra): after 5 attacks, hits every enemy on the board for 30% and stuns them', () => {
  const r = simulate(powerCat(), [
    [{ uid: 1, unitId: 'torterra', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 0, y: 3 }, { uid: 4, unitId: 'wall', star: 0, x: 4, y: 2 }],
  ], 1);
  const tt = unitOf(r, 1).id;
  const cast = evs(r, 'cast', tt)[0];
  assert.equal(evs(r, 'attack', tt).filter((e) => e.t <= cast.t).length, catalog.torterra.energy, 'with the 5th attack');
  for (const uid of [2, 3, 4]) {
    const id = unitOf(r, uid).id;
    assert.ok(r.events.some((e) => e.type === 'damage' && e.id === id && e.t === cast.t && e.amount === Math.floor((catalog.torterra.damage[0] * 30) / 100)), `hits ${uid}`);
    assert.ok(evs(r, 'stun', id).some((e) => e.t === cast.t && e.duration === 10), `stuns ${uid}`);
  }
});

test('bot layout rules: tanks in front, ranged at the edge of their range, healer behind, out of Psywave, every move explained', () => {
  const s = startedGame(11);
  const me = s.players[0];
  // A deliberately bad board: the tank at the back, the ranged and healer in front.
  me.board = [
    { uid: 901, unitId: 'coalossal', star: 0, x: 0, y: 3 },
    { uid: 902, unitId: 'vespiquen', star: 0, x: 2, y: 0 },
    { uid: 903, unitId: 'lilligant', star: 0, x: 3, y: 0 },
    { uid: 904, unitId: 'tapukoko', star: 0, x: 4, y: 3 },
  ];
  // Last round the enemy had a Beheeyem at their x = 2, so its Psywave runs
  // down our column 2 (the middle).
  s.players[1].lastBoard = [{ unitId: 'beheeyem', star: 0, x: 2, y: 2 }];
  const plan = planLayout(s, catalog, 0);
  assert.equal(new Set(plan.map((m) => `${m.x},${m.y}`)).size, plan.length, 'one square each');
  assert.ok(plan.every((m) => m.reason && m.reason.length > 10), 'every placement says why');
  const at = (uid) => plan.find((m) => m.uid === uid);
  assert.equal(at(901).y, 0, 'the tank holds the front row');
  assert.equal(at(904).y, 0, 'Tapu Koko (a diver) starts in front');
  assert.equal(at(902).y, catalog.vespiquen.range - 1, 'Vespiquen stands as far back as its range still reaches');
  assert.equal(at(903).y, 1, 'Lilligant right behind the front line');
  assert.ok(plan.every((m) => m.x !== 2), "nobody stands in Psywave's column");
  // Same inputs, same plan; and the moves really produce it.
  assert.deepEqual(planLayout(s, catalog, 0), plan);
  for (const m of plan) assert.ok(applyIntent(s, catalog, 0, { type: 'move', uid: m.uid, x: m.x, y: m.y }).ok);
  for (const m of plan) assert.deepEqual([me.board.find((u) => u.uid === m.uid).x, me.board.find((u) => u.uid === m.uid).y], [m.x, m.y]);
});

test('Aromatherapy (Lilligant): each attack heals allies in the 3x3 around the square it hits', () => {
  const cat = powerCat();
  cat.hurt = { ...cat.wall, hp: [1e5, 1e5, 1e5, 1e5] }; // never knocked out during the test
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [200, 200, 200, 200] };
  // Lilligant at combat (2,5) shoots the brute at (2,3) (2 squares). The brute is
  // hitting an ally at (2,4), right next to the square Lilligant hits; an ally
  // at (1,4) is diagonal to it (inside the 3x3); another at (0,7) is nowhere near.
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'lilligant', star: 0, x: 2, y: 1 }, { uid: 2, unitId: 'hurt', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'hurt', star: 0, x: 0, y: 3 }, { uid: 4, unitId: 'hurt', star: 0, x: 1, y: 0 }],
    [{ uid: 5, unitId: 'brute', star: 0, x: 2, y: 0 }],
  ], 1);
  const l = unitOf(r, 1).id;
  const shots = evs(r, 'attack', l).filter((e) => e.target === unitOf(r, 5).id);
  assert.ok(shots.length > 1, 'Lilligant shoots the brute');
  const amount = Math.floor((catalog.lilligant.damage[0] * catalog.lilligant.ability.healPct) / 100);
  const healed = (id) => shots.filter((s) => evs(r, 'heal', id).some((h) => h.t === s.t && h.amount === amount)).length;
  assert.ok(healed(unitOf(r, 2).id) >= shots.length - 1, 'the ally next to the hit square is healed each time');
  assert.equal(catalog.lilligant.ability.radius, 1, 'the heal covers the 3x3');
  // The diagonal ally is at full HP, so nothing lands, but it is offered the heal.
  const offered = evs(r, 'heal', unitOf(r, 4).id).filter((h) => h.from?.[l]?.[1] === amount);
  assert.ok(offered.length >= shots.length - 1, 'the diagonal ally is in the heal too');
  assert.equal(evs(r, 'heal', unitOf(r, 3).id).length, 0, 'an ally elsewhere is not');
});

test('Battle Bond (Greninja): after 5 attacks it becomes Ash-Greninja (faster, harder hitting, range 3)', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'greninja', star: 1, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  const g = unitOf(r, 1).id;
  const tf = evs(r, 'transform', g)[0];
  const form = catalog.greninja.ability.form;
  assert.deepEqual([tf.name, tf.range, tf.sprite], [form.name, form.range, form.sprite]);
  assert.equal(evs(r, 'attack', g).filter((e) => e.t <= tf.t).length, catalog.greninja.energy);
  const after = r.events.filter((e) => e.type === 'damage' && e.src === g && e.t > tf.t && !e.crit);
  assert.equal(after[0].amount, form.damage[1], 'hits with the form damage at its star');
  const times = evs(r, 'attack', g).map((e) => e.t).filter((x) => x > tf.t);
  assert.equal(times[1] - times[0], Math.round(form.secPerHit / TICK_SECONDS), 'attacks faster');
  assert.equal(evs(r, 'transform', g).length, 1, 'once per fight');
});

test('Self-Destruct (Golem): knocked out, it stays put 3s, then explodes on adjacent enemies; the fight waits for it', () => {
  const cat = powerCat();
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [600, 600, 600, 600] };
  cat.bystander = { ...cat.wall, hp: [2000, 2000, 2000, 2000] };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'golem', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'brute', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'bystander', star: 0, x: 0, y: 3 }],
  ], 1);
  const g = unitOf(r, 1).id;
  const fuse = evs(r, 'fuse', g)[0];
  assert.ok(fuse, 'fuse lit');
  const boom = evs(r, 'explode', g)[0];
  assert.equal(boom.t - fuse.t, catalog.golem.ability.delay, '3 seconds later');
  assert.equal(evs(r, 'death', g)[0].t, boom.t, 'only gone after the explosion');
  const hit = r.events.find((e) => e.type === 'damage' && e.src === g && e.t === boom.t);
  assert.equal(hit.id, unitOf(r, 2).id, 'the adjacent brute is caught');
  assert.equal(hit.amount, Math.floor((catalog.golem.damage[0] * catalog.golem.ability.damagePct) / 100));
  assert.ok(!r.events.some((e) => e.type === 'damage' && e.src === g && e.id === unitOf(r, 3).id), 'the far one is not');
  assert.ok(r.ticks >= boom.t, 'the fight lasted until the explosion');
  assert.ok(!r.events.some((e) => e.type === 'damage' && e.id === g && e.t > fuse.t), 'it cannot be hit while the fuse burns');
});

test('Shining Star (Minior): knocked out in Rock form, it comes back as Star Form with its own HP after 0.5s immune', () => {
  const cat = powerCat();
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [125, 125, 125, 125] };
  cat.stunner = { ...cat.brute, energy: 1, ability: { name: 'Stun', kind: 'empower', damagePct: 100, stun: 10 } };
  const form = catalog.minior.ability.form;
  for (const foe of ['brute', 'stunner']) {
    const r = simulate(cat, [[{ uid: 1, unitId: 'minior', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: foe, star: 0, x: 2, y: 0 }]], 1);
    const m = unitOf(r, 1).id;
    const hits = r.events.filter((e) => e.type === 'damage' && e.id === m);
    const ko = hits.find((e) => e.hp === 0);
    const start = evs(r, 'morphStart', m)[0];
    assert.ok(ko && start, 'Rock form is knocked out, then starts transforming');
    assert.equal(start.t, ko.t, 'in the same tick');
    assert.ok(hits.filter((e) => e.t < ko.t).every((e) => e.hp > 0), 'only once its Rock form HP is gone');
    assert.equal(start.hp, form.hp[0], 'with Star Form\'s own HP');
    assert.equal(start.maxHp, form.hp[0]);
    const deaths = evs(r, 'death', m);
    assert.ok(deaths.every((e) => e.t > start.t), 'Rock form breaking is not a knockout');
    const tf = evs(r, 'transform', m)[0];
    assert.equal(tf.t, start.t + 5, 'takes 0.5s');
    assert.equal(tf.sprite, form.sprite);
    assert.ok(!hits.some((e) => e.t > start.t && e.t <= tf.t), 'no damage while transforming');
    assert.ok(!evs(r, 'stun', m).some((e) => e.t > start.t && e.t <= tf.t), 'no stuns while transforming');
    assert.ok(!r.events.some((e) => e.src === m && e.t > start.t && e.t <= tf.t), 'it does nothing while transforming');
    assert.equal(evs(r, 'morphStart', m).length, 1, 'Star Form doesn\'t come back again');
  }
});

test('Shining Star (Minior): every 10 Star Form attacks it hops to a different enemy, even when its target is next to it', () => {
  const cat = powerCat();
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [150, 150, 150, 150] };
  cat.dummy = { ...cat.wall, damage: [1, 1, 1, 1] }; // never dies, barely hurts
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'minior', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'brute', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'dummy', star: 0, x: 0, y: 3 }],
  ], 1);
  const m = unitOf(r, 1).id;
  const tf = evs(r, 'transform', m)[0];
  assert.ok(tf, 'it reaches Star Form');
  const every = catalog.minior.ability.form.energy;
  const attacks = evs(r, 'attack', m).filter((e) => e.t > tf.t);
  assert.ok(attacks.length >= every, 'and attacks enough');
  const hopAt = attacks[every - 1].t;
  const hop = evs(r, 'blink', m).find((e) => e.hop);
  assert.ok(hop, 'it hops');
  assert.equal(hop.t, hopAt, `right after attack ${every}`);
  const before = attacks[every - 1].target;
  const cast = evs(r, 'cast', m).find((e) => e.t === hopAt);
  assert.notEqual(cast.target, before, 'to a different enemy');
  const to = r.initial.find((u) => u.id === cast.target);
  assert.equal(Math.max(Math.abs(hop.x - to.x), Math.abs(hop.y - to.y)), 1, 'landing right beside it');
  assert.ok(attacks.some((e) => e.t > hopAt && e.target === cast.target), 'then attacks it');
});

test('Shining Star (Minior): Star Form zips straight to the square beside its target instead of walking, after a shock wave', () => {
  const cat = powerCat();
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, hp: [150, 150, 150, 150], damage: [250, 250, 250, 250] };
  cat.far = { ...cat.wall, moveSpeed: 'statue', hp: [99999, 99999, 99999, 99999] };
  // Minior in front of a brute; once the brute is down, the only enemy left is far away in a corner.
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'minior', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'brute', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'far', star: 0, x: 0, y: 3 }],
  ], 1);
  const m = unitOf(r, 1).id;
  const tf = evs(r, 'transform', m)[0];
  assert.ok(tf, 'it transforms');
  assert.ok(evs(r, 'shockwave', m).some((e) => e.t === tf.t), 'with a shock wave');
  assert.ok(evs(r, 'stun', unitOf(r, 2).id).some((e) => e.t === tf.t), 'that stuns the enemy next to it');
  assert.ok(!evs(r, 'move', m).some((e) => e.t > tf.t), 'it never walks in Star Form');
  const zip = evs(r, 'blink', m)[0];
  assert.ok(zip, 'it zips');
  const far = unitOf(r, 3);
  assert.equal(Math.max(Math.abs(zip.x - far.x), Math.abs(zip.y - far.y)), 1, 'right next to its target');
  assert.ok(Math.max(Math.abs(zip.x - zip.fromX), Math.abs(zip.y - zip.fromY)) > 1, 'from more than a square away');
  const hit = r.events.find((e) => e.type === 'attack' && e.id === m && e.t > zip.t);
  assert.ok(hit && hit.t - zip.t <= 4, 'and attacks right away');
});

test('Wild Charge (Tapu Koko): dashes in a line next to the farthest enemy, immune on the way, then hits for 150%; stuns everyone it touches', () => {
  const cat = powerCat();
  cat.pecker = { ...cat.wall, secPerHit: 0.1 }; // never moves, hits anyone for 1 every tick
  // Tapu Koko at combat (1,7); the farthest enemy at (1,0) and another in the straight line at (1,3).
  const toOwn = ([x, y]) => ({ x: COLS - 1 - x, y: HALF - 1 - y });
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'tapukoko', star: 0, x: 1, y: 3 }], // combat (1,7)
    [{ uid: 2, unitId: 'pecker', star: 0, ...toOwn([1, 0]) }, { uid: 3, unitId: 'pecker', star: 0, ...toOwn([1, 3]) }, { uid: 4, unitId: 'pecker', star: 0, ...toOwn([0, 7]) }],
  ], 1);
  const k = unitOf(r, 1).id;
  const dash = evs(r, 'dash', k)[0];
  assert.ok(dash, 'it dashes');
  const far = unitOf(r, 2);
  assert.equal(Math.max(Math.abs(dash.x - far.x), Math.abs(dash.y - far.y)), 1, `lands next to the farthest enemy, at (${dash.x},${dash.y})`);
  assert.ok(dash.duration >= 2, 'the dash takes time');
  const cast = evs(r, 'cast', k)[0];
  assert.equal(cast.t, dash.t + dash.duration + 1, 'strikes when it arrives');
  assert.equal(r.events.find((e) => e.type === 'damage' && e.src === k && e.t === cast.t).amount, Math.floor((catalog.tapukoko.damage[0] * 150) / 100));
  const hitsOnKoko = r.events.filter((e) => e.type === 'damage' && e.id === k);
  assert.ok(hitsOnKoko.some((e) => e.t <= dash.t) && hitsOnKoko.some((e) => e.t > dash.t + dash.duration), 'it is hit before and after');
  assert.ok(!hitsOnKoko.some((e) => e.t > dash.t && e.t <= dash.t + dash.duration), 'but not while dashing');
  assert.ok(evs(r, 'stun', far.id).some((e) => e.t === cast.t), 'the target is stunned');
  assert.ok(evs(r, 'stun', unitOf(r, 3).id).some((e) => e.t === dash.t), 'the one in its path is stunned');
});

test('Transform (Ditto): walks into the nearest enemy\'s range, takes 1s to copy it (max HP too, keeping its HP %), stands still, and turns back when it faints', () => {
  const cat = powerCat();
  cat.weak = { ...clone(catalog.mawile), hp: [300, 300, 300, 300], moveSpeed: 'statue', secPerHit: 2 }; // slow, so the copy outlasts it
  cat.far = { ...clone(catalog.coalossal), moveSpeed: 'statue', hp: [1e6, 1e6, 1e6, 1e6] };
  cat.ditto = { ...clone(catalog.ditto), hp: [4000, 4000, 4000, 4000] }; // survives long enough to copy twice
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'ditto', star: 0, x: 2, y: 3 }], // combat (2,7)
    [{ uid: 2, unitId: 'weak', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'far', star: 0, x: 4, y: 3 }], // combat (2,3), (0,0)
  ], 1);
  const d = unitOf(r, 1).id;
  const max = cat.ditto.hp[0];
  assert.equal(r.initial.find((u) => u.id === d).maxHp, max);
  const moves = evs(r, 'move', d);
  const start = evs(r, 'morphStart', d)[0];
  assert.ok(start.t >= moves.filter((e) => e.t < start.t).at(-1).t + STEP_TICKS, 'finishes its step before transforming');
  assert.equal(start.target, unitOf(r, 2).id, 'goes for the nearest');
  assert.ok(moves.filter((e) => e.t < start.t).length >= 2, 'walks next to it first (range 1)');
  assert.equal(moves[1].t - moves[0].t, 8 + 5, 'a 0.5s step, then a 0.8s wait (medium)');
  assert.ok(moves[0].t >= 8, 'waits before its first step too');
  const tfs = evs(r, 'transform', d);
  const hpBefore = r.events.filter((e) => e.type === 'damage' && e.id === d && e.t <= tfs[0].t).at(-1)?.hp ?? max;
  assert.deepEqual([tfs[0].copy, tfs[0].t, tfs[0].maxHp, tfs[0].hp], ['weak', start.t + cat.ditto.ability.morph - 1, 300, Math.round((hpBefore * 300) / max)], 'copies it 1s later, with its max HP (same share of HP)');
  assert.ok(!r.events.some((e) => e.src === d && e.t <= tfs[0].t), 'does not attack before copying');
  const first = r.events.find((e) => e.type === 'damage' && e.src === d && !e.crit);
  assert.equal(first.amount, cat.weak.damage[0], "with the copied Pokémon's damage");
  const weakDied = evs(r, 'death', unitOf(r, 2).id)[0];
  const revert = tfs.find((e) => e.revert);
  assert.ok(revert && revert.t > weakDied.t && revert.t <= weakDied.t + 1, 'turns back right after');
  assert.ok(!moves.some((e) => e.t > tfs[0].t && e.t <= revert.t), 'stands still while copied');
  const hpThen = r.events.filter((e) => e.type === 'damage' && e.id === d && e.t <= revert.t).at(-1)?.hp ?? 300;
  assert.equal(revert.maxHp, max);
  assert.equal(revert.hp, Math.round((hpThen * max) / 300), 'keeps its HP %');
  assert.ok(moves.some((e) => e.t > revert.t), 'then walks to the next');
  const next = tfs[tfs.indexOf(revert) + 1];
  assert.equal(next.copy, 'far', 'and copies it');
  assert.equal(next.maxHp, 1e6);
});

test('Frostbite (Frosmoth): every hit chills the target: slower attacks for a while, refreshed by each hit, then it wears off', () => {
  const cat = powerCat();
  // A sturdy dummy that attacks every second from anywhere, and never moves.
  cat.dummy = { ...cat.wall, range: 99, secPerHit: 1, damage: [1, 1, 1, 1] };
  const fros = catalog.frosmoth.ability;
  const fight = (frosmothSecPerHit) => {
    const c = structuredClone(cat);
    c.frosmoth = { ...c.frosmoth, secPerHit: frosmothSecPerHit, damage: [1, 1, 1, 1], hp: [99999, 99999, 99999, 99999] };
    return simulate(c, [[{ uid: 1, unitId: 'frosmoth', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'dummy', star: 0, x: 2, y: 0 }]], 1);
  };
  const r = fight(1);
  const d = unitOf(r, 2).id;
  const chills = evs(r, 'chill', d);
  assert.ok(chills.length > 1, 'each hit chills');
  assert.equal(chills[0].duration, fros.duration);
  assert.equal(chills[0].pct, fros.slowPct);
  const hits = r.events.filter((e) => e.type === 'attack' && e.id === d).map((e) => e.t);
  const gaps = hits.slice(1).map((x, i) => x - hits[i]);
  const base = Math.round(1 / 0.1);
  assert.ok(gaps.slice(2).every((g) => g === Math.round((base * (100 + fros.slowPct)) / 100)), `chilled: ${fros.slowPct}% slower attacks (gaps ${gaps.slice(0, 6)})`);
  // Frosmoth hits only every 8s: between its hits the chill wears off and the dummy speeds back up.
  const slow = fight(8);
  const sd = unitOf(slow, 2).id;
  const h2 = slow.events.filter((e) => e.type === 'attack' && e.id === sd).map((e) => e.t);
  const [c1, c2] = evs(slow, 'chill', sd).map((e) => e.t);
  const between = h2.filter((x) => x > c1 + fros.duration + base && x <= c2);
  assert.ok(between.length >= 2 && between[1] - between[0] === base, `normal speed again once the chill is over (${between})`);
});

test('Blaze (Infernape): after 7 attacks it attacks 50% faster for 3 seconds', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'infernape', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  const i = unitOf(r, 1).id;
  const h = evs(r, 'haste', i)[0];
  assert.equal(evs(r, 'attack', i).filter((e) => e.t <= h.t).length, catalog.infernape.energy, 'no attack is lost');
  const base = Math.round(catalog.infernape.secPerHit / TICK_SECONDS);
  const fast = Math.round((base * 100) / 150);
  const times = evs(r, 'attack', i).map((e) => e.t);
  const k = times.indexOf(h.t);
  assert.equal(times[k + 1] - times[k], fast, 'the triggering attack already uses the faster cooldown');
  const later = times.filter((x) => x > h.t + catalog.infernape.ability.duration + fast);
  assert.equal(later[1] - later[0], base, 'back to normal afterwards');
});

test('attack range is a square: range 1 = the 3x3 around it (diagonals too), range 2 = the 5x5', () => {
  const cat = powerCat();
  cat.poker = { ...cat.stalker, moveSpeed: 'statue' }; // range 1, never moves
  cat.spear = { ...cat.poker, range: 2 };
  // Side 0 at combat (2,4); side 1's wall at own (x, y) = combat (4 - x, 3 - y).
  const attacks = (id, wx, wy) => evs(simulate(cat, [[{ uid: 1, unitId: id, star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: wx, y: wy }]], 1), 'attack', 0).length > 0;
  assert.ok(attacks('poker', 3, 0), 'range 1 reaches a diagonal neighbour (1,3)');
  assert.ok(!attacks('poker', 2, 1), 'range 1 does not reach 2 squares straight ahead (2,2)');
  assert.ok(attacks('spear', 4, 1), 'range 2 reaches the far corner of its 5x5 (0,2)');
  assert.ok(!attacks('spear', 2, 2), 'range 2 does not reach 3 squares ahead (2,1)');
});

test('units walk one square at a time (no diagonal steps): wait their movement speed, then a 0.5s step', () => {
  const boards = [
    [{ uid: 1, unitId: 'decidueye', star: 0, x: 0, y: 3 }, { uid: 3, unitId: 'mawile', star: 1, x: 4, y: 0 }, { uid: 5, unitId: 'coalossal', star: 0, x: 2, y: 1 }],
    [{ uid: 2, unitId: 'greninja', star: 0, x: 1, y: 0 }, { uid: 4, unitId: 'vespiquen', star: 2, x: 3, y: 3 }],
  ];
  const r = simulate(catalog, boards, 5);
  const all = [...r.initial, ...r.events.filter((e) => e.type === 'summon').map((e) => e.unit)];
  // Before its first step a unit waits its movement speed too (summons from when they appear).
  const born = new Map(r.events.filter((e) => e.type === 'summon').map((e) => [e.unit.id, e.t]));
  const pos = new Map(all.map((u) => [u.id, { x: u.x, y: u.y, t: (born.get(u.id) ?? 0) - STEP_TICKS, first: true }]));
  let moves = 0;
  for (const e of r.events.filter((ev) => ['move', 'knock', 'teleport'].includes(ev.type))) {
    const p = pos.get(e.id);
    if (e.type !== 'move') { pos.set(e.id, { ...p, x: e.x, y: e.y }); continue; } // powers move units too
    assert.equal(Math.abs(e.x - p.x) + Math.abs(e.y - p.y), 1, 'one orthogonal square per step');
    const def = catalog[all.find((u) => u.id === e.id).unitId];
    const wait = Math.round(MOVE_SPEEDS[def.moveSpeed] / TICK_SECONDS);
    if (p.first || p.t > 0) assert.ok(e.t - p.t >= STEP_TICKS + wait, `${def.name} stepped at tick ${e.t}, too soon after tick ${p.t}`);
    const early = r.events.find((ev) => ev.type === 'attack' && ev.id === e.id && ev.t > e.t && ev.t < e.t + STEP_TICKS);
    assert.ok(!early, `${def.name} attacked at tick ${early?.t} before finishing its step from tick ${e.t}`);
    pos.set(e.id, { x: e.x, y: e.y, t: e.t, first: false });
    moves++;
  }
  assert.ok(moves > 0);
});

test('after 30s, sudden death drains everyone equally until one side is knocked out', () => {
  // Two armies that never reach each other (opposite back corners, can't move):
  // without sudden death this would sit at a draw forever.
  const cat = clone(catalog);
  cat.statue = { ...clone(catalog.mawile), moveSpeed: 'statue' };
  const [hp0, hp1] = cat.statue.hp;
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'statue', star: 1, x: 0, y: HALF - 1 }],
    [{ uid: 2, unitId: 'statue', star: 0, x: 0, y: HALF - 1 }],
  ]);
  assert.equal(r.events.find((e) => e.type === 'suddenDeath')?.t, SUDDEN_DEATH_TICK);
  assert.ok(!r.events.some((e) => e.type === 'drain' && e.t < SUDDEN_DEATH_TICK), 'no drain before the timer');
  const perTick = SUDDEN_DEATH_HP_PER_SECOND * STAT_SCALE * TICK_SECONDS; // internal HP per tick
  for (const e of r.events.filter((ev) => ev.type === 'drain')) assert.equal(e.amount, perTick, 'same drain for everyone');
  assert.equal(r.winner, 0, 'the unit with more HP outlasts the other');
  assert.equal(r.ticks, SUDDEN_DEATH_TICK + Math.ceil((hp0 * STAT_SCALE) / perTick) - 1, 'the weaker one lasts hp / drain ticks');
  assert.equal(r.survivors[0].hp, (hp1 - hp0) * STAT_SCALE);
});

test('every fight ends with a winner unless both sides fall at the same moment', () => {
  for (let i = 0; i < 200; i++) {
    const ids = Object.keys(catalog);
    const army = (k) => [{ uid: k, unitId: ids[(i + k) % ids.length], star: (i * k) % 4, x: (i + k) % COLS, y: (i * 3 + k) % HALF }];
    const r = simulate(catalog, [army(1), army(2)], i);
    assert.ok(r.ticks < MAX_TICKS, 'sudden death ends the fight');
    if (r.winner === null) {
      const lastDeaths = r.events.filter((e) => e.type === 'death' && e.t === r.ticks);
      assert.equal(lastDeaths.length, 2, 'a draw only when the last units of both sides fall together');
    }
  }
});

test('a unit boxed in by its allies paths around them to reach an enemy', () => {
  // Mawile at own (2,1) with allies on its left, right, front and both front
  // corners: the only way out is backwards. The enemy is a stationary target in
  // the far corner. Allies and the enemy are immobile and harmless.
  const cat = clone(catalog);
  cat.wall = { ...clone(catalog.mawile), moveSpeed: 'statue', secPerHit: 100, hp: [99999, 99999, 99999, 99999] };
  const wall = [[1, 1], [3, 1], [2, 0], [1, 0], [3, 0]].map(([x, y], i) => ({ uid: 10 + i, unitId: 'wall', star: 0, x, y }));
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'mawile', star: 0, x: 2, y: 1 }, ...wall],
    [{ uid: 2, unitId: 'wall', star: 0, x: 0, y: HALF - 1 }],
  ]);
  const mawile = r.initial.find((u) => u.uid === 1).id;
  const enemy = r.initial.find((u) => u.uid === 2).id;
  const firstMove = r.events.find((e) => e.type === 'move' && e.id === mawile);
  assert.ok(firstMove, 'Mawile must not just stand there');
  assert.ok(firstMove.y > r.initial.find((u) => u.uid === 1).y, 'first step is backwards, out of the pocket');
  const hit = r.events.find((e) => e.type === 'attack' && e.id === mawile && e.target === enemy);
  assert.ok(hit && hit.t < 300, 'it walks around and attacks the enemy before sudden death');
});

test('more copies make a troop stronger', () => {
  const fight = (a, b) => simulate(catalog, [[{ uid: 1, unitId: 'mawile', star: a, x: 2, y: 0 }], [{ uid: 2, unitId: 'mawile', star: b, x: 2, y: 0 }]]).winner;
  for (let s = 1; s <= MAX_STAR; s++) assert.equal(fight(s, s - 1), 0, `${s}★ beats ${s - 1}★`);
});

test('basic attacks crit at the unit\'s crit chance for 50% more damage; mirrored units share luck', () => {
  const cat = clone(catalog);
  cat.wall = { ...clone(catalog.mawile), moveSpeed: 'statue', secPerHit: 100, hp: [1e6, 1e6, 1e6, 1e6] };
  const base = catalog.mawile.damage[0] * STAT_SCALE;
  let hits = 0;
  let crits = 0;
  for (let seed = 0; seed < 40; seed++) {
    const r = simulate(cat, [[{ uid: 1, unitId: 'mawile', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], seed);
    for (const e of r.events.filter((ev) => ev.type === 'damage' && ev.src === 0)) {
      const prev = r.events[r.events.indexOf(e) - 1];
      if (prev.type !== 'attack') continue; // skip Supers: they never crit
      hits++;
      if (e.crit) { crits++; assert.equal(e.amount, Math.floor((base * CRIT_PCT) / 100)); } else assert.equal(e.amount, base);
    }
  }
  const rate = (100 * crits) / hits;
  assert.ok(hits > 500 && Math.abs(rate - catalog.mawile.critChance) < 4, `crit rate ${rate.toFixed(1)}% over ${hits} hits`);
  // No crits at 0%.
  cat.calm = { ...clone(catalog.mawile), critChance: 0 };
  const r = simulate(cat, [[{ uid: 1, unitId: 'calm', star: 0, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  assert.ok(!r.events.some((e) => e.crit));
});

test('every fight starts with power progress at 0 (Hoopa: full) and a full attack cooldown before the first hit', () => {
  const r = simulate(powerCat(), [[{ uid: 1, unitId: 'infernape', star: 2, x: 2, y: 0 }], [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }]], 1);
  const i = unitOf(r, 1).id;
  assert.equal(unitOf(r, 1).mana, 0);
  assert.equal(evs(r, 'attack', i)[0].t, Math.round(catalog.infernape.secPerHit / TICK_SECONDS), 'first attack only after one full cooldown');
  // Across a real match, every fight's units start from zero again.
  let state = createGame({ seed: 5, catalog, names: ['A', 'B'] });
  let fights = 0;
  while (state.phase !== 'gameover' && fights < 8) {
    for (const p of [0, 1]) {
      const send = (intent) => applyIntent(state, catalog, p, intent);
      if (state.phase === 'combat') send({ type: 'continue' }); else if (state.phase !== 'gameover') botTurn(state, catalog, p, send);
    }
    const start = (u) => (catalog[u.unitId].ability?.startCharged ? u.maxMana : 0);
    if (state.phase === 'combat') { fights++; assert.ok(state.combat.result.initial.every((u) => u.mana === start(u)), `fight ${fights}`); }
  }
});

// ---- profile -------------------------------------------------------------------

test('profile: saved in browser storage and loaded back; old saved names carry over; bad data is cleaned', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    const basics = ({ name, avatar, saved }) => ({ name, avatar, saved });
    assert.deepEqual(basics(loadProfile()), { name: '', avatar: DEFAULT_AVATAR, saved: false }, 'nothing saved yet');
    store.set('poke-tactics-name', 'Misty');
    assert.deepEqual(basics(loadProfile()), { name: 'Misty', avatar: DEFAULT_AVATAR, saved: true }, 'the name saved before profiles');
    const pic = AVATARS[0];
    assert.equal(saveProfile({ name: '  Brock   the  Rock ', avatar: pic }).stored, true);
    assert.deepEqual(basics(loadProfile()), { name: 'Brock the Rock', avatar: pic, saved: true }, 'comes back after a reload');
    saveProfile({ name: 'x'.repeat(40), avatar: '../../evil.png' });
    const p = loadProfile();
    assert.equal(p.name.length, NAME_MAX);
    assert.equal(p.avatar, DEFAULT_AVATAR, 'only pictures from the list');
    store.set('poke-tactics-profile', '{not json');
    assert.equal(loadProfile().avatar, DEFAULT_AVATAR, 'corrupt data is ignored');
    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(saveProfile({ name: 'A', avatar: pic }).stored, false, 'blocked storage is reported, not thrown');
    assert.equal(loadProfile().saved, false);
  } finally {
    delete globalThis.localStorage;
  }
  for (const id of AVATARS) assert.ok(existsSync(new URL(`../assets/avatars/${id}.png`, import.meta.url)), `${id} picture exists (tools/make-avatars.py)`);
});

test('profile stats and friends: wins/losses per mode, most used Pokémon, add and remove friends; kept when the name changes', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    recordMatch('training', 'win');
    recordMatch('training', 'loss');
    recordMatch('online', 'win');
    recordMatch('online', 'draw');
    recordMatch('hacked', 'win');
    recordBattle(['mawile', 'golem']);
    recordBattle(['mawile', 'mawile']); // the same Pokémon counts once per battle
    addFriend({ id: 'a', name: 'Misty', avatar: 'lilligant' });
    addFriend({ id: 'b', name: 'Brock', avatar: 'nope' });
    addFriend({ id: 'a', name: 'Misty W', avatar: 'lilligant' }); // same friend: updated, not doubled
    saveProfile({ name: 'Ash', avatar: AVATARS[0] });
    const p = loadProfile();
    assert.deepEqual(p.stats.training, { wins: 1, losses: 1, draws: 0 });
    assert.deepEqual(p.stats.online, { wins: 1, losses: 0, draws: 1 });
    assert.deepEqual(p.stats.troops, { mawile: 2, golem: 1 });
    assert.deepEqual(favouriteTroop(p.stats), { id: 'mawile', battles: 2 });
    assert.equal(favouriteTroop({ troops: {} }), null, 'none before any battle');
    assert.deepEqual(p.friends.map((f) => [f.id, f.name, f.avatar]), [['b', 'Brock', DEFAULT_AVATAR], ['a', 'Misty W', 'lilligant']]);
    removeFriend('b');
    assert.deepEqual(loadProfile().friends.map((f) => f.id), ['a']);
    assert.equal(loadProfile().name, 'Ash');
    store.set('poke-tactics-profile', JSON.stringify({ name: 'X', stats: { online: { wins: -5, losses: 'lots' }, troops: { '<b>': 3 } }, friends: 'no' }));
    const bad = loadProfile();
    assert.deepEqual(bad.stats.online, { wins: 0, losses: 0, draws: 0 }, 'bad numbers are dropped');
    assert.deepEqual(bad.stats.troops, {}, 'bad ids are dropped');
    assert.deepEqual(bad.friends, []);
  } finally {
    delete globalThis.localStorage;
  }
});

test('each player\'s profile picture is part of the game state', () => {
  const s = createGame({ seed: 1, catalog, names: ['A', 'B'], avatars: ['infernape', 'golem'] });
  assert.deepEqual(s.players.map((p) => p.avatar), ['infernape', 'golem']);
  assert.deepEqual(createGame({ seed: 1, catalog, names: ['A', 'B'] }).players.map((p) => p.avatar), [null, null]);
});

test('power progress never goes down except when the power is used', () => {
  for (let i = 0; i < 60; i++) {
    const ids = TROOPS;
    const army = (k) => [0, 1, 2].map((j) => ({ uid: k * 10 + j, unitId: ids[(i + j * 3 + k) % ids.length], star: (i + j) % 4, x: (j * 2 + k) % COLS, y: (i + j) % HALF }));
    const r = simulate(catalog, [army(1), army(2)], i);
    const mana = new Map();
    for (const e of r.events) {
      if (e.type === 'cast') { mana.set(e.id, 0); continue; }
      const m = e.type === 'attack' ? e.mana : undefined;
      if (m === undefined) continue;
      assert.ok(m >= (mana.get(e.id) ?? 0), `unit ${e.id} went from ${mana.get(e.id)} to ${m} at tick ${e.t}`);
      mana.set(e.id, m);
    }
  }
});

test('a summon with no free square is not wasted: the power stays charged', () => {
  const cat = powerCat();
  cat.target = { ...cat.wall };
  // Vespiquen boxed in by walls on every side; the enemy wall is in its range.
  const box = [[1, 0], [3, 0], [2, 1], [1, 1], [3, 1]].map(([x, y], k) => ({ uid: 10 + k, unitId: 'wall', star: 0, x, y }));
  const front = [1, 3].map((x, k) => ({ uid: 20 + k, unitId: 'target', star: 0, x, y: 0 })); // the diagonals ahead
  const r = simulate(cat, [[{ uid: 1, unitId: 'vespiquen', star: 0, x: 2, y: 0 }, ...box], [{ uid: 2, unitId: 'target', star: 0, x: 2, y: 0 }, ...front]], 1);
  const v = unitOf(r, 1).id;
  assert.ok(!evs(r, 'summon', v).length, 'no room, no Combee');
  const attacks = evs(r, 'attack', v);
  assert.ok(attacks.length > catalog.vespiquen.energy + 2);
  assert.ok(attacks.slice(catalog.vespiquen.energy - 1).every((e) => e.mana === catalog.vespiquen.energy), 'the charge is kept');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
