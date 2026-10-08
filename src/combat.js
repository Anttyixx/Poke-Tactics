// Combat simulation. Pure and deterministic:
//   simulate(catalog, [board0, board1]) -> { initial, events, winner, ticks, survivors }
// Same inputs always produce the same output — no Math.random, no Date, no DOM,
// integer math only. In multiplayer the host runs this and broadcasts the
// result; clients only *replay* the event log, they never re-simulate.

export const COLS = 5;
export const ROWS = 8;
export const HALF = ROWS / 2; // each player owns HALF rows
export const MAX_TICKS = 300; // 1 tick = 0.1s of game time -> 30s cap, then draw
export const TICK_SECONDS = 0.1;
export const MANA_PER_ATTACK = 1; // 1 energy per attack; a unit supers once it has `energy`
export const MANA_PER_HIT = 0; // taking hits gives no energy
const FIRST_ATTACK_DELAY = 3;
// units.json uses the design sheet's numbers (HP 25, damage 3, ...). Combat runs
// in tenths of those so star scaling keeps precision with integer math; the UI
// divides by STAT_SCALE again for display.
export const STAT_SCALE = 10;
// Star multipliers for units that only give base HP; stars = copies - 1.
const STAR_PCT = [100, 150, 220, 320];

// Multiplier for a star level: from the unit's per-star HP list when it has one
// (damage and ability power scale with HP), otherwise the default table.
export function starRatio(def, star) {
  return Array.isArray(def.hp) ? def.hp[star] / def.hp[0] : STAR_PCT[star] / 100;
}

// A unit's combat stats at a star level, in internal units (integers).
export function unitStats(def, star) {
  const ratio = starRatio(def, star);
  const hp = Array.isArray(def.hp) ? def.hp[star] : def.hp * ratio;
  return {
    hp: Math.round(hp * STAT_SCALE),
    atk: Math.round(def.atk * ratio * STAT_SCALE),
    attackCd: Math.max(1, Math.round(1 / (def.hitsPerSec * TICK_SECONDS))),
    energy: def.energy,
    ratio,
  };
}
// Ability damage/heal/shield amounts are in sheet units too.
export const abilityPower = (value, ratio) => Math.round(value * ratio * STAT_SCALE);

// Board positions are stored in "own" coordinates: x 0..COLS-1, y 0..HALF-1
// with y = 0 being the front line. Side 1 is point-mirrored so both players
// place units the same way.
export function toCombatPos(side, x, y) {
  return side === 0 ? { x, y: HALF + y } : { x: COLS - 1 - x, y: HALF - 1 - y };
}

// Fixed order = deterministic tie-breaking when choosing where to step.
const NEIGHBORS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];

// Deterministic hash -> 0 or 1 (no Math.random: combat must replay identically).
function coin(seed, t) {
  let h = Math.imul((seed ^ t) >>> 0, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h & 1;
}

const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function spawn(catalog, inst, side, id) {
  const def = catalog[inst.unitId];
  const pos = toCombatPos(side, inst.x, inst.y);
  const stats = unitStats(def, inst.star);
  return {
    id, side, uid: inst.uid, unitId: inst.unitId, star: inst.star,
    x: pos.x, y: pos.y,
    hp: stats.hp, maxHp: stats.hp,
    atk: stats.atk, ratio: stats.ratio,
    armor: def.armor ?? 0, range: def.range,
    attackCd: stats.attackCd, moveCd: def.moveCd,
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

// `seed` only decides which side acts first on each tick (see below).
export function simulate(catalog, boards, seed = 0) {
  const units = [];
  boards.forEach((board, side) => {
    [...board].sort((a, b) => a.uid - b.uid)
      .forEach((inst) => units.push(spawn(catalog, inst, side, units.length)));
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

  function damage(target, amount, src) {
    if (!standing(target)) return;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    target.hp = Math.max(0, target.hp - (amount - absorbed));
    if (target.hp > 0) target.pendingMana += MANA_PER_HIT;
    emit('damage', { id: target.id, src: src.id, amount, hp: target.hp, shield: target.shield, mana: shownMana(target) });
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
    u.x = best.x;
    u.y = best.y;
    emit('move', { id: u.id, x: u.x, y: u.y });
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

    if (dist(u, at(target)) <= u.range) {
      if (u.atkTimer > 0) return;
      if (u.mana >= u.maxMana) {
        cast(u, target);
      } else {
        u.mana = Math.min(u.maxMana, u.mana + MANA_PER_ATTACK);
        emit('attack', { id: u.id, target: target.id, mana: shownMana(u) });
        damage(target, Math.max(1, Math.floor((u.atk * 100) / (100 + target.armor))), u);
      }
      u.atkTimer = u.attackCd;
    } else if (u.moveTimer === 0 && step(u, target)) {
      u.moveTimer = u.moveCd;
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
    for (const u of units) {
      if (u.hp === 0) u.alive = false; // knocked out this tick
      u.mana = shownMana(u);
      u.stun = Math.max(u.stun, u.pendingStun);
      u.pendingMana = 0;
      u.pendingStun = 0;
    }
    winner = outcome();
  }
  if (winner === undefined) winner = null; // timeout
  emit('end', { winner });

  return {
    initial,
    events,
    winner,
    ticks: t,
    survivors: units.filter((u) => u.alive && u.side === winner).map(snapshot),
  };
}
