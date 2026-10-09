// Zero-dependency test runner: `node tests/run.js` (or `npm test`).
// Focuses on the properties Phase 3 depends on: determinism, JSON-serializable
// state, and applyIntent rejecting anything invalid. Plus the team/pool rules.

import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  createGame, applyIntent, fielded, troopIds, teamSize, poolSize, TEAM_SIZE,
  COPIES_PER_TROOP, MAX_STAR, SHOP_SIZE, START_COINS, WIN_COINS, LOSS_COINS, MAX_REROLLS,
} from '../src/game.js';
import {
  simulate, MAX_TICKS, COLS, HALF, SUDDEN_DEATH_TICK, SUDDEN_DEATH_HP_PER_SECOND, MOVE_SPEEDS, CRIT_PCT, STAT_SCALE, TICK_SECONDS,
} from '../src/combat.js';
import { botTurn } from '../src/bot.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (v) => JSON.parse(JSON.stringify(v));
const TROOPS = troopIds(catalog);
const team = (troops = TROOPS.slice(0, teamSize(catalog))) => ({ type: 'chooseTeam', troops });
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
  const kinds = new Set(['empower', 'snipe', 'summon', 'stealth', 'haste', 'opening']);
  for (const [id, u] of Object.entries(catalog)) {
    for (const k of ['hp', 'damage']) {
      const v = u[k];
      assert.ok(Array.isArray(v) && v.length === COPIES_PER_TROOP, `${id}.${k} lists 0-${MAX_STAR}★`);
      assert.ok(v.every((n, i) => n > 0 && (!i || n > v[i - 1])), `${id}.${k} must be positive and increase with stars`);
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
      // A power either goes off at battle start or every `energy` attacks.
      assert.ok(u.ability.kind === 'opening' ? u.energy === 0 : Number.isInteger(u.energy) && u.energy > 0, `${id}.energy`);
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
    team('mawile'), team(null),
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
    p.rerolls = 1;
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
  p.rerolls = 1;
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
  assert.equal(p.shop[0], null);
  assert.equal(p.coins, 99 - catalog[id].cost);
  assertCopiesConserved(p);
  assert.equal(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 1, y: 1 }).ok, false, 'slot is now empty');
});

test('no duplicates on the field: buying a troop you already have levels it up (1-4 copies = 0-3 stars)', () => {
  const s = startedGame();
  const p = s.players[0];
  const id = 'mawile';
  const other = TROOPS.find((t) => t !== id);
  p.coins = 99;
  p.shop = [id, id, other];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 0, y: 0 }).ok);
  // A second copy aimed at a different empty square still levels up the first one.
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 1, x: 4, y: 2 }).ok);
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

test('economy: start with 6 coins; winner +6, loser +9; coins carry over uncapped', () => {
  const s = startedGame();
  assert.deepEqual(s.players.map((p) => p.coins), [START_COINS, START_COINS]);
  const p = s.players[0];
  p.shop = ['mawile', null, null];
  p.coins = 50; // whatever isn't spent carries over to the next round
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 2, y: 0 }).ok); // player 0 has a troop, player 1 an empty board
  const before = s.players.map((q) => q.coins);
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'ready' });
  const { winner } = s.combat.result;
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'continue' });
  assert.equal(s.round, 2);
  s.players.forEach((q, i) => assert.equal(q.coins, before[i] + (winner === i ? WIN_COINS : LOSS_COINS), `player ${i} (winner ${winner})`));
  assert.ok(s.players[0].coins > 50, 'no cap on coins');
});

test('rerolls: 3 free to start, none left means none, +1 per round capped at 3, shop refreshes each round', () => {
  const s = startedGame();
  const p = s.players[0];
  assert.equal(p.rerolls, MAX_REROLLS);
  const coins = p.coins;
  for (let i = 0; i < MAX_REROLLS; i++) assert.ok(applyIntent(s, catalog, 0, { type: 'reroll' }).ok);
  assert.equal(p.coins, coins, 'rerolls are free');
  assert.equal(p.rerolls, 0);
  assert.equal(applyIntent(s, catalog, 0, { type: 'reroll' }).ok, false, 'out of rerolls');
  const nextRound = () => {
    for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'ready' });
    for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'continue' });
  };
  p.shop = [null, null, null];
  nextRound();
  assert.equal(p.rerolls, 1, '+1 reroll for the new round');
  assert.ok(p.shop.some(Boolean), 'shop is refreshed automatically after the battle');
  nextRound();
  nextRound();
  nextRound();
  assert.equal(p.rerolls, MAX_REROLLS, 'capped');
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
  p.shop = ['mawile', 'coalossal', null];
  applyIntent(s, catalog, 1, { type: 'buy', slot: 0, x: 1, y: 0 });
  applyIntent(s, catalog, 1, { type: 'buy', slot: 1, x: 3, y: 2 });
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'ready' });
  for (const i of [0, 1]) applyIntent(s, catalog, i, { type: 'continue' });
  assert.equal(s.phase, 'planning');
  assert.deepEqual(p.lastBoard, [{ unitId: 'mawile', star: 0, x: 1, y: 0 }, { unitId: 'coalossal', star: 0, x: 3, y: 2 }]);
  // Changing the board now doesn't change what the opponent sees from last round.
  applyIntent(s, catalog, 1, { type: 'move', uid: p.board[0].uid, x: 0, y: 3 });
  assert.deepEqual(p.lastBoard[0], { unitId: 'mawile', star: 0, x: 1, y: 0 });
});

