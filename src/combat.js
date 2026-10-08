// Combat simulation. Pure and deterministic:
//   simulate(catalog, [board0, board1]) -> { initial, events, winner, ticks, survivors }
// Same inputs always produce the same output — no Math.random, no Date, no DOM,
// integer math only. In multiplayer the host runs this and broadcasts the
// result; clients only *replay* the event log, they never re-simulate.

export const COLS = 5;
export const ROWS = 8;
export const HALF = ROWS / 2; // each player owns HALF rows
// 1 tick = 0.1s of game time. After the 30s timer, sudden death: every unit
// still standing loses the same HP each tick until one side is knocked out.
export const SUDDEN_DEATH_TICK = 300;
export const SUDDEN_DEATH_HP_PER_SECOND = 300;
// Safety net only: with the drain, every fight ends well before this.
export const MAX_TICKS = 900;
export const TICK_SECONDS = 0.1;
export const MANA_PER_ATTACK = 1; // 1 energy per attack; a unit supers once it has `energy`
export const MANA_PER_HIT = 0; // taking hits gives no energy
// units.json uses the design sheet's numbers directly (HP, damage per hit, ...).
// The UI divides by STAT_SCALE for display; 1 = combat runs in sheet units.
export const STAT_SCALE = 1;
// A critical hit deals 50% more damage. Only basic attacks can crit.
export const CRIT_PCT = 150;
// Movement speed tiers, in seconds per square.
export const MOVE_SPEEDS = { fast: 0.5, medium: 0.8, slow: 1.0, 'very slow': 1.3 };

// A unit's combat stats at a star level, in internal units (integers).
export function unitStats(def, star) {
  return {
    hp: Math.round(def.hp[star] * STAT_SCALE),
    atk: Math.round(def.damage[star] * STAT_SCALE),
    attackCd: Math.max(1, Math.round(def.secPerHit / TICK_SECONDS)), // ticks per attack
    moveCd: Math.max(1, Math.round(MOVE_SPEEDS[def.moveSpeed] / TICK_SECONDS)), // ticks per square
    crit: def.critChance ?? 0, // percent
    energy: def.energy,
  };
}
// Damage a power deals at a star level (powers set it as a % of the unit's hit), or null.
export const powerDamage = (def, star) => (def.ability?.damagePct ? Math.floor((def.damage[star] * STAT_SCALE * def.ability.damagePct) / 100) : null);

// Board positions are stored in "own" coordinates: x 0..COLS-1, y 0..HALF-1
// with y = 0 being the front line. Side 1 is point-mirrored so both players
// place units the same way.
export function toCombatPos(side, x, y) {
  return side === 0 ? { x, y: HALF + y } : { x: COLS - 1 - x, y: HALF - 1 - y };
}

// Fixed order = deterministic tie-breaking when choosing where to step.
// Units walk one square at a time, up/down/left/right only (no diagonal steps).
const NEIGHBORS = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const DIAGONALS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

