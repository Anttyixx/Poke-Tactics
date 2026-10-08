// Rendering and input. The UI never mutates game state: it reads `state`,
// and turns clicks/drags into intents passed to `onIntent`. Combat is shown by
// replaying the event log from the combat result, never by re-simulating.

import { COLS, ROWS, HALF, TICK_SECONDS, scale } from './combat.js?v=1bea2c1';
import { BASE_INCOME, BENCH_SIZE, MAX_INTEREST, REROLL_COST, boardCap, fieldCount, interest, leaderIds, sellValue } from './game.js?v=1bea2c1';

const TICK_MS = 100; // playback speed at 1x: one sim tick (0.1s of game time) per 100ms, i.e. real time
// Attack-effect colour when a unit doesn't set its own "fx" colour in units.json.
const TYPE_FX = { warrior: '#ffb36b', ranger: '#a6e37f', mage: '#b994ff', rogue: '#e0a3ff', cleric: '#ffe28a' };

// Sprite sheets are 4x4 grids of 64px frames: one row per facing direction,
// four walk-cycle frames per row. CSS picks the row from data-facing.
const facingFor = (dx, dy, fallback) => (dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : dy > 0 ? 'down' : fallback);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const secs = (ticks) => +(ticks * TICK_SECONDS).toFixed(1);

export function describeAbility(ab, star) {
  const p = (v) => scale(v, star);
  const stunText = ab.duration ? ` and stuns for ${secs(ab.duration)}s` : '';
  switch (ab.kind) {
    case 'strike': return `Strikes its target for ${p(ab.damage)} damage.`;
    case 'stun': return `Hits its target for ${p(ab.damage)} damage${stunText}.`;
    case 'blast': return `Blasts the target and adjacent enemies for ${p(ab.damage)} damage${stunText}.`;
    case 'heal': return ab.target === 'all' ? `Heals all allies for ${p(ab.amount)}.` : `Heals the most injured ally for ${p(ab.amount)}.`;
    case 'shield': return ab.target === 'allies' ? `Shields all allies for ${p(ab.amount)}.` : `Shields itself for ${p(ab.amount)}.`;
    default: return '';
  }
}

