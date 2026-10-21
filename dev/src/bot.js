// Dummy opponent. It plays through the exact same intent API as a human, so
// in Phase 3 a remote guest can take its seat without touching the rules.

import { MAX_STAR, REROLL_COST, fielded, teamSize, troopIds } from './game.js?v=b1c32ce';
import { COLS, HALF } from './combat.js?v=b1c32ce';

// Columns ordered from the centre outwards, e.g. [2, 1, 3, 0, 4] for 5 columns.
const CENTER_OUT = [...Array(COLS).keys()].sort((a, b) => Math.abs(2 * a - (COLS - 1)) - Math.abs(2 * b - (COLS - 1)) || a - b);

// `arrange: false` keeps the old behaviour (units stay where they were bought);
// the balance tools use it to compare against the rule-based layout.
export function botTurn(state, catalog, p, send, { arrange = true } = {}) {
  if (state.phase === 'team') {
    // Deterministic per seed and seat, so seeded matches replay identically.
    const troops = troopIds(catalog);
    const start = (state.seed + p) % troops.length;
    const picks = [...troops.slice(start), ...troops.slice(0, start)].slice(0, teamSize(catalog));
    send({ type: 'chooseTeam', troops: picks });
    return;
  }
  shop(state, catalog, p, send);
  // Rerolls cost coins; keep rerolling while it still leaves enough to buy the
  // cheapest troop on the team.
  const me = state.players[p];
  const cheapest = Math.min(...me.team.map((id) => catalog[id].cost));
  while (me.coins >= cheapest + REROLL_COST && send({ type: 'reroll' }).ok) shop(state, catalog, p, send);
  if (arrange) for (const step of planLayout(state, catalog, p)) send({ type: 'move', uid: step.uid, x: step.x, y: step.y });
  send({ type: 'ready' });
}

// ---- Layout rules -------------------------------------------------------------
// Before every fight the bot rebuilds its formation from these rules, using
// what it can see: its own Pokémon and the opponent's lineup from last round.
// Nothing is random; each placement carries the reason it was chosen. Each rule
// was kept because it wins more games against the old bot (which left units
// where it bought them); tools/bot-rules.mjs measures them.
//
//  1. Tanks hold the front. Sturdy melee Pokémon (HP 900+) take the front row,
//     sturdiest in the middle, where the enemy's attackers converge.
//  2. Dodge Psywave. An enemy Beheeyem fires down its column at the start of
//     the battle and throws the first Pokémon it hits to the back. Columns it
//     faces are filled last, so the wave usually hits nothing.
//  3. Meet their main force. The formation leans toward the side of the enemy
//     lineup with more HP, so our front line faces their strongest Pokémon.
//  4. Other melee fighters, divers (Hoopa, Tapu Koko) and Ditto fill the rest
//     of the front line (or the row behind it): they all need to reach enemies
//     quickly, and divers charge their jump with every attack.
//  5. Ranged attackers stand as far back as they can while still reaching the
//     enemy's front row (row = range - 1), behind a front-liner when possible.
//     Hardest hitters choose first.
//  6. Healers stand right behind the busiest part of the front line, so the
//     enemies they hit are surrounded by allies to heal.

const STURDY_HP = 900;
// How much it takes to knock out: HP plus any shield.
const toughness = (def, star) => def.hp[star] + (def.shield?.[star] ?? 0);
function roleOf(def) {
  if (['splashHeal', 'treat', 'boost'].includes(def.ability?.kind)) return 'healer';
  if (def.ability?.kind === 'copy' || def.ability?.teleport || def.ability?.dash) return 'rusher';
  if (def.range <= 1) return toughness(def, 0) >= STURDY_HP ? 'tank' : 'melee';
  return 'ranged';
}
const ROLE_REASON = {
  rusher: 'needs to reach enemies fast (and charges its power by attacking), so it starts in front',
  melee: 'melee: fills the front line',
};

