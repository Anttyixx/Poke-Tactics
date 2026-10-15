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
// Walking: a Pokémon waits its movement speed (seconds, below), then takes
// STEP_TICKS to cross to the next square, then waits again before the next.
export const STEP_TICKS = 5; // 0.5s per step
// Movement speed tiers: the wait between steps, in seconds.
export const MOVE_SPEEDS = { 'very fast': 0.35, fast: 0.5, medium: 0.8, slow: 1.0, 'very slow': 1.3, 'super slow': 2.0 };
const ticksOf = (seconds) => Math.max(1, Math.round(seconds / TICK_SECONDS));

// A unit's combat stats at a star level, in internal units (integers).
export function unitStats(def, star) {
  return {
    hp: Math.round(def.hp[star] * STAT_SCALE),
    atk: Math.round(def.damage[star] * STAT_SCALE),
    attackCd: ticksOf(def.secPerHit), // ticks per attack
    moveCd: ticksOf(MOVE_SPEEDS[def.moveSpeed]), // ticks of waiting before each step
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
// Psywave's wind-up before the wave leaves Beheeyem, in ticks.
const WAVE_WINDUP = 3;

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

// Distance is the number of steps between two squares: units walk
// up/down/left/right, so a diagonal neighbour is 2 away. "Nearest" and
// "farthest" enemy use it.
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const dist = manhattan;
// Attack range (and blast radius) is a square around the Pokémon instead:
// range 1 = the 3x3 around it (diagonals included), range 2 = the 5x5, ...
const reach = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function spawn(catalog, inst, side, id, slot, pos = toCombatPos(side, inst.x, inst.y)) {
  const def = catalog[inst.unitId];
  const stats = unitStats(def, inst.star);
  return {
    id, side, slot, uid: inst.uid, unitId: inst.unitId, star: inst.star,
    x: pos.x, y: pos.y,
    sp: { x: pos.x, y: pos.y }, // where it stood at the start of the tick (see at())
    hp: stats.hp, maxHp: stats.hp,
    atk: stats.atk, crit: stats.crit,
    armor: def.armor ?? 0, range: def.range,
    attackCd: stats.attackCd, moveCd: stats.moveCd,
    // Every fight (and every summon) starts fresh: power progress at 0 and a full
    // attack cooldown before the first hit.
    mana: def.ability?.startCharged ? stats.energy : 0, maxMana: stats.energy, // mana counts attacks toward the power; 0 = no counter
    power: def.ability, powerKind: def.ability?.kind ?? null, // read every tick: kept on the unit itself (faster)
    shield: 0, stun: 0,
    pendingMana: 0, pendingStun: 0, // applied at the end of the tick
    atkTimer: stats.attackCd,
    moveTimer: stats.moveCd, // waiting before the next step (it waits before its first one too)
    stepTimer: 0, // mid-step: ticks until it reaches the square it's walking to
    hasteUntil: 0, hastePct: 0, stealthFrom: 0, stealthUntil: 0,
    tauntBy: null, tauntUntil: 0, // Amoonguss's Rage Powder: it must attack this unit through tauntUntil
    rage: 0, movedSinceHit: true, // Annihilape's Rage Fist: attacks in a row without moving
    darts: null, dartOf: null, dartSlot: 0, dartShots: 0, // Dragapult's Dreepy: [{ readyAt, unit }] / which Dragapult a Dreepy belongs to
    bindingUntil: 0, hoopaForm: null, lastBound: null, // Hoopa: its own bind lasts through this tick; the form it has taken
    boundUntil: 0, // Hoopa's bind: it can't move (walk, zip or dash) through this tick; it can still attack
    guardUntil: 0, guardPct: 0, guardBrokeAt: -1, // Alcremie's Mint Cream shield: less damage; the first stun or shove only breaks it
    regen: null, // Alcremie's Matcha Cream: { src, per, left, next } healing once a second
    chillFrom: 0, chillUntil: 0, chillPct: 0, // Frosmoth's chill: slower attacks and steps through chillUntil
    pendingChill: null, // { duration, pct }: a chill that lands at the end of the tick
    pendingTaunt: null, // { by, until }: Amoonguss's pull, landing at the end of the tick
    hold: 0, // ticks it can't move or attack (riding a Psywave); cooldowns still run
    landStun: 0, // stun applied when the hold ends (it has landed)
    pendingHeal: 0, healFrom: null, // healing lands at the end of the tick, like stuns; who it came from
    sprite: def.sprite, // changes when it transforms (Ash-Greninja, Minior, Ditto)
    form: null, // name of the form it has transformed into, if any
    pendingForm: false, // transform at the end of this tick (Minior's low-HP trigger)
    pendingRebirth: false, // Minior: knocked out in Rock form, comes back as Star Form at the end of the tick
    copyOf: null, // Ditto: id of the unit it is copying
    pendingCopy: null, pendingRevert: false, // Ditto: copy / turn back at the end of the tick
    morphUntil: 0, // mid-transformation (Minior, Ditto) through this tick: it can't act
    immuneFrom: 0, immuneUntil: 0, // nothing affects it in these ticks (Minior transforming, Tapu Koko dashing)
    dashTarget: null, dashUntil: 0, // Tapu Koko: who it strikes when its dash arrives
    blink: false, // Minior's Star Form: zips straight to its target instead of walking
    fuse: 0, fused: false, fusedAt: 0, // Golem: ticks left before it explodes after being knocked out
    bornAt: -1, // tick a summon joined the fight
    target: null, alive: true, summoned: Boolean(inst.summoned),
  };
}

const snapshot = (u) => ({
  id: u.id, side: u.side, uid: u.uid, unitId: u.unitId, star: u.star,
  x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, mana: u.mana, maxMana: u.maxMana,
  ...(u.summoned && { summoned: true }),
});

// The offsets of the (2r+1)x(2r+1) square around a square, row by row.
const squares = new Map();
const squareAround = (r) => {
  if (!squares.has(r)) squares.set(r, Array.from({ length: (2 * r + 1) ** 2 }, (_, k) => [(k % (2 * r + 1)) - r, Math.floor(k / (2 * r + 1)) - r]));
  return squares.get(r);
};

// Scratch space for findPath, reused by every search of every fight.
const pathBlocked = new Uint8Array(COLS * ROWS);
const pathPrev = new Int16Array(COLS * ROWS);
const pathQueue = new Int16Array(COLS * ROWS);

// `seed` decides crits and which side acts first on each tick (see below).
// { record: false } skips the event log (faster; for simulations that only
// need the outcome). The fight itself is identical either way.
// { maxTicks } stops early (for quick what-if checks, never real fights): the
// result then has `cut: true`, `winner: undefined` and each side's share of HP
// left (`hpShare`).
export function simulate(catalog, boards, seed = 0, { record = true, maxTicks = MAX_TICKS } = {}) {
  const units = [];
  boards.forEach((board, side) => {
    [...board].sort((a, b) => a.uid - b.uid)
      .forEach((inst, slot) => units.push(spawn(catalog, inst, side, units.length, slot)));
  });
  const initial = units.map(snapshot);
  const bySide = [0, 1].map((side) => units.filter((u) => u.side === side));
  const events = [];
  let t = 0;
  // Every call site is written `record && emit(...)`, so a simulation that skips
  // the log (record: false) never even builds the event objects.
  const emit = (type, data) => events.push({ t, type, ...data });
  const inside = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
  const unitAt = (x, y) => {
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.alive && u.x === x && u.y === y) return u; }
    return undefined;
  };
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
  // Minior transforming and Tapu Koko dashing can't be hurt, stunned or moved.
  // Immunity always starts on a new tick, so it never decides a same-tick trade.
  const immune = (u) => t >= u.immuneFrom && t <= u.immuneUntil;
  // Hoopa's bind. A Hoopa whose counter is full waits; the first enemy that
  // tries to move after that is bound in place for `duration` ticks instead.
  // Returns true if `u` may not move this tick (already bound, or just bound).
  const bound = (u) => u.boundUntil > 0 && t <= u.boundUntil;
  function heldBack(u) {
    if (bound(u)) return true;
    if (immune(u)) return false;
    const ready = (h) => (h.power.noCounter ? !(t <= h.bindingUntil) : h.maxMana > 0 && h.mana >= h.maxMana);
    const hoopa = units.find((h) => h.side !== u.side && standing(h) && h.powerKind === 'bind' && !h.copyOf && ready(h) && !(h.power.noRepeat && h.lastBound === u.id));
    if (!hoopa) return false;
    hoopa.lastBound = u.id;
    if (hoopa.maxMana > 0) hoopa.mana = 0;
    hoopa.bindingUntil = t + hoopa.power.duration;
    record && emit('cast', { id: hoopa.id, target: u.id });
    if (hoopa.power.chargedForm) hoopaForm(hoopa, null); // its charge is spent: back to its usual form
    if (hoopa.power.bindForm) hoopaForm(hoopa, hoopa.power.bindForm); // its other form while the bind lasts
    u.boundUntil = t + hoopa.power.duration;
    record && emit('bind', { id: u.id, by: hoopa.id, duration: hoopa.power.duration });
    return true;
  }
  // Hoopa's forms: `form` = { name, sprite, hpPct, damagePct, speedPct, range,
  // moveSpeed } relative to its own stats at its star; null = its own form.
  // Max HP changes keep the same share of HP.
  function hoopaForm(h, form) {
    const def = catalog[h.unitId];
    const base = unitStats(def, h.star);
    const f = form ?? {};
    rescaleHp(h, Math.round((base.hp * (f.hpPct ?? 100)) / 100));
    h.atk = Math.round((base.atk * (f.damagePct ?? 100)) / 100);
    h.attackCd = Math.max(1, Math.round((base.attackCd * 100) / (f.speedPct ?? 100)));
    h.range = f.range ?? def.range;
    h.moveCd = f.moveSpeed ? ticksOf(MOVE_SPEEDS[f.moveSpeed]) : base.moveCd;
    h.hoopaForm = form ? form.name ?? 'form' : null;
    record && emit('transform', { id: h.id, sprite: f.sprite ?? def.sprite, range: h.range, moveCd: h.moveCd, name: f.name ?? def.name, hp: h.hp, maxHp: h.maxHp, revert: !form });
  }
  // Every tick: a charged Hoopa takes its charged form; a bind form ends with its bind.
  function hoopaTick(h) {
    const p = h.power;
    if (p.chargedForm && !h.hoopaForm && h.maxMana > 0 && h.mana >= h.maxMana) hoopaForm(h, p.chargedForm);
    if (p.bindForm && h.hoopaForm && !(t <= h.bindingUntil)) hoopaForm(h, null);
  }
  // Shielded by Alcremie (Mint Cream) this tick.
  const guarded = (u) => u.guardUntil > 0 && t <= u.guardUntil;
  // A stun or a shove that hits a shield breaks it instead of landing. Anything
  // else that would stun or shove it in the same tick (a Heat Crash does both)
  // is blocked too.
  const blocks = (u) => guarded(u) || u.guardBrokeAt === t;
  function breakGuard(u) {
    if (u.guardBrokeAt === t) return;
    u.guardUntil = 0;
    u.guardBrokeAt = t;
    record && emit('guardBreak', { id: u.id });
  }
  const shownMana = (u) => Math.min(u.maxMana, u.mana + u.pendingMana);
  // Where a unit stood at the start of the tick. Targeting, range and pathing
  // all read this, so a unit that moved earlier in the tick isn't seen at its
  // new square until next tick. (Square occupancy stays live: no two units
  // can ever share a square.)
  const at = (u) => u.sp; // { x, y }, set at the start of each tick (read-only)
  // Side 1's board is point-mirrored, so it reads direction lists mirrored too;
  // otherwise the two sides would break ties differently.
  const dirCache = new Map();
  const dirs = (u, list = NEIGHBORS) => {
    let pair = dirCache.get(list);
    if (!pair) dirCache.set(list, (pair = [list, list.map(([dx, dy]) => [-dx, -dy])]));
    return pair[u.side === 1 ? 1 : 0];
  };
  const enemiesOf = (u) => units.filter((e) => e.side !== u.side && visible(e));
  // nearest/farthest scan units in the same order as enemiesOf, without building the list.

  function nearestEnemy(u) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (e.side === u.side || !visible(e)) continue;
      const d = dist(u, e.sp);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  function farthestEnemy(u) {
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (e.side === u.side || !visible(e)) continue;
      const d = dist(u, e.sp);
      if (d > bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  // Returns the damage actually dealt to HP.
  function damage(target, amount, src, crit = false) {
    if (!standing(target) || immune(target)) return 0;
    if (guarded(target)) amount = Math.max(1, Math.floor((amount * (100 - target.guardPct)) / 100));
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    const before = target.hp;
    target.hp = Math.max(0, target.hp - (amount - absorbed));
    if (target.hp > 0) target.pendingMana += MANA_PER_HIT;
    record && emit('damage', { id: target.id, src: src.id, amount, hp: target.hp, shield: target.shield, mana: shownMana(target), ...(crit && { crit }) });
    if (target.hp === 0) knockedOut(target);
    // Minior: dropping to its HP threshold transforms it (at the end of the tick).
    const p = target.power;
    if (target.hp > 0 && p?.kind === 'transform' && p.trigger === 'lowHp' && !target.form && !target.morphUntil && target.hp * 100 <= target.maxHp * p.hpPct) target.pendingForm = true;
    return before - target.hp;
  }

  // Healing lands at the end of the tick (see the main loop), so it never
  // depends on who acted first, and a Pokémon knocked out this tick stays out.
  // `src` is who healed (for the event log: each healer's share of what landed).
  function heal(target, amount, src) {
    if (!standing(target) || amount <= 0) return;
    target.pendingHeal += amount;
    (target.healFrom ??= {})[src.id] = (target.healFrom[src.id] ?? 0) + amount;
  }

  // HP reached 0. Usually that's a knockout; a Golem instead lights its fuse:
  // it stays on its square (it can't be hit or targeted) and explodes later.
  function knockedOut(u) {
    if (u.powerKind === 'transform' && u.power.trigger === 'knockedOut' && !u.form && !u.pendingRebirth) {
      // Minior: Rock form breaks open instead of fainting. Like any knockout it
      // can't be hit or targeted for the rest of this tick; at the end of the
      // tick it comes back with Star Form's own HP (see the main loop).
      u.pendingRebirth = true;
    } else if (u.powerKind === 'selfdestruct' && !u.fused) {
      u.fused = true;
      u.fuse = u.power.delay;
      u.fusedAt = t; // it still acts this tick, like anyone knocked out mid-tick
      record && emit('fuse', { id: u.id, duration: u.power.delay });
    } else {
      record && emit('death', { id: u.id });
    }
  }

  function explode(u) {
    const p = u.power;
    record && emit('explode', { id: u.id, radius: p.radius });
    const amount = Math.floor((u.atk * p.damagePct) / 100);
    for (const e of units) if (e.side !== u.side && standing(e) && reach(u, e) <= p.radius) damage(e, amount, u);
    record && emit('death', { id: u.id });
  }

  // Change a unit's fighting stats: transforming (Battle Bond, Shining Star) or
  // Ditto copying. `stats` = { atk, attackCd, moveCd, range, crit?, sprite }.
  function setStats(u, stats, info) {
    Object.assign(u, stats);
    record && emit('transform', { id: u.id, sprite: u.sprite, range: u.range, moveCd: u.moveCd, ...info });
  }
  function applyForm(u, form) {
    u.form = form.name;
    // Its power is spent: no more counting, unless the form has a power of its
    // own (Star Form's hop every `energy` attacks).
    u.maxMana = form.hop ? form.energy : 0;
    u.mana = 0;
    setStats(u, {
      atk: Math.round(form.damage[u.star] * STAT_SCALE), attackCd: ticksOf(form.secPerHit),
      moveCd: ticksOf(MOVE_SPEEDS[form.moveSpeed]), range: form.range, sprite: form.sprite,
      blink: Boolean(form.blink),
    }, { name: form.name, maxMana: u.maxMana });
    // A faster form doesn't sit out the rest of its old, slower attack timer.
    u.atkTimer = Math.min(u.atkTimer, u.attackCd);
    // A shock wave as it changes: stuns every enemy in the square around it
    // (radius 1 = the 3x3). Stuns land at the end of the tick, as always.
    const wave = form.shockwave;
    if (wave) {
      record && emit('shockwave', { id: u.id, radius: wave.radius });
      for (const e of units) if (e.side !== u.side && standing(e) && reach(u, e) <= wave.radius) stun(e, wave.stun);
    }
  }
  // Ditto: a new max HP keeps the same share of HP left (never rounding down to 0).
  const rescaleHp = (u, maxHp) => {
    u.hp = Math.max(1, Math.round((u.hp * maxHp) / u.maxHp));
    u.maxHp = maxHp;
  };
  // Ditto: copy everything about `e`'s fighting, including its max HP, except
  // its power and movement (a copied Ditto stands still). Runs at the end of
  // the tick, since it changes Ditto's HP.
  function copyUnit(u, e) {
    u.copyOf = e.id;
    rescaleHp(u, e.maxHp);
    setStats(u, { atk: e.atk, attackCd: e.attackCd, range: e.range, crit: e.crit, sprite: e.sprite }, { name: catalog[e.unitId].name, copy: e.unitId, hp: u.hp, maxHp: u.maxHp });
  }
  function revertCopy(u) {
    const def = catalog[u.unitId];
    const base = unitStats(def, u.star);
    u.copyOf = null;
    u.target = null;
    rescaleHp(u, base.hp);
    setStats(u, { atk: base.atk, attackCd: base.attackCd, range: def.range, crit: base.crit, sprite: def.sprite }, { name: def.name, revert: true, hp: u.hp, maxHp: u.maxHp });
  }

  function stun(target, duration) {
    if (immune(target)) return;
    if (blocks(target)) { breakGuard(target); return; }
    target.pendingStun = Math.max(target.pendingStun, duration);
    record && emit('stun', { id: target.id, duration });
  }

  // Shove `u` to (x, y) without walking: knockbacks and teleports.
  function relocate(u, cell, type, extra) {
    if (u.x === cell.x && u.y === cell.y) return;
    u.x = cell.x;
    u.y = cell.y;
    u.movedSinceHit = true;
    record && emit(type, { id: u.id, x: u.x, y: u.y, ...extra });
  }

  // Where a Pokémon goes when something is launched onto its square, in order:
  // its own left, its own right, back (toward its own back row), forward, then
  // the diagonals (back ones first). Directions are from the displaced
  // Pokémon's point of view, so both sides are treated the same. Null if all
  // eight squares are taken or off the board.
  // The free squares around `o`, in order: its own left, its own right, back
  // (toward its own back row), forward, then the diagonals from back to front.
  // Directions are from o's point of view, so both sides are treated the same.
  function freeAround(o) {
    const back = o.side === 0 ? 1 : -1; // side 0's back row is the bottom of the board
    const left = o.side === 0 ? -1 : 1;
    const order = [[left, 0], [-left, 0], [0, back], [0, -back], [left, back], [-left, back], [left, -back], [-left, -back]];
    return order.map(([dx, dy]) => ({ x: o.x + dx, y: o.y + dy })).filter((c) => inside(c.x, c.y) && !occupied(c.x, c.y));
  }
  const displaceSpot = (o) => freeAround(o)[0] ?? null;

  // Land a launched Pokémon on `goal`. Whoever stands there is displaced (see
  // displaceSpot); if they have nowhere to go, the launched one lands on the
  // closest free square instead. Returns the displaced Pokémon, if any.
  function land(target, goal, side) {
    if (blocks(target)) { breakGuard(target); return null; } // the shield takes the shove
    const o = unitAt(goal.x, goal.y);
    if (o && o !== target && blocks(o)) {
      // A shielded Pokémon can't be pushed aside: its shield breaks and the
      // launched one lands on the closest free square instead.
      breakGuard(o);
      relocate(target, closestFree(goal, target, target, side), 'knock');
      return null;
    }
    if (o && o !== target) {
      const spot = displaceSpot(o);
      if (!spot) { relocate(target, closestFree(goal, target, target, side), 'knock'); return null; }
      relocate(o, spot, 'knock', { by: target.id });
    }
    relocate(target, goal, 'knock');
    return o && o !== target ? o : null;
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

  // Tapu Koko's dash: the open square around `target` (all 8) closest to `u` in a
  // straight line; ties go by a side-mirrored order so both sides match.
  const AROUND = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  function dashSpot(u, target) {
    const p = at(target);
    let best = null;
    let bestD = Infinity;
    for (const [dx, dy] of dirs(u, AROUND)) {
      const c = { x: p.x + dx, y: p.y + dy };
      if (!inside(c.x, c.y) || occupied(c.x, c.y)) continue;
      const d = (c.x - u.x) ** 2 + (c.y - u.y) ** 2;
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }
  // The squares a straight line from `a` to `b` passes through (centre to
  // centre), not counting `a`.
  function lineCells(a, b) {
    const n = 12 * Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    const seen = new Map();
    for (let i = 1; i <= n; i++) {
      const x = Math.floor(a.x + 0.5 + ((b.x - a.x) * i) / n);
      const y = Math.floor(a.y + 0.5 + ((b.y - a.y) * i) / n);
      if ((x !== a.x || y !== a.y) && inside(x, y)) seen.set(y * COLS + x, { x, y });
    }
    return [...seen.values()];
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

  // How many a summon power brings at the summoner's star level, and at what
  // star the summoned units come (fixed, or the summoner's own).
  const summonCount = (u) => u.power.countByStar?.[u.star] ?? 1;

  function summon(u, cell) {
    const kin = units.length;
    const star = u.power.summonStar ?? u.star;
    const pal = spawn(catalog, { uid: -kin, unitId: u.power.unit, star, summoned: true }, u.side, kin, bySide[u.side].length, cell);
    pal.sp = { x: pal.x, y: pal.y };
    units.push(pal);
    bySide[u.side].push(pal);
    record && emit('summon', { id: u.id, unit: snapshot(pal) });
  }

  // Powers that fire the moment the attack counter fills (no attack is lost).
  function instantPower(u, target) {
    const p = u.power;
    // A charged power is never wasted: with no free square to summon into, it
    // stays charged and tries again after the next attack.
    // Summons take the free squares around the summoner in freeAround's order.
    const cells = p.kind === 'summon' ? freeAround(u).slice(0, summonCount(u)) : [];
    if (p.kind === 'summon' && !cells.length) return;
    const taunted = p.kind === 'taunt' ? tauntPick(u) : null;
    if (p.kind === 'taunt' && !taunted) return; // nobody to pull: stays charged
    u.mana = 0;
    switch (p.kind) {
      case 'snipe': {
        const far = farthestEnemy(u) ?? target;
        record && emit('cast', { id: u.id, target: far.id });
        damage(far, Math.floor((u.atk * p.damagePct) / 100), u);
        break;
      }
      case 'summon':
        record && emit('cast', { id: u.id, target: null });
        for (const cell of cells) summon(u, cell);
        break;
      case 'stealth':
        record && emit('cast', { id: u.id, target: null });
        u.stealthFrom = t;
        u.stealthUntil = t + p.duration;
        record && emit('stealth', { id: u.id, duration: p.duration });
        if (p.hastePct) { u.hasteUntil = t + p.duration; u.hastePct = p.hastePct; record && emit('haste', { id: u.id, duration: p.duration }); }
        break;
      case 'haste':
        record && emit('cast', { id: u.id, target: null });
        u.hasteUntil = t + p.duration;
        u.hastePct = p.hastePct;
        record && emit('haste', { id: u.id, duration: p.duration });
        break;
      case 'quake': {
        // Every enemy on the board, visible or not.
        record && emit('cast', { id: u.id, target: null });
        const amount = Math.floor((u.atk * p.damagePct) / 100);
        for (const e of units) {
          if (e.side === u.side || !standing(e)) continue;
          damage(e, amount, u);
          if (standing(e) && p.stun) stun(e, p.stun);
        }
        break;
      }
      case 'treat':
        sweetTreat(u);
        break;
      case 'taunt':
        // Like stuns, the pull lands at the end of the tick, so the Pokémon it
        // pulls acts this tick as it would have either way.
        record && emit('cast', { id: u.id, target: taunted.id });
        taunted.pendingTaunt = { by: u.id, until: t + p.duration };
        record && emit('taunt', { id: taunted.id, by: u.id, duration: p.duration });
        break;
      case 'boost': {
        // Toxtricity's Overdrive: allies in the plus around it (left, right, front,
        // back) that have a power counter gain `charges` toward their power (never
        // past full). Like all power progress, they land at the end of the tick.
        record && emit('cast', { id: u.id, target: null });
        for (const [dx, dy] of NEIGHBORS) {
          const o = unitAt(u.x + dx, u.y + dy);
          if (!o || o.side !== u.side || !standing(o) || !(o.maxMana > 0)) continue;
          const gain = Math.min(p.charges, o.maxMana - shownMana(o));
          if (gain <= 0) continue;
          o.pendingMana += gain;
          record && emit('boost', { id: o.id, by: u.id, amount: gain, mana: shownMana(o) });
        }
        break;
      }
      case 'transform':
        if (u.form) { hop(u, target); break; } // Star Form's own power
        record && emit('cast', { id: u.id, target: null });
        applyForm(u, p.form);
        break;
      default:
        throw new Error(`Unknown power kind "${p.kind}"`);
    }
  }

  // Amoonguss's Rage Powder: of the enemies within `radius` squares (the 5x5 for
  // 2) that are attacking someone else, the hardest hitter is pulled onto it.
  function tauntPick(u) {
    const r = u.power.radius;
    let best = null;
    for (const e of units) {
      if (e.side === u.side || !standing(e) || e.target === u.id || (e.tauntUntil >= t && standing(units[e.tauntBy]))) continue;
      if (Math.max(Math.abs(e.x - u.x), Math.abs(e.y - u.y)) > r) continue;
      const dps = e.atk / e.attackCd;
      if (!best || dps > best.dps || (dps === best.dps && e.slot < best.e.slot)) best = { e, dps };
    }
    return best?.e ?? null;
  }

  // Dragapult's Dragon Darts: when it is about to attack and both its Dreepy
  // are home, it fires them instead of attacking: each at one of the farthest
  // enemies (two darts go for two different ones). Each lands beside its
  // target, which must attack it until it faints (see `lure`). A fainted Dreepy
  // flies back; until both are home again, Dragapult attacks as usual.
  // Darts fly at the end of the tick (both sides at once), at enemies that were
  // already on the board when the tick began.
  let dartQueue = [];
  // Ready to fire: every Dreepy home, or with `perShot` (Dreepy per shot)
  // enough of them home for one shot.
  function dartsHome(u) {
    u.darts ??= Array.from({ length: u.power.count }, () => ({ readyAt: 0, unit: null, aim: null }));
    const home = u.darts.filter((slot) => !slot.unit && t >= slot.readyAt).length;
    return u.power.perShot ? home >= u.power.perShot : home === u.darts.length;
  }
  // Every Dragapult's first ready Dreepy goes, then every second one, ... so
  // when both sides' darts want the same squares, neither side gets them all.
  function fireDarts() {
    for (let k = 0; dartQueue.length; k++) {
      dartQueue = dartQueue.filter((u) => k < u.darts.length);
      // A Dragapult knocked out earlier this tick still fires (like any action
      // this tick), so a Dreepy landing first never cancels the other side's.
      for (const u of dartQueue) if (u.alive) fireDart(u, u.darts[k]);
    }
  }
  function fireDart(u, slot) {
    const p = u.power;
    if (slot.unit || t < slot.readyAt || !(u.dartShots > 0)) return;
    // Enemies its other Dreepy were fired at (not whoever they fight now: a
    // lure from the other side's darts this same tick may have changed that).
    const busy = new Set(u.darts.filter((s) => s.unit).map((s) => s.aim));
    // Distances are from where everyone stood when the tick began, so a shove
    // from a dart that landed earlier this tick (either side's) changes nothing.
    const me = { x: at(u).x, y: at(u).y, side: u.side };
    const foes = units.filter((e) => e.side !== u.side && visible(e) && e.bornAt !== t)
      .sort((a, b) => reach(me, at(b)) - reach(me, at(a)) || dist(me, at(b)) - dist(me, at(a)) || a.slot - b.slot);
    // `outside`: only enemies farther than that many squares away (1 = not in
    // the 3x3 around it), farthest first, one Dreepy each; with nobody that far,
    // no Dreepy at all.
    const pool = p.outside ? foes.filter((e) => reach(me, at(e)) > p.outside) : foes;
    const target = pool.find((e) => !busy.has(e.id)) ?? (p.outside ? null : pool[0]);
    if (!target) return;
    // `displace`: it crashes into its target, landing on its square and
    // pushing it aside (like any knock: a shield breaks instead, and with no
    // room, or a target nothing can affect, it lands beside it).
    const kin = units.length;
    const shove = p.displace && !immune(target) ? (blocks(target) ? null : displaceSpot(target)) : null;
    const cell = shove ? { x: target.x, y: target.y } : dashSpot(me, target) ?? closestFree(at(target), me, null, u.side);
    if (!cell) return;
    record && emit('cast', { id: u.id, target: target.id });
    if (p.displace && !immune(target) && blocks(target)) breakGuard(target);
    const pal = spawn(catalog, { uid: -kin, unitId: p.unit, star: u.star, summoned: true }, u.side, kin, bySide[u.side].length, cell);
    pal.sp = { x: pal.x, y: pal.y };
    pal.dartOf = u.id;
    pal.bornAt = t;
    pal.target = target.id;
    units.push(pal);
    bySide[u.side].push(pal);
    slot.unit = pal;
    slot.aim = target.id;
    u.dartShots--;
    if (u.maxMana > 0) u.mana = 0; // the charge is spent only once a Dreepy is actually out
    record && emit('summon', { id: u.id, unit: snapshot(pal), dart: true, target: target.id });
    if (shove) relocate(target, shove, 'knock', { by: pal.id }); // right after it lands on that square
    // The crash itself: a set hit (`impactDamage` by star, or `impactPct` of
    // Dragapult's damage) and a short stun.
    if (p.impactDamage) damage(target, Math.round(p.impactDamage[u.star] * STAT_SCALE), pal);
    else if (p.impactPct) damage(target, Math.floor((u.atk * p.impactPct) / 100), u);
    if (p.impactStun && standing(target)) stun(target, p.impactStun);
    // The hit distracts it: it drops whoever it was attacking and must go
    // after the Dreepy until the Dreepy faints.
    if (p.lure && standing(target) && !immune(target)) {
      target.tauntBy = pal.id;
      target.tauntUntil = MAX_TICKS;
      target.target = pal.id;
      // Whatever it was winding up is lost: once the stun wears off it turns on
      // the Dreepy and attacks right away.
      target.atkTimer = Math.min(target.atkTimer, 1);
      record && emit('taunt', { id: target.id, by: pal.id, duration: MAX_TICKS - t, dart: true });
    }
  }
  // A Dreepy fainted: it flies back to Dragapult, home `returnSec` later
  // (however far it has to come). Dragapult fires again once both are home.
  function dartHome(d) {
    const u = units[d.dartOf];
    const slot = u?.darts?.find((s) => s.unit === d);
    if (!slot) return;
    slot.unit = null;
    if (!standing(u)) return;
    const ticks = Math.max(1, Math.round(u.power.returnSec / TICK_SECONDS));
    slot.readyAt = t + ticks;
    record && emit('dartReturn', { id: u.id, dreepy: d.id, fromX: d.x, fromY: d.y, duration: ticks, unitId: d.unitId });
  }

  // Alcremie's Sweet Treat: a random flavour (seeded, so replays match). It
  // changes into that flavour's form and treats one ally for `duration` ticks:
  //   heal   - the ally with the lowest share of HP heals healPct% of Alcremie's
  //            damage, spread over the duration (a chunk every second);
  //   haste  - the hardest-hitting ally attacks hastePct% faster;
  //   guard  - the ally most enemies are attacking takes guardPct% less damage,
  //            and the first stun or shove that would land breaks the shield instead.
  // The treat itself lands at the end of the tick, like stuns and heals, so it
  // never depends on which side acted first.
  let treats = [];
  function sweetTreat(u) {
    const p = u.power;
    const f = p.flavors[hash(seed, t, u.slot + 211) % p.flavors.length];
    record && emit('cast', { id: u.id, target: null });
    setStats(u, { sprite: f.sprite }, { name: f.name, flavor: f.flavor });
    treats.push({ u, f });
  }
  function serveTreat({ u, f }) {
    const p = u.power;
    const allies = units.filter((a) => a.side === u.side && standing(a));
    if (!allies.length) return;
    const share = (a) => a.hp / a.maxHp;
    const first = (key) => allies.reduce((best, a) => (key(a) > key(best) || (key(a) === key(best) && a.slot < best.slot) ? a : best));
    let target;
    if (f.flavor === 'heal') {
      target = first((a) => -share(a));
      const chunks = Math.max(1, Math.round(p.duration / 10));
      target.regen = { src: u, per: Math.floor((u.atk * f.healPct) / 100 / chunks), left: chunks, next: t + 10 };
    } else if (f.flavor === 'haste') {
      target = first((a) => a.atk / a.attackCd);
      target.hastePct = target.hasteUntil > t ? Math.max(target.hastePct, f.hastePct) : f.hastePct;
      target.hasteUntil = Math.max(target.hasteUntil, t + p.duration);
      record && emit('haste', { id: target.id, duration: p.duration });
    } else {
      const attackers = (a) => units.filter((e) => e.side !== u.side && standing(e) && e.target === a.id).length;
      target = first((a) => attackers(a) * 10 - share(a));
      target.guardUntil = t + p.duration;
      target.guardPct = f.guardPct;
      record && emit('guard', { id: target.id, duration: p.duration, pct: f.guardPct });
    }
    record && emit('treat', { id: u.id, target: target.id, flavor: f.flavor, duration: p.duration });
  }

  // An empowered attack: the one after the counter fills.
  function powerStrike(u, target) {
    const p = u.power;
    u.mana = 0;
    record && emit('cast', { id: u.id, target: target.id });
    const dealt = damage(target, Math.floor((u.atk * p.damagePct) / 100), u);
    if (p.lifestealPct && dealt) heal(u, Math.floor((dealt * p.lifestealPct) / 100), u);
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
    record && emit('cast', { id: u.id, target: target?.id ?? null, x: u.x, y: end });
    if (!target) return;
    // The wave takes time to cross the board: whoever it moves is out of action
    // until it lands (wind-up plus about a tick per square).
    // Measured from where Beheeyem stood when the fight began, so two waves
    // fired at each other on the first tick resolve the same either way round.
    const travel = WAVE_WINDUP + Math.abs(end - at(u).y);
    damage(target, Math.floor((u.atk * p.damagePct) / 100), u);
    if (!standing(target) || target.y === end) return;
    if (blocks(target)) { breakGuard(target); return; } // the shield takes the wave
    const shoved = land(target, { x: u.x, y: end }, u.side);
    target.hold = travel;
    target.landStun = p.stun ?? 0; // stunned once it lands (see act)
    if (shoved) shoved.hold = travel;
  }

  // Chilled (Frosmoth): attacks and steps take chillPct% longer. Like stuns, a
  // chill lands at the end of the tick and counts from the next one.
  const chilled = (u) => t >= u.chillFrom && t <= u.chillUntil;
  const slowed = (ticks, u) => (chilled(u) ? Math.round((ticks * (100 + u.chillPct)) / 100) : ticks);
  // Haste (Infernape, Alcremie's Ruby Cream) and Annihilape's rage both speed
  // attacks up; they add together.
  const cooldown = (u) => {
    const pct = (u.hasteUntil > t ? u.hastePct : 0) + (u.rage && u.powerKind === 'rage' ? u.rage * u.power.stackPct : 0);
    return slowed(pct ? Math.max(1, Math.round((u.attackCd * 100) / (100 + pct))) : u.attackCd, u);
  };
  // A hit from Frosmoth chills the target (a new hit restarts the timer).
  function chill(target, p) {
    if (!standing(target) || immune(target)) return;
    target.pendingChill = { duration: p.duration, pct: p.slowPct };
    record && emit('chill', { id: target.id, duration: p.duration, pct: p.slowPct });
  }

  // Minior's Star Form, every `energy` attacks: it picks a new target (a
  // seeded pick among the other enemies it can land beside) and zips to the
  // open square beside it closest to it. With no other enemy to reach, it
  // moves to another square beside its current target; with none free, it stays.
  function hop(u, target) {
    u.mana = 0;
    const options = [];
    for (const e of units) {
      if (e.side === u.side || e === target || !visible(e)) continue;
      const cell = dashSpot(u, e);
      if (cell) options.push({ e, cell });
    }
    let pick = options.length ? options[hash(seed, t, u.slot + 101) % options.length] : null;
    if (!pick) { const cell = dashSpot(u, target); if (cell) pick = { e: target, cell }; }
    record && emit('cast', { id: u.id, target: pick ? pick.e.id : null });
    if (!pick) return;
    relocate(u, pick.cell, 'blink', { fromX: u.x, fromY: u.y, hop: true });
    u.target = pick.e.id;
  }

  // Shortest walk (breadth-first search, up/down/left/right) from `u` around
  // every other unit to a square where some enemy is within its attack range.
  // Returns the first square of that walk and the enemy it leads to, or null if
  // every route is blocked. Neighbours are explored in a side-mirrored order, so
  // both sides break ties the same way.
  function findPath(u) {
    const enemies = enemiesOf(u);
    // Squares taken right now (live occupancy, like occupied()). The buffers
    // are shared by every search (a search always finishes before the next).
    const blocked = pathBlocked.fill(0);
    for (let i = 0; i < units.length; i++) { const o = units[i]; if (o.alive) blocked[o.y * COLS + o.x] = 1; }
    const prev = pathPrev.fill(-2); // -2 = unseen, -1 = start
    const queue = pathQueue;
    const startK = u.y * COLS + u.x;
    prev[startK] = -1;
    queue[0] = startK;
    let tail = 1;
    const ds = dirs(u);
    for (let qi = 0; qi < tail; qi++) {
      const k = queue[qi];
      const cx = k % COLS, cy = (k - cx) / COLS;
      if (k !== startK) {
        let best = null, bestD = 0;
        for (const e of enemies) {
          const d = Math.max(Math.abs(cx - e.sp.x), Math.abs(cy - e.sp.y));
          if (d <= u.range && (!best || d < bestD)) { best = e; bestD = d; }
        }
        if (best) {
          let first = k;
          while (prev[first] !== startK) first = prev[first];
          const fx = first % COLS;
          return { next: { x: fx, y: (first - fx) / COLS }, target: best };
        }
      }
      for (let di = 0; di < ds.length; di++) {
        const nx = cx + ds[di][0], ny = cy + ds[di][1];
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const nk = ny * COLS + nx;
        if (prev[nk] !== -2 || blocked[nk]) continue;
        prev[nk] = k;
        queue[tail++] = nk;
      }
    }
    return null;
  }

  // A step: STEP_TICKS crossing to the new square, then the movement-speed wait.
  function startStep(u) {
    u.stepTimer = STEP_TICKS;
    u.moveTimer = STEP_TICKS + slowed(u.moveCd, u);
  }

  function moveTo(u, cell) {
    u.x = cell.x;
    u.y = cell.y;
    u.movedSinceHit = true;
    record && emit('move', { id: u.id, x: u.x, y: u.y });
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
    if (u.powerKind === 'bind' && standing(u)) hoopaTick(u);
    // A Golem knocked out with its fuse lit just counts down, then explodes.
    if (u.fuse > 0 && u.fusedAt < t) { u.fuse--; if (u.fuse === 0) explode(u); return; }
    // Coming out of a stun (or landing after being carried), a Pokémon looks
    // around again and picks the nearest enemy rather than its old target.
    if (u.stun > 0) { u.stun--; if (u.stun === 0 && !(u.tauntUntil >= t)) u.target = null; return; }
    if (u.atkTimer > 0) u.atkTimer--;
    if (u.moveTimer > 0) u.moveTimer--;
    if (u.stepTimer > 0) u.stepTimer--;
    if (t <= u.morphUntil) return; // transforming
    if (t <= u.dashUntil) return; // mid-dash
    // Tapu Koko's dash has arrived: strike the Pokémon it dashed at (no dashing
    // off again before that).
    const arrived = u.dashTarget !== null;
    if (arrived) {
      const far = units[u.dashTarget];
      u.dashTarget = null;
      if (visible(far) && reach(u, at(far)) <= u.range) u.target = far.id;
    }
    if (u.hold > 0) {
      u.hold--;
      if (u.hold === 0) {
        u.target = null;
        if (u.landStun) { stun(u, u.landStun); u.landStun = 0; }
      }
      return;
    }

    // Ditto walks (as itself) toward the nearest enemy until it is within that
    // enemy's range, then takes `morph` ticks to turn into it. A copied Ditto
    // can't move: when the Pokémon it copied faints, or no enemy is in range,
    // it turns back into Ditto (at the end of the tick) and walks again.
    if (u.powerKind === 'copy') {
      if (u.copyOf === null) {
        const e = nearestEnemy(u);
        if (!e) return;
        u.target = e.id;
        if (u.stepTimer > 0) return; // finish the step first
        if (reach(u, at(e)) <= e.range) {
          u.pendingCopy = e.id;
          u.morphUntil = t + u.power.morph - 1;
          record && emit('morphStart', { id: u.id, target: e.id, duration: u.power.morph });
          return;
        }
        u.range = e.range; // walk until it is in reach of its own copy of `e`
      } else {
        const inReach = (e) => e && visible(e) && e.side !== u.side && reach(u, at(e)) <= u.range;
        let e = u.target === null ? null : units[u.target];
        if (!inReach(e)) e = enemiesOf(u).filter(inReach).sort((a, b) => dist(u, at(a)) - dist(u, at(b)))[0];
        if (!standing(units[u.copyOf]) || !e) { u.pendingRevert = true; return; }
        u.target = e.id;
      }
    }

    // Pulled by Amoonguss's Rage Powder: it goes after Amoonguss until it wears off.
    if (u.tauntUntil >= t && standing(units[u.tauntBy]) && visible(units[u.tauntBy])) {
      const tt = units[u.tauntBy];
      u.target = tt.id;
      if (reach(u, at(tt)) > u.range) {
        if (u.moveTimer === 0 && u.stepTimer === 0 && !heldBack(u) && step(u, tt)) startStep(u);
        return;
      }
    }
    let target = u.target === null ? null : units[u.target];
    if (!target || !visible(target) || target.side === u.side || reach(u, at(target)) > u.range) target = nearestEnemy(u);
    if (!target) return;
    u.target = target.id;

    // Dragapult's Dragon Darts: with both Dreepy home and its attack ready,
    // its next action (an attack, or a step toward its target) fires them
    // instead, at the end of the tick. With a power counter it also needs that many attacks since the
    // last pair.
    if (u.powerKind === 'darts' && u.stepTimer === 0 && dartsHome(u) && !(u.maxMana > 0 && u.mana < u.maxMana)
      && (!u.power.outside || units.some((e) => e.side !== u.side && visible(e) && reach(u, at(e)) > u.power.outside))) {
      // Firing is an attack: it waits for its attack timer like one (so not
      // before a full attack cooldown at the start of the fight).
      const inRange = reach(u, at(target)) <= u.range;
      if (u.atkTimer === 0 && (inRange || u.moveTimer === 0)) {
        u.dartShots = u.power.perShot ?? u.power.count;
        dartQueue.push(u);
        u.atkTimer = cooldown(u);
        if (!inRange) u.moveTimer = slowed(u.moveCd, u); // it used its step too: waits as if it had walked
        return;
      }
    }

    // "Every N attacks, the next attack ..." powers.
    const empowered = u.powerKind === 'empower' && u.maxMana > 0 && u.mana >= u.maxMana;
    if (empowered && u.power.teleport && u.atkTimer === 0) {
      // No need to teleport if the farthest enemy is already in reach.
      const far = farthestEnemy(u);
      const cell = far && reach(u, at(far)) > u.range && freeBeside(u, far);
      if (cell) {
        relocate(u, cell, 'teleport');
        u.moveTimer = u.stepTimer = 0;
        target = far;
        u.target = far.id;
      }
    }
    if (empowered && u.power.dash && u.atkTimer === 0 && !arrived && !bound(u)) {
      // Dash in a straight line next to the farthest enemy, stunning every
      // enemy it passes through on the way.
      const far = farthestEnemy(u);
      const cell = far && reach(u, at(far)) > u.range && dashSpot(u, far);
      if (cell && !heldBack(u)) {
        const from = { x: u.x, y: u.y };
        for (const c of lineCells(from, cell)) {
          const o = unitAt(c.x, c.y);
          if (o && o !== far && o.side !== u.side && standing(o)) stun(o, u.power.stun);
        }
        // The dash takes a tick per square, during which Tapu Koko is immune
        // to everything; it strikes when it arrives.
        const travel = Math.max(2, Math.max(Math.abs(cell.x - from.x), Math.abs(cell.y - from.y)));
        relocate(u, cell, 'dash', { fromX: from.x, fromY: from.y, duration: travel });
        u.moveTimer = u.stepTimer = 0;
        u.target = far.id;
        u.dashTarget = far.id;
        u.dashUntil = u.immuneUntil = t + travel;
        u.immuneFrom = t + 1;
        return;
      }
    }

    if (reach(u, at(target)) <= u.range) {
      // It can't attack mid-step; waiting between steps doesn't stop it.
      if (u.atkTimer > 0 || u.stepTimer > 0) return;
      if (empowered) {
        powerStrike(u, target);
      } else {
        if (u.maxMana > 0) u.mana = Math.min(u.maxMana, u.mana + MANA_PER_ATTACK);
        record && emit('attack', { id: u.id, target: target.id, mana: shownMana(u) });
        // Annihilape: every attack in a row without moving makes the next ones faster.
        if (u.powerKind === 'rage') {
          const was = u.rage;
          u.rage = u.movedSinceHit ? 0 : Math.min(u.power.maxStacks, u.rage + 1);
          u.movedSinceHit = false;
          if (u.rage !== was) record && emit('rage', { id: u.id, stacks: u.rage, pct: u.rage * u.power.stackPct });
        }
        const crit = critRoll(seed, t, u.slot) < u.crit;
        const hit = crit ? Math.floor((u.atk * CRIT_PCT) / 100) : u.atk;
        damage(target, Math.max(1, Math.floor((hit * 100) / (100 + target.armor))), u, crit);
        // Frosmoth: every hit chills its target.
        if (u.powerKind === 'chill' && !u.copyOf) chill(target, u.power);
        // Lilligant: each attack also heals its allies around the square it hit:
        // the (2r+1)x(2r+1) square for `radius` r, else the 4 squares beside it.
        if (u.powerKind === 'splashHeal') {
          const p = at(target);
          const amount = Math.floor((u.atk * u.power.healPct) / 100);
          const r = u.power.radius ?? 0;
          const cells = r ? squareAround(r) : NEIGHBORS;
          for (const [dx, dy] of cells) {
            const o = unitAt(p.x + dx, p.y + dy);
            if (o && o.side === u.side) heal(o, amount, u);
          }
        }
        if (u.powerKind && u.powerKind !== 'empower' && u.powerKind !== 'bind' && u.powerKind !== 'darts' && u.maxMana > 0 && u.mana >= u.maxMana) instantPower(u, target);
      }
      u.atkTimer = cooldown(u);
    } else if (u.moveTimer === 0 && u.stepTimer === 0 && (u.blink || u.copyOf === null) && heldBack(u)) {
      // Bound by Hoopa: it stays where it is (it still attacks anything in range).
    } else if (u.blink && u.moveTimer === 0 && u.stepTimer === 0) {
      // Minior's Star Form doesn't walk: it zips straight to the open square
      // beside its target closest to it, then waits its movement speed before
      // it can zip again. If every square beside the target is taken, it walks.
      const cell = dashSpot(u, target);
      const from = { x: u.x, y: u.y };
      if (cell) {
        relocate(u, cell, 'blink', { fromX: from.x, fromY: from.y });
        u.moveTimer = u.moveCd;
      } else {
        const path = findPath(u);
        if (path) { u.target = path.target.id; moveTo(u, path.next); startStep(u); }
        else if (step(u, target)) startStep(u);
      }
    } else if (u.moveTimer === 0 && u.stepTimer === 0 && u.copyOf === null) {
      // Out of range: walk around anyone in the way toward the enemy that can
      // be reached soonest (which may not be the one closest as the crow flies).
      const path = findPath(u);
      if (path) {
        u.target = path.target.id;
        moveTo(u, path.next);
        startStep(u);
      } else if (step(u, target)) {
        startStep(u);
      }
    }
  }

  // undefined = still fighting, 0/1 = winning side, null = nobody left / draw
  const outcome = () => {
    let a = false;
    let b = false;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) continue;
      if (u.side === 0) a = true; else b = true;
      if (a && b) return undefined;
    }
    return a ? 0 : b ? 1 : null;
  };

  let orders = null;
  let orderSize = -1; // rebuilt when a summon joins
  let winner = outcome();
  while (winner === undefined && t < maxTicks) {
    t++;
    // Knocked-out units never move again, so only the living need updating.
    for (const u of units) if (u.alive) { u.sp.x = u.x; u.sp.y = u.y; }
    // Which side acts first each tick is a seeded coin flip. Attacks, mana and
    // stuns resolve simultaneously anyway; this only decides who claims a
    // contested square first. A fixed pattern (e.g. odd/even) would line up with
    // cooldowns and always favour the same side. Each side keeps its unit order,
    // and units summoned this tick wait until the next one.
    if (orderSize !== units.length) { orders = [[...bySide[0], ...bySide[1]], [...bySide[1], ...bySide[0]]]; orderSize = units.length; }
    const order = coin(seed, t) ? orders[0] : orders[1];
    // Battle-start powers go off on the first tick, before anyone acts.
    if (t === 1) for (const u of order) if (u.powerKind === 'opening' && standing(u)) openingPower(u);
    for (const u of order) if (u.alive) act(u);
    if (t === SUDDEN_DEATH_TICK) record && emit('suddenDeath', {});
    if (t >= SUDDEN_DEATH_TICK) {
      // The drain lands at the end of the tick, after everyone has acted, and
      // ignores shields. Same amount for everyone: the weakest fall first.
      const drain = Math.round((SUDDEN_DEATH_HP_PER_SECOND * STAT_SCALE) * TICK_SECONDS);
      for (const u of units) {
        if (!standing(u) || immune(u)) continue;
        u.hp = Math.max(0, u.hp - drain);
        record && emit('drain', { id: u.id, amount: drain, hp: u.hp });
        if (u.hp === 0) knockedOut(u);
      }
    }
    for (const k of knocks) if (standing(k.target) && !immune(k.target)) land(k.target, k.goal, k.side);
    knocks = [];
    for (const tr of treats) if (standing(tr.u)) serveTreat(tr);
    treats = [];
    fireDarts();
    for (const u of units) {
      if (!u.alive) continue; // out since an earlier tick: nothing left to resolve
      // Alcremie's Matcha Cream: a chunk of healing every second.
      if (u.regen && t >= u.regen.next) {
        heal(u, u.regen.per, u.regen.src);
        u.regen = --u.regen.left > 0 ? { ...u.regen, next: u.regen.next + 10 } : null;
      }
      if (u.pendingHeal && u.hp > 0) {
        const gained = Math.min(u.pendingHeal, u.maxHp - u.hp);
        u.hp += gained;
        // from: healer id -> [HP it restored, HP it offered] (the rest was over max HP).
        if (record) {
          const from = Object.fromEntries(Object.entries(u.healFrom ?? {}).map(([id, a]) => [id, [Math.round((gained * a) / u.pendingHeal), a]]));
          emit('heal', { id: u.id, amount: gained, hp: u.hp, from });
        }
      }
      u.pendingHeal = 0;
      u.healFrom = null;
      // Minior: a low-HP transformation takes `morph` ticks, during which it
      // is immune to everything; then it becomes its new form.
      if (u.pendingForm && u.hp > 0) {
        record && emit('cast', { id: u.id, target: null });
        const m = u.power.morph ?? 0;
        if (m) {
          u.morphUntil = u.immuneUntil = t + m;
          u.immuneFrom = t + 1;
          u.stun = u.pendingStun = 0;
          record && emit('morphStart', { id: u.id, duration: m });
        } else applyForm(u, u.power.form);
      }
      u.pendingForm = false;
      // Minior knocked out in Rock form: Star Form's own HP, then the same
      // immune transformation as above.
      if (u.pendingRebirth) {
        u.pendingRebirth = false;
        u.form = 'breaking'; // no second rebirth, even before the new form lands
        u.maxHp = u.hp = Math.round(u.power.form.hp[u.star] * STAT_SCALE);
        u.shield = 0;
        record && emit('cast', { id: u.id, target: null });
        const m = u.power.morph ?? 0;
        u.morphUntil = u.immuneUntil = t + Math.max(1, m);
        u.immuneFrom = t + 1;
        u.stun = u.pendingStun = 0;
        u.pendingMana = 0;
        record && emit('morphStart', { id: u.id, duration: Math.max(1, m), hp: u.hp, maxHp: u.maxHp });
      }
      if (u.powerKind === 'transform' && u.morphUntil === t && u.hp > 0) { applyForm(u, u.power.form); u.target = null; }
      // Ditto finishes turning into its target (if that one is still standing),
      // or turns back.
      if (u.pendingCopy !== null && u.morphUntil === t) {
        if (u.hp > 0 && standing(units[u.pendingCopy])) copyUnit(u, units[u.pendingCopy]);
        u.pendingCopy = null;
      }
      if (u.pendingRevert && u.hp > 0) revertCopy(u);
      u.pendingRevert = false;
    }
    for (const u of units) {
      if (!u.alive) continue;
      if (u.hp === 0 && !(u.fuse > 0)) {
        u.alive = false; // knocked out this tick (a lit Golem stays)
        if (u.dartOf !== null) dartHome(u); // a Dreepy flies back to its Dragapult
      }
      u.mana = shownMana(u);
      u.stun = Math.max(u.stun, u.pendingStun);
      if (u.pendingChill && u.hp > 0) {
        u.chillFrom = t + 1;
        u.chillUntil = t + u.pendingChill.duration;
        u.chillPct = u.pendingChill.pct;
      }
      u.pendingChill = null;
      if (u.pendingTaunt && u.hp > 0) {
        u.tauntBy = u.pendingTaunt.by;
        u.tauntUntil = u.pendingTaunt.until;
        u.target = u.tauntBy;
      }
      u.pendingTaunt = null;
      u.pendingMana = 0;
      u.pendingStun = 0;
    }
    winner = outcome();
  }
  if (winner === undefined && maxTicks < MAX_TICKS) {
    const hpShare = [0, 1].map((side) => {
      const mine = units.filter((u) => u.side === side && !u.summoned);
      return mine.reduce((sum, u) => sum + (u.alive ? u.hp / u.maxHp : 0), 0) / Math.max(1, mine.length);
    });
    return { initial, events, winner: undefined, ticks: t, cut: true, hpShare, survivors: [] };
  }
  if (winner === undefined) winner = null; // unreachable: sudden death always ends the fight
  record && emit('end', { winner });

  return {
    initial,
    events,
    winner,
    ticks: t,
    survivors: units.filter((u) => u.alive && u.side === winner && !u.summoned).map(snapshot),
  };
}