export function createUI({ catalog, viewer, onIntent, onNewGame }) {
  const $ = (id) => document.getElementById(id);
  const arena = $('arena');
  const layer = $('units');
  const benchEl = $('bench');
  const shopEl = $('shop');
  const infoEl = $('info');
  const hudEl = $('hud');
  const overlay = $('overlay');
  const controls = $('combat-controls');
  const rerollBtn = $('reroll');
  const readyBtn = $('ready');
  const toastEl = $('toast');

  let state = null;
  let selected = null; // uid of selected own unit
  let hovered = null; // unitId hovered in the shop
  let playedRound = 0; // last combat round we started animating
  let playback = null;
  let speed = 1;
  let toastTimer = 0;

  // Board dimensions come from combat.js; CSS sizes everything from these.
  arena.style.setProperty('--cols', COLS);
  arena.style.setProperty('--rows', ROWS);
  arena.style.setProperty('--tick', `${TICK_MS}ms`);
  arena.style.aspectRatio = `${COLS} / ${ROWS}`;
  for (let vy = 0; vy < ROWS; vy++) {
    for (let vx = 0; vx < COLS; vx++) {
      const c = document.createElement('div');
      c.className = `cell ${vy >= HALF ? 'own' : 'enemy'}${(vx + vy) % 2 ? ' alt' : ''}${vy === HALF ? ' front' : ''}`;
      $('cells').append(c);
    }
  }
  const slots = Array.from({ length: BENCH_SIZE }, (_, i) => {
    const s = document.createElement('div');
    s.className = 'slot';
    s.dataset.index = i;
    benchEl.append(s);
    return s;
  });

  // ---- helpers -------------------------------------------------------------

  const me = () => state.players[viewer];
  const foe = () => state.players[1 - viewer];
  const canPlan = () => state?.phase === 'planning' && !me().ready;
  const owned = (uid) => [...me().board, ...me().bench].find((u) => u?.uid === uid);
  // Combat coordinates -> what this viewer sees (own side always at the bottom).
  const viewPos = (x, y) => (viewer === 0 ? { x, y } : { x: COLS - 1 - x, y: ROWS - 1 - y });

  function place(el, vx, vy) {
    el.style.left = `${(vx * 100) / COLS}%`;
    el.style.top = `${(vy * 100) / ROWS}%`;
    el.style.zIndex = vy + 1;
  }

  function cellAt(e) {
    const r = arena.getBoundingClientRect();
    const vx = Math.floor(((e.clientX - r.left) / r.width) * COLS);
    const vy = Math.floor(((e.clientY - r.top) / r.height) * ROWS);
    if (vx < 0 || vy < 0 || vx >= COLS || vy >= ROWS) return null;
    return { vx, vy };
  }

  const spriteStyle = (def) => `style="background-image:url('${def.sprite}')"`;

  function unitEl(unitId, star, side = 'ally', facing = 'down') {
    const def = catalog[unitId];
    const el = document.createElement('div');
    el.className = `unit ${side}${def.sprite ? ' sprite-unit' : ''}${def.leader ? ' leader' : ''}`;
    el.dataset.type = def.type;
    // Animation pacing follows movement speed: 1 = a step every 5 ticks (the usual pace).
    el.style.setProperty('--step', def.moveCd / 5);
    const bars = '<div class="bars"><div class="hp"><i></i><b></b></div><div class="mana"><i></i></div></div>';
    const stars = def.leader ? '' : `<div class="stars s${star}">${'★'.repeat(star)}</div>`;
    if (def.sprite) {
      el.dataset.facing = facing;
      el.innerHTML = `<div class="shadow"></div><div class="sprite" ${spriteStyle(def)}></div>${stars}${bars}`;
    } else {
      el.innerHTML = `
        <div class="token"><span>${def.emoji}</span></div>
        <div class="stars s${star}">${'★'.repeat(star)}</div>${bars}`;
    }
    return el;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 1800);
  }

  function showOverlay(html) {
    overlay.querySelector('.card').innerHTML = html;
    overlay.hidden = false;
  }

  function select(uid) {
    selected = uid;
    renderPlanning();
  }

  function intent(i) {
    selected = null;
    onIntent(i);
  }

  // ---- input ---------------------------------------------------------------

  arena.addEventListener('click', (e) => {
    if (state?.phase !== 'planning') return;
    const cell = cellAt(e);
    if (!cell || cell.vy < HALF) return select(null);
    const x = cell.vx;
    const y = cell.vy - HALF;
    const occupant = me().board.find((u) => u.x === x && u.y === y);
    if (selected !== null && occupant?.uid !== selected && canPlan()) {
      intent({ type: 'move', uid: selected, to: { area: 'board', x, y } });
    } else {
      select(occupant && occupant.uid !== selected ? occupant.uid : null);
    }
  });

  benchEl.addEventListener('click', (e) => {
    const slot = e.target.closest('.slot');
    if (!slot || state?.phase !== 'planning') return;
    const index = +slot.dataset.index;
    const occupant = me().bench[index];
    if (selected !== null && occupant?.uid !== selected && canPlan()) {
      intent({ type: 'move', uid: selected, to: { area: 'bench', index } });
    } else {
      select(occupant && occupant.uid !== selected ? occupant.uid : null);
    }
  });

  // Drag and drop (desktop). Click-to-select-then-click works everywhere.
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('.unit[data-uid]');
    if (!el || !canPlan()) return e.preventDefault();
    e.dataTransfer.setData('text/plain', el.dataset.uid);
    e.dataTransfer.effectAllowed = 'move';
    selected = +el.dataset.uid; // don't re-render mid-drag or the drag is cancelled
    renderInfo();
  });
  const dropTarget = (el, onDrop) => {
    el.addEventListener('dragover', (e) => { if (canPlan()) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const uid = +e.dataTransfer.getData('text/plain');
      if (uid) onDrop(e, uid);
    });
  };
  dropTarget(arena, (e, uid) => {
    const cell = cellAt(e);
    if (cell && cell.vy >= HALF) intent({ type: 'move', uid, to: { area: 'board', x: cell.vx, y: cell.vy - HALF } });
  });
  dropTarget(benchEl, (e, uid) => {
    const slot = e.target.closest('.slot');
    if (slot) intent({ type: 'move', uid, to: { area: 'bench', index: +slot.dataset.index } });
  });
  dropTarget($('shop-wrap'), (e, uid) => intent({ type: 'sell', uid }));

  shopEl.addEventListener('click', (e) => {
    const card = e.target.closest('.card[data-slot]');
    if (card && !card.disabled) intent({ type: 'buy', slot: +card.dataset.slot });
  });
  shopEl.addEventListener('pointerover', (e) => {
    const card = e.target.closest('.card[data-slot]');
    const id = card ? me().shop[+card.dataset.slot] : null;
    if (id !== hovered) { hovered = id; renderInfo(); }
  });
  shopEl.addEventListener('pointerleave', () => { hovered = null; renderInfo(); });

  rerollBtn.addEventListener('click', () => intent({ type: 'reroll' }));
  readyBtn.addEventListener('click', () => intent({ type: 'ready' }));
  infoEl.addEventListener('click', (e) => {
    if (e.target.id === 'sell' && selected !== null) intent({ type: 'sell', uid: selected });
  });
  hudEl.addEventListener('click', (e) => {
    if (e.target.id === 'new-game' && confirm('Abandon this match and start a new one?')) onNewGame();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'continue') { e.target.disabled = true; onIntent({ type: 'continue' }); }
    if (e.target.id === 'play-again') onNewGame();
    const pick = e.target.closest('[data-leader]');
    if (pick && !pick.disabled) onIntent({ type: 'chooseLeader', leader: pick.dataset.leader });
  });
  controls.addEventListener('click', (e) => {
    if (e.target.id === 'skip') return playback?.skip();
    const s = +e.target.dataset.speed;
    if (!s) return;
    speed = s;
    arena.style.setProperty('--speed', s);
    controls.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', +b.dataset.speed === s));
  });
  document.addEventListener('keydown', (e) => {
    if (!state || e.ctrlKey || e.metaKey || e.altKey || e.target.matches('input, textarea')) return;
    const key = e.key.toLowerCase();
    if (key === 'd' && canPlan()) intent({ type: 'reroll' });
    else if (key === 'f' && canPlan()) intent({ type: 'ready' });
    else if (key === 'e' && canPlan() && selected !== null) intent({ type: 'sell', uid: selected });
    else if (key === 'escape') select(null);
    else if (key === ' ' && playback) { e.preventDefault(); playback.skip(); }
  });

  // ---- rendering -----------------------------------------------------------

  function render(next) {
    // Compare by content, not object identity: in multiplayer every update
    // arrives as a fresh state object deserialized from the network.
    if (!state || next.seed !== state.seed || next.round < state.round) {
      // New match: forget anything tied to the previous one.
      playback?.cancel();
      playedRound = 0;
      selected = null;
    }
    state = next;
    if (selected !== null && !owned(selected)) selected = null;
    renderHud();

    if (state.phase === 'combat') {
      renderShop();
      if (playedRound !== state.combat.round) startPlayback();
      else if (!playback) showResult();
      return;
    }
    overlay.hidden = true;
    renderPlanning();
    if (state.phase === 'leader') showLeaderPick();
    if (state.phase === 'gameover') showGameOver();
  }

  function hpBox(p, side) {
    const pct = Math.max(0, p.hp);
    return `<div class="hpbox ${side}">
      <span class="name">${esc(p.name)}</span>
      <div class="hpbar"><i style="width:${pct}%"></i></div>
      <b>${p.hp}</b>
    </div>`;
  }

  function renderHud() {
    const p = me();
    const income = BASE_INCOME + interest(p.gold);
    hudEl.innerHTML = `
      <div class="stat"><span class="label">Round</span><b>${state.round}</b></div>
      <div class="stat"><span class="label">Gold</span><b class="gold">${p.gold}</b><small>+${income}/round</small></div>
      <div class="stat"><span class="label">Board</span><b>${fieldCount(p)}/${boardCap(Math.max(1, state.round))}</b></div>
      ${hpBox(p, 'ally')}
      ${hpBox(foe(), 'enemy')}
      <button id="new-game" class="ghost" title="Start a new match">New game</button>`;
  }

  function renderPlanning() {
    arena.classList.remove('in-combat');
    controls.hidden = true;
    const draggable = canPlan();

    layer.replaceChildren(...me().board.map((u) => {
      const el = unitEl(u.unitId, u.star);
      el.dataset.uid = u.uid;
      el.draggable = draggable;
      el.classList.toggle('selected', u.uid === selected);
      place(el, u.x, u.y + HALF);
      return el;
    }));

    me().bench.forEach((u, i) => {
      slots[i].replaceChildren();
      if (!u) return;
      const el = unitEl(u.unitId, u.star);
      el.dataset.uid = u.uid;
      el.draggable = draggable;
      el.classList.toggle('selected', u.uid === selected);
      slots[i].append(el);
    });

    renderShop();
    renderInfo();
  }

  function renderShop() {
    const p = me();
    shopEl.innerHTML = p.shop.map((id, slot) => {
      if (!id) return `<button class="card empty" disabled><span>Sold</span></button>`;
      const def = catalog[id];
      const disabled = !canPlan() || p.gold < def.cost;
      return `<button class="card" data-slot="${slot}" data-type="${def.type}" ${disabled ? 'disabled' : ''}>
        ${def.sprite
          ? `<span class="portrait" data-facing="down"><span class="sprite" ${spriteStyle(def)}></span></span>`
          : `<span class="emoji">${def.emoji}</span>`}
        <span class="name">${esc(def.name)}</span>
        <span class="type">${def.type}</span>
        <span class="cost c${def.cost}">${def.cost}g</span>
      </button>`;
    }).join('');
    rerollBtn.textContent = `Reroll (${REROLL_COST}g)`;
    rerollBtn.disabled = !canPlan() || p.gold < REROLL_COST;
    readyBtn.disabled = !canPlan();
    readyBtn.textContent = state.phase === 'planning' && p.ready ? 'Waiting for opponent…' : 'Fight!';
  }

  function renderInfo() {
    const inst = selected !== null ? owned(selected) : null;
    const unitId = inst?.unitId ?? hovered;
    if (!unitId) {
      infoEl.innerHTML = `<h2>How to play</h2>
        <ul class="help">
          <li>Buy units from the shop below.</li>
          <li>Click a unit, then click a square on <b>your half</b> (bottom) to place it. Desktop: drag and drop.</li>
          <li>The row nearest the middle is your front line. Put tanky melee units there.</li>
          <li>Three copies of a unit merge into a stronger ★★ version.</li>
          <li>Press <b>Fight!</b> to watch the battle play out by itself.</li>
          <li>Interest: +1 gold per 10 you hold (max +${MAX_INTEREST}).</li>
        </ul>
        <p class="keys">Keys: <kbd>D</kbd> reroll · <kbd>F</kbd> fight · <kbd>E</kbd> sell · <kbd>Space</kbd> skip</p>`;
      return;
    }
    const def = catalog[unitId];
    const star = inst?.star ?? 1;
    infoEl.innerHTML = `
      <div class="info-head" data-type="${def.type}">
        ${def.sprite
          ? `<span class="portrait" data-facing="down"><span class="sprite" ${spriteStyle(def)}></span></span>`
          : `<span class="emoji">${def.emoji}</span>`}
        <div><h2>${esc(def.name)} ${def.leader ? '' : `<span class="stars s${star}">${'★'.repeat(star)}</span>`}</h2>
        <span class="sub">${def.leader ? `Leader · ${def.type}` : `${def.type} · ${def.cost} gold`}</span></div>
      </div>
      <dl class="stats">
        <dt>HP</dt><dd>${scale(def.hp, star)}</dd>
        <dt>Attack</dt><dd>${scale(def.atk, star)}</dd>
        <dt>Armor</dt><dd>${def.armor}</dd>
        <dt>Range</dt><dd>${def.range}</dd>
        <dt>Attacks/s</dt><dd>${(1 / (def.attackCd * TICK_SECONDS)).toFixed(2)}</dd>
        <dt>Mana</dt><dd>${def.mana}</dd>
      </dl>
      <p class="ability"><b>${esc(def.ability.name)}:</b> ${describeAbility(def.ability, star)}</p>
      ${def.leader ? '<p class="muted">Your leader is always on the field and doesn\'t count toward the board limit. It can\'t be sold or benched.</p>' : ''}
      ${inst && !inst.leader && canPlan() ? `<button id="sell" class="danger">Sell for ${sellValue(catalog, inst)}g</button>` : ''}`;
  }

  // ---- combat playback -----------------------------------------------------

  function startPlayback() {
    const { result } = state.combat;
    playedRound = state.combat.round;
    selected = null;
    overlay.hidden = true;
    arena.classList.add('in-combat');
    controls.hidden = false;
    renderInfo();

    const actors = new Map();
    layer.replaceChildren();
    for (const u of result.initial) {
      const ally = u.side === viewer;
      const a = { ...u, shield: 0, stunUntil: 0, el: unitEl(u.unitId, u.star, ally ? 'ally' : 'enemy', ally ? 'up' : 'down') };
      const p = viewPos(u.x, u.y);
      place(a.el, p.x, p.y);
      layer.append(a.el);
      actors.set(u.id, a);
      bars(a);
    }

    const { events } = result;
    let tick = 0;
    let next = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;

    // Hits from projectiles land after the projectile's flight time, so their
    // effects are scheduled with later(). Skip/cancel flush or drop them.
    let pending = [];
    const later = (ms, fn) => {
      if (!ms) return fn();
      const job = { fn };
      job.timer = setTimeout(() => { pending = pending.filter((j) => j !== job); fn(); }, ms);
      pending.push(job);
    };
    const flush = () => { for (const j of pending) { clearTimeout(j.timer); j.fn(); } pending = []; };
    const ctx = { actors, later, srcDelay: new Map(), hitDelay: new Map(), action: new Map() };

    const advance = (animate) => {
      tick++;
      ctx.srcDelay.clear();
      ctx.hitDelay.clear();
      while (next < events.length && events[next].t <= tick) { applyEvent(ctx, events[next], next, animate); next++; }
      for (const a of actors.values()) {
        if (a.stunUntil && tick >= a.stunUntil) { a.stunUntil = 0; a.el.classList.remove('stunned'); }
      }
    };
    const finish = () => {
      cancelAnimationFrame(raf);
      playback = null;
      controls.hidden = true;
      setTimeout(() => { if (state.phase === 'combat' && !playback) render(state); }, 700);
    };
    const frame = (now) => {
      acc += Math.min(now - last, 250) * speed;
      last = now;
      while (acc >= TICK_MS && tick < result.ticks) { acc -= TICK_MS; advance(true); }
      if (tick >= result.ticks) return finish();
      raf = requestAnimationFrame(frame);
    };

    playback = {
      skip() {
        flush();
        while (tick < result.ticks) advance(false);
        finish();
      },
      cancel() {
        cancelAnimationFrame(raf);
        for (const j of pending) clearTimeout(j.timer);
        pending = [];
        playback = null;
      },
    };
    raf = requestAnimationFrame(frame);
  }

  function bars(a) {
    a.el.querySelector('.hp i').style.width = `${(100 * a.hp) / a.maxHp}%`;
    a.el.querySelector('.hp b').style.width = `${Math.min(100, (100 * a.shield) / a.maxHp)}%`;
    a.el.querySelector('.mana i').style.width = `${a.maxMana ? (100 * a.mana) / a.maxMana : 0}%`;
  }

  function floatText(a, text, kind) {
    const el = document.createElement('div');
    el.className = `float ${kind}`;
    el.textContent = text;
    const p = viewPos(a.x, a.y);
    place(el, p.x, p.y);
    el.addEventListener('animationend', () => el.remove());
    layer.append(el);
  }

  // Sprites face along the dominant axis of movement or attack.
  function face(a, dx, dy) {
    if (!a.el.dataset.facing) return;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    a.el.dataset.facing = facingFor(horizontal ? dx : 0, horizontal ? 0 : dy, a.el.dataset.facing);
  }

  function pulse(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
  }

  const rangeOf = (a) => catalog[a.unitId].range;
  const fxColor = (unitId) => catalog[unitId].fx ?? TYPE_FX[catalog[unitId].type] ?? '#fff';

  // One-shot visual effect centred on a board square; `cells` sets its size in squares.
  function fx(vx, vy, cls, color, cells = 1) {
    const el = document.createElement('div');
    el.className = `fx ${cls}`;
    el.style.setProperty('--fx', color);
    el.style.setProperty('--cells', cells);
    el.style.left = `${((vx + 0.5 - cells / 2) * 100) / COLS}%`;
    el.style.top = `${((vy + 0.5 - cells / 2) * 100) / ROWS}%`;
    el.addEventListener('animationend', () => el.remove());
    layer.append(el);
  }

  // Fly a projectile from one square to another; returns its flight time in ms.
  function projectile(from, to, color, big) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const ms = Math.max(160, 90 * Math.max(Math.abs(dx), Math.abs(dy))) / speed;
    const el = document.createElement('div');
    el.className = `projectile${big ? ' big' : ''}`;
    el.style.setProperty('--fx', color);
    el.style.setProperty('--angle', `${Math.atan2(dy, dx)}rad`);
    el.innerHTML = '<i></i>';
    place(el, from.x, from.y);
    el.style.zIndex = 16;
    layer.append(el);
    el.animate([{ translate: '0 0' }, { translate: `${dx * 100}% ${dy * 100}%` }], { duration: ms, easing: 'linear' })
      .onfinish = () => el.remove();
    return ms;
  }

  // `idx` is the event's position in the log. A delayed hit must never
  // overwrite newer HP/mana, so state is only applied if it's the newest seen.
  function applyEvent(ctx, ev, idx, animate) {
    const { actors, later } = ctx;
    const a = actors.get(ev.id);
    if (!a) return;
    const newest = () => { if (idx < (a.seq ?? -1)) return false; a.seq = idx; return true; };
    const at = () => viewPos(a.x, a.y);
    switch (ev.type) {
      case 'move': {
        const from = viewPos(a.x, a.y);
        a.x = ev.x;
        a.y = ev.y;
        const p = viewPos(a.x, a.y);
        face(a, p.x - from.x, p.y - from.y);
        place(a.el, p.x, p.y);
        break;
      }
      case 'attack': {
        a.mana = ev.mana;
        bars(a);
        ctx.action.set(a.id, 'attack');
        if (!animate) break;
        const t = actors.get(ev.target);
        const from = viewPos(a.x, a.y);
        const to = viewPos(t.x, t.y);
        a.el.style.setProperty('--dx', Math.sign(to.x - from.x));
        a.el.style.setProperty('--dy', Math.sign(to.y - from.y));
        face(a, to.x - from.x, to.y - from.y);
        pulse(a.el, rangeOf(a) > 1 ? 'shoot' : 'lunge');
        if (rangeOf(a) > 1) ctx.srcDelay.set(a.id, projectile(from, to, fxColor(a.unitId), false));
        break;
      }
      case 'cast': {
        a.mana = 0;
        bars(a);
        ctx.action.set(a.id, 'cast');
        if (!animate) break;
        const ab = catalog[a.unitId].ability;
        pulse(a.el, 'casting');
        floatText(a, ab.name, 'cast');
        if (!['strike', 'stun', 'blast'].includes(ab.kind)) break; // heal/shield show on each recipient
        const t = actors.get(ev.target);
        const from = viewPos(a.x, a.y);
        const to = viewPos(t.x, t.y);
        face(a, to.x - from.x, to.y - from.y);
        const color = fxColor(a.unitId);
        const flight = rangeOf(a) > 1 ? projectile(from, to, color, true) : 0;
        ctx.srcDelay.set(a.id, flight);
        later(flight, () => {
          if (ab.kind === 'blast') fx(to.x, to.y, 'ring', color, ab.radius * 2 + 1);
          else fx(to.x, to.y, ab.kind === 'stun' ? 'zap' : 'burst', color, 1.6);
        });
        break;
      }
      case 'damage': {
        const delay = animate ? ctx.srcDelay.get(ev.src) ?? 0 : 0;
        if (delay) ctx.hitDelay.set(a.id, delay);
        const src = actors.get(ev.src);
        later(delay, () => {
          if (newest()) {
            a.hp = ev.hp;
            a.shield = ev.shield;
            a.mana = ev.mana;
            bars(a);
          }
          if (!animate) return;
          floatText(a, `-${ev.amount}`, 'dmg');
          pulse(a.el, 'hit');
          if (src && rangeOf(src) <= 1 && ctx.action.get(src.id) === 'attack') fx(at().x, at().y, 'slash', fxColor(src.unitId));
        });
        break;
      }
      case 'heal':
        if (newest()) { a.hp = ev.hp; bars(a); }
        if (animate && ev.amount) { floatText(a, `+${ev.amount}`, 'heal'); fx(at().x, at().y, 'heal', '#5be38a', 1.3); }
        break;
      case 'shield':
        a.shield = ev.shield;
        bars(a);
        if (animate) { floatText(a, `+${ev.amount}`, 'shield'); fx(at().x, at().y, 'shield', '#ffffff', 1.3); }
        break;
      case 'stun':
        a.stunUntil = ev.t + ev.duration;
        later(ctx.hitDelay.get(a.id) ?? 0, () => a.el.classList.add('stunned'));
        break;
      case 'death':
        later(ctx.hitDelay.get(a.id) ?? 0, () => a.el.classList.add('dead'));
        break;
    }
  }


  // ---- overlays ------------------------------------------------------------

  function showResult() {
    const { result, damage, round } = state.combat;
    const won = result.winner === viewer;
    const draw = result.winner === null;
    const title = draw ? 'Draw' : won ? 'Victory!' : 'Defeat';
    const detail = draw
      ? `Nobody won in time. Both players take ${damage[viewer]} damage.`
      : won
        ? `${result.survivors.length} of your units survived. ${esc(foe().name)} takes ${damage[1 - viewer]} damage.`
        : `${result.survivors.length} enemy units survived. You take ${damage[viewer]} damage.`;
    const hpAfter = Math.max(0, me().hp - damage[viewer]);
    showOverlay(`
      <h1 class="${draw ? '' : won ? 'win' : 'loss'}">${title}</h1>
      <p>${detail}</p>
      <p class="muted">Round ${round} · Your HP ${me().hp} → ${hpAfter}${won ? ' · +1 bonus gold' : ''}</p>
      ${me().ready
        ? '<button disabled>Waiting for opponent…</button>'
        : '<button id="continue" class="primary" autofocus>Continue</button>'}`);
    overlay.querySelector('#continue')?.focus();
  }

  function showLeaderPick() {
    const waiting = me().ready;
    showOverlay(`
      <h1>Choose your leader</h1>
      <p class="muted">Your leader starts on the field and fights every round for free.</p>
      <div class="leader-pick">
        ${leaderIds(catalog).map((id) => {
          const def = catalog[id];
          const chosen = me().leader === id;
          return `<button class="leader-card${chosen ? ' chosen' : ''}" data-leader="${id}" data-type="${def.type}" ${waiting ? 'disabled' : ''}>
            <span class="portrait" data-facing="down"><span class="sprite" ${spriteStyle(def)}></span></span>
            <b>${esc(def.name)}</b>
            <span class="muted">${def.range > 1 ? `Ranged (${def.range})` : 'Melee'} · ${def.hp} HP · ${def.atk} ATK</span>
            <small><b>${esc(def.ability.name)}:</b> ${describeAbility(def.ability, 1)}</small>
          </button>`;
        }).join('')}
      </div>
      ${waiting ? '<p class="muted">Waiting for opponent…</p>' : ''}`);
  }

  function showGameOver() {
    const title = state.winner === viewer ? 'You win the match! 🏆' : state.winner === null ? 'Double knockout. It\'s a draw.' : 'You were eliminated';
    showOverlay(`
      <h1 class="${state.winner === viewer ? 'win' : 'loss'}">${title}</h1>
      <p>The match lasted ${state.round} rounds. Final HP: ${me().hp} vs ${foe().hp}.</p>
      <button id="play-again" class="primary">Play again</button>`);
  }

  return { render, toast };
}