// The moves that turn the current board into the planned one:
// [{ uid, x, y, reason }], in an order that works with the game's swap-on-move
// (a unit moved onto a planned square never gets swapped away again).
export function planLayout(state, catalog, p) {
  const me = state.players[p];
  const foe = state.players[1 - p].lastBoard ?? [];
  const units = me.board.map((u) => ({ u, def: catalog[u.unitId], role: roleOf(catalog[u.unitId]) }));
  const strength = (x) => toughness(x.def, x.u.star);
  const hits = (x) => x.def.damage[x.u.star];

  // What the opponent showed last round, in our own column numbers.
  const facing = (x) => COLS - 1 - x;
  const mid = (COLS - 1) / 2;
  const psyCols = new Set(foe.filter((e) => catalog[e.unitId]?.ability?.kind === 'opening').map((e) => facing(e.x)));
  const flankHp = [0, 0]; // [left, right] as we see it
  for (const e of foe) {
    const c = facing(e.x);
    if (c !== mid) flankHp[c < mid ? 0 : 1] += catalog[e.unitId] ? toughness(catalog[e.unitId], e.star) : 0;
  }
  const strong = flankHp[0] === flankHp[1] ? null : flankHp[0] > flankHp[1] ? 'left' : 'right';
  // Columns from the centre outwards, their stronger flank first on each step,
  // and any column Psywave fires down last.
  const centreOut = [...Array(COLS).keys()].sort((a, b) => Math.abs(2 * a - (COLS - 1)) - Math.abs(2 * b - (COLS - 1)) || (strong === 'right' ? b - a : a - b));
  const order = [...centreOut.filter((c) => !psyCols.has(c)), ...centreOut.filter((c) => psyCols.has(c))];
  const why = [
    strong && `leaning ${strong}, where the enemy has more HP`,
    psyCols.size && "staying out of the enemy Beheeyem's Psywave column",
  ].filter(Boolean).join('; ');
  const extra = why ? ` (${why})` : '';

  const taken = new Set();
  const plan = [];
  const free = (x, y) => !taken.has(`${x},${y}`);
  const place = (it, rows, cols, reason) => {
    for (const y of rows) for (const c of cols) {
      if (!free(c, y)) continue;
      taken.add(`${c},${y}`);
      plan.push({ uid: it.u.uid, x: c, y, reason: `${it.def.name}: ${reason}` });
      return;
    }
  };
  const rowsFrom = (row) => [row, ...[...Array(row).keys()].reverse(), ...Array.from({ length: HALF - 1 - row }, (_, k) => row + 1 + k)];
  const sorted = (role, key) => units.filter((x) => x.role === role).sort((a, b) => key(b) - key(a) || a.u.uid - b.u.uid);

  // 1. Tanks, sturdiest first, into the middle of the front row.
  for (const t of sorted('tank', strength)) place(t, rowsFrom(0), order, `tank: holds the front line${extra}`);
  // 4. Rushers and other melee, hardest hitters first.
  for (const role of ['rusher', 'melee']) for (const m of sorted(role, hits)) place(m, rowsFrom(0), order, ROLE_REASON[role] + extra);
  // 5. Ranged, hardest hitters first, behind a front-liner where possible.
  const guarded = order.filter((c) => !free(c, 0));
  const behind = [...guarded, ...order.filter((c) => !guarded.includes(c))];
  for (const r of sorted('ranged', hits)) {
    const row = Math.min(HALF - 1, r.def.range - 1);
    place(r, rowsFrom(row), behind, `ranged: as far back as it can stand and still reach the enemy's front row (range ${r.def.range})${extra}`);
  }
  // 6. Healers behind the busiest part of the front line.
  const frontAround = (c) => [c - 1, c, c + 1].filter((k) => k >= 0 && k < COLS && !free(k, 0)).length;
  const byBusy = (cols) => [...cols].sort((a, b) => frontAround(b) - frontAround(a)); // stable: ties keep the order above
  const busy = [...byBusy(order.filter((c) => !psyCols.has(c))), ...order.filter((c) => psyCols.has(c))];
  for (const h of sorted('healer', hits)) place(h, rowsFrom(1), busy, 'healer: right behind the busiest part of the front line, so its heals reach the most allies');

  return plan;
}

// Buy until nothing useful is affordable: levelling up a troop already on the
// board comes first, then the most expensive new troop on a free square.
function shop(state, catalog, p, send) {
  const me = state.players[p];
  for (;;) {
    let best = null;
    me.shop.forEach((id, slot) => {
      if (!id || catalog[id].cost > me.coins) return;
      const stack = fielded(me, id);
      if (stack?.star >= MAX_STAR) return;
      const cell = stack ?? freeCell(me, catalog[id].range <= 1);
      if (!cell) return;
      const score = (stack ? 100 : 0) + catalog[id].cost;
      if (!best || score > best.score) best = { score, intent: { type: 'buy', slot, x: cell.x, y: cell.y } };
    });
    if (!best || !send(best.intent).ok) return;
  }
}

// Melee fills the front line from the centre out; ranged units fill the back.
function freeCell(me, melee) {
  const rows = [...Array(HALF).keys()];
  for (const y of melee ? rows : rows.reverse()) {
    for (const x of CENTER_OUT) {
      if (!me.board.some((u) => u.x === x && u.y === y)) return { x, y };
    }
  }
  return null;
}
