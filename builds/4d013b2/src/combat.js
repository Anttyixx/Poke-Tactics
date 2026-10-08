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
const FIRST_ATTACK_DELAY = 3;
// units.json uses the design sheet's numbers directly (HP, damage per hit, ...).
// The UI divides by STAT_SCALE for display; 1 = combat runs in sheet units.
export const STAT_SCALE = 1;
// A critical hit deals 50% more damage. Only basic attacks can crit.
export const CRIT_PCT = 150;
// Movement speed tiers, in seconds per square.
export const MOVE_SPEEDS = { fast: 0.5, medium: 0.8, slow: 1.0, 'very slow': 1.3 };

// How much stronger a star level hits than 0★: Supers scale by the same amount.
export function starRatio(def, star) {
  return def.damage[star] / def.damage[0];
}

// A unit's combat stats at a star level, in internal units (integers).
export function unitStats(def, star) {
  return {
    hp: Math.round(def.hp[star] * STAT_SCALE),
    atk: Math.round(def.damage[star] * STAT_SCALE),
    attackCd: Math.max(1, Math.round(def.secPerHit / TICK_SECONDS)), // ticks per attack
    moveCd: Math.max(1, Math.round(MOVE_SPEEDS[def.moveSpeed] / TICK_SECONDS)), // ticks per square
    crit: def.critChance ?? 0, // percent
    energy: def.energy,
    ratio: starRatio(def, star),
  };
}
// Ability damage/heal/shield amounts are given for 0★ in sheet units.
export const abilityPower = (value, ratio) => Math.round(value * ratio * STAT_SCALE);

// Board positions are stored in "own" coordinates: x 0..COLS-1, y 0..HALF-1
// with y = 0 being the front line. Side 1 is point-mirrored so both players
// place units the same way.
export function toCombatPos(side, x, y) {
  return side === 0 ? { x, y: HALF + y } : { x: COLS - 1 - x, y: HALF - 1 - y };
}

// Fixed order = deterministic tie-breaking when choosing where to step.
// Units walk one square at a time, up/down/left/right only (no diagonal steps).
const NEIGHBORS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

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

function spawn(catalog, inst, side, id, slot) {
  const def = catalog[inst.unitId];
  const pos = toCombatPos(side, inst.x, inst.y);
  const stats = unitStats(def, inst.star);
  return {
    id, side, slot, uid: inst.uid, unitId: inst.unitId, star: inst.star,
    x: pos.x, y: pos.y,
    hp: stats.hp, maxHp: stats.hp,
    atk: stats.atk, ratio: stats.ratio, crit: stats.crit,
    armor: def.armor ?? 0, range: def.range,
    attackCd: stats.attackCd, moveCd: stats.moveCd,
    mana: 0, maxMana: stats.energy,
    ability: def.ability,
    shield: 0, stun: 0,
    pendingMana: 0, pendingStun: 0, // applied at the end of the tick
    atkTimer: FIRST_ATTACK_DELAY, moveTimer: 0,
    target: null, alive: true,
  };
}