// Deterministic hash (no Math.random: combat must replay identically).
function hash(seed, t, salt = 0) {
  let h = Math.imul((seed ^ t ^ Math.imul(salt, 0x27d4eb2f)) >>> 0, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
const coin = (seed, t) => hash(seed, t) & 1;
// Crit roll (0-99) for an attack on tick `t` by the unit in position `slot` of
// its side's list. It never depends on the order units act in, and both sides
// share the same rolls slot for slot, so luck never favours a side.
const critRoll = (seed, t, slot) => hash(seed, t, slot + 1) % 100;

const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function spawn(catalog, inst, side, id, slot, pos = toCombatPos(side, inst.x, inst.y)) {
  const def = catalog[inst.unitId];
  const stats = unitStats(def, inst.star);
  return {
    id, side, slot, uid: inst.uid, unitId: inst.unitId, star: inst.star,
    x: pos.x, y: pos.y,
    hp: stats.hp, maxHp: stats.hp,
    atk: stats.atk, crit: stats.crit,
    armor: def.armor ?? 0, range: def.range,
    attackCd: stats.attackCd, moveCd: stats.moveCd,
    // Every fight (and every summon) starts fresh: power progress at 0 and a full
    // attack cooldown before the first hit.
    mana: 0, maxMana: stats.energy, // mana counts attacks toward the power; 0 = no counter
    power: def.ability,
    shield: 0, stun: 0,
    pendingMana: 0, pendingStun: 0, // applied at the end of the tick
    atkTimer: stats.attackCd, moveTimer: 0,
    hasteUntil: 0, hastePct: 0, stealthFrom: 0, stealthUntil: 0,
    target: null, alive: true, summoned: Boolean(inst.summoned),
  };
}

const snapshot = (u) => ({
  id: u.id, side: u.side, uid: u.uid, unitId: u.unitId, star: u.star,
  x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, mana: u.mana, maxMana: u.maxMana,
  ...(u.summoned && { summoned: true }),
});

// `seed` decides crits and which side acts first on each tick (see below).
export function simulate(catalog, boards, seed = 0) {
  const units = [];
  boards.forEach((board, side) => {
    [...board].sort((a, b) => a.uid - b.uid)
      .forEach((inst, slot) => units.push(spawn(catalog, inst, side, units.length, slot)));
  });
  const initial = units.map(snapshot);
  const bySide = [0, 1].map((side) => units.filter((u) => u.side === side));
  const events = [];
  let t = 0;
  const emit = (type, data) => events.push({ t, type, ...data });
  const inside = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
  const unitAt = (x, y) => units.find((u) => u.alive && u.x === x && u.y === y);
  const occupied = (x, y) => Boolean(unitAt(x, y));
  // Ticks resolve simultaneously: a unit knocked out this tick (hp 0) still acts
  // this tick (its `alive` flag only clears at the end of the tick), but nobody
  // can target, damage, heal or stun it any more. Without this, whichever side
  // happens to act first in a tick wins every even trade.
  const standing = (u) => u.alive && u.hp > 0;
  // Invisible units can't be targeted or tracked by enemies. Invisibility
  // starts on the next tick, so it never decides who wins a same-tick trade.
  const visible = (u) => standing(u) && !(t > u.stealthFrom && t <= u.stealthUntil);
  // Mana gained from being hit, and stuns, also wait for the end of the tick, so
  // a unit's action this tick never depends on who happened to act before it.
  // Events report mana as it will be once the tick ends.
  const shownMana = (u) => Math.min(u.maxMana, u.mana + u.pendingMana);
  // Where a unit stood at the start of the tick. Targeting, range and pathing
  // all read this, so a unit that moved earlier in the tick isn't seen at its
  // new square until next tick. (Square occupancy stays live: no two units
  // can ever share a square.)
  const at = (u) => ({ x: u.sx, y: u.sy });
  // Side 1's board is point-mirrored, so it reads direction lists mirrored too;
  // otherwise the two sides would break ties differently.
  const dirs = (u, list = NEIGHBORS) => list.map(([dx, dy]) => (u.side === 1 ? [-dx, -dy] : [dx, dy]));
  const enemiesOf = (u) => units.filter((e) => e.side !== u.side && visible(e));

  function nearestEnemy(u) {
    let best = null;
    let bestDist = Infinity;
    for (const e of enemiesOf(u)) {
      const d = dist(u, at(e));
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  function farthestEnemy(u) {
    let best = null;
    let bestDist = -1;
    for (const e of enemiesOf(u)) {
      const d = dist(u, at(e));
      if (d > bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  // Returns the damage actually dealt to HP.
  function damage(target, amount, src, crit = false) {
    if (!standing(target)) return 0;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    const before = target.hp;
    target.hp = Math.max(0, target.hp - (amount - absorbed));
    if (target.hp > 0) target.pendingMana += MANA_PER_HIT;
    emit('damage', { id: target.id, src: src.id, amount, hp: target.hp, shield: target.shield, mana: shownMana(target), ...(crit && { crit }) });
    if (target.hp === 0) emit('death', { id: target.id });
    return before - target.hp;
  }

  function heal(target, amount) {
    if (!standing(target)) return; // knocked out this tick: no coming back
    const gained = Math.min(amount, target.maxHp - target.hp);
    target.hp += gained;
    emit('heal', { id: target.id, amount: gained, hp: target.hp });
  }

  function stun(target, duration) {
    target.pendingStun = Math.max(target.pendingStun, duration);
    emit('stun', { id: target.id, duration });
  }

  // Shove `u` to (x, y) without walking: knockbacks and teleports.
  function relocate(u, cell, type) {
    if (u.x === cell.x && u.y === cell.y) return;
    u.x = cell.x;
    u.y = cell.y;
    emit(type, { id: u.id, x: u.x, y: u.y });
  }

  // The free square closest to `goal` (ties: closest to `from`, then a fixed
  // side-mirrored scan order). `self` may stay on its own square.
  function closestFree(goal, from, self, side) {
    let best = null;
    let key = null;
    for (let i = 0; i < COLS * ROWS; i++) {
      const j = side === 1 ? COLS * ROWS - 1 - i : i;
      const c = { x: j % COLS, y: Math.floor(j / COLS) };
      const o = unitAt(c.x, c.y);
      if (o && o !== self) continue;
      const k = [manhattan(c, goal), manhattan(c, from)];
      if (!key || k[0] < key[0] || (k[0] === key[0] && k[1] < key[1])) { best = c; key = k; }
    }
    return best;
  }

  // A free square next to `target` (up/down/left/right), for teleports.
  function freeBeside(u, target) {
    const p = at(target);
    for (const [dx, dy] of dirs(u)) {
      const c = { x: p.x + dx, y: p.y + dy };
      if (inside(c.x, c.y) && !occupied(c.x, c.y)) return c;
    }
    return null;
  }

  // Knockbacks from attacks land at the end of the tick (like stuns), so a unit
  // hit early in the tick still acts from where it stood.
  let knocks = [];
  function knockback(u, target, squares) {
    // Straight away from the attacker; for a diagonal hit, along the column.
    const from = at(target);
    const dy = Math.sign(from.y - at(u).y);
    const dx = dy ? 0 : Math.sign(from.x - at(u).x);
    let goal = from;
    for (let i = 0; i < squares && inside(goal.x + dx, goal.y + dy); i++) goal = { x: goal.x + dx, y: goal.y + dy };
    knocks.push({ target, goal, side: u.side });
  }

  const summonCell = (u) => [...dirs(u), ...dirs(u, DIAGONALS)]
    .map(([dx, dy]) => ({ x: u.x + dx, y: u.y + dy }))
    .find((c) => inside(c.x, c.y) && !occupied(c.x, c.y));

  function summon(u, cell) {
    const kin = units.length;
    const pal = spawn(catalog, { uid: -kin, unitId: u.power.unit, star: u.star, summoned: true }, u.side, kin, bySide[u.side].length, cell);
    pal.sx = pal.x;
    pal.sy = pal.y;
    units.push(pal);
    bySide[u.side].push(pal);
    emit('summon', { id: u.id, unit: snapshot(pal) });
  }

  // Powers that fire the moment the attack counter fills (no attack is lost).
  function instantPower(u, target) {
    const p = u.power;
    // A charged power is never wasted: with no free square to summon into, it
    // stays charged and tries again after the next attack.
    const cell = p.kind === 'summon' ? summonCell(u) : null;
    if (p.kind === 'summon' && !cell) return;
    u.mana = 0;
    switch (p.kind) {
      case 'snipe': {
        const far = farthestEnemy(u) ?? target;
        emit('cast', { id: u.id, target: far.id });
        damage(far, Math.floor((u.atk * p.damagePct) / 100), u);
        break;
      }
      case 'summon':
        emit('cast', { id: u.id, target: null });
        summon(u, cell);
        break;
      case 'stealth':
        emit('cast', { id: u.id, target: null });
        u.stealthFrom = t;
        u.stealthUntil = t + p.duration;
        emit('stealth', { id: u.id, duration: p.duration });
        if (p.hastePct) { u.hasteUntil = t + p.duration; u.hastePct = p.hastePct; emit('haste', { id: u.id, duration: p.duration }); }
        break;
      case 'haste':
        emit('cast', { id: u.id, target: null });
        u.hasteUntil = t + p.duration;
        u.hastePct = p.hastePct;
        emit('haste', { id: u.id, duration: p.duration });
        break;
      default:
        throw new Error(`Unknown power kind "${p.kind}"`);
    }
  }

  // An empowered attack: the one after the counter fills.
  function powerStrike(u, target) {
    const p = u.power;
    u.mana = 0;
    emit('cast', { id: u.id, target: target.id });
    const dealt = damage(target, Math.floor((u.atk * p.damagePct) / 100), u);
    if (p.lifestealPct && dealt) heal(u, Math.floor((dealt * p.lifestealPct) / 100));
    if (!standing(target)) return;
    if (p.knockback) knockback(u, target, p.knockback);
    if (p.stun) stun(target, p.stun);
  }

  // Beheeyem-style opener: a wave straight down the unit's column toward the
  // enemy. The first enemy in the column is hit and knocked to the far end;
  // anyone already standing there is pushed to the side.
  function openingPower(u) {
    const p = u.power;
    const dy = u.side === 0 ? -1 : 1;
    const end = u.side === 0 ? 0 : ROWS - 1;
    let target = null;
    for (let y = u.y + dy; inside(u.x, y) && !target; y += dy) {
      const o = unitAt(u.x, y);
      if (o && o.side !== u.side && visible(o)) target = o;
    }
    emit('cast', { id: u.id, target: target?.id ?? null, x: u.x, y: end });
    if (!target) return;
    damage(target, Math.floor((u.atk * p.damagePct) / 100), u);
    if (!standing(target) || target.y === end) return;
    const blocker = unitAt(u.x, end);
    if (blocker) {
      const side = dirs(u, [[-1, 0], [1, 0]]).map(([dx]) => ({ x: u.x + dx, y: end })).find((c) => inside(c.x, c.y) && !occupied(c.x, c.y));
      if (side) relocate(blocker, side, 'knock');
    }
    // If the end square is still taken, land as close to it as possible in the column.
    let y = end;
    while (y !== target.y && occupied(u.x, y)) y -= dy;
    relocate(target, { x: u.x, y }, 'knock');
  }

  const cooldown = (u) => (u.hasteUntil > t ? Math.max(1, Math.round((u.attackCd * 100) / (100 + u.hastePct))) : u.attackCd);

  // Shortest walk (breadth-first search, up/down/left/right) from `u` around
  // every other unit to a square where some enemy is within its attack range.
  // Returns the first square of that walk and the enemy it leads to, or null if
  // every route is blocked. Neighbours are explored in a side-mirrored order, so
  // both sides break ties the same way.
  function findPath(u) {
    const enemies = enemiesOf(u);
    const key = (c) => c.y * COLS + c.x;
    const start = { x: u.x, y: u.y };
    const prev = new Map([[key(start), null]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      if (c !== start) {
        let reachable = null;
        for (const e of enemies) {
          const d = dist(c, at(e));
          if (d <= u.range && (!reachable || d < reachable.d)) reachable = { e, d };
        }
        if (reachable) {
          let first = c;
          while (prev.get(key(first)) !== start) first = prev.get(key(first));
          return { next: first, target: reachable.e };
        }
      }
      for (const [dx, dy] of dirs(u)) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (!inside(n.x, n.y) || prev.has(key(n)) || occupied(n.x, n.y)) continue;
        prev.set(key(n), c);
        queue.push(n);
      }
    }
    return null;
  }

  function moveTo(u, cell) {
    u.x = cell.x;
    u.y = cell.y;
    emit('move', { id: u.id, x: u.x, y: u.y });
  }

  // Fallback when no route exists right now: a step that gets closer, if any.
  function step(u, target) {
    const goal = at(target);
    let best = null;
    let bestD = dist(u, goal);
    let bestM = manhattan(u, goal);
    for (const [dx, dy] of dirs(u)) {
      const cell = { x: u.x + dx, y: u.y + dy };
      if (!inside(cell.x, cell.y) || occupied(cell.x, cell.y)) continue;
      const d = dist(cell, goal);
      const m = manhattan(cell, goal);
      if (d < bestD || (d === bestD && m < bestM)) { best = cell; bestD = d; bestM = m; }
    }
    if (!best) return false;
    moveTo(u, best);
    return true;
  }

  function act(u) {
    if (u.stun > 0) { u.stun--; return; }
    if (u.atkTimer > 0) u.atkTimer--;
    if (u.moveTimer > 0) u.moveTimer--;

    let target = u.target === null ? null : units[u.target];
    if (!target || !visible(target) || target.side === u.side || dist(u, at(target)) > u.range) target = nearestEnemy(u);
    if (!target) return;
    u.target = target.id;

    // "Every N attacks, the next attack ..." powers.
    const empowered = u.power?.kind === 'empower' && u.maxMana > 0 && u.mana >= u.maxMana;
    if (empowered && u.power.teleport && u.atkTimer === 0) {
      // No need to teleport if the farthest enemy is already in reach.
      const far = farthestEnemy(u);
      const cell = far && dist(u, at(far)) > u.range && freeBeside(u, far);
      if (cell) {
        relocate(u, cell, 'teleport');
        target = far;
        u.target = far.id;
      }
    }

    if (dist(u, at(target)) <= u.range) {
      if (u.atkTimer > 0) return;
      if (empowered) {
        powerStrike(u, target);
      } else {
        if (u.maxMana > 0) u.mana = Math.min(u.maxMana, u.mana + MANA_PER_ATTACK);
        emit('attack', { id: u.id, target: target.id, mana: shownMana(u) });
        const crit = critRoll(seed, t, u.slot) < u.crit;
        const hit = crit ? Math.floor((u.atk * CRIT_PCT) / 100) : u.atk;
        damage(target, Math.max(1, Math.floor((hit * 100) / (100 + target.armor))), u, crit);
        if (u.power && u.power.kind !== 'empower' && u.maxMana > 0 && u.mana >= u.maxMana) instantPower(u, target);
      }
      u.atkTimer = cooldown(u);
    } else if (u.moveTimer === 0) {
      // Out of range: walk around anyone in the way toward the enemy that can
      // be reached soonest (which may not be the one closest as the crow flies).
      const path = findPath(u);
      if (path) {
        u.target = path.target.id;
        moveTo(u, path.next);
        u.moveTimer = u.moveCd;
      } else if (step(u, target)) {
        u.moveTimer = u.moveCd;
      }
    }
  }

  // undefined = still fighting, 0/1 = winning side, null = nobody left / draw
  const outcome = () => {
    const a = units.some((u) => u.alive && u.side === 0);
    const b = units.some((u) => u.alive && u.side === 1);
    if (a && b) return undefined;
    return a ? 0 : b ? 1 : null;
  };

  let winner = outcome();
  while (winner === undefined && t < MAX_TICKS) {
    t++;
    for (const u of units) { u.sx = u.x; u.sy = u.y; }
    // Which side acts first each tick is a seeded coin flip. Attacks, mana and
    // stuns resolve simultaneously anyway; this only decides who claims a
    // contested square first. A fixed pattern (e.g. odd/even) would line up with
    // cooldowns and always favour the same side. Each side keeps its unit order,
    // and units summoned this tick wait until the next one.
    const order = coin(seed, t) ? [...bySide[0], ...bySide[1]] : [...bySide[1], ...bySide[0]];
    // Battle-start powers go off on the first tick, before anyone acts.
    if (t === 1) for (const u of order) if (u.power?.kind === 'opening' && standing(u)) openingPower(u);
    for (const u of order) if (u.alive) act(u);
    if (t === SUDDEN_DEATH_TICK) emit('suddenDeath', {});
    if (t >= SUDDEN_DEATH_TICK) {
      // The drain lands at the end of the tick, after everyone has acted, and
      // ignores shields. Same amount for everyone: the weakest fall first.
      const drain = Math.round((SUDDEN_DEATH_HP_PER_SECOND * STAT_SCALE) * TICK_SECONDS);
      for (const u of units) {
        if (!standing(u)) continue;
        u.hp = Math.max(0, u.hp - drain);
        emit('drain', { id: u.id, amount: drain, hp: u.hp });
        if (u.hp === 0) emit('death', { id: u.id });
      }
    }
    for (const k of knocks) if (standing(k.target)) relocate(k.target, closestFree(k.goal, k.target, k.target, k.side), 'knock');
    knocks = [];
    for (const u of units) {
      if (u.hp === 0) u.alive = false; // knocked out this tick
      u.mana = shownMana(u);
      u.stun = Math.max(u.stun, u.pendingStun);
      u.pendingMana = 0;
      u.pendingStun = 0;
    }
    winner = outcome();
  }
  if (winner === undefined) winner = null; // unreachable: sudden death always ends the fight
  emit('end', { winner });

  return {
    initial,
    events,
    winner,
    ticks: t,
    survivors: units.filter((u) => u.alive && u.side === winner && !u.summoned).map(snapshot),
  };
}
