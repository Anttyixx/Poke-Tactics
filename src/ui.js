// Rendering and input. The UI never mutates game state: it reads `state`,
// and turns clicks/drags into intents passed to `onIntent`. Combat is shown by
// replaying the event log from the combat result, never by re-simulating.

import { COLS, CRIT_PCT, toCombatPos, MOVE_SPEEDS, ROWS, HALF, STAT_SCALE, SUDDEN_DEATH_TICK, TICK_SECONDS, powerDamage, unitStats } from './combat.js';
import {
  COPIES_PER_TROOP, LOSS_COINS, MAX_REROLLS, WIN_COINS,
  copiesOf, fielded, poolSize, sellValue, teamSize, troopIds,
} from './game.js';

const TICK_MS = 100; // playback speed at 1x: one sim tick (0.1s of game time) per 100ms, i.e. real time
// Attack-effect colour when a unit doesn't set its own "fx" colour in units.json.
const TYPE_FX = { warrior: '#ffb36b', ranger: '#a6e37f', mage: '#b994ff', rogue: '#e0a3ff', cleric: '#ffe28a' };

// Sprite sheets are 4x4 grids of 64px frames: one row per facing direction,
// four walk-cycle frames per row. CSS picks the row from data-facing.
const facingFor = (dx, dy, fallback) => (dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : dy > 0 ? 'down' : fallback);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const secs = (ticks) => +(ticks * TICK_SECONDS).toFixed(1);
// Seconds between attacks, as the game actually plays it (cooldowns are whole 0.1s ticks).
const attackTime = (stats) => secs(stats.attackCd);
const dps = (stats) => (show(stats.atk) / attackTime(stats)).toFixed(1);
const SPEED_NAME = { fast: 'Fast', medium: 'Medium', slow: 'Slow', 'very slow': 'Very slow' };
const moveText = (def) => `${SPEED_NAME[def.moveSpeed]} (${MOVE_SPEEDS[def.moveSpeed]}s per tile)`;

// Internal combat numbers -> the design sheet's units.
const show = (v) => +(v / STAT_SCALE).toFixed(1);

// What a Pokémon's power does, in plain words, with numbers for this star level.
export function describePower(def, star, catalog) {
  const p = def.ability;
  if (!p) return '';
  const every = `After every ${def.energy} attacks`;
  const dmg = powerDamage(def, star);
  switch (p.kind) {
    case 'empower': {
      const extras = [
        p.teleport && 'teleports next to the farthest enemy and',
        `hits for ${p.damagePct}% damage (${show(dmg)})`,
        p.knockback && `, knocking the target back ${p.knockback} squares`,
        p.stun && `${p.knockback ? 'and stunning it' : 'and stuns the target'} for ${secs(p.stun)}s`,
        p.lifestealPct && `, healing for ${p.lifestealPct}% of the damage dealt`,
      ].filter(Boolean).join(' ').replace(/ ,/g, ',');
      return `${every}, its next attack ${extras}.`;
    }
    case 'snipe': return `Every ${def.energy}th attack also zaps the farthest enemy for ${p.damagePct}% damage (${show(dmg)}).`;
    case 'summon': return `${every}, it summons a ${catalog?.[p.unit]?.name ?? p.unit} next to it, at the same star level.`;
    case 'stealth': return `${every}, it turns invisible for ${secs(p.duration)}s${p.hastePct ? ` and attacks ${p.hastePct}% faster` : ''}. Enemies can't target or follow it while it's invisible.`;
    case 'haste': return `${every}, it's enraged: ${p.hastePct}% faster attacks for ${secs(p.duration)}s.`;
    case 'opening': return `When the battle starts, it fires a wave down its column. The first enemy hit takes ${p.damagePct}% damage (${show(dmg)}) and is carried all the way to the other end of the board. Anyone already there is pushed to the side.`;
    default: return '';
  }
}

// When a power goes off, as a short tag.
export const powerCadence = (def) => (!def.ability ? 'No power' : def.ability.kind === 'opening' ? 'Power at battle start' : `Power every ${def.energy} attacks`);

