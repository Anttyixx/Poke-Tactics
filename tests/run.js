// Zero-dependency test runner: `node tests/run.js` (or `npm test`).
// Focuses on the properties Phase 3 depends on: determinism, JSON-serializable
// state, and applyIntent rejecting anything invalid.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createGame, applyIntent, boardCap, fieldCount, leaderIds, BENCH_SIZE } from '../src/game.js';
import { simulate, MAX_TICKS } from '../src/combat.js';
import { botTurn } from '../src/bot.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (v) => JSON.parse(JSON.stringify(v));

// A game that is past leader selection and in round 1 planning.
function startedGame(seed = 7, leaders = ['decidueye', 'decidueye']) {
  const s = createGame({ seed, catalog, names: ['A', 'B'] });
  leaders.forEach((leader, p) => assert.ok(applyIntent(s, catalog, p, { type: 'chooseLeader', leader }).ok));
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
      else botTurn(state, catalog, p, send(p));
      if (roundTrip) state = clone(state);
    }
  }
  return state;
}

test('unit catalog is well formed', () => {
  const kinds = new Set(['strike', 'stun', 'blast', 'heal', 'shield']);
  for (const [id, u] of Object.entries(catalog)) {
    for (const k of ['hp', 'atk', 'armor', 'range', 'attackCd', 'moveCd', 'mana', 'cost']) {
      assert.ok(Number.isInteger(u[k]) && u[k] >= 0, `${id}.${k} must be a non-negative integer`);
    }
    assert.ok(u.leader ? u.cost === 0 && u.sprite : [1, 2, 3].includes(u.cost), `${id} cost`);
    assert.ok(kinds.has(u.ability.kind), `${id} ability kind`);
  }
});

test('full bot-vs-bot match is deterministic for a seed', () => {
  assert.deepEqual(playMatch(1234), playMatch(1234));
});

test('state survives a JSON round trip between turns', () => {
  assert.deepEqual(playMatch(99, { roundTrip: true }), playMatch(99));
});

test('matches actually finish', () => {
  for (const seed of [1, 2, 3, 4, 5]) assert.equal(playMatch(seed).phase, 'gameover', `seed ${seed}`);
});

test('simulate does not mutate its inputs and is repeatable', () => {
  const boards = [
    [{ uid: 1, unitId: 'squire', star: 1, x: 3, y: 0 }, { uid: 2, unitId: 'scout', star: 2, x: 4, y: 3 }],
    [{ uid: 3, unitId: 'knight', star: 1, x: 3, y: 0 }, { uid: 4, unitId: 'acolyte', star: 1, x: 2, y: 3 }],
  ];
  const before = clone(boards);
  const a = simulate(catalog, boards);
  assert.deepEqual(boards, before);
  assert.deepEqual(a, simulate(catalog, clone(boards)));
  assert.ok(a.ticks <= MAX_TICKS);
  assert.equal(a.events.at(-1).type, 'end');
});

test('empty boards resolve immediately', () => {
  const unit = [{ uid: 1, unitId: 'squire', star: 1, x: 0, y: 0 }];
  assert.equal(simulate(catalog, [[], []]).winner, null);
  assert.equal(simulate(catalog, [unit, []]).winner, 0);
  assert.equal(simulate(catalog, [[], unit]).winner, 1);
});

test('mirrored boards are fair-ish (no first-mover blowout)', () => {
  const side = (uidBase) => [
    { uid: uidBase + 1, unitId: 'knight', star: 1, x: 3, y: 0 },
    { uid: uidBase + 2, unitId: 'hunter', star: 1, x: 4, y: 3 },
  ];
  const r = simulate(catalog, [side(0), side(10)]);
  // Either side may win by a hair, but survivors should be few and hurt.
  assert.ok(r.survivors.length <= 1);
});

test('rejects invalid and out-of-phase intents', () => {
  const s = startedGame();
  const bad = [
    [5, { type: 'reroll' }],
    [0, null],
    [0, { type: 'hack' }],
    [0, { type: 'toString' }],
    [0, { type: 'buy', slot: 99 }],
    [0, { type: 'buy', slot: '0' }],
    [0, { type: 'sell', uid: 12345 }],
    [0, { type: 'continue' }],
  ];
  for (const [p, intent] of bad) {
    const before = clone(s);
    assert.equal(applyIntent(s, catalog, p, intent).ok, false, JSON.stringify(intent));
    assert.deepEqual(s, before, 'rejected intent must not change state');
  }
});

