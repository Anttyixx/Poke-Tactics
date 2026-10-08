// Zero-dependency test runner: `node tests/run.js` (or `npm test`).
// Focuses on the properties Phase 3 depends on: determinism, JSON-serializable
// state, and applyIntent rejecting anything invalid. Plus the team/pool rules.

import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  createGame, applyIntent, fielded, leaderIds, troopIds, teamSize, poolSize,
  COPIES_PER_TROOP, MAX_STAR, SHOP_SIZE, START_COINS, WIN_COINS, LOSS_COINS, MAX_REROLLS,
} from '../src/game.js';
import { simulate, MAX_TICKS, COLS, HALF, SUDDEN_DEATH_TICK, SUDDEN_DEATH_HP_PER_SECOND } from '../src/combat.js';
import { botTurn } from '../src/bot.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (v) => JSON.parse(JSON.stringify(v));
const TROOPS = troopIds(catalog);
const team = (leader = 'decidueye', troops = TROOPS.slice(0, teamSize(catalog))) => ({ type: 'chooseTeam', leader, troops });

// A game past team building, in round 1 planning.
function startedGame(seed = 7, leaders = ['decidueye', 'decidueye'], opts = {}) {
  const s = createGame({ seed, catalog, names: ['A', 'B'], ...opts });
  leaders.forEach((leader, p) => assert.ok(applyIntent(s, catalog, p, team(leader)).ok));
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
  const kinds = new Set(['strike', 'stun', 'blast', 'heal', 'shield']);
  for (const [id, u] of Object.entries(catalog)) {
    const hp = Array.isArray(u.hp) ? u.hp : [u.hp];
    assert.ok(hp.every((h) => h > 0), `${id}.hp must be positive`);
    if (!u.leader) assert.ok(hp.length === COPIES_PER_TROOP && hp.every((h, i) => !i || h > hp[i - 1]), `${id}: troops list HP for 0-${MAX_STAR}★, increasing`);
    for (const k of ['atk', 'hitsPerSec']) assert.ok(u[k] > 0, `${id}.${k} must be positive`);
    for (const k of ['energy', 'range']) assert.ok(Number.isInteger(u[k]) && u[k] > 0, `${id}.${k} must be a positive integer`);
    assert.ok(u.secPerTile > 0, `${id}.secPerTile must be positive`);
    assert.ok(u.leader ? u.cost === 0 : Number.isInteger(u.cost) && u.cost > 0, `${id} cost`);
    assert.ok(kinds.has(u.ability.kind), `${id} ability kind`);
    assert.ok(u.sprite && existsSync(new URL(`../${u.sprite}`, import.meta.url)), `${id}: missing sprite ${u.sprite}`);
  }
  assert.equal(new Set(TROOPS.map((id) => catalog[id].secPerTile)).size, 1, 'all troops move at the same speed');
  assert.ok(TROOPS.length >= teamSize(catalog) && teamSize(catalog) > 0);
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

test('team phase: only valid teams; round 1 starts with leaders placed and pools filled', () => {
  const s = createGame({ seed: 7, catalog, names: ['A', 'B'] });
  assert.equal(s.phase, 'team');
  const need = teamSize(catalog);
  const bad = [
    { type: 'buy', slot: 0, x: 0, y: 0 }, { type: 'ready' },
    team('mawile'), team('toString'), team(null),
    team('decidueye', TROOPS.slice(0, need - 1)), // too few
    team('decidueye', [...TROOPS.slice(0, need - 1), TROOPS[0]]), // duplicate
    team('decidueye', [...TROOPS.slice(0, need - 1), 'greninja']), // a leader as a troop
    team('decidueye', 'mawile'),
  ];
  for (const intent of bad) {
    const before = clone(s);
    assert.equal(applyIntent(s, catalog, 0, intent).ok, false, JSON.stringify(intent));
    assert.deepEqual(s, before);
  }
  assert.ok(applyIntent(s, catalog, 0, team('infernape')).ok);
  assert.equal(applyIntent(s, catalog, 0, team('greninja')).ok, false, 'cannot choose twice');
  assert.equal(s.phase, 'team');
  assert.ok(applyIntent(s, catalog, 1, team('decidueye')).ok);
  assert.equal(s.phase, 'planning');
  assert.equal(s.round, 1);
  assert.deepEqual(s.players.map((p) => p.board.map((u) => [u.unitId, u.leader, u.y, u.star])),
    [[['infernape', true, 0, 0]], [['decidueye', true, 3, 0]]], 'melee leaders in front, ranged at the back');
  for (const p of s.players) {
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
      assert.ok(p.team.includes(id) && !catalog[id].leader, id);
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
  assert.equal(applyIntent(s, catalog, 0, { type: 'buy', slot: 2, x: 2, y: 3 }).ok, false, 'nor onto the leader');
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
    assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: i, y: 1 }).ok, `${id} placed`);
  });
  assert.equal(p.board.length, p.team.length + 1, 'all troops plus the leader');
  const someone = p.board.find((u) => !u.leader);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: someone.uid, x: 0, y: HALF }).ok, false);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: someone.uid, x: -1, y: 0 }).ok, false);
});

