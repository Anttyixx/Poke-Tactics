// Combat simulation. Pure and deterministic:
//   simulate(catalog, [board0, board1]) -> { initial, events, winner, ticks, survivors }
// Same inputs always produce the same output — no Math.random, no Date, no DOM,
// integer math only. In multiplayer the host runs this and broadcasts the
// result; clients only *replay* the event log, they never re-simulate.

export const COLS = 8;
export const ROWS = 8;
export const HALF = ROWS / 2; // each player owns HALF rows
export const MAX_TICKS = 300; // 1 tick = 0.1s of game time -> 30s cap, then draw
export const TICK_SECONDS = 0.1;
export const MANA_PER_ATTACK = 10;
export const MANA_PER_HIT = 5;
const FIRST_ATTACK_DELAY = 3;
const STAR_PCT = [0, 100, 180, 320];

export const scale = (value, star) => Math.floor((value * STAR_PCT[star]) / 100);

// Board positions are stored in "own" coordinates: x 0..COLS-1, y 0..HALF-1
// with y = 0 being the front line. Side 1 is point-mirrored so both players
// place units the same way.
export function toCombatPos(side, x, y) {
  return side === 0 ? { x, y: HALF + y } : { x: COLS - 1 - x, y: HALF - 1 - y };
}

// Fixed order = deterministic tie-breaking when choosing where to step.
const NEIGHBORS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];

const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function spawn(catalog, inst, side, id) {
  const def = catalog[inst.unitId];
  const pos = toCombatPos(side, inst.x, inst.y);
  const hp = scale(def.hp, inst.star);
  return {
    id, side, uid: inst.uid, unitId: inst.unitId, star: inst.star,
    x: pos.x, y: pos.y,
    hp, maxHp: hp,
    atk: scale(def.atk, inst.star),
    armor: def.armor, range: def.range,
    attackCd: def.attackCd, moveCd: def.moveCd,
    mana: 0, maxMana: def.mana,
    ability: def.ability,
    shield: 0, stun: 0,
    atkTimer: FIRST_ATTACK_DELAY, moveTimer: 0,
    target: null, alive: true,
  };
}

const snapshot = (u) => ({
  id: u.id, side: u.side, uid: u.uid, unitId: u.unitId, star: u.star,
  x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, mana: u.mana, maxMana: u.maxMana,
});

export function simulate(catalog, boards) {
  const units = [];
  boards.forEach((board, side) => {
    [...board].sort((a, b) => a.uid - b.uid)
      .forEach((inst) => units.push(spawn(catalog, inst, side, units.length)));
  });
  const initial = units.map(snapshot);
  const events = [];
  let t = 0;
  const emit = (type, data) => events.push({ t, type, ...data });
  const occupied = (x, y) => units.some((u) => u.alive && u.x === x && u.y === y);

  function nearestEnemy(u) {
    let best = null;
    let bestDist = Infinity;
    for (const e of units) {
      if (!e.alive || e.side === u.side) continue;
      const d = dist(u, e);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  function lowestHealth(allies) {
    return allies.reduce((a, b) => (b.hp * a.maxHp < a.hp * b.maxHp ? b : a));
  }

  function damage(target, amount, src) {
    if (!target.alive) return;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    target.hp = Math.max(0, target.hp - (amount - absorbed));
    if (target.hp === 0) target.alive = false;
    else target.mana = Math.min(target.maxMana, target.mana + MANA_PER_HIT);
    emit('damage', { id: target.id, src: src.id, amount, hp: target.hp, shield: target.shield, mana: target.mana });
    if (!target.alive) emit('death', { id: target.id });
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
    target.stun = Math.max(target.stun, duration);
    emit('stun', { id: target.id, duration });
  }

  function cast(u, target) {
    const ab = u.ability;
    const power = (v) => scale(v, u.star);
    const allies = units.filter((a) => a.alive && a.side === u.side);
    u.mana = 0;
    emit('cast', { id: u.id, target: target.id });
    switch (ab.kind) {
      case 'strike':
        damage(target, power(ab.damage), u);
        break;
      case 'stun':
        damage(target, power(ab.damage), u);
        if (target.alive) stun(target, ab.duration);
        break;
      case 'blast':
        for (const e of units) {
          if (!e.alive || e.side === u.side || dist(e, target) > ab.radius) continue;
          damage(e, power(ab.damage), u);
          if (ab.duration && e.alive) stun(e, ab.duration);
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
    let best = null;
    let bestD = dist(u, target);
    let bestM = manhattan(u, target);
    for (const [dx, dy] of NEIGHBORS) {
      const cell = { x: u.x + dx, y: u.y + dy };
      if (cell.x < 0 || cell.y < 0 || cell.x >= COLS || cell.y >= ROWS || occupied(cell.x, cell.y)) continue;
      const d = dist(cell, target);
      const m = manhattan(cell, target);
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
    if (!target || !target.alive || dist(u, target) > u.range) target = nearestEnemy(u);
    if (!target) return;
    u.target = target.id;

    if (dist(u, target) <= u.range) {
      if (u.atkTimer > 0) return;
      if (u.mana >= u.maxMana) {
        cast(u, target);
      } else {
        u.mana = Math.min(u.maxMana, u.mana + MANA_PER_ATTACK);
        emit('attack', { id: u.id, target: target.id, mana: u.mana });
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
    // Alternate processing order each tick so neither side always acts first.
    const order = t % 2 ? units : [...units].reverse();
    for (const u of order) if (u.alive) act(u);
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