test('cannot place on the enemy half or exceed the board cap', () => {
  const s = startedGame();
  const p = s.players[0];
  p.gold = 50;
  for (let i = 0; i < 5; i++) applyIntent(s, catalog, 0, { type: 'buy', slot: i });
  const benched = p.bench.filter(Boolean);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: benched[0].uid, to: { area: 'board', x: 0, y: 4 } }).ok, false);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: benched[0].uid, to: { area: 'board', x: 0, y: -1 } }).ok, false);
  const cap = boardCap(s.round);
  const placed = p.bench.filter(Boolean).map((u, i) =>
    applyIntent(s, catalog, 0, { type: 'move', uid: u.uid, to: { area: 'board', x: i, y: 0 } }).ok);
  assert.equal(placed.filter(Boolean).length, Math.min(cap, placed.length));
  assert.equal(fieldCount(p), Math.min(cap, placed.length));
  assert.equal(p.board.length, fieldCount(p) + 1, 'leader is on the board but outside the cap');
});

test('three copies merge into a 2-star, even with a full bench', () => {
  const s = startedGame();
  const p = s.players[0];
  p.gold = 100;
  p.bench = Array(BENCH_SIZE).fill(null).map((_, i) => ({ uid: 1000 + i, unitId: i < 2 ? 'squire' : 'scout', star: 1 }));
  p.bench[2].unitId = 'acolyte';
  p.shop = ['squire', null, null, null, null];
  assert.ok(applyIntent(s, catalog, 0, { type: 'buy', slot: 0 }).ok);
  const squires = p.bench.filter((u) => u?.unitId === 'squire');
  assert.equal(squires.length, 1);
  assert.equal(squires[0].star, 2);
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

test('leader phase: valid picks only, then round 1 starts with leaders on the board', () => {
  const s = createGame({ seed: 7, catalog, names: ['A', 'B'] });
  assert.equal(s.phase, 'leader');
  assert.deepEqual(leaderIds(catalog), ['decidueye', 'greninja', 'infernape']);
  for (const bad of [{ type: 'buy', slot: 0 }, { type: 'ready' }, { type: 'chooseLeader', leader: 'squire' },
    { type: 'chooseLeader', leader: 'toString' }, { type: 'chooseLeader' }]) {
    assert.equal(applyIntent(s, catalog, 0, bad).ok, false, JSON.stringify(bad));
  }
  assert.ok(applyIntent(s, catalog, 0, { type: 'chooseLeader', leader: 'infernape' }).ok);
  assert.equal(applyIntent(s, catalog, 0, { type: 'chooseLeader', leader: 'greninja' }).ok, false);
  assert.equal(s.phase, 'leader');
  assert.ok(applyIntent(s, catalog, 1, { type: 'chooseLeader', leader: 'decidueye' }).ok);
  assert.equal(s.phase, 'planning');
  assert.equal(s.round, 1);
  assert.deepEqual(s.players.map((p) => p.board.map((u) => [u.unitId, u.leader, u.y])),
    [[['infernape', true, 0]], [['decidueye', true, 3]]], 'melee leaders start in front, ranged at the back');
});

test('leaders never appear in the shop', () => {
  const s = startedGame();
  for (let i = 0; i < 200; i++) {
    s.players[0].gold = 99;
    applyIntent(s, catalog, 0, { type: 'reroll' });
    for (const id of s.players[0].shop) assert.ok(!catalog[id].leader, id);
  }
});

test('leader cannot be sold or benched, but can move around the board', () => {
  const s = startedGame();
  const p = s.players[0];
  const leader = p.board[0];
  p.bench[0] = { uid: 500, unitId: 'squire', star: 1 };
  assert.equal(applyIntent(s, catalog, 0, { type: 'sell', uid: leader.uid }).ok, false);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: leader.uid, to: { area: 'bench', index: 1 } }).ok, false);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: leader.uid, to: { area: 'bench', index: 0 } }).ok, false);
  assert.equal(applyIntent(s, catalog, 0, { type: 'move', uid: 500, to: { area: 'board', x: leader.x, y: leader.y } }).ok, false,
    'a bench unit cannot swap the leader off the board');
  assert.ok(applyIntent(s, catalog, 0, { type: 'move', uid: leader.uid, to: { area: 'board', x: 0, y: 0 } }).ok);
  assert.deepEqual([leader.x, leader.y], [0, 0]);
  assert.ok(applyIntent(s, catalog, 0, { type: 'move', uid: 500, to: { area: 'board', x: 1, y: 0 } }).ok);
  assert.ok(applyIntent(s, catalog, 0, { type: 'move', uid: leader.uid, to: { area: 'board', x: 1, y: 0 } }).ok, 'board-to-board swap is fine');
  assert.equal(p.board.find((u) => u.uid === 500).x, 0);
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