const snapshot = (u) => ({
  id: u.id, side: u.side, uid: u.uid, unitId: u.unitId, star: u.star,
  x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, mana: u.mana, maxMana: u.maxMana,
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
  const occupied = (x, y) => units.some((u) => u.alive && u.x === x && u.y === y);
  // Ticks resolve simultaneously: a unit knocked out this tick (hp 0) still acts
  // this tick (its `alive` flag only clears at the end of the tick), but nobody
  // can target, damage, heal or stun it any more. Without this, whichever side
  // happens to act first in a tick wins every even trade.
  const standing = (u) => u.alive && u.hp > 0;
  // Mana gained from being hit, and stuns, also wait for the end of the tick, so
  // a unit's action this tick never depends on who happened to act before it.
  // Events report mana as it will be once the tick ends.
  const shownMana = (u) => Math.min(u.maxMana, u.mana + u.pendingMana);
  // Where a unit stood at the start of the tick. Targeting, range and pathing
  // all read this, so a unit that moved earlier in the tick isn't seen at its
  // new square until next tick. (Square occupancy stays live: no two units
  // can ever share a square.)
  const at = (u) => ({ x: u.sx, y: u.sy });

  function nearestEnemy(u) {
    let best = null;
    let bestDist = Infinity;
    for (const e of units) {
      if (!standing(e) || e.side === u.side) continue;
      const d = dist(u, at(e));
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  function lowestHealth(allies) {
    return allies.reduce((a, b) => (b.hp * a.maxHp < a.hp * b.maxHp ? b : a));
  }

  function damage(target, amount, src, crit = false) {
    if (!standing(target)) return;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    target.hp = Math.max(0, target.hp - (amount - absorbed));
    if (target.hp > 0) target.pendingMana += MANA_PER_HIT;
    emit('damage', { id: target.id, src: src.id, amount, hp: target.hp, shield: target.shield, mana: shownMana(target), ...(crit && { crit }) });
    if (target.hp === 0) emit('death', { id: target.id });
  }

  function heal(target, amount) {
    const gained = Math.min(amount, target.maxHp - target.hp);
    target.hp += gained;
    emit('heal', { id: target.id, amount: gained, hp: target.hp });
  }

  function addShield(target, amount) {
    target.shield += amount;
    emit('shield', { id: target.id, amount, shield: target.shield });
  }

  function stun(target, duration) {
    target.pendingStun = Math.max(target.pendingStun, duration);
    emit('stun', { id: target.id, duration });
  }

  function cast(u, target) {
    const ab = u.ability;
    const power = (v) => abilityPower(v, u.ratio);
    const allies = units.filter((a) => standing(a) && a.side === u.side);
    u.mana = 0;
    emit('cast', { id: u.id, target: target.id });
    switch (ab.kind) {
      case 'strike':
        damage(target, power(ab.damage), u);
        break;
      case 'stun':
        damage(target, power(ab.damage), u);
        if (standing(target)) stun(target, ab.duration);
        break;
      case 'blast':
        for (const e of units) {
          if (!standing(e) || e.side === u.side || dist(at(e), at(target)) > ab.radius) continue;
          damage(e, power(ab.damage), u);
          if (ab.duration && standing(e)) stun(e, ab.duration);
        }
        break;
      case 'heal':
        for (const a of ab.target === 'all' ? allies : [lowestHealth(allies)]) heal(a, power(ab.amount));
        break;
      case 'shield':
        for (const a of ab.target === 'allies' ? allies : [u]) addShield(a, power(ab.amount));
        break;
      default:
        throw new Error(`Unknown ability kind "${ab.kind}"`);
    }
  }

  // Step to the free neighbouring cell that gets closest to the target.
  // Shortest walk (breadth-first search, up/down/left/right) from `u` around
  // every other unit to a square where some enemy is within its attack range.
  // Returns the first square of that walk and the enemy it leads to, or null if
  // every route is blocked. Neighbours are explored in a side-mirrored order, so
  // both sides break ties the same way.
  function findPath(u) {
    const flip = u.side === 1 ? -1 : 1;
    const enemies = units.filter((e) => standing(e) && e.side !== u.side);
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
      for (const [ndx, ndy] of NEIGHBORS) {
        const n = { x: c.x + ndx * flip, y: c.y + ndy * flip };
        if (n.x < 0 || n.y < 0 || n.x >= COLS || n.y >= ROWS || prev.has(key(n)) || occupied(n.x, n.y)) continue;
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
    // Side 1's board is point-mirrored, so it walks the neighbour list mirrored
    // too; otherwise the two sides would break pathing ties differently.
    const flip = u.side === 1 ? -1 : 1;
    for (const [ndx, ndy] of NEIGHBORS) {
      const dx = ndx * flip;
      const dy = ndy * flip;
      const cell = { x: u.x + dx, y: u.y + dy };
      if (cell.x < 0 || cell.y < 0 || cell.x >= COLS || cell.y >= ROWS || occupied(cell.x, cell.y)) continue;
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
    if (!target || !standing(target) || dist(u, at(target)) > u.range) target = nearestEnemy(u);
    if (!target) return;
    u.target = target.id;

    // A Super can have its own reach (ability.range), e.g. Decidueye's hits from
    // anywhere on the board; basic attacks always use the unit's range.
    const superReady = u.mana >= u.maxMana;
    const reach = superReady ? Math.max(u.range, u.ability.range ?? 0) : u.range;
    if (dist(u, at(target)) <= reach) {
      if (u.atkTimer > 0) return;
      if (superReady) {
        cast(u, target);
      } else {
        u.mana = Math.min(u.maxMana, u.mana + MANA_PER_ATTACK);
        emit('attack', { id: u.id, target: target.id, mana: shownMana(u) });
        const crit = critRoll(seed, t, u.slot) < u.crit;
        const hit = crit ? Math.floor((u.atk * CRIT_PCT) / 100) : u.atk;
        damage(target, Math.max(1, Math.floor((hit * 100) / (100 + target.armor))), u, crit);
      }
      u.atkTimer = u.attackCd;
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
    // cooldowns and always favour the same side. Each side keeps its unit order.
    const order = coin(seed, t) ? units : [...bySide[1], ...bySide[0]];
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
    survivors: units.filter((u) => u.alive && u.side === winner).map(snapshot),
  };
}