test('featured troop leads the shop while its pool has copies; bad ids are ignored', () => {
  const s = startedGame(3, { featured: 'beheeyem' });
  for (const p of s.players) assert.equal(p.shop[0], 'beheeyem');
  const p = s.players[0];
  for (let i = 0; i < 5; i++) {
    p.rerolls = 1;
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

test('Thunderbolt (Toxtricity): every 8th attack also zaps the farthest enemy for 80%', () => {
  const r = simulate(powerCat(), [
    [{ uid: 1, unitId: 'toxtricity', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'wall', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 0, y: 3 }],
  ], 1);
  const tx = unitOf(r, 1).id;
  const far = unitOf(r, 3).id;
  const cast = evs(r, 'cast', tx)[0];
  assert.equal(cast.target, far);
  assert.equal(evs(r, 'attack', tx).filter((e) => e.t <= cast.t).length, catalog.toxtricity.energy, 'fires with the 8th attack');
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === far).amount, Math.floor((catalog.toxtricity.damage[0] * 80) / 100));
});

test('Attack Order (Vespiquen): every 10 attacks summons a Combee that fights but never counts as a survivor', () => {
  const cat = powerCat();
  cat.target = { ...cat.wall, hp: [1500, 1500, 1500, 1500] };
  const r = simulate(cat, [[{ uid: 1, unitId: 'vespiquen', star: 1, x: 2, y: 0 }], [{ uid: 2, unitId: 'target', star: 0, x: 2, y: 0 }]], 1);
  const v = unitOf(r, 1).id;
  const s = evs(r, 'summon', v)[0];
  assert.ok(s, 'summons');
  assert.deepEqual([s.unit.unitId, s.unit.star, s.unit.summoned], ['combee', 1, true]);
  assert.equal(evs(r, 'attack', v).filter((e) => e.t <= s.t).length, catalog.vespiquen.energy);
  assert.ok(evs(r, 'attack', s.unit.id).length > 0, 'the Combee attacks');
  assert.equal(r.winner, 0);
  assert.deepEqual(r.survivors.map((u) => u.unitId), ['vespiquen']);
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

test('Night Slash (Greninja): the attack after 6 teleports to the farthest enemy, hits 30% harder and heals 10%', () => {
  const cat = powerCat();
  cat.brute = { ...cat.wall, range: 1, secPerHit: 1, damage: [40, 40, 40, 40] };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'greninja', star: 0, x: 2, y: 0 }],
    [{ uid: 2, unitId: 'brute', star: 0, x: 2, y: 0 }, { uid: 3, unitId: 'wall', star: 0, x: 0, y: 3 }], // far one at combat (4, 0)
  ], 1);
  const g = unitOf(r, 1).id;
  const far = unitOf(r, 3).id;
  const cast = evs(r, 'cast', g)[0];
  assert.equal(cast.target, far);
  const tp = evs(r, 'teleport', g)[0];
  assert.equal(tp.t, cast.t);
  assert.equal(Math.abs(tp.x - 4) + Math.abs(tp.y - 0), 1, 'lands next to the farthest enemy');
  const dealt = Math.floor((catalog.greninja.damage[0] * 130) / 100);
  assert.equal(r.events.find((e) => e.type === 'damage' && e.id === far).amount, dealt);
  assert.equal(evs(r, 'heal', g).find((e) => e.t === cast.t).amount, Math.floor(dealt / 10));
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

test('units walk one square at a time (no diagonal steps), at their own pace', () => {
  const boards = [
    [{ uid: 1, unitId: 'decidueye', star: 0, x: 0, y: 3 }, { uid: 3, unitId: 'mawile', star: 1, x: 4, y: 0 }, { uid: 5, unitId: 'coalossal', star: 0, x: 2, y: 1 }],
    [{ uid: 2, unitId: 'greninja', star: 0, x: 1, y: 0 }, { uid: 4, unitId: 'vespiquen', star: 2, x: 3, y: 3 }],
  ];
  const r = simulate(catalog, boards, 5);
  const all = [...r.initial, ...r.events.filter((e) => e.type === 'summon').map((e) => e.unit)];
  const pos = new Map(all.map((u) => [u.id, { x: u.x, y: u.y, t: -Infinity }]));
  let moves = 0;
  for (const e of r.events.filter((ev) => ['move', 'knock', 'teleport'].includes(ev.type))) {
    const p = pos.get(e.id);
    if (e.type !== 'move') { pos.set(e.id, { ...p, x: e.x, y: e.y }); continue; } // powers move units too
    assert.equal(Math.abs(e.x - p.x) + Math.abs(e.y - p.y), 1, 'one orthogonal square per step');
    const def = catalog[all.find((u) => u.id === e.id).unitId];
    const pace = MOVE_SPEEDS[def.moveSpeed];
    assert.ok(e.t - p.t >= Math.round(pace / TICK_SECONDS), `${def.name} stepped faster than ${pace}s per square`);
    const early = r.events.find((ev) => ev.type === 'attack' && ev.id === e.id && ev.t > e.t && ev.t < e.t + Math.round(pace / TICK_SECONDS));
    assert.ok(!early, `${def.name} attacked at tick ${early?.t} before finishing its step from tick ${e.t}`);
    pos.set(e.id, { x: e.x, y: e.y, t: e.t });
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

test('every fight starts with power progress at 0 and a full attack cooldown before the first hit', () => {
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
    if (state.phase === 'combat') { fights++; assert.ok(state.combat.result.initial.every((u) => u.mana === 0), `fight ${fights}`); }
  }
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
