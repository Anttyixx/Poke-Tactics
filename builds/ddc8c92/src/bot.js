// Dummy opponent. It plays through the exact same intent API as a human, so
// in Phase 3 a remote guest can take its seat without touching the rules.

import { MAX_STAR, REROLL_COST, boardCap, fieldCount, leaderIds, teamSize, troopIds } from './game.js?v=ddc8c92';
import { COLS, HALF } from './combat.js?v=ddc8c92';

// Columns ordered from the centre outwards, e.g. [2, 1, 3, 0, 4] for 5 columns.
const CENTER_OUT = [...Array(COLS).keys()].sort((a, b) => Math.abs(2 * a - (COLS - 1)) - Math.abs(2 * b - (COLS - 1)) || a - b);

export function botTurn(state, catalog, p, send) {
  if (state.phase === 'team') {
    // Deterministic per seed and seat, so seeded matches replay identically.
    const leaders = leaderIds(catalog);
    const troops = troopIds(catalog);
    const start = (state.seed + p) % troops.length;
    const picks = [...troops.slice(start), ...troops.slice(0, start)].slice(0, teamSize(catalog));
    send({ type: 'chooseTeam', leader: leaders[(state.seed + p) % leaders.length], troops: picks });
    return;
  }
  shop(state, catalog, p, send);
  if (state.round >= 3 && state.players[p].gold >= REROLL_COST + 3) {
    send({ type: 'reroll' });
    shop(state, catalog, p, send);
  }
  send({ type: 'ready' });
}

// Buy until nothing useful is affordable: stacking a copy onto a troop already
// on the board comes first (it powers it up without using a board slot), then
// the most expensive troop that fits on a free square.
function shop(state, catalog, p, send) {
  const me = state.players[p];
  for (;;) {
    let best = null;
    me.shop.forEach((id, slot) => {
      if (!id || catalog[id].cost > me.gold) return;
      const stack = me.board.find((u) => !u.leader && u.unitId === id && u.star < MAX_STAR);
      const cell = stack ?? (fieldCount(me) < boardCap(state.round) ? freeCell(me, catalog[id].range <= 1) : null);
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