export function createUI({ catalog, viewer, onIntent, onNewGame }) {
  const $ = (id) => document.getElementById(id);
  const arena = $('arena');
  const layer = $('units');
  const shopEl = $('shop');
  const infoEl = $('info');
  const hudEl = $('hud');
  const overlay = $('overlay');
  const controls = $('combat-controls');
  const rerollBtn = $('reroll');
  const readyBtn = $('ready');
  const toastEl = $('toast');
  const dexEl = $('dex');
  let dexPick = null; // unit id shown in the Pokédex
  const clockEl = $('clock');

  let state = null;
  let selected = null; // uid of selected own unit
  let buying = null; // shop slot picked to buy; the next board click places it
  let hovered = null; // unitId hovered in the shop
  let draft = { troops: [] }; // team builder picks
  let playedRound = 0; // last combat round we started animating
  let playback = null;
  let speed = 1;
  let toastTimer = 0;
  const appEl = $('app');
  const menuEl = $('menu');
  let shownCoins = null; // last coin count drawn, to animate changes
  let shownShop = ''; // last shop drawn, to deal new cards in
  let seenUids = new Set(); // board units already drawn, to drop new ones in
  let peek = null; // unit id shown in the info pop-up (phones), opened with an ⓘ button
  const sheetBackdrop = $('info-backdrop');

  // Board dimensions come from combat.js; CSS sizes everything from these.
  arena.style.setProperty('--cols', COLS);
  arena.style.setProperty('--rows', ROWS);
  arena.style.setProperty('--tick', `${TICK_MS}ms`);
  arena.style.aspectRatio = `${COLS} / ${ROWS}`;

  // Size the board to the space it has, as big as fits. Measured in JS (not
  // just CSS) so that when the space changes (battle controls appearing, a
  // phone rotating, the window being resized) the board glides to its new size.
  const fit = $('board-fit');
  let fitted = false;
  new ResizeObserver(() => {
    const w = Math.floor(Math.min(fit.clientWidth, (fit.clientHeight * COLS) / ROWS));
    if (w <= 0) return;
    if (!fitted) arena.style.transition = 'none'; // first layout: no animation
    arena.style.width = `${w}px`;
    if (!fitted) { void arena.offsetWidth; arena.style.transition = ''; fitted = true; }
  }).observe(fit);
  for (let vy = 0; vy < ROWS; vy++) {
    for (let vx = 0; vx < COLS; vx++) {
      const c = document.createElement('div');
      c.className = `cell ${vy >= HALF ? 'own' : 'enemy'}${(vx + vy) % 2 ? ' alt' : ''}${vy === HALF ? ' front' : ''}`;
      $('cells').append(c);
    }
  }

  // ---- helpers -------------------------------------------------------------

  const me = () => state.players[viewer];
  const foe = () => state.players[1 - viewer];
  const canPlan = () => state?.phase === 'planning' && !me().ready;
  const owned = (uid) => me().board.find((u) => u.uid === uid);
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
    el.className = `unit ${side}${def.sprite ? ' sprite-unit' : ''}${def.summon ? ' summon' : ''}`;
    el.dataset.type = def.type;
    // Animation pacing follows movement speed (--step 1 = 0.5s per square).
    el.style.setProperty('--step', unitStats(def, 0).moveCd / 5);
    const bars = '<div class="bars"><div class="hp"><i></i><b></b></div><div class="mana"><i></i></div></div>';
    const stars = `<div class="stars s${star}">${'★'.repeat(star)}</div>`;
    if (def.sprite) {
      el.dataset.facing = facing;
      el.style.setProperty('--fx', fxColor(unitId));
      // Cosmetic only: start each unit's idle breathing at a different point.
      el.style.setProperty('--idle-delay', `${(-Math.random() * 1.8).toFixed(2)}s`);
      el.innerHTML = `<div class="shadow"></div><div class="body"><div class="sprite" ${spriteStyle(def)}></div></div>${stars}${bars}`;
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
    buying = null;
    renderPlanning();
  }

  function pickShop(slot) {
    buying = buying === slot ? null : slot;
    selected = null;
    renderPlanning();
  }

  function intent(i) {
    selected = null;
    buying = null;
    return onIntent(i);
  }

  // Buy the picked shop troop onto own square (x, y). On failure the pick is kept
  // so the player can just click another square.
  function buyAt(slot, x, y) {
    const res = intent({ type: 'buy', slot, x, y });
    if (!res?.ok && me().shop[slot]) { buying = slot; renderPlanning(); }
  }

  // ---- input ---------------------------------------------------------------

  arena.addEventListener('click', (e) => {
    if (state?.phase !== 'planning') return;
    if (e.target.closest('[data-unit-info]')) return openInfo(owned(selected)?.unitId);
    const cell = cellAt(e);
    if (!cell || cell.vy < HALF) return select(null);
    const x = cell.vx;
    const y = cell.vy - HALF;
    if (buying !== null && canPlan()) return buyAt(buying, x, y);
    const occupant = me().board.find((u) => u.x === x && u.y === y);
    if (selected !== null && occupant?.uid !== selected && canPlan()) {
      intent({ type: 'move', uid: selected, x, y });
    } else {
      select(occupant && occupant.uid !== selected ? occupant.uid : null);
    }
  });

  // Drag and drop (desktop). Click-to-select-then-click works everywhere.
  // Drag: a board troop ("unit:<uid>") onto a square to move/combine, or onto the
  // shop to sell; a shop card ("shop:<slot>") onto a square to buy it there.
  document.addEventListener('dragstart', (e) => {
    const unit = e.target.closest?.('.unit[data-uid]');
    const card = e.target.closest?.('.card[data-slot]');
    if (!canPlan() || (!unit && !card) || card?.disabled) return e.preventDefault();
    e.dataTransfer.setData('text/plain', unit ? `unit:${unit.dataset.uid}` : `shop:${card.dataset.slot}`);
    e.dataTransfer.effectAllowed = 'move';
    // Don't re-render mid-drag or the drag is cancelled.
    if (unit) { selected = +unit.dataset.uid; buying = null; } else { buying = +card.dataset.slot; selected = null; }
    renderInfo();
  });
  const dropTarget = (el, onDrop) => {
    el.addEventListener('dragover', (e) => { if (canPlan()) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const [kind, id] = e.dataTransfer.getData('text/plain').split(':');
      if (kind && id !== undefined) onDrop(e, kind, +id);
    });
  };
  dropTarget(arena, (e, kind, id) => {
    const cell = cellAt(e);
    if (!cell || cell.vy < HALF) return;
    if (kind === 'shop') buyAt(id, cell.vx, cell.vy - HALF);
    else intent({ type: 'move', uid: id, x: cell.vx, y: cell.vy - HALF });
  });
  dropTarget($('shop-wrap'), (e, kind, id) => { if (kind === 'unit') intent({ type: 'sell', uid: id }); });

  shopEl.addEventListener('click', (e) => {
    const info = e.target.closest('[data-info]');
    if (info) { e.stopPropagation(); return openInfo(me().shop[+info.dataset.info]); }
    const card = e.target.closest('.card[data-slot]');
    if (card && !card.disabled) pickShop(+card.dataset.slot);
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
    if (e.target.closest('#info-close')) return closeInfo();
    if (e.target.id === 'sell' && selected !== null) { closeInfo(); intent({ type: 'sell', uid: selected }); }
    e.target.closest('.ability')?.classList.toggle('open'); // phones clamp it to two lines
  });
  sheetBackdrop.addEventListener('click', () => closeInfo());
  hudEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn?.id === 'open-dex') openDex();
    if (btn?.id === 'open-menu') openMenu();
  });
  menuEl.addEventListener('click', (e) => {
    if (e.target === menuEl) return closeMenu();
    const btn = e.target.closest('button[data-menu]');
    if (!btn) return;
    const action = btn.dataset.menu;
    if (action === 'close') closeMenu();
    else if (action === 'dex') { closeMenu(); openDex(); }
    else if (action === 'new-confirmed') { closeMenu(); onNewGame(); }
    else openMenu(action); // 'main', 'help', 'new'
  });
  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'open-dex') return openDex();
    if (e.target.id === 'continue') { e.target.disabled = true; onIntent({ type: 'continue' }); }
    if (e.target.id === 'play-again') onNewGame();
    if (state?.phase !== 'team' || me().ready) return;
    const troop = e.target.closest('[data-pick-troop]');
    if (troop) {
      const id = troop.dataset.pickTroop;
      if (draft.troops.includes(id)) draft.troops = draft.troops.filter((t) => t !== id);
      else if (draft.troops.length < teamSize(catalog)) draft.troops = [...draft.troops, id];
      else toast(`Your team is full. Remove a Pokémon first.`);
    }
    if (e.target.id === 'start-team') {
      const res = onIntent({ type: 'chooseTeam', troops: draft.troops });
      if (res?.ok) return;
    }
    if (troop) showTeamBuilder();
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
    if (!dexEl.hidden) { if (key === 'escape' || key === 'p') closeDex(); return; }
    if (!menuEl.hidden) { if (key === 'escape' || key === 'm') closeMenu(); return; }
    if (peek && key === 'escape') return closeInfo();
    if (key === 'p') openDex();
    else if (key === 'm') openMenu();
    else if (key === 'd' && canPlan()) intent({ type: 'reroll' });
    else if (key === 'f' && canPlan()) intent({ type: 'ready' });
    else if (key === 'e' && canPlan() && selected !== null) intent({ type: 'sell', uid: selected });
    else if (key === 'escape' && state.phase === 'planning') select(null);
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
      buying = null;
      // With exactly a team's worth of troops available, start with all of them picked.
      draft = { troops: troopIds(catalog).length === teamSize(catalog) ? troopIds(catalog) : [] };
    }
    state = next;
    if (selected !== null && !owned(selected)) selected = null;
    if (buying !== null && !me().shop[buying]) buying = null;
    renderHud();

    if (state.phase === 'combat') {
      renderShop();
      if (playedRound !== state.combat.round) startPlayback();
      else if (!playback) showResult();
      return;
    }
    overlay.hidden = true;
    renderPlanning();
    if (state.phase === 'team') showTeamBuilder();
    if (state.phase === 'gameover') showGameOver();
  }

  function hpBox(p, side) {
    const pct = Math.max(0, p.hp);
    return `<div class="hpbox ${side}" title="${esc(p.name)}: ${p.hp} HP">
      ${side === 'ally' ? `<span class="name">${esc(p.name)}</span>` : `<b>${p.hp}</b>`}
      <div class="hpbar"><i style="width:${pct}%"></i></div>
      ${side === 'ally' ? `<b>${p.hp}</b>` : `<span class="name">${esc(p.name)}</span>`}
    </div>`;
  }

  const ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const ICON_DEX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M3 12h6m6 0h6"/><circle cx="12" cy="12" r="3"/></svg>';

  function renderHud() {
    const p = me();
    const coinsChanged = shownCoins !== null && shownCoins !== p.coins;
    shownCoins = p.coins;
    hudEl.innerHTML = `
      <span class="chip"><span class="label">Round</span><b>${state.round || '–'}</b></span>
      <span class="chip coins" title="Win a battle: +${WIN_COINS}. Lose: +${LOSS_COINS}. Coins carry over."><b class="gold${coinsChanged ? ' bump' : ''}">${p.coins}</b></span>
      <span class="chip" title="Free rerolls. +1 each round, up to ${MAX_REROLLS}."><span class="label">Rerolls</span><b>${p.rerolls}/${MAX_REROLLS}</b></span>
      <div class="duel">${hpBox(p, 'ally')}<span class="vs">VS</span>${hpBox(foe(), 'enemy')}</div>
      <div class="hud-actions">
        <button id="open-dex" class="icon-btn dex-button" title="Every Pokémon's stats (P)">${ICON_DEX}<span class="label-text">Pokédex</span></button>
        <button id="open-menu" class="icon-btn" title="Menu (M)" aria-label="Menu">${ICON_MENU}<span class="label-text">Menu</span></button>
      </div>`;
  }

  // ---- menu ------------------------------------------------------------------

  function openMenu(view = 'main') {
    const panel = menuEl.querySelector('.menu-panel');
    panel.classList.toggle('help', view === 'help');
    const close = '<button class="menu-close ghost" data-menu="close" aria-label="Close">✕</button>';
    const back = '<button class="back ghost" data-menu="main">← Back</button>';
    if (view === 'help') {
      panel.innerHTML = `${close}${back}<h1>How to play</h1>
        <ul class="help-list">
          <li><b>Build a team</b> of ${teamSize(catalog)} Pokémon. Each puts ${COPIES_PER_TROOP} copies into your own pool, and your shop draws from it. Your board starts empty.</li>
          <li><b>Buy</b>: tap a shop card, then a square on your half (or drag the card onto the board).</li>
          <li><b>Level up</b>: each Pokémon can be on the board only once. Buying another copy levels it up: 2 copies = ★, 3 = ★★, 4 = ★★★.</li>
          <li><b>Position</b>: the row nearest the middle is your front line. Tap a Pokémon, then a square, to move it (onto another Pokémon swaps them).</li>
          <li><b>Sell</b>: drag a Pokémon onto the shop, or tap it and press Sell. Its copies go back to your pool.</li>
          <li><b>Fight</b>: the battle plays out by itself. After 30 seconds, sudden death drains everyone until one side falls.</li>
          <li><b>Powers</b>: every Pokémon has one; the blue bar under it fills with each attack. See them all in the Pokédex.</li>
          <li><b>Scouting</b>: from round 2, the faded Pokémon on the enemy side show where your opponent placed theirs last round.</li>
          <li><b>Coins</b>: you start with 6. Win a battle: +${WIN_COINS}. Lose: +${LOSS_COINS}. Coins carry over.</li>
          <li><b>Rerolls</b> are free: ${MAX_REROLLS} to start, +1 each round (max ${MAX_REROLLS}). The shop refreshes after every battle.</li>
          <li><b>Win</b> by bringing your opponent from 100 HP to 0. The loser of a battle loses HP for every Pokémon still standing.</li>
        </ul>
        <p class="muted">Keys: <kbd>D</kbd> reroll · <kbd>F</kbd> fight · <kbd>E</kbd> sell · <kbd>Space</kbd> skip · <kbd>P</kbd> Pokédex · <kbd>M</kbd> menu</p>`;
    } else if (view === 'new') {
      panel.innerHTML = `${close}<h1>New game?</h1>
        <p class="muted">This match will be lost.</p>
        <div class="confirm-row"><button data-menu="main">Keep playing</button><button class="danger" data-menu="new-confirmed">Start a new game</button></div>`;
    } else {
      panel.innerHTML = `${close}<h1>Menu</h1>
        <div class="menu-list">
          <button data-menu="close"><span>▶</span><div>Resume</div></button>
          <button data-menu="help"><span>?</span><div>How to play<small>Rules, controls and keys</small></div></button>
          <button data-menu="dex"><span>◎</span><div>Pokédex<small>Every Pokémon's stats and power</small></div></button>
          <button data-menu="new"><span>↻</span><div>New game<small>Start over with a new team</small></div></button>
        </div>`;
    }
    menuEl.hidden = false;
    panel.querySelector('button:not(.menu-close)')?.focus();
  }

  function closeMenu() {
    menuEl.hidden = true;
  }

  // Phones: Pokémon details open as a pop-up sheet over the game (the layout
  // never changes size). On wide screens the panel beside the board shows them.
  function openInfo(unitId) {
    if (!unitId) return;
    peek = unitId;
    renderInfo();
    appEl.classList.add('info-open');
    sheetBackdrop.hidden = false;
  }

  function closeInfo() {
    if (!peek) return;
    peek = null;
    appEl.classList.remove('info-open');
    sheetBackdrop.hidden = true;
    renderInfo();
  }

  function renderPlanning() {
    arena.classList.remove('in-combat', 'sudden-death');
    controls.hidden = true;
    const draggable = canPlan();
    const buyingId = buying !== null ? me().shop[buying] : null;
    arena.classList.toggle('buying', !!buyingId);

    // The opponent's lineup from last round, faded, on their half: a hint for
    // where to place your own Pokémon. Their current board stays hidden.
    const foeSide = 1 - viewer;
    const ghosts = state.phase === 'planning' ? foe().lastBoard ?? [] : [];
    // While buying, the hint shows on the board itself, so nothing else moves.
    const levelling = buyingId ? fielded(me(), buyingId) : null;
    $('enemy-label').textContent = buyingId
      ? (levelling ? `Tap your side to level up ${catalog[buyingId].name}` : 'Tap a square on your side')
      : ghosts.length ? 'Enemy lineup last round' : 'Enemy side';
    arena.classList.toggle('has-ghosts', ghosts.length > 0 || !!buyingId);
    arena.classList.toggle('hinting', !!buyingId);
    const ghostEls = ghosts.map((u) => {
      const el = unitEl(u.unitId, u.star, 'enemy', 'down');
      el.classList.add('ghost');
      el.title = `${catalog[u.unitId].name} (last round)`;
      const c = toCombatPos(foeSide, u.x, u.y);
      const v = viewPos(c.x, c.y);
      place(el, v.x, v.y);
      return el;
    });

    const fresh = state.round !== seenUids.round;
    if (fresh) seenUids = Object.assign(new Set(), { round: state.round });
    layer.replaceChildren(...ghostEls, ...me().board.map((u) => {
      const el = unitEl(u.unitId, u.star);
      // Newly bought (or levelled up): drop onto the board with a bounce.
      const key = `${u.uid}:${u.star}`;
      if (!seenUids.has(key)) { if (!fresh) el.classList.add('dropped'); seenUids.add(key); }
      el.dataset.uid = u.uid;
      el.draggable = draggable;
      el.classList.toggle('selected', u.uid === selected);
      if (u.uid === selected) el.insertAdjacentHTML('beforeend', '<span class="info-btn unit-info" data-unit-info role="button" aria-label="Info">i</span>');
      // Highlight the troop the picked shop copy would level up.
      el.classList.toggle('combine-target', u.unitId === buyingId);
      place(el, u.x, u.y + HALF);
      return el;
    }));

    renderShop();
    renderInfo();
  }

  function renderShop() {
    const p = me();
    // A new round or a reroll deals the cards in; buying one doesn't.
    const deal = `${state.round}|${p.rerolls}|${state.phase}`;
    const dealt = deal !== shownShop && state.phase === 'planning';
    shownShop = deal;
    shopEl.innerHTML = p.shop.map((id, slot) => {
      if (!id) return `<button class="card empty" disabled><span>${state.phase === 'planning' ? 'Bought' : ''}</span></button>`;
      const def = catalog[id];
      const disabled = !canPlan() || p.coins < def.cost;
      return `<button class="card${slot === buying ? ' buying' : ''}${dealt ? ' dealt' : ''}" style="--i:${slot}" data-slot="${slot}" data-type="${def.type}" ${disabled ? 'disabled' : 'draggable="true"'}>
        ${def.sprite
          ? `<span class="portrait" data-facing="down"><span class="sprite" ${spriteStyle(def)}></span></span>`
          : `<span class="emoji">${def.emoji}</span>`}
        <span class="name">${esc(def.name)}</span>
        <span class="type">${def.type}</span>
        <span class="cost c${def.cost}" title="${def.cost} coins">${def.cost}</span>
        <span class="info-btn" data-info="${slot}" role="button" aria-label="${esc(def.name)} info">i</span>
        ${fielded(p, id) ? `<span class="levelup">Level up ${'★'.repeat(fielded(p, id).star) || '0★'}→${'★'.repeat(fielded(p, id).star + 1)}</span>` : ''}
        <span class="left">${p.pool[id]} left in pool</span>
      </button>`;
    }).join('');
    rerollBtn.textContent = p.rerolls > 0 ? `Reroll (${p.rerolls} left)` : 'No rerolls left';
    rerollBtn.disabled = !canPlan() || p.rerolls <= 0;
    readyBtn.disabled = !canPlan();
    readyBtn.textContent = state.phase === 'planning' && p.ready ? 'Waiting for opponent…' : 'Fight!';
  }

  function portrait(def) {
    return `<span class="portrait" data-facing="down"><span class="sprite" ${spriteStyle(def)}></span></span>`;
  }

  function poolList() {
    const p = me();
    if (!p.team.length) return '';
    const pips = (n) => `<span class="pips" title="${n} of ${COPIES_PER_TROOP} copies left">${Array.from({ length: COPIES_PER_TROOP }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
    return `<h2 class="pool-title"><span>Your pool</span><span>${poolSize(p)} left</span></h2>
      <ul class="pool-list">${p.team.map((id) => `
        <li data-type="${catalog[id].type}">${portrait(catalog[id])}
          <span>${esc(catalog[id].name)}</span>
          ${pips(p.pool[id])}</li>`).join('')}
      </ul>`;
  }

  function renderInfo() {
    const sel = selected !== null ? owned(selected) : null;
    // The pop-up shows exactly what its ⓘ was tapped on.
    const inst = peek ? (sel?.unitId === peek ? sel : null) : sel;
    const shopId = peek ? (inst ? null : peek) : buying !== null ? me().shop[buying] : null;
    const unitId = peek ?? inst?.unitId ?? shopId ?? hovered;
    if (!unitId) {
      appEl.classList.add('info-idle');
      infoEl.innerHTML = `${state.phase === 'planning' ? `<p class="tip">${me().board.length ? 'Tap a Pokémon to see its stats or move it. Tap a shop card, then a square, to buy.' : 'Tap a shop card, then a square on your side, to place your first Pokémon.'}</p>` : ''}
        ${poolList()}`;
      return;
    }
    appEl.classList.remove('info-idle');
    const def = catalog[unitId];
    const star = inst?.star ?? 0;
    const stats = unitStats(def, star);
    const copies = inst ? copiesOf(inst) : 1;
    const onBoard = shopId && !inst ? fielded(me(), shopId) : null;
    const hint = !shopId || inst || peek ? ''
      : onBoard
        ? `<p class="hint">You already have a ${esc(def.name)} on the board. Click anywhere on your side to level it up to ${'★'.repeat(onBoard.star + 1)}.</p>`
        : '<p class="hint">Click an empty square on your side to place it.</p>';
    infoEl.innerHTML = `
      <button id="info-close" class="ghost" aria-label="Close">✕</button>
      <div class="info-head" data-type="${def.type}">
        ${portrait(def)}
        <div><h2>${esc(def.name)} <span class="stars s${star}">${'★'.repeat(star)}</span></h2>
        <span class="sub">${def.type} · ${def.cost} coins · ${copies}/${COPIES_PER_TROOP} copies</span></div>
      </div>
      ${hint}
      <dl class="stats">
        <dt>HP</dt><dd>${show(stats.hp)}</dd>
        <dt>Damage per hit</dt><dd>${show(stats.atk)}</dd>
        <dt>Attacks every</dt><dd>${attackTime(stats)}s</dd>
        <dt>Crit chance</dt><dd>${stats.crit}%</dd>
        <dt>DPS</dt><dd>${dps(stats)}</dd>
        <dt>Range</dt><dd>${def.range}</dd>
        <dt>Movement</dt><dd>${SPEED_NAME[def.moveSpeed]}</dd>
      </dl>
      ${def.ability ? `<p class="ability"><b>${esc(def.ability.name)}:</b> ${describePower(def, star, catalog)}</p>` : ''}
      ${inst && canPlan()
        ? `<button id="sell" class="danger">Sell for ${sellValue(catalog, inst)} coins (${copies} ${copies === 1 ? 'copy' : 'copies'} back to pool)</button>` : ''}`;
  }

  // ---- combat playback -----------------------------------------------------

  function startPlayback() {
    const { result } = state.combat;
    playedRound = state.combat.round;
    selected = null;
    overlay.hidden = true;
    arena.classList.add('in-combat');
    arena.classList.remove('sudden-death', 'buying', 'has-ghosts', 'hinting');
    closeInfo();
    buying = null;
    setClock(0);
    controls.hidden = false;
    renderInfo();

    const actors = new Map();
    layer.replaceChildren();
    const addActor = (u) => {
      const ally = u.side === viewer;
      const a = { ...u, shield: 0, stunUntil: 0, el: unitEl(u.unitId, u.star, ally ? 'ally' : 'enemy', ally ? 'up' : 'down') };
      const p = viewPos(u.x, u.y);
      place(a.el, p.x, p.y);
      layer.append(a.el);
      actors.set(u.id, a);
      bars(a);
      return a;
    };
    for (const u of result.initial) addActor(u);

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
    const ctx = { actors, addActor, later, srcDelay: new Map(), hitDelay: new Map(), action: new Map() };

    const advance = (animate) => {
      tick++;
      setClock(tick);
      ctx.srcDelay.clear();
      ctx.hitDelay.clear();
      while (next < events.length && events[next].t <= tick) { applyEvent(ctx, events[next], next, animate); next++; }
      for (const a of actors.values()) {
        if (a.stunUntil && tick >= a.stunUntil) { a.stunUntil = 0; a.el.classList.remove('stunned'); }
        if (a.stealthUntil && tick >= a.stealthUntil) { a.stealthUntil = 0; a.el.classList.remove('stealthed'); }
        if (a.hasteUntil && tick >= a.hasteUntil) { a.hasteUntil = 0; a.el.classList.remove('hasted'); }
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

  // Countdown to sudden death, then a banner.
  function setClock(tick) {
    const left = Math.max(0, Math.ceil((SUDDEN_DEATH_TICK - tick) * TICK_SECONDS));
    clockEl.textContent = tick >= SUDDEN_DEATH_TICK ? 'SUDDEN DEATH' : `0:${String(left).padStart(2, '0')}`;
    clockEl.classList.toggle('sudden', tick >= SUDDEN_DEATH_TICK);
  }

  function bars(a) {
    a.el.querySelector('.hp i').style.width = `${(100 * a.hp) / a.maxHp}%`;
    a.el.querySelector('.hp').style.setProperty('--hp-trail', `${(100 * a.hp) / a.maxHp}%`);
    a.el.querySelector('.hp b').style.width = `${Math.min(100, (100 * a.shield) / a.maxHp)}%`;
    a.el.querySelector('.mana i').style.width = `${a.maxMana ? (100 * a.mana) / a.maxMana : 0}%`;
  }

  function floatText(a, text, kind) {
    const el = document.createElement('div');
    el.className = `float ${kind}`;
    el.textContent = text;
    el.style.setProperty('--jx', `${Math.round((Math.random() - 0.5) * 50)}%`);
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

  // Add an animation class for `ms`, restarting it if it's already playing.
  // Body animations replace each other, so a new move cancels the previous one.
  const BODY_ANIMS = ['hop', 'lunge', 'shoot', 'cast-strike', 'cast-channel', 'cast-charge', 'cast-slam'];
  function play(el, cls, ms) {
    if (BODY_ANIMS.includes(cls)) el.classList.remove(...BODY_ANIMS.filter((c) => c !== cls));
    pulse(el, cls);
    el.timers ??= {};
    clearTimeout(el.timers[cls]);
    el.timers[cls] = setTimeout(() => el.classList.remove(cls), ms);
  }

  // Which body animation a power uses, and when (ms at 1x) its hit lands
  // within that animation, so damage and effects line up with the motion.
  function powerMotion(p, ranged) {
    if (p.knockback) return { cls: 'cast-slam', ms: 600, impact: 510 };
    if (p.kind === 'empower') return { cls: 'cast-strike', ms: 500, impact: 325 };
    if (p.kind === 'snipe') return { cls: 'cast-charge', ms: 500, impact: 250 };
    return { cls: 'cast-channel', ms: 550, impact: 275 };
  }

  const flightMs = (from, to) => Math.max(160, 90 * Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))) / speed;

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
    const ms = flightMs(from, to);
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
    if (ev.type === 'suddenDeath') { arena.classList.add('sudden-death'); return; }
    const a = actors.get(ev.id);
    if (!a) return;
    const newest = () => { if (idx < (a.seq ?? -1)) return false; a.seq = idx; return true; };
    // Power progress has its own guard: a hit that lands late (after a projectile's
    // flight) must not roll the bar back past attacks made since it was fired.
    const setMana = (m) => { if (idx < (a.manaSeq ?? -1)) return; a.manaSeq = idx; a.mana = m; };
    const at = () => viewPos(a.x, a.y);
    switch (ev.type) {
      case 'move': {
        const from = viewPos(a.x, a.y);
        a.x = ev.x;
        a.y = ev.y;
        const p = viewPos(a.x, a.y);
        face(a, p.x - from.x, p.y - from.y);
        place(a.el, p.x, p.y);
        if (animate) {
          // Hop to the next square over the unit's whole move time, leaning into
          // the move; the walk cycle plays only while it's moving, and a little
          // dust puffs up where it lands.
          const hopMs = (unitStats(catalog[a.unitId], 0).moveCd * TICK_MS) / speed;
          a.el.style.setProperty('--mx', Math.sign(p.x - from.x));
          play(a.el, 'hop', hopMs);
          play(a.el, 'moving', hopMs);
          setTimeout(() => { if (a.el.isConnected && !a.el.classList.contains('dead')) fx(p.x, p.y, 'dust', '#fff', 1); }, hopMs * 0.85);
        }
        break;
      }
      case 'attack': {
        setMana(ev.mana);
        bars(a);
        ctx.action.set(a.id, 'attack');
        if (!animate) break;
        const t = actors.get(ev.target);
        const from = viewPos(a.x, a.y);
        const to = viewPos(t.x, t.y);
        a.el.style.setProperty('--dx', Math.sign(to.x - from.x));
        a.el.style.setProperty('--dy', Math.sign(to.y - from.y));
        face(a, to.x - from.x, to.y - from.y);
        if (rangeOf(a) > 1) {
          play(a.el, 'shoot', 260 / speed);
          ctx.srcDelay.set(a.id, projectile(from, to, fxColor(a.unitId), false));
        } else {
          play(a.el, 'lunge', 300 / speed);
          ctx.srcDelay.set(a.id, 165 / speed); // the hit lands at the end of the dash
        }
        break;
      }
      case 'cast': {
        setMana(0);
        bars(a);
        ctx.action.set(a.id, 'cast');
        if (!animate) break;
        const p = catalog[a.unitId].ability;
        const ranged = rangeOf(a) > 1;
        const from = viewPos(a.x, a.y);
        const t = actors.get(ev.target);
        // The opening wave flies to its target, or to the end of the column if it misses.
        const to = t ? viewPos(t.x, t.y) : ev.x !== undefined ? viewPos(ev.x, ev.y) : null;
        const motion = powerMotion(p, ranged);
        play(a.el, motion.cls, motion.ms / speed);
        floatText(a, p.name, 'cast');
        const color = fxColor(a.unitId);
        if (!to) { fx(from.x, from.y, 'ring', color, 1.6); break; } // self buffs and summons
        a.el.style.setProperty('--dx', Math.sign(to.x - from.x));
        a.el.style.setProperty('--dy', Math.sign(to.y - from.y));
        face(a, to.x - from.x, to.y - from.y);
        // Ranged powers launch their orb at the peak of the wind-up; melee ones
        // hit at the moment of contact.
        const windup = motion.impact / speed;
        if (p.kind === 'opening') {
          // The wave flies the whole column to the far end of the board. The
          // Pokémon it hits rides it there, and anyone at the end is pushed
          // aside as it arrives.
          const end = viewPos(ev.x, ev.y);
          const arrive = windup + flightMs(from, end);
          const hit = t ? windup + flightMs(from, to) : arrive;
          later(windup, () => projectile(from, end, color, true));
          ctx.srcDelay.set(a.id, hit);
          if (t) later(hit, () => fx(to.x, to.y, 'burst', color, 1.6));
          later(arrive, () => fx(end.x, end.y, 'ring', color, 1.4));
          ctx.wave = { target: ev.target, hit, arrive };
          break;
        }
        const flight = p.kind === 'snipe' ? flightMs(from, to) : 0;
        if (flight) later(windup, () => projectile(from, to, color, true));
        ctx.srcDelay.set(a.id, windup + flight);
        if (t) later(windup + flight, () => fx(to.x, to.y, p.kind === 'snipe' ? 'zap' : 'burst', color, 1.6));
        break;
      }
      case 'summon': {
        const pal = ctx.addActor(ev.unit);
        if (animate) { play(pal.el, 'spawned', 400); const p = viewPos(pal.x, pal.y); fx(p.x, p.y, 'ring', fxColor(pal.unitId), 1.3); }
        break;
      }
      case 'knock': {
        a.x = ev.x;
        a.y = ev.y;
        const p = viewPos(ev.x, ev.y);
        const wave = animate && ev.t === 1 ? ctx.wave : null;
        if (wave && wave.target === a.id) {
          // Carried by Psywave: slides with the wave from the hit to the far end.
          later(wave.hit, () => {
            a.el.style.transition = `left ${wave.arrive - wave.hit}ms linear, top ${wave.arrive - wave.hit}ms linear`;
            place(a.el, p.x, p.y);
            play(a.el, 'knocked', wave.arrive - wave.hit);
            setTimeout(() => { a.el.style.transition = ''; }, wave.arrive - wave.hit);
          });
          break;
        }
        // Thrown by a hit: lands when the hit does (or, pushed aside by the wave, when it arrives).
        const delay = !animate ? 0 : wave ? wave.arrive : ctx.hitDelay.get(a.id) ?? 0;
        later(delay, () => { place(a.el, p.x, p.y); if (animate) play(a.el, 'knocked', 350 / speed); });
        break;
      }
      case 'teleport': {
        const from = viewPos(a.x, a.y);
        a.x = ev.x;
        a.y = ev.y;
        const p = viewPos(a.x, a.y);
        if (animate) { fx(from.x, from.y, 'burst', fxColor(a.unitId), 1.2); play(a.el, 'blink', 250 / speed); }
        place(a.el, p.x, p.y);
        break;
      }
      case 'stealth':
        a.stealthUntil = ev.t + ev.duration;
        a.el.classList.add('stealthed');
        break;
      case 'haste':
        a.hasteUntil = ev.t + ev.duration;
        a.el.classList.add('hasted');
        break;
      case 'damage': {
        const delay = animate ? ctx.srcDelay.get(ev.src) ?? 0 : 0;
        if (delay) ctx.hitDelay.set(a.id, delay);
        const src = actors.get(ev.src);
        later(delay, () => {
          if (newest()) {
            a.hp = ev.hp;
            a.shield = ev.shield;
            setMana(ev.mana);
            bars(a);
          }
          if (!animate) return;
          floatText(a, ev.crit ? `-${show(ev.amount)}!` : `-${show(ev.amount)}`, ev.crit ? 'dmg crit' : 'dmg');
          // Flinch away from whoever hit it.
          if (src) {
            const s = viewPos(src.x, src.y);
            const me = at();
            a.el.style.setProperty('--hx', Math.sign(me.x - s.x));
            a.el.style.setProperty('--hy', Math.sign(me.y - s.y));
          }
          play(a.el, 'hit', ev.crit ? 200 : 140);
          if (src && rangeOf(src) <= 1 && ctx.action.get(src.id) === 'attack') fx(at().x, at().y, 'slash', fxColor(src.unitId));
        });
        break;
      }
      case 'drain': // sudden death: everyone loses the same HP each tick
        if (newest()) { a.hp = ev.hp; bars(a); }
        break;
      case 'heal':
        if (newest()) { a.hp = ev.hp; bars(a); }
        if (animate && ev.amount) { floatText(a, `+${show(ev.amount)}`, 'heal'); fx(at().x, at().y, 'heal', '#5be38a', 1.3); }
        break;
      case 'shield':
        a.shield = ev.shield;
        bars(a);
        if (animate) { floatText(a, `+${show(ev.amount)}`, 'shield'); fx(at().x, at().y, 'shield', '#ffffff', 1.3); }
        break;
      case 'stun':
        a.stunUntil = ev.t + ev.duration;
        later(ctx.hitDelay.get(a.id) ?? 0, () => a.el.classList.add('stunned'));
        break;
      case 'death':
        later(ctx.hitDelay.get(a.id) ?? 0, () => {
          a.el.classList.add('dead');
          if (animate) { const p = at(); setTimeout(() => fx(p.x, p.y, 'poof', '#fff', 1.3), 250 / speed); }
        });
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
      ? `Both teams were knocked out at the same moment. Both players take ${damage[viewer]} damage.`
      : won
        ? `${result.survivors.length} of your units survived. ${esc(foe().name)} takes ${damage[1 - viewer]} damage.`
        : `${result.survivors.length} enemy units survived. You take ${damage[viewer]} damage.`;
    const hpAfter = Math.max(0, me().hp - damage[viewer]);
    showOverlay(`
      <h1 class="${draw ? '' : won ? 'win' : 'loss'}">${title}</h1>
      <p>${detail}</p>
      <p class="muted">Round ${round} · Your HP ${me().hp} → ${hpAfter} · +${won ? WIN_COINS : LOSS_COINS} coins</p>
      ${me().ready
        ? '<button disabled>Waiting for opponent…</button>'
        : '<button id="continue" class="primary" autofocus>Continue</button>'}`);
    overlay.querySelector('#continue')?.focus();
  }

  function teamCard(id, picked) {
    const def = catalog[id];
    const stats = unitStats(def, 0);
    return `<button class="leader-card${picked ? ' chosen' : ''}" data-pick-troop="${id}" data-type="${def.type}" ${me().ready ? 'disabled' : ''}>
      ${portrait(def)}
      <b>${esc(def.name)}</b>
      <span class="muted">${def.cost} coins · ${def.range > 1 ? `Ranged (${def.range})` : 'Melee'} · ${show(stats.hp)} HP · ${show(stats.atk)} dmg every ${attackTime(stats)}s</span>
      <small><b>${esc(def.ability.name)}:</b> ${describePower(def, 0, catalog)}</small>
    </button>`;
  }

  function showTeamBuilder() {
    const need = teamSize(catalog);
    const waiting = me().ready;
    const ready = draft.troops.length === need;
    showOverlay(`
      <h1>Build your team</h1>
      <p class="muted">Pick ${need} Pokémon. Each one adds ${COPIES_PER_TROOP} copies to your pool, and your shop draws from it. Your board starts empty. <button id="open-dex" class="linkish">Compare them in the Pokédex</button></p>
      <h2 class="pick-title">Team ${draft.troops.length}/${need}</h2>
      <div class="pick-grid">${troopIds(catalog).map((id) => teamCard(id, draft.troops.includes(id))).join('')}</div>
      ${waiting
        ? '<p class="muted">Waiting for opponent…</p>'
        : `<button id="start-team" class="primary" ${ready ? '' : 'disabled'}>${ready ? 'Start match' : `Pick ${need - draft.troops.length} more`}</button>`}`);
  }

  function showGameOver() {
    const title = state.winner === viewer ? 'You win the match! 🏆' : state.winner === null ? 'Double knockout. It\'s a draw.' : 'You were eliminated';
    showOverlay(`
      <h1 class="${state.winner === viewer ? 'win' : 'loss'}">${title}</h1>
      <p>The match lasted ${state.round} rounds. Final HP: ${me().hp} vs ${foe().hp}.</p>
      <button id="play-again" class="primary">Play again</button>`);
  }

  // ---- Pokédex ---------------------------------------------------------------
  // Every Pokémon's stats, read straight from units.json, so new Pokémon and
  // stat changes show up here automatically.

  dexEl.addEventListener('click', (e) => {
    if (e.target === dexEl || e.target.closest('#dex-close')) return closeDex();
    const pick = e.target.closest('[data-dex]');
    if (pick) { dexPick = pick.dataset.dex; renderDex(); }
  });

  function openDex(id) {
    dexPick = id ?? dexPick ?? troopIds(catalog)[0];
    renderDex();
    dexEl.hidden = false;
  }

  function closeDex() {
    dexEl.hidden = true;
  }

  function renderDex() {
    const list = (ids, title) => `<h3>${title}</h3><div class="dex-list">${ids.map((id) => {
      const def = catalog[id];
      return `<button class="dex-entry${id === dexPick ? ' active' : ''}" data-dex="${id}" data-type="${def.type}">
        ${portrait(def)}<span>${esc(def.name)}</span><small>${def.summon ? 'summon' : `${def.cost} 🪙`}</small></button>`;
    }).join('')}</div>`;
    const summons = Object.keys(catalog).filter((id) => catalog[id].summon).sort();
    const def = catalog[dexPick];
    const rows = [0, 1, 2, 3].map((star) => {
      const st = unitStats(def, star);
      return {
        star, hp: show(st.hp), dmg: show(st.atk), crit: show(Math.floor((st.atk * CRIT_PCT) / 100)), dps: dps(st),
        sup: powerDamage(def, star) === null ? '—' : show(powerDamage(def, star)),
      };
    });
    const col = (label, key) => `<tr><th>${label}</th>${rows.map((r) => `<td>${r[key]}</td>`).join('')}</tr>`;
    const stats0 = unitStats(def, 0);
    dexEl.querySelector('.dex-panel').innerHTML = `
      <button id="dex-close" class="ghost" aria-label="Close">✕</button>
      <h1>Pokédex</h1>
      <div class="dex-body">
        <nav class="dex-nav">${list(troopIds(catalog), 'Pokémon')}${summons.length ? list(summons, 'Summoned in battle') : ''}</nav>
        <section class="dex-detail" data-type="${def.type}">
          <div class="dex-hero">
            <span class="portrait dex-portrait" data-facing="down"><span class="sprite" ${spriteStyle(def)}></span></span>
            <div>
              <h2>${esc(def.name)}</h2>
              <p class="dex-tags">
                <span>${def.summon ? 'Summoned' : `${def.cost} coins`}</span>
                <span>${def.range > 1 ? `Ranged · ${def.range} tiles` : 'Melee · 1 tile'}</span>
                <span>Moves: ${moveText(def)}</span>
                <span>Attacks every ${attackTime(stats0)}s</span>
                <span>Crit ${stats0.crit}%</span>
                <span>${powerCadence(def)}</span>
              </p>
            </div>
          </div>
          <table class="dex-table">
            <thead><tr><th></th>${rows.map((r) => `<th>${r.star ? '★'.repeat(r.star) : '0★'}</th>`).join('')}</tr></thead>
            <tbody>
              ${col('HP', 'hp')}
              ${col('Damage per hit', 'dmg')}
              ${col('Crit damage', 'crit')}
              ${col('DPS', 'dps')}
              ${def.ability ? col(`${esc(def.ability.name)} damage`, 'sup') : ''}
            </tbody>
          </table>
          <p class="muted">Copies on the board: 1 = 0★, 2 = ★, 3 = ★★, 4 = ★★★. A crit deals 50% more damage.</p>
          ${def.ability ? `<h3>Power: ${esc(def.ability.name)}</h3>
          <p>${describePower(def, 0, catalog)}</p>` : `<p>${esc(def.name)} can't be picked: it's summoned in battle.</p>`}
        </section>
      </div>`;
  }

  return { render, toast };
}
