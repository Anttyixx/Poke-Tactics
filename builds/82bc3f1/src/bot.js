// Dummy opponent. It plays through the exact same intent API as a human, so
// in Phase 3 a remote guest can take its seat without touching the rules.

import { REROLL_COST, boardCap, leaderIds, ownedUnits, sellValue } from './game.js?v=82bc3f1';
import { COLS, HALF } from './combat.js?v=82bc3f1';

// Columns ordered from the centre outwards, e.g. [2, 1, 3, 0, 4] for 5 columns.
const CENTER_OUT = [...Array(COLS).keys()].sort((a, b) => Math.abs(2 * a - (COLS - 1)) - Math.abs(2 * b - (COLS - 1)) || a - b);

export function botTurn(state, catalog, p, send) {
  if (state.phase === 'leader') {
    // Deterministic per seed and seat, so seeded matches replay identically.
    const ids = leaderIds(catalog);
    send({ type: 'chooseLeader', leader: ids[(state.seed + p) % ids.length] });
    return;
  }
  shop(state, catalog, p, send);
  if (state.round >= 3 && state.players[p].gold >= REROLL_COST + 4) {
    send({ type: 'reroll' });
    shop(state, catalog, p, send);
  }
  arrange(state, catalog, p, send);
  send({ type: 'ready' });
}

function shop(state, catalog, p, send) {
  const me = state.players[p];
  const cap = boardCap(state.round);
  for (;;) {
    const owned = ownedUnits(me).filter((u) => !u.leader);
    let best = -1;
    let bestScore = -Infinity;
    me.shop.forEach((id, slot) => {
      if (!id) return;
      const { cost } = catalog[id];
      if (cost > me.gold) return;
      const copies = owned.filter((u) => u.unitId === id && u.star === 1).length;
      if (!me.bench.includes(null) && copies < 2) return;
      if (owned.length >= cap + 3 && copies === 0) return;
      const score = cost * 10 + copies * 25;
      if (score > bestScore) { bestScore = score; best = slot; }
    });
    if (best === -1 || !send({ type: 'buy', slot: best }).ok) return;
  }
}

function arrange(state, catalog, p, send) {
  const me = state.players[p];
  const all = ownedUnits(me).filter((u) => !u.leader).sort((a, b) => sellValue(catalog, b) - sellValue(catalog, a) || a.uid - b.uid);
  const keep = new Set(all.slice(0, boardCap(state.round)));

  for (const u of [...me.board]) {
    if (u.leader || keep.has(u)) continue;
    const free = me.bench.indexOf(null);
    send(free === -1 ? { type: 'sell', uid: u.uid } : { type: 'move', uid: u.uid, to: { area: 'bench', index: free } });
  }
  for (const u of keep) {
    if (me.board.includes(u)) continue;
    const cell = freeCell(me, catalog[u.unitId].range <= 1);
    if (cell) send({ type: 'move', uid: u.uid, to: { area: 'board', ...cell } });
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