test('leader cannot be sold or combined, but can move and swap', () => {
  const s = startedGame();
  const p = s.players[0];
  const leader = p.board[0];
  p.coins = 99;
  p.shop = ['mawile', null, null];
  applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 0, y: 0 });
  const troop = p.board.find((u) => !u.leader);
  assert.equal(applyIntent(s, catalog, 0, { type: 'sell', uid: leader.uid }).ok, false);
  assert.ok(applyIntent(s, catalog, 0, { type: 'move', uid: leader.uid, x: 0, y: 0 }).ok, 'swap with a troop');
  assert.deepEqual([leader.x, leader.y, troop.x, troop.y], [0, 0, 2, 3]);
  assert.equal(p.board.length, 2);
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
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0, x: 2, y: 0 }).ok); // player 0 has a troop, player 1 only a leader
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

test('featured troop leads the shop while its pool has copies; bad ids are ignored', () => {
  const s = startedGame(3, ['greninja', 'greninja'], { featured: 'beheeyem' });
  for (const p of s.players) assert.equal(p.shop[0], 'beheeyem');
  const p = s.players[0];
  for (let i = 0; i < 5; i++) {
    p.rerolls = 1;
    assert.ok(applyIntent(s, catalog, 0, { type: 'reroll' }).ok);
    assert.equal(p.shop[0], 'beheeyem');
  }
  for (const bad of ['greninja', 'nope', 'toString', '', null]) {
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

test("a Super with its own reach (Decidueye's) hits enemies beyond basic range without moving", () => {
  // Test-only catalog: Decidueye supers after 1 attack; two dummies that never move.
  const cat = clone(catalog);
  cat.decidueye.energy = 1;
  cat.dummy = { ...clone(catalog.mawile), hp: [0.1, 1, 2, 3], hitsPerSec: 0.01, secPerTile: 1000 };
  cat.far = { ...cat.dummy, hp: [500, 501, 502, 503] };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'decidueye', star: 0, leader: true, x: 0, y: HALF - 1 }], // back row
    [{ uid: 2, unitId: 'dummy', star: 0, x: COLS - 1, y: 0 }, { uid: 3, unitId: 'far', star: 0, x: COLS - 1, y: HALF - 1 }],
  ]);
  const cast = r.events.find((e) => e.type === 'cast' && e.id === 0);
  assert.ok(cast, 'Decidueye should cast');
  assert.equal(r.initial.find((u) => u.id === cast.target).unitId, 'far');
  assert.ok(!r.events.some((e) => e.type === 'move' && e.id === 0 && e.t <= cast.t), 'cast without walking');
  const d = r.initial.find((u) => u.id === 0);
  const f = r.initial.find((u) => u.unitId === 'far');
  assert.ok(Math.max(Math.abs(d.x - f.x), Math.abs(d.y - f.y)) > catalog.decidueye.range, 'target was out of basic range');
});

test('units walk one square at a time (no diagonal steps), at their own pace', () => {
  const boards = [
    [{ uid: 1, unitId: 'decidueye', star: 0, leader: true, x: 0, y: 3 }, { uid: 3, unitId: 'mawile', star: 1, x: 4, y: 0 }, { uid: 5, unitId: 'coalossal', star: 0, x: 2, y: 1 }],
    [{ uid: 2, unitId: 'greninja', star: 0, leader: true, x: 1, y: 0 }, { uid: 4, unitId: 'vespiquen', star: 2, x: 3, y: 3 }],
  ];
  const r = simulate(catalog, boards, 5);
  const pos = new Map(r.initial.map((u) => [u.id, { x: u.x, y: u.y, t: -Infinity }]));
  let moves = 0;
  for (const e of r.events.filter((ev) => ev.type === 'move')) {
    const p = pos.get(e.id);
    assert.equal(Math.abs(e.x - p.x) + Math.abs(e.y - p.y), 1, 'one orthogonal square per step');
    const def = catalog[r.initial.find((u) => u.id === e.id).unitId];
    assert.ok(e.t - p.t >= Math.round(def.secPerTile * 10), `${def.name} stepped faster than ${def.secPerTile}s per square`);
    pos.set(e.id, { x: e.x, y: e.y, t: e.t });
    moves++;
  }
  assert.ok(moves > 0);
});

test('after 30s, sudden death drains everyone equally until one side is knocked out', () => {
  // Two armies that never reach each other (opposite back corners, can't move):
  // without sudden death this would sit at a draw forever.
  const cat = clone(catalog);
  cat.statue = { ...clone(catalog.mawile), secPerTile: 1000 };
  const r = simulate(cat, [
    [{ uid: 1, unitId: 'statue', star: 1, x: 0, y: HALF - 1 }], // 37 HP
    [{ uid: 2, unitId: 'statue', star: 0, x: 0, y: HALF - 1 }], // 25 HP
  ]);
  assert.equal(r.events.find((e) => e.type === 'suddenDeath')?.t, SUDDEN_DEATH_TICK);
  assert.ok(!r.events.some((e) => e.type === 'drain' && e.t < SUDDEN_DEATH_TICK), 'no drain before the timer');
  const perTick = (SUDDEN_DEATH_HP_PER_SECOND * 10) / 10; // sheet HP/s -> internal HP per tick
  for (const e of r.events.filter((ev) => ev.type === 'drain')) assert.equal(e.amount, perTick, 'same drain for everyone');
  assert.equal(r.winner, 0, 'the unit with more HP outlasts the other');
  assert.equal(r.ticks, SUDDEN_DEATH_TICK + 250 / perTick - 1, '25 HP lasts 2.5s');
  assert.equal(r.survivors[0].hp, 370 - 250);
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
  cat.wall = { ...clone(catalog.mawile), secPerTile: 1000, hitsPerSec: 0.01, hp: [999, 999, 999, 999] };
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
