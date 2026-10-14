// Rendering and input. The UI never mutates game state: it reads `state`,
// and turns clicks/drags into intents passed to `onIntent`. Combat is shown by
// replaying the event log from the combat result, never by re-simulating.

import { COLS, toCombatPos, MOVE_SPEEDS, ROWS, HALF, STAT_SCALE, SUDDEN_DEATH_TICK, STEP_TICKS, TICK_SECONDS, powerDamage, unitStats } from './combat.js';
import {
  COPIES_PER_TROOP, LOST_COIN, REROLL_COST, ROUND_COINS, START_COINS, lostCount,
  copiesOf, fielded, poolSize, sellValue, teamSize, troopIds,
} from './game.js';
import { AVATARS, NAME_MAX, avatarUrl, favouriteTroop } from './profile.js';

const TICK_MS = 100;
// Alcremie's treats: colour and the word that pops up on the Pokémon it treats.
const TREAT_COLOR = { heal: '#6fe08a', haste: '#ff7fae', guard: '#8fd2ff' };
const TREAT_TEXT = { heal: 'Sweet heal', haste: 'Attack speed up', guard: 'Shielded' }; // playback speed at 1x: one sim tick (0.1s of game time) per 100ms, i.e. real time
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
const SPEED_NAME = { 'very fast': 'Very fast', fast: 'Fast', medium: 'Medium', slow: 'Slow', 'very slow': 'Very slow', 'super slow': 'Super slow' };
const moveText = (def) => `${SPEED_NAME[def.moveSpeed]} (waits ${MOVE_SPEEDS[def.moveSpeed]}s between 0.5s steps)`;

// Level marks: ★, ★★, ★★★, then the shiny star for a full set of copies.
// `star` is the internal level (0-3).
export const LEVEL_NAMES = ['1 star', '2 stars', '3 stars', 'Shiny'];
export const levelMark = (star) => (star >= 3 ? '<span class="star-max" title="Shiny">✦</span>' : '★'.repeat(star + 1));
const levelSpan = (star) => `<span class="stars s${star}" aria-label="${LEVEL_NAMES[star]}">${levelMark(star)}</span>`;

// Internal combat numbers -> the design sheet's units.
const show = (v) => +(v / STAT_SCALE).toFixed(1);

// What a Pokémon's power does, in plain words, with numbers for this star
// level (no star given: the first level). Every power reads the same way: when
// it goes off, then what it does, with the important values coloured.
const vDmg = (x) => `<span class="v v-dmg">${x}</span>`;
const vTime = (ticks) => `<span class="v v-time">${secs(ticks)}s</span>`;
const vNum = (x) => `<span class="v">${x}</span>`;
const vHeal = (x) => `<span class="v v-heal">${x}</span>`;
const area = (r) => vNum(`${2 * r + 1}x${2 * r + 1}`);

export function powerText(def, star, catalog) {
  const p = def.ability;
  if (!p) return null;
  const lvl = star ?? 0;
  const dmg = powerDamage(def, lvl);
  const hit = p.damagePct ? `${vDmg(`${p.damagePct}%`)} damage (${vDmg(show(dmg))})` : '';
  const every = `Every ${def.energy} attacks`;
  switch (p.kind) {
    case 'empower': {
      if (p.dash) return { when: every, text: `Dashes in a straight line to the farthest enemy, immune to everything on the way, and hits it for ${hit}. The target and every enemy it passes through are stunned for ${vTime(p.stun)}.` };
      if (p.teleport) return { when: every, text: `Teleports next to the farthest enemy and hits it for ${hit}${p.lifestealPct ? `, healing for ${vHeal(`${p.lifestealPct}%`)} of the damage dealt` : ''}.` };
      const extra = [
        p.knockback && `knocks the target back ${vNum(p.knockback)} squares`,
        p.stun && `stuns ${p.knockback ? 'it' : 'the target'} for ${vTime(p.stun)}`,
        p.lifestealPct && `heals it for ${vHeal(`${p.lifestealPct}%`)} of the damage dealt`,
      ].filter(Boolean);
      return { when: every, text: `Its next attack hits for ${hit}${extra.length ? `${extra.length === 1 ? ' and ' : ', '}${extra.join(' and ')}` : ''}.` };
    }
    case 'bind': {
      const start = p.startCharged ? 'It starts the fight charged and refills' : 'Its power fills';
      return { when: `After ${def.energy} attacks`, text: `${start} after ${vNum(def.energy)} attacks, then waits until an enemy tries to move. Hoopa binds that Pokémon in place for ${vTime(p.duration)}: it can't walk, zip or dash, but it still attacks anything in range.${p.noRepeat ? ' It never binds the same Pokémon twice in a row.' : ''}${p.chargedForm ? ` While charged it becomes ${esc(p.chargedForm.name)}.` : ''}` };
    }
    case 'taunt': return { when: every, text: `Spreads its spores: the hardest-hitting enemy within the ${area(p.radius)} around it that is attacking someone else must attack ${esc(def.name)} for ${vTime(p.duration)}.` };
    case 'rage': return { when: 'Every attack', text: `Each attack in a row without moving makes it attack ${vNum(`${p.stackPct}%`)} faster, up to ${vNum(`${p.stackPct * p.maxStacks}%`)} after ${vNum(p.maxStacks)} attacks. Moving resets it.` };
    case 'darts': {
      const name = catalog?.[p.unit]?.name ?? p.unit;
      return { when: def.energy ? 'Both home + charged' : 'Both home', text: `With both ${name} at home${def.energy ? ` and its counter full (it starts full, then fills with ${vNum(def.energy)} attacks)` : ''}, its next action (an attack, or a step toward its target) fires them instead: one at each of the ${vNum(p.count)} farthest enemies${p.outside ? ` outside the ${area(p.outside)} around it (never at a Pokémon right next to it; with only one enemy that far, just one ${name} goes, and with none it attacks)` : ''}${p.impactDamage ? `, each hitting for ${vDmg(show(Math.round(p.impactDamage[lvl] * STAT_SCALE)))}` : p.impactPct ? `, each hitting for ${vDmg(`${p.impactPct}%`)} damage (${vDmg(show(Math.floor((def.damage[lvl] * STAT_SCALE * p.impactPct) / 100)))})` : ''}${p.impactStun ? ` and stunning it for ${vTime(p.impactStun)}` : ''}. Each ${p.displace ? 'crashes into its target, shoving it aside onto a square next to it, then stays' : 'lands beside its target'} and fights.${p.lure ? ` Its target stops attacking whoever it was and must attack the ${name} until it faints.` : ''} A ${name} that faints flies back (${vTime(Math.round(p.returnSec * 10))}). Until both are home, ${esc(def.name)} attacks normally. They come at ${esc(def.name)}'s level.` };
    }
    case 'boost': return { when: every, text: `Charges up the allies directly left, right, in front of and behind it: each gains ${vNum(`+${p.charges}`)} toward its power (Pokémon without a power counter don't benefit).` };
    case 'snipe': return { when: every, text: `The attack also zaps the farthest enemy for ${hit}.` };
    case 'summon': {
      const name = catalog?.[p.unit]?.name ?? p.unit;
      const n = (p.countByStar ?? [1, 1, 1, 1])[lvl];
      const level = p.summonStar !== undefined ? `They are always ${levelMark(p.summonStar)}.` : `They come at ${def.name}'s level.`;
      return { when: every, text: `Summons ${vNum(n)} ${name} beside it. ${level}` };
    }
    case 'stealth': return { when: every, text: `Turns invisible for ${vTime(p.duration)}${p.hastePct ? ` and attacks ${vNum(`${p.hastePct}%`)} faster` : ''}. Enemies can't target or follow it while it's invisible.` };
    case 'haste': return { when: every, text: `Attacks ${vNum(`${p.hastePct}%`)} faster for ${vTime(p.duration)}.` };
    case 'quake': return { when: every, text: `Shakes the whole board: every enemy takes ${hit}${p.stun ? ` and is stunned for ${vTime(p.stun)}` : ''}.` };
    case 'chill': return { when: 'Every attack', text: `Chills the target for ${vTime(p.duration)}: it attacks and moves ${vNum(`${p.slowPct}%`)} slower. Another hit restarts the timer.` };
    case 'splashHeal': {
      const where = p.radius ? `in the ${area(p.radius)} around its target` : 'directly left, right, above and below its target';
      return { when: 'Every attack', text: `Heals your Pokémon ${where} for ${vHeal(`${p.healPct}%`)} of its damage (${vHeal(show(Math.floor((def.damage[lvl] * STAT_SCALE * p.healPct) / 100)))}).` };
    }
    case 'selfdestruct': return { when: 'When knocked out', text: `Stays on its square for ${vTime(p.delay)}, then explodes: enemies in the ${area(p.radius)} around it take ${hit}.` };
    case 'copy': return { when: 'Always', text: `Walks to the nearest enemy and takes ${vTime(p.morph)} to transform into it, copying its HP, damage, attack speed, range and crit (not its power or movement). It keeps its share of HP and stands still while transformed. When that Pokémon faints, it turns back and walks to the next one.` };
    case 'transform': {
      const f = p.form;
      const when = p.trigger === 'knockedOut' ? 'When knocked out' : p.trigger === 'lowHp' ? `At ${p.hpPct}% HP` : every;
      const into = p.trigger === 'knockedOut' ? 'Instead of fainting, it transforms' : 'Transforms';
      const stats = `${f.hp ? `${vNum(show(Math.round(f.hp[lvl] * STAT_SCALE)))} HP, ` : ''}${vDmg(show(Math.round(f.damage[lvl] * STAT_SCALE)))} damage every ${vNum(`${f.secPerHit}s`)}, range ${vNum(f.range)}`;
      const morph = p.morph ? ` It takes ${vTime(p.morph)} and can't be hurt while it does.` : '';
      const wave = f.shockwave ? ` A shock wave stuns every enemy in the ${area(f.shockwave.radius)} around it for ${vTime(f.shockwave.stun)}.` : '';
      return { when, text: `${into} into ${f.name} for the rest of the fight: ${stats}${f.hp ? '' : ' (HP stays the same)'}.${morph}${wave}` };
    }
    case 'treat': {
      const fl = Object.fromEntries(p.flavors.map((f) => [f.flavor, f]));
      const heal = fl.heal && `<b>${esc(fl.heal.name.replace(/.*\((.*)\)/, '$1'))}</b> heals the ally with the lowest share of HP for ${vHeal(`${fl.heal.healPct}%`)} of its damage (${vHeal(show(Math.floor((def.damage[lvl] * STAT_SCALE * fl.heal.healPct) / 100)))}) over ${vTime(p.duration)}`;
      const haste = fl.haste && `<b>${esc(fl.haste.name.replace(/.*\((.*)\)/, '$1'))}</b> makes the hardest-hitting ally attack ${vNum(`${fl.haste.hastePct}%`)} faster for ${vTime(p.duration)}`;
      const guard = fl.guard && `<b>${esc(fl.guard.name.replace(/.*\((.*)\)/, '$1'))}</b> shields the ally most enemies are attacking for ${vTime(p.duration)}: ${vNum(`${fl.guard.guardPct}%`)} less damage, and the first stun or knockback only breaks the shield`;
      return { when: every, text: `Changes into a random flavour and treats one ally. ${[heal, haste, guard].filter(Boolean).join('. ')}.` };
    }
    case 'opening': return { when: 'At battle start', text: `Fires a wave down its column. The first enemy hit takes ${hit}, is carried to the far end of the board${p.stun ? ` and is stunned for ${vTime(p.stun)}` : ''}.` };
    default: return null;
  }
}

export function describePower(def, star, catalog) {
  const pt = powerText(def, star, catalog);
  return pt ? `<span class="pw-when">${pt.when}</span> ${pt.text}` : '';
}

// Ditto has no fighting stats of its own: it copies the nearest enemy's.
const isCopycat = (def) => def.ability?.kind === 'copy';

export function createUI({ catalog, viewer, onIntent, onNewGame, onLobby, onProfile = () => {}, onFriends = () => {}, getFriends = () => null, getLastLog = () => null, getProfile = () => ({ name: '', avatar: null, saved: false }), getLog, changelog = [], version = null, build = null }) {
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
  let dexPick = null; // unit id shown in the Pokédex entry
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
  let started = false; // past the start screen (it shows once, when the game loads)
  let online = false; // playing a friend (the menu offers Leave instead of New game)
  let lobbyView = null; // which online-lobby screen is showing, if any
  // What's new: the newest entry the player has opened, to flag unread updates.
  const SEEN_KEY = 'poke-tactics-seen-update';
  const latestUpdate = changelog[0]?.id ?? null;
  const seenUpdate = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
  const hasUnread = () => latestUpdate !== null && seenUpdate() !== latestUpdate;
  // "v0.6.1 · dev 79ad49f": the game version (newest What's new entry) and build.
  const channel = /\/builds\//.test(location.pathname) ? 'build' : /\/dev\//.test(location.pathname) ? 'dev' : null;
  const versionText = [version && `v${version}`, build && (channel ? `${channel} ${build}` : build)].filter(Boolean).join(' · ');
  let deadline = null; // online: when planning auto-locks (Date.now() ms), or null
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
  // A profile picture: the front-facing frame of a sprite sheet.
  const avatar = (id, cls = '') => `<span class="avatar ${cls}" style="background-image:url('${avatarUrl(id)}')" aria-hidden="true"></span>`;
  let profileDraft = null; // the profile screen's unsaved choices
  let menuView = null; // which menu screen is open
  let confirmRemove = null; // friend code whose Remove was tapped once

  function unitEl(unitId, star, side = 'ally', facing = 'down') {
    const def = catalog[unitId];
    const el = document.createElement('div');
    el.className = `unit ${side}${def.sprite ? ' sprite-unit' : ''}${def.summon ? ' summon' : ''}`;
    el.dataset.type = def.type;
    const bars = '<div class="bars"><div class="hp"><i></i><b></b></div><div class="mana"><i></i></div></div>';
    const stars = `<div class="stars s${star}">${levelMark(star)}</div>`;
    if (def.sprite) {
      el.dataset.facing = facing;
      el.style.setProperty('--fx', fxColor(unitId));
      // Cosmetic only: start each unit's idle breathing at a different point.
      el.style.setProperty('--idle-delay', `${(-Math.random() * 1.8).toFixed(2)}s`);
      el.innerHTML = `<div class="shadow"></div><div class="body"><div class="sprite" ${spriteStyle(def)}></div></div>${stars}${bars}<div class="stun-fx" aria-hidden="true"><i></i><i></i><i></i></div>`;
    } else {
      el.innerHTML = `
        <div class="token"><span>${def.emoji}</span></div>
        <div class="stars s${star}">${levelMark(star)}</div>${bars}`;
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
    closeLobby();
    overlay.classList.remove('start-screen', 'lobby');
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
  menuEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'friend-code') { onFriends('add', e.target.value); e.target.value = ''; }
  });
  menuEl.addEventListener('click', (e) => {
    if (e.target === menuEl) return closeMenu();
    const pic = e.target.closest('button[data-avatar]');
    if (pic && profileDraft) {
      profileDraft.avatar = pic.dataset.avatar;
      for (const b of menuEl.querySelectorAll('button[data-avatar]')) b.setAttribute('aria-pressed', String(b === pic));
      menuEl.querySelector('.profile-preview .avatar').style.backgroundImage = `url('${avatarUrl(profileDraft.avatar)}')`;
      togglePicker(false);
      return;
    }
    const btn = e.target.closest('button[data-menu]');
    if (!btn) return;
    const action = btn.dataset.menu;
    if (action === 'close') closeMenu();
    else if (action === 'dex') { closeMenu(); openDex(); }
    else if (action === 'new-confirmed') { closeMenu(); onNewGame(); }
    else if (action === 'leave-confirmed') { closeMenu(); onLobby('leave'); }
    else if (action === 'copy-log') copyLog(btn);
    else if (action === 'download-log') copyLog(btn, { download: true });
    else if (action === 'copy-text') copyText(btn.dataset.copy, btn);
    else if (action === 'profile-save') saveProfileForm();
    else if (action === 'profile-pick') togglePicker();
    else if (action === 'friend-add') {
      const input = menuEl.querySelector('#friend-code');
      onFriends('add', input?.value ?? '');
      if (input) input.value = '';
    } else if (action === 'friend') {
      // Removing a friend takes a second tap ("Remove?") so it's never by accident.
      if (btn.dataset.action === 'remove' && confirmRemove !== btn.dataset.code) { confirmRemove = btn.dataset.code; return showFriends(); }
      confirmRemove = null;
      onFriends(btn.dataset.action, btn.dataset.code);
    }
    else if (action === 'start-battle') { closeMenu(); onLobby('open'); }
    else if (action === 'start-friend') { closeMenu(); onLobby('friend'); }
    else if (action === 'start-training') { closeMenu(); started = true; overlay.classList.remove('start-screen'); showTeamBuilder(); }
    else openMenu(action); // 'main', 'help', 'new'
  });
  // Online pop-ups get their own layer over the start screen (see showLobby).
  const lobbyEl = document.createElement('div');
  lobbyEl.id = 'lobby';
  lobbyEl.className = 'lobby';
  lobbyEl.hidden = true;
  lobbyEl.setAttribute('role', 'dialog');
  lobbyEl.innerHTML = '<div class="card"></div>';
  document.body.append(lobbyEl);
  function closeLobby() {
    lobbyEl.hidden = true;
    lobbyView = null;
  }

  const overlayClick = (e) => {
    const btn = e.target.closest('button, [data-dex-info]');
    if (btn?.id === 'battle') { started = true; overlay.classList.remove('start-screen'); return showTeamBuilder(); }
    if (btn?.id === 'friend') return onLobby('open');
    if (btn?.id === 'vs-friend') return onLobby('friend');
    if (btn?.dataset.lobby === 'friends') return openMenu('friends');
    if (btn?.dataset.lobby) return onLobby(btn.dataset.lobby, lobbyValues());
    if (btn?.dataset.copy) return copyText(btn.dataset.copy, btn);
    if (btn?.id === 'share-link') return navigator.share?.({ title: 'Poke Tactics', text: `Battle me in Poke Tactics! Code: ${btn.dataset.code}`, url: btn.dataset.url }).catch(() => {});
    if (btn?.id === 'start-menu') return openMenu('main');
    if (btn?.id === 'profile-chip') return openMenu('profile');
    const info = e.target.closest('[data-dex-info]');
    if (info) return openDex(info.dataset.dexInfo); // a team card's ⓘ: full stats and power
    if (e.target.id === 'open-dex') return openDex();
    if (e.target.id === 'continue') { e.target.disabled = true; onIntent({ type: 'continue' }); }
    if (e.target.id === 'play-again') { started = true; if (online) { e.target.disabled = true; e.target.textContent = 'Waiting for the host…'; } onNewGame(); }
    if (e.target.id === 'to-menu') return onLobby(online ? 'leave' : 'home');
    if (e.target.id === 'game-log') return openMenu('log');
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
  };
  overlay.addEventListener('click', overlayClick);
  lobbyEl.addEventListener('click', overlayClick);
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
    if (!dexEl.hidden || !entryEl.hidden) { dexKey(key); return; }
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
    // An online match is showing: any "connecting…" pop-up is done.
    if (online) closeLobby();
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
    if (state.phase === 'team') { if (started) showTeamBuilder(); else showStart(); }
    if (state.phase === 'gameover') showGameOver();
  }

  function hpBox(p, side) {
    const pct = Math.max(0, p.hp);
    return `<div class="hpbox ${side}" title="${esc(p.name)}: ${p.hp} HP">
      ${side === 'ally' ? `${avatar(p.avatar, 'hud-avatar')}<span class="name">${esc(p.name)}</span>` : `<b>${p.hp}</b>`}
      <div class="hpbar"><i style="width:${pct}%"></i></div>
      ${side === 'ally' ? `<b>${p.hp}</b>` : `<span class="name">${esc(p.name)}</span>${avatar(p.avatar, 'hud-avatar')}`}
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
      <span class="chip coins" title="Each round: +${ROUND_COINS}, plus ${LOST_COIN} for each of your Pokémon knocked out last battle. Coins carry over."><b class="gold${coinsChanged ? ' bump' : ''}">${p.coins}</b></span>
      <div class="duel">${hpBox(p, 'ally')}<span class="vs">VS</span>${hpBox(foe(), 'enemy')}</div>
      <div class="hud-actions">
        <button id="open-dex" class="icon-btn dex-button" title="Every Pokémon's stats (P)">${ICON_DEX}<span class="label-text">Pokédex</span></button>
        <button id="open-menu" class="icon-btn${hasUnread() ? ' unread' : ''}" title="Menu (M)" aria-label="Menu">${ICON_MENU}<span class="label-text">Menu</span></button>
      </div>`;
  }

  // ---- menu ------------------------------------------------------------------

  function openMenu(view = 'main') {
    menuView = view;
    const panel = menuEl.querySelector('.menu-panel');
    panel.classList.toggle('help', view === 'help');
    const close = '<button class="menu-close ghost" data-menu="close" aria-label="Close">✕</button>';
    const back = '<button class="back ghost" data-menu="main">← Back</button>';
    if (view === 'help') {
      panel.innerHTML = `${close}${back}<h1>How to play</h1>
        <ul class="help-list">
          <li><b>Build a team</b> of ${teamSize(catalog)} Pokémon. Each puts ${COPIES_PER_TROOP} copies into your own pool, and your shop draws from it. Your board starts empty.</li>
          <li><b>Buy</b>: tap a shop card, then a square on your half (or drag the card onto the board).</li>
          <li><b>Level up</b>: each Pokémon can be on the board only once. Buying another copy levels it up: 1 copy = ★, 2 = ★★, 3 = ★★★, 4 = ${levelMark(3)} (shiny).</li>
          <li><b>Position</b>: the row nearest the middle is your front line. Tap a Pokémon, then a square, to move it (onto another Pokémon swaps them).</li>
          <li><b>Sell</b>: drag a Pokémon onto the shop, or tap it and press Sell. Its copies go back to your pool.</li>
          <li><b>Fight</b>: the battle plays out by itself. After 30 seconds, sudden death drains everyone until one side falls.</li>
          <li><b>Powers</b>: every Pokémon has one; the blue bar under it fills with each attack. See them all in the Pokédex.</li>
          <li><b>Scouting</b>: from round 2, the faded Pokémon on the enemy side show where your opponent placed theirs last round.</li>
          <li><b>Coins</b>: you start with ${START_COINS}. Every round after that: +${ROUND_COINS}, plus ${LOST_COIN} for each of your Pokémon knocked out in the last battle. Coins carry over.</li>
          <li><b>Shop</b>: it refreshes for free every time you buy, and after every battle. A reroll costs ${REROLL_COST} coin.</li>
          <li><b>Win</b> by bringing your opponent from 100 HP to 0. The loser of a battle loses HP for every Pokémon still standing.</li>
        </ul>
        <p class="muted">Keys: <kbd>D</kbd> reroll · <kbd>F</kbd> fight · <kbd>E</kbd> sell · <kbd>Space</kbd> skip · <kbd>P</kbd> Pokédex · <kbd>M</kbd> menu</p>`;
    } else if (view === 'news') {
      try { localStorage.setItem(SEEN_KEY, latestUpdate); } catch {}
      hudEl.querySelector('#open-menu')?.classList.remove('unread');
      overlay.querySelector('#start-menu')?.classList.remove('unread');
      panel.innerHTML = `${close}${back}<h1>What's new</h1>${changelogHTML()}`;
    } else if (view === 'log') {
      panel.innerHTML = `${close}${back}<h1>Match log</h1>
        <p class="muted">Every move both players made this match. Paste it to Claude to analyse the match or test stat changes.</p>
        <label class="field log-notes" for="log-notes">Your notes (optional)
          <textarea id="log-notes" rows="4" placeholder="e.g. Mawile felt useless; Tapu Koko's dash won round 6"></textarea></label>
        <div class="log-actions"><button class="primary" data-menu="copy-log">Copy match log</button>
        <button data-menu="download-log">Download as a file</button></div>
        <p class="muted" id="log-status" aria-live="polite"></p>
        <textarea id="log-text" class="log-text" rows="6" readonly hidden></textarea>`;
    } else if (view === 'profile') {
      const p = getProfile();
      profileDraft = { name: p.name, avatar: p.avatar };
      panel.innerHTML = `${close}${back}<h1>Profile</h1>
        <div class="profile-head">
          <div class="profile-preview">${avatar(profileDraft.avatar, 'big')}
            <button type="button" class="ghost change-pic" data-menu="profile-pick" aria-expanded="false">Change</button></div>
          <label class="field">Your name<input id="profile-name" maxlength="${NAME_MAX}" autocomplete="nickname" placeholder="Trainer" value="${esc(p.name)}"></label>
        </div>
        <div class="avatar-picker" hidden>
          <p class="field-label">Pick a profile picture</p>
          <div class="avatar-grid" role="group" aria-label="Profile picture">${AVATARS.map((id) =>
            `<button type="button" data-avatar="${id}" aria-pressed="${id === profileDraft.avatar}" title="${esc(catalog[id]?.name ?? id)}">${avatar(id)}</button>`).join('')}</div>
        </div>
        <button class="primary profile-save" data-menu="profile-save">Save</button>
        ${statsHTML(p.stats)}
        ${friendsSummaryHTML()}
        <p class="muted small">Your profile and stats are saved in this browser, so they're here next time you play. Clearing your browser's site data resets them.</p>`;
      menuEl.hidden = false;
      panel.querySelector('#profile-name').focus();
      return;
    } else if (view === 'friends') {
      confirmRemove = null;
      panel.innerHTML = `${close}${back}<h1>Friends</h1><div class="friends-body">${friendsViewHTML()}</div>`;
      menuEl.hidden = false;
      return;
    } else if (view === 'lastlog') {
      const text = getLastLog() ?? '';
      panel.innerHTML = `${close}${back}<h1>Last online match log</h1>
        <p class="muted">Every move of your last online match, and what happened to the connection. Copy it and paste it to Claude to look into a drop.</p>
        <div class="log-actions"><button class="primary" data-menu="copy-text" data-copy="${esc(text)}">Copy match log</button>
        <button data-download="${esc(text)}">Download as a file</button></div>
        <textarea class="log-text" rows="6" readonly>${esc(text)}</textarea>`;
    } else if (view === 'leave') {
      panel.innerHTML = `${close}<h1>Leave the match?</h1>
        <p class="muted">Your friend will be told you left, and the match ends.</p>
        <div class="confirm-row"><button data-menu="main">Keep playing</button><button class="danger" data-menu="leave-confirmed">Leave</button></div>`;
    } else if (view === 'new') {
      panel.innerHTML = `${close}<h1>New game?</h1>
        <p class="muted">This match will be lost.</p>
        <div class="confirm-row"><button data-menu="main">Keep playing</button><button class="danger" data-menu="new-confirmed">Start a new game</button></div>`;
    } else if (!started) {
      // From the start screen: everything a player can start from here.
      panel.innerHTML = `${close}<h1>Menu</h1>
        <div class="menu-list">
          <button data-menu="start-battle"><span>⚔</span><div>Battle<small>Play the next player looking for a battle</small></div></button>
          <button data-menu="start-friend"><span>✉</span><div>Battle a friend<small>Send a battle request with their friend code</small></div></button>
          <button data-menu="start-training"><span>▶</span><div>Training<small>Play against the bot</small></div></button>
          <button data-menu="friends" class="${getFriends()?.incoming.length ? 'unread' : ''}"><span>♥</span><div>Friends<small>${friendsSub()}</small></div></button>
          <button data-menu="profile"><span>☺</span><div>Profile<small>Your name, picture and stats</small></div></button>
          <button data-menu="news" class="${hasUnread() ? 'unread' : ''}"><span>★</span><div>What's new<small>${esc(changelog[0]?.title ?? 'Updates to the game')}</small></div></button>
          <button data-menu="help"><span>?</span><div>How to play<small>Rules, controls and keys</small></div></button>
          <button data-menu="dex"><span>◎</span><div>Pokédex<small>Every Pokémon's stats and power</small></div></button>
          ${getLastLog() ? '<button data-menu="lastlog"><span>⧉</span><div>Last online match log<small>Copy it to look into a dropped connection</small></div></button>' : ''}
        </div>
        ${versionText ? `<p class="menu-version">${esc(versionText)}</p>` : ''}`;
    } else {
      panel.innerHTML = `${close}<h1>Menu</h1>
        <div class="menu-list">
          <button data-menu="close"><span>▶</span><div>Resume</div></button>
          <button data-menu="news" class="${hasUnread() ? 'unread' : ''}"><span>★</span><div>What's new<small>${esc(changelog[0]?.title ?? 'Updates to the game')}</small></div></button>
          <button data-menu="help"><span>?</span><div>How to play<small>Rules, controls and keys</small></div></button>
          <button data-menu="dex"><span>◎</span><div>Pokédex<small>Every Pokémon's stats and power</small></div></button>
          <button data-menu="log"><span>⧉</span><div>Match log<small>Copy every move this match, with notes</small></div></button>
          <button data-menu="friends" class="${getFriends()?.incoming.length ? 'unread' : ''}"><span>♥</span><div>Friends<small>${friendsSub()}</small></div></button>
          <button data-menu="profile"><span>☺</span><div>Profile<small>Your name, picture and stats</small></div></button>
          ${online
            ? '<button data-menu="leave"><span>⏏</span><div>Leave match<small>Disconnect from your friend</small></div></button>'
            : '<button data-menu="new"><span>↻</span><div>New game<small>Start over with a new team</small></div></button>'}
        </div>`;
    }
    menuEl.hidden = false;
    panel.querySelector('button:not(.menu-close)')?.focus();
  }

  const KIND = { buff: 'Buff', nerf: 'Nerf', new: 'New', change: 'Change', fix: 'Fix' };
  function changelogHTML() {
    if (!changelog.length) return '<p class="muted">No updates yet.</p>';
    const date = (d) => { try { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return d; } };
    return `<div class="news">${changelog.map((u) => `
      <section class="news-entry">
        <div class="news-date">${esc(date(u.date))}</div>
        <h2>${esc(u.title)}</h2>
        ${u.intro ? `<p class="muted">${esc(u.intro)}</p>` : ''}
        <ul>${u.changes.map((c) => {
          const def = c.pokemon && catalog[c.pokemon];
          return `<li>${def ? portrait(def) : '<span class="news-dot" aria-hidden="true"></span>'}
            <div>${c.kind ? `<span class="tag ${c.kind}">${KIND[c.kind] ?? esc(c.kind)}</span>` : ''}${def && !c.text.startsWith(def.name) ? `<b>${esc(def.name)}</b> ` : ''}${esc(c.text)}</div></li>`;
        }).join('')}</ul>
      </section>`).join('')}</div>`;
  }

  async function copyLog(btn, { download = false } = {}) {
    const status = menuEl.querySelector('#log-status');
    btn.disabled = true;
    status.textContent = 'Getting the match log…';
    const log = await getLog?.();
    btn.disabled = false;
    if (!log?.intents?.length) { status.textContent = 'No moves recorded yet. Start a match first.'; return; }
    const notes = menuEl.querySelector('#log-notes').value.trim();
    const text = JSON.stringify({ ...log, notes, viewer: log.names[viewer], copied: new Date().toISOString() });
    if (download) {
      downloadText(text, logFileName(log));
      status.textContent = `Downloaded ${logFileName(log)} (${log.intents.length} moves).`;
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `Copied ${log.intents.length} moves. Paste them into your chat with Claude.`;
    } catch {
      const box = menuEl.querySelector('#log-text');
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
      status.textContent = 'Copying was blocked here. The log is selected below: copy it yourself.';
    }
  }

  // Save text as a file (the match log), e.g. poke-tactics-2026-10-14-1530-vs-Sean.json.
  function logFileName(log) {
    const d = new Date(log.started ?? Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const foe = log.names?.[1 - viewer] ?? 'match';
    return `poke-tactics-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-vs-${String(foe).replace(/[^\w-]+/g, '_')}.json`;
  }
  function downloadText(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-download]');
    if (!btn) return;
    let log = null;
    try { log = JSON.parse(btn.dataset.download); } catch {}
    downloadText(btn.dataset.download, logFileName(log ?? {}));
  });

  function closeMenu() {
    menuEl.hidden = true;
    profileDraft = null;
  }

  // The profile picture options only show after pressing Change.
  function togglePicker(open) {
    const picker = menuEl.querySelector('.avatar-picker');
    const btn = menuEl.querySelector('.change-pic');
    if (!picker || !btn) return;
    const show = open ?? picker.hidden;
    picker.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    btn.textContent = show ? 'Done' : 'Change';
    if (show) picker.querySelector('[aria-pressed="true"]')?.focus();
  }

  function statsHTML(stats) {
    const total = { wins: 0, losses: 0, draws: 0 };
    for (const r of [stats.online, stats.training]) for (const k in total) total[k] += r[k];
    const played = total.wins + total.losses + total.draws;
    const rate = played ? `${Math.round((100 * total.wins) / played)}%` : '–';
    const row = (label, r) => `<tr><th>${label}</th><td>${r.wins}</td><td>${r.losses}</td><td>${r.draws}</td></tr>`;
    const fav = favouriteTroop(stats);
    const favDef = fav && catalog[fav.id];
    return `<section class="profile-section">
        <h2>Stats</h2>
        <div class="stat-tiles">
          <div><b>${total.wins}</b><span>Wins</span></div>
          <div><b>${total.losses}</b><span>Losses</span></div>
          <div><b>${rate}</b><span>Win rate</span></div>
        </div>
        <table class="record"><thead><tr><th></th><th>Wins</th><th>Losses</th><th>Draws</th></tr></thead>
          <tbody>${row('Online', stats.online)}${row('Training', stats.training)}</tbody></table>
        <div class="favourite">${favDef
          ? `${avatar(fav.id)}<div><small>Most used Pokémon</small><b>${esc(favDef.name)}</b><span>in ${fav.battles} ${fav.battles === 1 ? 'battle' : 'battles'}</span></div>`
          : '<div><small>Most used Pokémon</small><span>Play a battle to find out.</span></div>'}</div>
      </section>`;
  }

  const onlineCount = () => (getFriends()?.friends ?? []).filter((f) => f.status !== 'offline').length;
  const friendsSub = () => {
    const f = getFriends();
    if (!f?.available) return 'Add friends and battle them';
    const n = onlineCount();
    return f.incoming.length ? `${f.incoming.length} friend request${f.incoming.length === 1 ? '' : 's'}` : n ? `${n} online now` : 'Add friends and battle them';
  };

  function friendsSummaryHTML() {
    const f = getFriends();
    return `<section class="profile-section">
        <h2>Friends <span class="count">${f?.friends.length ?? 0}</span></h2>
        <p class="muted">${f?.available ? `${onlineCount()} online now.` : 'Friends need online play.'}</p>
        <button type="button" data-menu="friends">Open friends</button>
      </section>`;
  }

  const STATUS_TEXT = { online: 'Online', battling: 'In a battle', offline: 'Offline' };
  const ORDER = { online: 0, battling: 1, offline: 2 };

  // The Friends screen: your code, adding friends, requests, and the friends
  // list with who's online and a Battle button.
  function friendsViewHTML() {
    const f = getFriends();
    if (!f?.available) return '<p class="muted">Friends need online play, which isn\'t available in this copy of the game.</p>';
    const person = (p, actions) => `<li>${avatar(p.avatar)}<div class="who"><b>${esc(p.name)}</b>${p.status ? `<small class="status ${p.status}"><i></i>${STATUS_TEXT[p.status]}</small>` : ''}</div>${actions}</li>`;
    const act = (action, p, label, cls = '') => `<button type="button" class="${cls}" data-menu="friend" data-action="${action}" data-code="${esc(p.code)}">${label}</button>`;
    const list = [...f.friends].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
    return `
      <div class="friend-code"><span>Your friend code</span><b>${esc(f.code ?? '······')}</b>
        ${f.code ? `<button type="button" data-menu="copy-text" data-copy="${esc(f.code)}">Copy</button>` : ''}</div>
      <div class="add-friend-row">
        <input id="friend-code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Friend's code" aria-label="Friend's code">
        <button type="button" class="primary" data-menu="friend-add">Add friend</button>
      </div>
      ${f.incoming.length ? `<h2>Friend requests</h2><ul class="friend-list">${f.incoming.map((p) => person({ ...p, status: null },
        `${act('accept', p, 'Accept', 'primary small-btn')}${act('decline', p, 'Decline', 'ghost small-btn')}`)).join('')}</ul>` : ''}
      ${f.outgoing.length ? `<h2>Sent requests</h2><ul class="friend-list">${f.outgoing.map((p) => person({ ...p, status: null },
        `<small class="muted">Waiting</small>${act('cancel', p, 'Cancel', 'ghost small-btn')}`)).join('')}</ul>` : ''}
      <h2>Friends <span class="count">${f.friends.length}</span></h2>
      ${list.length ? `<ul class="friend-list">${list.map((p) => person(p,
        `${p.status === 'online'
          ? (f.waiting?.code === p.code ? '<small class="muted">Asking…</small>' : act('challenge', p, '⚔ Battle', 'primary small-btn'))
          : ''}${act('remove', p, confirmRemove === p.code ? 'Remove?' : '✕', `ghost small-btn danger-text${confirmRemove === p.code ? ' confirm' : ''}`)}`)).join('')}</ul>`
        : '<p class="muted">No friends yet. Send a friend your code, or add theirs.</p>'}
      <p class="muted small">Friends are saved on the game server and linked to this browser. Another browser or device, or clearing this site's data, starts a new friends list with a new code.</p>`;
  }

  // Battle requests, shown over whatever screen is up.
  let challengeEl = null;
  let challengeTimer = 0;
  function renderChallenge() {
    const f = getFriends();
    const ch = f?.challenge;
    const w = f?.waiting;
    clearInterval(challengeTimer);
    if (!ch && !w) { challengeEl?.remove(); challengeEl = null; return; }
    if (!challengeEl) {
      challengeEl = document.createElement('div');
      challengeEl.className = 'challenge-card';
      challengeEl.setAttribute('role', 'alertdialog');
      challengeEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-challenge]');
        if (btn) onFriends(btn.dataset.challenge);
      });
      document.body.append(challengeEl);
    }
    const p = ch ?? w;
    const left = () => Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
    challengeEl.innerHTML = ch
      ? `${avatar(ch.avatar, 'big')}<div class="text"><b>${esc(ch.name)} wants to battle!</b><small><span class="left">${left()}</span>s to answer</small></div>
         <div class="buttons"><button class="primary" data-challenge="accept-battle">Accept</button><button class="ghost" data-challenge="decline-battle">Decline</button></div>`
      : `${avatar(w.avatar, 'big')}<div class="text"><b>Asking ${esc(w.name)} to battle…</b><small><span class="left">${left()}</span>s for them to answer</small></div>
         <div class="buttons"><button class="ghost" data-challenge="withdraw">Cancel</button></div>`;
    challengeTimer = setInterval(() => { const el = challengeEl?.querySelector('.left'); if (el) el.textContent = left(); }, 1000);
  }

  // Friends data changed: refresh whatever shows it.
  function showFriends() {
    renderChallenge();
    const mine = lobbyEl.querySelector('#my-friend-code');
    const code = getFriends()?.code;
    if (mine && code) {
      mine.textContent = code;
      const copy = mine.parentElement.querySelector('[data-copy]');
      if (copy) { copy.dataset.copy = code; copy.hidden = false; }
    }
    if (menuEl.hidden || menuView !== 'friends') return;
    const panel = menuEl.querySelector('.menu-panel');
    const input = panel.querySelector('#friend-code');
    const typed = input?.value ?? '';
    const focused = document.activeElement === input;
    panel.querySelector('.friends-body').innerHTML = friendsViewHTML();
    const fresh = panel.querySelector('#friend-code');
    if (fresh) { fresh.value = typed; if (focused) fresh.focus(); }
  }

  function saveProfileForm() {
    const name = menuEl.querySelector('#profile-name')?.value ?? '';
    const saved = onProfile({ name, avatar: profileDraft.avatar });
    toast(saved?.stored === false ? 'This browser blocked saving. Your profile lasts until you close the page.' : 'Profile saved');
    closeMenu();
    if (overlay.classList.contains('start-screen')) showStart();
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
    // A new round, a reroll or a purchase deals new cards in.
    const deal = `${state.round}|${p.shopRolls}|${state.phase}`;
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
        ${fielded(p, id) ? `<span class="levelup">Level up ${levelMark(fielded(p, id).star)} → ${levelMark(fielded(p, id).star + 1)}</span>` : ''}
        <span class="left">${p.pool[id]} left in pool</span>
      </button>`;
    }).join('');
    rerollBtn.textContent = `Reroll (${REROLL_COST} coin)`;
    rerollBtn.disabled = !canPlan() || p.coins < REROLL_COST;
    readyBtn.disabled = !canPlan();
    readyBtn.dataset.base = state.phase === 'planning' && p.ready ? 'Waiting for opponent…' : 'Fight!';
    tickDeadline();
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
        ? `<p class="hint">You already have a ${esc(def.name)} on the board. Click anywhere on your side to level it up to ${levelSpan(onBoard.star + 1)}.</p>`
        : '<p class="hint">Click an empty square on your side to place it.</p>';
    infoEl.innerHTML = `
      <button id="info-close" class="ghost" aria-label="Close">✕</button>
      <div class="info-head" data-type="${def.type}">
        ${portrait(def)}
        <div><h2>${esc(def.name)} ${levelSpan(star)}</h2>
        <span class="sub">${def.type} · ${def.cost} coins · ${copies}/${COPIES_PER_TROOP} copies</span></div>
      </div>
      ${hint}
      <dl class="stats">
        <dt>HP</dt><dd>${show(stats.hp)}</dd>
        ${isCopycat(def) ? `<dt>Movement</dt><dd>${SPEED_NAME[def.moveSpeed]}</dd><dt>Everything else</dt><dd>Copies its target</dd>` : `
        <dt>Damage per hit</dt><dd>${show(stats.atk)}</dd>
        <dt>Attacks every</dt><dd>${attackTime(stats)}s</dd>
        <dt>Crit chance</dt><dd>${stats.crit}%</dd>
        <dt>DPS</dt><dd>${dps(stats)}</dd>
        <dt>Range</dt><dd>${def.range}</dd>
        <dt>Movement</dt><dd>${SPEED_NAME[def.moveSpeed]}</dd>`}
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
        if (a.chillUntil && tick >= a.chillUntil) { a.chillUntil = 0; a.el.classList.remove('chilled'); }
        if (a.stealthUntil && tick >= a.stealthUntil) { a.stealthUntil = 0; a.el.classList.remove('stealthed'); }
        if (a.hasteUntil && tick >= a.hasteUntil) { a.hasteUntil = 0; a.el.classList.remove('hasted'); }
        if (a.guardUntil && tick > a.guardUntil) { a.guardUntil = 0; a.el.classList.remove('guarded'); }
        if (a.tauntUntil && (tick > a.tauntUntil || actors.get(a.tauntBy)?.el.classList.contains('dead'))) { a.tauntUntil = 0; a.el.classList.remove('taunted'); }
        if (a.boundUntil && tick > a.boundUntil) { a.boundUntil = 0; a.el.classList.remove('bound'); }
        if (a.treatUntil && tick > a.treatUntil) { a.treatUntil = 0; a.el.classList.remove('treated'); delete a.el.dataset.treat; }
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
  // Sprites only have 4 facings, so a target off the straight lines (a diagonal
  // attack) is shown by tilting the sprite: it turns from the way it faces
  // toward the target, i.e. by the signed angle between the two (clockwise on
  // screen is positive, as for CSS rotate). An exact diagonal (45°) tilts
  // MAX_TILT degrees, shallower angles less. Straight lines (every step is one)
  // give no tilt.
  const MAX_TILT = 16;
  const SHOVE_MS = 200; // shoved aside by someone landing on its square
  const KNOCK_MS = 300; // knocked back by a hit (up to 2 squares)
  const FACING_VEC = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
  function face(a, dx, dy) {
    if (!a.el.dataset.facing) return;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const facing = facingFor(horizontal ? dx : 0, horizontal ? 0 : dy, a.el.dataset.facing);
    a.el.dataset.facing = facing;
    const [fx, fy] = FACING_VEC[facing];
    const angle = (Math.atan2(fx * dy - fy * dx, fx * dx + fy * dy) * 180) / Math.PI; // -45..45
    a.el.style.setProperty('--tilt', `${((angle * MAX_TILT) / 45).toFixed(1)}deg`);
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
    if (p.kind === 'quake') return { cls: 'cast-slam', ms: 600, impact: 510 };
    return { cls: 'cast-channel', ms: 550, impact: 275 };
  }

  const flightMs = (from, to) => Math.max(160, 90 * Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))) / speed;

  const rangeOf = (a) => a.range ?? catalog[a.unitId].range; // a transformed unit's range can change
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
        // A shove still waiting for its hit to land happens now, so this step
        // starts from the square the unit was shoved to.
        a.pendingKnock?.(true);
        a.el.style.transition = '';
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
          const hopMs = (STEP_TICKS * TICK_MS) / speed; // every step takes 0.5s
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
        if (p.kind === 'quake') {
          // The whole board shakes as it lands.
          later(motion.impact / speed, () => { pulse(arena, 'shake'); fx(from.x, from.y, 'ring', color, 5); });
          break;
        }
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
        if (!animate) break;
        const p = viewPos(pal.x, pal.y);
        if (ev.dart) {
          // Dragapult's Dreepy: shot out of Dragapult like Tapu Koko's dash, a
          // fast straight streak with sparks behind it, small at first and full
          // size as it lands (onto its target, which is shoved aside on arrival).
          pal.el.style.visibility = 'hidden';
          const from = at();
          const dx = p.x - from.x;
          const dy = p.y - from.y;
          const squares = Math.max(Math.abs(dx), Math.abs(dy));
          const ms = Math.max(160, 55 * squares) / speed;
          const color = fxColor(pal.unitId);
          const flyer = document.createElement('div');
          flyer.className = 'unit sprite-unit dart-flyer dashing';
          flyer.style.setProperty('--fx', color);
          flyer.dataset.facing = facingFor(Math.abs(dx) >= Math.abs(dy) ? dx : 0, Math.abs(dx) >= Math.abs(dy) ? 0 : dy, 'down');
          flyer.innerHTML = `<div class="body"><div class="sprite" style="background-image:url('${catalog[pal.unitId]?.sprite ?? ''}')"></div></div>`;
          place(flyer, from.x, from.y);
          layer.append(flyer);
          flyer.animate([{ translate: '0 0', scale: '0.35' }, { translate: `${dx * 100}% ${dy * 100}%`, scale: '1' }], { duration: ms, easing: 'cubic-bezier(.6,0,.2,1)' }).onfinish = () => flyer.remove();
          for (let i = 1; i <= squares; i++) {
            const k = i / (squares + 1);
            setTimeout(() => fx(from.x + dx * k, from.y + dy * k, 'zap', color, 0.8), ms * k);
          }
          ctx.hitDelay.set(pal.id, ms);
          later(ms, () => { pal.el.style.visibility = ''; play(pal.el, 'spawned', 300); fx(p.x, p.y, 'burst', fxColor(pal.unitId), 1.2); });
        } else { play(pal.el, 'spawned', 400); fx(p.x, p.y, 'ring', fxColor(pal.unitId), 1.3); }
        break;
      }
      case 'dartReturn': { // a fainted Dreepy is knocked away by the hit, then arcs back to Dragapult
        if (!animate) break;
        const dreepy = actors.get(ev.dreepy);
        const hitter = dreepy?.lastHitBy;
        const from = viewPos(ev.fromX, ev.fromY);
        const home = at(); // Dragapult, in squares
        const ms = Math.max(ev.duration * TICK_MS, 500) / speed;
        later(ctx.hitDelay.get(ev.dreepy) ?? 0, () => {
          const ghost = document.createElement('div');
          ghost.className = 'unit sprite-unit dart-ghost';
          ghost.dataset.facing = 'down';
          ghost.innerHTML = `<div class="body"><div class="sprite" style="background-image:url('${catalog[ev.unitId]?.sprite ?? ''}')"></div></div>`;
          place(ghost, from.x, from.y);
          layer.append(ghost);
          // Knocked a square away from whoever hit it (straight up if unknown)...
          const by = hitter ? viewPos(hitter.x, hitter.y) : { x: from.x, y: from.y + 1 };
          let dx = from.x - by.x;
          let dy = from.y - by.y;
          const len = Math.hypot(dx, dy) || 1;
          dx = (dx / len) * 0.9;
          dy = (dy / len) * 0.9;
          // ...then a curve up and over back home (a quadratic arc).
          const end = { x: home.x - from.x, y: home.y - from.y };
          const peak = { x: (dx + end.x) / 2, y: Math.min(dy, end.y) - 1.2 - Math.hypot(end.x - dx, end.y - dy) * 0.25 };
          const frames = [{ offset: 0, translate: '0 0', rotate: '0deg', opacity: 0.6 }];
          frames.push({ offset: 0.3, translate: `${dx * 100}% ${dy * 100}%`, rotate: `${dx >= 0 ? 200 : -200}deg`, opacity: 0.45, easing: 'ease-in-out' });
          for (let k = 1; k <= 8; k++) {
            const q = k / 8;
            const x = (1 - q) ** 2 * dx + 2 * (1 - q) * q * peak.x + q ** 2 * end.x;
            const y = (1 - q) ** 2 * dy + 2 * (1 - q) * q * peak.y + q ** 2 * end.y;
            frames.push({ offset: 0.3 + 0.7 * q, translate: `${x * 100}% ${y * 100}%`, rotate: `${(dx >= 0 ? 200 : -200) + (dx >= 0 ? 160 : -160) * q}deg`, opacity: 0.45 - 0.25 * q });
          }
          ghost.animate(frames, { duration: ms, easing: 'linear' }).onfinish = () => ghost.remove();
        });
        break;
      }
      case 'taunt': { // Amoonguss: this Pokémon must attack it for a while
        a.tauntUntil = ev.t + ev.duration;
        a.tauntBy = ev.by;
        a.el.classList.add('taunted');
        if (animate && ev.dart) {
          later(ctx.hitDelay.get(ev.by) ?? 0, () => floatText(a, 'Distracted', 'taunt'));
        } else if (animate) {
          const from = actors.get(ev.by);
          const ms = from ? projectile(viewPos(from.x, from.y), at(), '#ff6fa8', false) : 0;
          later(ms, () => { floatText(a, 'Taunted', 'taunt'); fx(at().x, at().y, 'burst', '#ff6fa8', 1.2); });
        }
        break;
      }
      case 'rage': // Annihilape: faster with every attack in a row
        a.el.dataset.rage = ev.stacks;
        a.el.classList.toggle('raging', ev.stacks > 0);
        a.el.style.setProperty('--rage', ev.stacks);
        if (animate && ev.stacks) floatText(a, `+${ev.pct}% speed`, 'rage');
        break;
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
        // Thrown by a hit: lands when the hit does. Shoved aside by someone landing
        // on its square: moves when they land (for the wave, when it arrives).
        // Either way it's a quick slide, not the unit's (slower) walking pace.
        const delay = !animate ? 0 : wave ? wave.arrive : ctx.hitDelay.get(ev.by ?? a.id) ?? 0;
        const ms = animate ? (ev.by !== undefined ? SHOVE_MS : KNOCK_MS) / speed : 0;
        const job = (instant) => {
          if (a.pendingKnock !== job) return; // already done, or replaced by a newer one
          a.pendingKnock = null;
          a.el.style.transition = instant || !ms ? 'none' : `left ${ms}ms cubic-bezier(.2,.8,.3,1), top ${ms}ms cubic-bezier(.2,.8,.3,1)`;
          place(a.el, p.x, p.y);
          if (instant || !ms) { void a.el.offsetWidth; a.el.style.transition = ''; return; }
          play(a.el, 'knocked', ms + 150 / speed);
          setTimeout(() => { if (!a.pendingKnock) a.el.style.transition = ''; }, ms);
        };
        a.pendingKnock = job;
        later(delay, () => job(false));
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
      case 'transform': {
        // Battle Bond, Shining Star, Ditto copying or turning back: a quick
        // morph, then the new sprite. A Ditto that turns back and copies again in
        // the same moment shows its own form briefly in between.
        a.range = ev.range;
        if (ev.maxMana !== undefined) { a.maxMana = ev.maxMana; setMana(0); bars(a); } // a form with its own power counter
        // Ditto takes on the copied Pokémon's max HP (keeping its share of HP).
        if (ev.maxHp && newest()) { a.maxHp = ev.maxHp; a.hp = ev.hp; bars(a); }
        const spr = a.el.querySelector('.sprite');
        const apply = () => {
          if (spr) spr.style.backgroundImage = `url('${ev.sprite}')`;
          a.el.classList.toggle('copied', Boolean(ev.copy)); // a Ditto-coloured copy
        };
        if (!animate) { apply(); break; }
        const delay = !ev.revert && a.revertedAt === ev.t ? 450 / speed : 0;
        if (ev.revert) a.revertedAt = ev.t;
        later(delay, () => {
          play(a.el, 'morph', 500 / speed);
          setTimeout(apply, 200 / speed);
          const p = at();
          fx(p.x, p.y, 'burst', fxColor(a.unitId), 1.5);
          floatText(a, ev.revert ? ev.name : ev.copy ? `→ ${ev.name}` : ev.name, 'cast');
        });
        break;
      }
      case 'dash': {
        // Tapu Koko: a straight-line dash, crackling along the way (immune until it lands).
        const from = viewPos(ev.fromX, ev.fromY);
        a.x = ev.x;
        a.y = ev.y;
        const p = viewPos(a.x, a.y);
        face(a, p.x - from.x, p.y - from.y);
        if (!animate) { place(a.el, p.x, p.y); break; }
        const ms = ((ev.duration ?? 2) * TICK_SECONDS * 1000) / speed;
        play(a.el, 'immune', ms);
        a.el.style.transition = `left ${ms}ms cubic-bezier(.6,0,.2,1), top ${ms}ms cubic-bezier(.6,0,.2,1)`;
        place(a.el, p.x, p.y);
        play(a.el, 'dashing', ms + 80);
        const steps = Math.max(Math.abs(p.x - from.x), Math.abs(p.y - from.y));
        for (let i = 1; i <= steps; i++) {
          const k = i / (steps + 1);
          setTimeout(() => fx(from.x + (p.x - from.x) * k, from.y + (p.y - from.y) * k, 'zap', fxColor(a.unitId), 1), (ms * k));
        }
        setTimeout(() => { a.el.style.transition = ''; }, ms);
        break;
      }
      case 'blink': {
        // Minior's Star Form: a near-instant zip to its target, leaving sparks.
        const from = viewPos(ev.fromX, ev.fromY);
        a.x = ev.x;
        a.y = ev.y;
        const p = viewPos(a.x, a.y);
        face(a, p.x - from.x, p.y - from.y);
        if (!animate) { place(a.el, p.x, p.y); break; }
        const ms = 120 / speed;
        a.el.style.transition = `left ${ms}ms cubic-bezier(.5,0,.2,1), top ${ms}ms cubic-bezier(.5,0,.2,1)`;
        place(a.el, p.x, p.y);
        play(a.el, 'dashing', ms + 60);
        fx(from.x, from.y, 'burst', fxColor(a.unitId), 0.9);
        if (ev.hop) setTimeout(() => fx(p.x, p.y, 'ring', fxColor(a.unitId), 1.4), ms);
        setTimeout(() => { a.el.style.transition = ''; }, ms);
        break;
      }
      case 'morphStart': { // Minior (immune) or Ditto changing form
        // Minior's Rock form breaking: Star Form's own, full HP bar.
        if (ev.maxHp && newest()) { a.maxHp = ev.maxHp; a.hp = ev.hp; a.shield = 0; later(ctx.hitDelay.get(a.id) ?? 0, () => bars(a)); }
        if (!animate) break;
        const immune = catalog[a.unitId].ability?.kind === 'transform';
        const cls = immune ? ['morphing', 'immune'] : ['morphing'];
        a.el.classList.add(...cls);
        setTimeout(() => a.el.classList.remove(...cls), (ev.duration * TICK_SECONDS * 1000) / speed);
        if (immune) setTimeout(() => floatText(a, 'Immune', 'shield'), 300 / speed);
        break;
      }
      case 'fuse': // Golem knocked out: it stays, glowing, until it explodes
        if (newest()) { a.hp = 0; bars(a); }
        later(ctx.hitDelay.get(a.id) ?? 0, () => {
          a.el.classList.add('fusing');
          if (animate) floatText(a, '!!', 'crit');
        });
        break;
      case 'shockwave': { // Minior's Star Form arrives with a stunning burst
        if (!animate) break;
        const p = at();
        fx(p.x, p.y, 'ring', fxColor(a.unitId), ev.radius * 2 + 1.4);
        fx(p.x, p.y, 'burst', '#ffe14d', ev.radius * 2 + 0.4);
        pulse(arena, 'shake');
        break;
      }
      case 'explode': {
        a.el.classList.remove('fusing');
        if (!animate) break;
        const p = at();
        fx(p.x, p.y, 'ring', '#ff7a2f', ev.radius * 2 + 1.4);
        fx(p.x, p.y, 'burst', '#ffd36b', ev.radius * 2 + 0.6);
        pulse(arena, 'shake');
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
        if (src) a.lastHitBy = src; // which way it flies if this knocks it out (Dreepy)
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
      case 'guard': // Alcremie's Mint Cream: a shield bubble for a while
        a.guardUntil = ev.t + ev.duration;
        a.el.classList.add('guarded');
        break;
      case 'guardBreak':
        a.guardUntil = 0;
        a.el.classList.remove('guarded');
        if (a.el.dataset.treat === 'guard') { a.treatUntil = 0; a.el.classList.remove('treated'); delete a.el.dataset.treat; }
        if (animate) { floatText(a, 'Shield broke', 'guard'); fx(at().x, at().y, 'burst', '#9fd8ff', 1.2); }
        break;
      case 'treat': { // Alcremie: the treat flies to the ally it picked, which wears it for the duration
        const to = actors.get(ev.target);
        if (!to) break;
        const color = TREAT_COLOR[ev.flavor];
        const wear = () => {
          to.treatUntil = ev.t + ev.duration;
          to.el.dataset.treat = ev.flavor;
          to.el.style.setProperty('--treat', color);
          to.el.classList.add('treated');
        };
        if (!animate) { wear(); break; }
        const ms = to === a ? 0 : projectile(at(), viewPos(to.x, to.y), color, true);
        later(ms, () => {
          wear();
          const p = viewPos(to.x, to.y);
          fx(p.x, p.y, 'burst', color, 1.4);
          floatText(to, TREAT_TEXT[ev.flavor], ev.flavor === 'heal' ? 'heal' : ev.flavor === 'guard' ? 'guard' : 'cast');
        });
        break;
      }
      case 'bind': { // Hoopa: rings hold the Pokémon in place for a while
        const from = actors.get(ev.by);
        const wear = () => {
          a.boundUntil = ev.t + ev.duration;
          a.el.classList.add('bound');
        };
        if (!animate) { wear(); break; }
        const ms = from ? projectile(viewPos(from.x, from.y), at(), '#ff8ad8', true) : 0;
        later(ms, () => { wear(); floatText(a, 'Bound', 'bind'); fx(at().x, at().y, 'burst', '#ff8ad8', 1.3); });
        break;
      }
      case 'boost': // Toxtricity's Overdrive: power charges for an ally beside it
        if (newest()) { setMana(ev.mana); bars(a); }
        if (animate) { floatText(a, `+${ev.amount} charge`, 'boost'); fx(at().x, at().y, 'burst', '#ffe14d', 1.1); }
        break;
      case 'chill': { // Frosmoth: slower for a while (each hit restarts it)
        const fresh = !(a.chillUntil && ev.t < a.chillUntil);
        a.chillUntil = ev.t + ev.duration + 1;
        later(ctx.hitDelay.get(a.id) ?? 0, () => {
          a.el.classList.add('chilled');
          if (animate && fresh) floatText(a, 'Chilled', 'chill');
        });
        break;
      }
      case 'stun':
        a.stunUntil = ev.t + ev.duration;
        later(ctx.hitDelay.get(a.id) ?? 0, () => {
          a.el.classList.add('stunned');
          if (animate) { const p = at(); fx(p.x, p.y, 'stunpop', '#ffe14d', 1.2); }
        });
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
      <p class="muted">Round ${round} · Your HP ${me().hp} → ${hpAfter} · +${ROUND_COINS + LOST_COIN * lostCount(result, viewer)} coins next round (${ROUND_COINS} + ${lostCount(result, viewer)} for Pokémon lost)</p>
      ${me().ready
        ? '<button disabled>Waiting for opponent…</button>'
        : '<button id="continue" class="primary" autofocus>Continue</button>'}`);
    overlay.querySelector('#continue')?.focus();
  }

  // Team cards look like the Pokédex's: sprite in a glow, name, cost and type.
  // A picked card gets a green border and its Pokémon walks. Stats live
  // behind the ⓘ button (the Pokédex entry).
  function teamCard(id, picked, i) {
    const def = catalog[id];
    return `<button class="dex-card team-card${picked ? ' chosen' : ''}" style="--i:${i}" data-pick-troop="${id}" data-type="${def.type}" ${me().ready ? 'disabled' : ''} aria-pressed="${picked}">
      <span class="info-btn" data-dex-info="${id}" role="button" aria-label="${esc(def.name)} info">i</span>
      <span class="dex-card-art">${portrait(def)}</span>
      <b>${esc(def.name)}</b>
      <small>${def.cost} 🪙 · ${def.type[0].toUpperCase() + def.type.slice(1)}</small>
    </button>`;
  }

  function profileChip() {
    const p = getProfile();
    return `<button id="profile-chip" class="profile-chip" title="Your profile">${avatar(p.avatar)}<span>${p.saved && p.name ? esc(p.name) : 'Set up your profile'}</span></button>`;
  }

  function showStart() {
    const ids = troopIds(catalog);
    const parade = ids.map((id, i) => `<span class="walker" style="--i:${i};--n:${ids.length}" data-facing="right"><span class="sprite" ${spriteStyle(catalog[id])}></span></span>`).join('');
    showOverlay(`
      <div class="start">
        <div class="logo"><span>Poke</span><span>Tactics</span></div>
        <p class="tagline">Draft a team, place your Pokémon, and watch them battle it out.</p>
        <div class="parade" aria-hidden="true">${parade}</div>
        <div class="start-modes">
          <button id="friend" class="primary battle-btn">Battle</button>
          <button id="vs-friend" class="battle-btn training-btn">Battle a friend</button>
          <button id="battle" class="battle-btn training-btn">Training</button>
        </div>
        <button id="start-menu" class="icon-btn start-menu${hasUnread() ? ' unread' : ''}" title="Menu (M)" aria-label="Menu">${ICON_MENU}</button>
        ${profileChip()}
        ${versionText ? `<div class="start-version">${esc(versionText)}</div>` : ''}
      </div>`);
    overlay.classList.add('start-screen');
    overlay.querySelector('#friend').focus();
  }

  function showTeamBuilder() {
    const need = teamSize(catalog);
    const waiting = me().ready;
    const ready = draft.troops.length === need;
    const count = `${Array.from({ length: need }, (_, k) => `<i class="${k < draft.troops.length ? 'on' : ''}"></i>`).join('')}<span>${draft.troops.length}/${need}</span>`;
    const actions = waiting
      ? '<p class="muted">Waiting for opponent…</p>'
      : `<button id="start-team" class="primary" ${ready ? '' : 'disabled'}>${ready ? 'Start battle' : `Pick ${need - draft.troops.length} more`}</button>`;
    const grid = overlay.hidden ? null : overlay.querySelector('.team-grid');
    if (grid) {
      // Already on screen: update in place, so only the card that changed
      // animates (redrawing would replay every picked card's animation).
      for (const card of grid.querySelectorAll('[data-pick-troop]')) {
        const picked = draft.troops.includes(card.dataset.pickTroop);
        card.classList.toggle('chosen', picked);
        card.setAttribute('aria-pressed', picked);
        card.disabled = Boolean(waiting);
      }
      overlay.querySelector('.team-count').innerHTML = count;
      const box = overlay.querySelector('.team-actions');
      if (box.innerHTML !== actions) box.innerHTML = actions;
      return;
    }
    showOverlay(`
      <h1>Choose your team</h1>
      <p class="muted">Pick ${need} Pokémon. Each puts ${COPIES_PER_TROOP} copies in your pool for the shop. Tap <span class="info-btn inline">i</span> for a Pokémon's stats.</p>
      <div class="team-count">${count}</div>
      <div class="team-grid fresh">${troopIds(catalog).map((id, i) => teamCard(id, draft.troops.includes(id), i)).join('')}</div>
      <div class="team-actions">${actions}</div>`);
  }

  function showGameOver() {
    const title = state.winner === viewer ? 'You win the match! 🏆' : state.winner === null ? 'Double knockout. It\'s a draw.' : 'You were eliminated';
    showOverlay(`
      <h1 class="${state.winner === viewer ? 'win' : 'loss'}">${title}</h1>
      <p>The match lasted ${state.round} rounds. Final HP: ${me().hp} vs ${foe().hp}.</p>
      ${online && viewer === 1
        ? '<button id="play-again" class="primary">Ask for a rematch</button>'
        : `<button id="play-again" class="primary">${online ? 'Rematch' : 'Play again'}</button>`}
      <button id="to-menu">Main menu</button>
      <button id="game-log" class="ghost">Match log (copy or download)</button>`);
  }

  // ---- online lobby ----------------------------------------------------------

  const lobbyValues = () => ({
    friendCode: lobbyEl.querySelector('#lobby-friend-code')?.value ?? '',
  });

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const was = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = was; }, 1400);
    } catch { toast('Copy blocked here. Select the text and copy it yourself.'); }
  }

  // Screens: 'queue' (waiting for an opponent), 'friend' (battle request by
  // friend code), 'connecting', 'resume', 'error', 'disconnected' and the
  // connection check. main.js decides which one to show.
  function showLobby(view, data = {}) {
    const back = '<button class="ghost" data-lobby="home">Back</button>';
    const html = {
      friend: () => `
        <h1>Battle a friend</h1>
        <p class="muted">Enter your friend's code to send them a battle request. They need to have the game open.</p>
        <input id="lobby-friend-code" class="code-input" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" aria-label="Friend code">
        <button class="primary" data-lobby="challenge">Send battle request</button>
        <div class="my-code">Your friend code: <b id="my-friend-code">${esc(data.myCode ?? '······')}</b>
          <button class="ghost small-btn" data-copy="${esc(data.myCode ?? '')}" ${data.myCode ? '' : 'hidden'}>Copy</button></div>
        <div class="lobby-actions">${back}<button class="ghost" data-lobby="friends">Friends list</button></div>`,
      resume: () => `
        <h1>Match in progress</h1>
        <p>You were in a match${data.opponent ? ` with <b>${esc(data.opponent)}</b>` : ''} (game <b>${esc(data.code)}</b>) when the page closed.</p>
        <p class="muted">It's still going on the server: rejoin and you're straight back in.</p>
        <button class="primary" data-lobby="resume">Rejoin the match</button>
        <div class="lobby-actions"><button class="ghost" data-lobby="discard">Start fresh</button></div>`,
      queue: () => `
        <h1>Waiting for opponent</h1>
        <div class="spinner" aria-hidden="true"></div>
        <p class="muted">The battle starts as soon as another player is looking too. Keep this screen open.</p>
        <button class="ghost" data-lobby="cancel">Cancel</button>`,
      checking: () => `
        <h1>Checking your connection</h1>
        <div class="spinner" aria-hidden="true"></div>
        <p class="muted">This takes a few seconds.</p>`,
      check: () => {
        const c = data;
        const row = ([ok, text]) => `<li class="${ok ? 'ok' : 'bad'}"><span aria-hidden="true">${ok ? '✓' : '✗'}</span>${text}</li>`;
        const verdict = !c.configured ? 'Online play isn\'t set up in this copy of the game.'
          : !c.ok ? 'Couldn\'t reach the game server. Check your internet connection; if other sites work, the server may be down for a moment.'
          : !c.sameVersion ? 'The game has been updated: refresh the page to play online.'
          : 'Online play should work from here.';
        return `
        <h1>Connection check</h1>
        <ul class="check-list">
          ${row([c.ok, c.ok ? 'The game server is reachable' : 'The game server can\'t be reached'])}
          ${c.ok ? row([c.sameVersion, c.sameVersion ? 'You have the latest version' : 'A newer version is out: refresh the page']) : ''}
        </ul>
        <p>${verdict}</p>
        <button class="primary" data-lobby="home">Back</button>`;
      },
      connecting: () => `
        <h1>Battle</h1>
        <div class="spinner" aria-hidden="true"></div>
        <p>${esc(data.text ?? 'Connecting…')}</p>
        ${data.cancel ? '<button class="ghost" data-lobby="home">Cancel</button>' : ''}`,
      error: () => `
        <h1>Couldn't connect</h1>
        <p>${esc(data.error)}</p>
        <div class="lobby-actions"><button class="primary" data-lobby="open">Try again</button><button data-lobby="check">Check my connection</button>${back}</div>`,
      disconnected: () => `
        <h1>Match ended</h1>
        <p>${esc(data.error)}</p>
        <button class="primary" data-lobby="home">Back to start</button>
        ${data.log ? `<p class="muted small">Did the connection drop? Copy the match log and send it in: it shows what happened to the connection.</p>
        <button class="ghost" data-copy="${esc(data.log)}">Copy match log</button>
        <button class="ghost" data-download="${esc(data.log)}">Download match log</button>` : ''}`,
    }[view]();
    // No match has started for this player yet: the start screen stays behind
    // the pop-up (never an empty board).
    if (!overlay.classList.contains('start-screen') || overlay.hidden) {
      started = false;
      playback?.cancel();
      playback = null;
      showStart();
    }
    lobbyEl.querySelector('.card').innerHTML = html;
    lobbyEl.hidden = false;
    lobbyView = view;
    const focus = view === 'friend' ? '#lobby-friend-code' : 'button.primary, button';
    lobbyEl.querySelector(focus)?.focus();
  }

  lobbyEl.addEventListener('input', (e) => {
    if (e.target.id !== 'lobby-friend-code') return;
    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v !== e.target.value) e.target.value = v;
  });
  lobbyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'lobby-friend-code') onLobby('challenge', lobbyValues());
  });

  // ---- online: planning countdown and the battle intro ----------------------

  // Online, planning locks in automatically at `ms` (Date.now() time); null = no timer.
  let deadlineTimer = 0;
  function setDeadline(ms) {
    deadline = ms;
    clearInterval(deadlineTimer);
    if (ms) deadlineTimer = setInterval(tickDeadline, 250);
    tickDeadline();
  }
  function tickDeadline() {
    const base = readyBtn.dataset.base || readyBtn.textContent;
    const live = deadline && state?.phase === 'planning';
    const left = live ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
    readyBtn.textContent = live ? `${base} 0:${String(left).padStart(2, '0')}` : base;
    readyBtn.classList.toggle('hurry', live && left <= 10);
    if (live && left === 0) clearInterval(deadlineTimer);
  }

  // A Pokémon-battle screen wipe: black bars sweep across, the two trainers'
  // names meet over a Poké Ball, then the bars sweep away.
  function playIntro(names, avatars = []) {
    document.querySelector('#wipe')?.remove();
    const el = document.createElement('div');
    el.id = 'wipe';
    el.setAttribute('aria-live', 'polite');
    const bars = Array.from({ length: 8 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
    el.innerHTML = `<div class="bars">${bars}</div>
      <div class="vs-card">
        <span class="trainer left">${avatars[0] ? avatar(avatars[0], 'intro-avatar') : ''}${esc(names[0])}</span>
        <span class="ball" aria-hidden="true"></span>
        <span class="trainer right">${esc(names[1])}${avatars[1] ? avatar(avatars[1], 'intro-avatar') : ''}</span>
        <span class="vs-text">VS</span>
      </div>`;
    el.setAttribute('aria-label', `${names[0]} versus ${names[1]}`);
    document.body.append(el);
    setTimeout(() => el.classList.add('out'), 2300);
    setTimeout(() => el.remove(), 3100);
  }

  // Switch between playing the bot (null) and playing a friend as `viewer`.
  function setOnline(opts) {
    online = Boolean(opts);
    viewer = opts?.viewer ?? 0;
    setDeadline(null);
    started = online;
    playback?.cancel();
    playback = null;
    state = null; // the next render starts fresh, from this player's side
    closeMenu();
    closeDex();
  }

  // ---- Pokédex ---------------------------------------------------------------
  // Every Pokémon's stats, read straight from units.json, so new Pokémon and
  // stat changes show up here automatically. The Pokédex pop-up is a grid of
  // cards (summons too); a card opens that Pokémon's entry in a second pop-up
  // on top. In an entry the level chip steps through ★, ★★, ★★★ and shiny, and
  // related Pokémon (its transformation, its summon, who summons it) sit as
  // small sprites by the big one: tapping one swaps the two places.

  const entryEl = $('dex-entry');
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let dexForm = null; // index of dexPick's form the entry shows (null: the Pokémon itself)
  let dexStar = 0; // level shown in the entry

  dexEl.addEventListener('click', (e) => {
    if (e.target === dexEl || e.target.closest('#dex-close')) return closeDex();
    const pick = e.target.closest('[data-dex]');
    if (pick) openEntry(pick.dataset.dex);
  });
  entryEl.addEventListener('click', (e) => {
    if (e.target === entryEl || e.target.closest('#entry-close')) return closeEntry();
    if (e.target.closest('#dex-level')) return setDexLevel((dexStar + 1) % 4);
    const form = e.target.closest('[data-dex-form]');
    if (form) { const [id, i] = form.dataset.dexForm.split(':'); return swapEntry(id, Number(i)); }
    const pick = e.target.closest('[data-dex]');
    if (pick) swapEntry(pick.dataset.dex, null);
  });

  // The Pokédex grid; with an id (a team card's ⓘ), just that Pokémon's entry.
  function openDex(id) {
    if (id) return openEntry(id);
    renderDexGrid();
    dexEl.classList.remove('closing');
    dexEl.hidden = false;
  }
  function openEntry(id) {
    dexPick = id;
    dexForm = null;
    dexStar = 0;
    renderEntry();
    entryEl.classList.remove('closing');
    entryEl.hidden = false;
    entryEl.scrollTop = 0;
  }
  // Close a pop-up with the opening animation played backwards.
  function closeAnimated(el) {
    if (el.hidden || el.classList.contains('closing')) return;
    if (reduceMotion()) { el.hidden = true; return; }
    el.classList.add('closing');
    setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 200);
  }
  function closeEntry() {
    closeAnimated(entryEl);
  }
  function closeDex() {
    closeEntry();
    closeAnimated(dexEl);
  }

  // Keys while the Pokédex is open: ←/→ change the entry's level, Escape
  // closes the top pop-up.
  function dexKey(key) {
    const entryOpen = !entryEl.hidden;
    if (entryOpen && (key === 'arrowright' || key === 'arrowleft')) {
      return setDexLevel((dexStar + (key === 'arrowright' ? 1 : 3)) % 4);
    }
    if (key === 'escape' && entryOpen) return closeEntry();
    if (key === 'escape' || key === 'p') closeDex();
  }

  const typeName = (type) => type[0].toUpperCase() + type.slice(1);
  const summonIds = () => Object.keys(catalog).filter((id) => catalog[id].summon).sort();
  // A transformed form as a Pokémon of its own (HP carries over when the form has none).
  // A Pokémon's forms: Greninja's or Minior's one transformation, Alcremie's flavours.
  const formsOf = (def) => (def.ability?.form ? [def.ability.form] : def.ability?.chargedForm ? [def.ability.chargedForm] : def.ability?.flavors ?? []);
  const formDef = (def, i = 0) => {
    const f = formsOf(def)[i];
    return { ...def, ...f, hp: f.hp ?? def.hp, energy: f.energy ?? 0, ability: null, form: true };
  };
  const formKey = (id, i) => `form:${id}:${i}`;
  // Who summons this Pokémon.
  const summonersOf = (id) => troopIds(catalog).filter((t) => ['summon', 'darts'].includes(catalog[t].ability?.kind) && catalog[t].ability.unit === id);

  function dexCard(id) {
    const def = catalog[id];
    return `<button class="dex-card" data-dex="${id}" data-type="${def.type}">
      <span class="dex-card-art">${portrait(def)}</span>
      <b>${esc(def.name)}</b>
      <small>${def.summon ? 'Summon' : `${def.cost} 🪙`} · ${typeName(def.type)}</small>
    </button>`;
  }

  function renderDexGrid() {
    const summons = summonIds();
    dexEl.querySelector('.dex-panel').innerHTML = `
      <button id="dex-close" class="ghost" aria-label="Close">✕</button>
      <h1>Pokédex</h1>
      <p class="muted dex-sub">Tap a Pokémon to see its stats and power.</p>
      <div class="dex-grid">${troopIds(catalog).map(dexCard).join('')}</div>
      ${summons.length ? `<h3 class="dex-section">Summoned in battle</h3><div class="dex-grid">${summons.map(dexCard).join('')}</div>` : ''}`;
  }

  // The stat shape: four stats as a diamond. Each point is the stat divided
  // by the highest value any Pokémon (or form) has at the same level, plus a
  // little headroom (RADAR_HEADROOM), so even the best stops short of the edge
  // and shapes compare directly.
  const RADAR_HEADROOM = 1.12; // the best reaches ~89% of the way out
  const RADAR = [['hp', 'HP'], ['atk', 'Damage'], ['spd', 'Atk speed'], ['move', 'Speed']];
  const radarRaw = (def, star) => {
    const st = unitStats(def, star);
    return {
      hp: st.hp, atk: st.atk, spd: 1 / attackTime(st),
      move: 1 / (MOVE_SPEEDS[def.moveSpeed] + STEP_TICKS * TICK_SECONDS),
    };
  };
  const radarTop = [];
  function radarValues(def, star) {
    if (!radarTop[star]) {
      const defs = Object.values(catalog).flatMap((d) => [d, ...formsOf(d).map((_, i) => formDef(d, i))]);
      const raws = defs.map((d) => radarRaw(d, star));
      radarTop[star] = Object.fromEntries(RADAR.map(([k]) => [k, Math.max(...raws.map((r) => r[k]))]));
    }
    const raw = radarRaw(def, star);
    return RADAR.map(([k]) => Math.min(1, raw[k] / (radarTop[star][k] * RADAR_HEADROOM)));
  }
  const RADAR_R = 70;
  const radarPoint = (i, v) => {
    const a = ((2 * Math.PI) / RADAR.length) * i - Math.PI / 2;
    return [100 + Math.cos(a) * RADAR_R * v, 100 + Math.sin(a) * RADAR_R * v];
  };
  const radarPoints = (vals) => vals.map((v, i) => radarPoint(i, Math.max(0.04, v)).map((n) => n.toFixed(1)).join(',')).join(' ');
  function radarSvg(vals) {
    const ring = (f) => `<polygon class="ring" points="${radarPoints(RADAR.map(() => f))}"/>`;
    const axes = RADAR.map((_, i) => { const [x, y] = radarPoint(i, 1); return `<line x1="100" y1="100" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('');
    const labels = RADAR.map(([, label], i) => {
      const [x, y] = radarPoint(i, i % 2 ? 1.36 : 1.2);
      return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}">${label}</text>`;
    }).join('');
    return `<svg class="dex-radar" viewBox="-12 -2 224 204" role="img" aria-label="Stat shape">
      ${ring(1)}${ring(2 / 3)}${ring(1 / 3)}<g class="axes">${axes}</g>
      <polygon class="shape" points="${radarPoints(vals)}" data-vals="${vals.join(',')}"/>${labels}</svg>`;
  }
  function tweenRadar(poly, to) {
    const from = poly.dataset.vals.split(',').map(Number);
    poly.dataset.vals = to.join(',');
    if (reduceMotion()) { poly.setAttribute('points', radarPoints(to)); return; }
    const start = performance.now();
    cancelAnimationFrame(poly._tween);
    const step = (now) => {
      const k = Math.min(1, (now - start) / 320);
      const e = 1 - (1 - k) ** 3;
      poly.setAttribute('points', radarPoints(from.map((f, i) => f + (to[i] - f) * e)));
      if (k < 1) poly._tween = requestAnimationFrame(step);
    };
    poly._tween = requestAnimationFrame(step);
  }

  // The parts of an entry that change with the level.
  function dexLevelValues(def, star, formOf, formIndex = 0) {
    const st = unitStats(def, star);
    let power = '';
    const f = formOf && formsOf(formOf)[formIndex];
    if (f && f === formOf.ability.chargedForm) {
      power = `${esc(formOf.name)} takes this form while its power is charged, and turns back when it binds a Pokémon. Same stats as ${esc(formOf.name)}.`;
    } else if (f?.flavor) {
      // An Alcremie flavour: what its treat does.
      const p = formOf.ability;
      const amount = (pct) => show(Math.floor((formOf.damage[star] * STAT_SCALE * pct) / 100));
      power = {
        heal: `Heals the ally with the lowest share of HP for ${vHeal(`${f.healPct}%`)} of ${esc(formOf.name)}'s damage (${vHeal(amount(f.healPct))}), spread over ${vTime(p.duration)}.`,
        haste: `The hardest-hitting ally attacks ${vNum(`${f.hastePct}%`)} faster for ${vTime(p.duration)}.`,
        guard: `Shields the ally most enemies are attacking for ${vTime(p.duration)}: it takes ${vNum(`${f.guardPct}%`)} less damage, and the first stun or knockback only breaks the shield.`,
      }[f.flavor] + ` ${esc(formOf.name)} keeps this form until its next Sweet Treat.`;
    } else if (f) {
      power = [
        `${esc(formOf.name)} stays in this form for the rest of the fight.`,
        !f.hp && `It keeps ${esc(formOf.name)}'s HP.`,
        f.shockwave && `As it changes, a shock wave stuns every enemy in the ${area(f.shockwave.radius)} around it for ${vTime(f.shockwave.stun)}.`,
        f.blink && 'It doesn\'t walk: it zips straight to the square beside its target.',
        f.hop && `Every ${vNum(f.energy)} attacks it zips to a different enemy.`,
      ].filter(Boolean).join(' ');
    } else if (def.ability) power = powerText(def, star, catalog)?.text ?? '';
    // Numbers in the text get their own spans so a level change can count them.
    power = power.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(/\d+(?:\.\d+)?/g, '<span class="pn">$&</span>'))).join('');
    return {
      hp: String(show(st.hp)), dmg: String(show(st.atk)), power,
    };
  }

  // Change the level in the open entry without redrawing it: numbers count to
  // their new values and the power text cross-fades.
  function setDexLevel(star) {
    dexStar = star;
    const detail = entryEl.querySelector('.dex-detail');
    if (!detail) return renderEntry();
    const base = catalog[dexPick];
    const isForm = dexForm !== null && Boolean(formsOf(base)[dexForm]);
    const shown = isForm ? formDef(base, dexForm) : base;
    const v = dexLevelValues(shown, star, isForm ? base : null, dexForm ?? 0);
    const poly = detail.querySelector('.dex-radar .shape');
    if (poly) tweenRadar(poly, radarValues(shown, star));
    const lvl = detail.querySelector('#dex-level');
    lvl.innerHTML = `<span class="stars s${star}">${levelMark(star)}</span>`;
    lvl.setAttribute('aria-label', `Level: ${LEVEL_NAMES[star]}. Tap for the next level.`);
    lvl.classList.remove('bump'); void lvl.offsetWidth; lvl.classList.add('bump');
    for (const el of detail.querySelectorAll('[data-k]')) {
      const next = v[el.dataset.k];
      if (next == null) continue;
      if (el.dataset.k === 'power') {
        // Same sentence with different numbers (the usual case): only the
        // numbers count to their new values. Otherwise swap the text in place.
        const nums = [...el.querySelectorAll('.pn')];
        const tmp = document.createElement('p');
        tmp.innerHTML = next;
        const nextNums = [...tmp.querySelectorAll('.pn')];
        const shape = (root) => root.innerHTML.replace(/<span class="pn">[^<]*<\/span>/g, '#');
        if (nums.length === nextNums.length && shape(el) === shape(tmp)) {
          nums.forEach((n, i) => { if (n.textContent !== nextNums[i].textContent) tweenNumber(n, nextNums[i].textContent); });
        } else el.innerHTML = next;
        continue;
      }
      const b = el.querySelector('b');
      if (b.textContent !== next) tweenNumber(b, next);
    }
  }
  function tweenNumber(el, to) {
    const from = parseFloat(el.textContent) || 0;
    const target = parseFloat(to);
    const places = (to.split('.')[1] ?? '').length;
    const start = performance.now();
    const ms = 280;
    const chip = el.closest('.dex-chip');
    chip?.classList.add('changing');
    cancelAnimationFrame(el._tween);
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - k) ** 3;
      el.textContent = k < 1 ? (from + (target - from) * e).toFixed(places) : to;
      if (k < 1) el._tween = requestAnimationFrame(step);
      else chip?.classList.remove('changing');
    };
    el._tween = requestAnimationFrame(step);
  }

  // Tapping a related Pokémon: it grows into the big spot while the current one
  // shrinks into the small spot (FLIP: measure, redraw, play from the old places).
  function swapEntry(id, form) {
    const oldKey = dexForm !== null ? formKey(dexPick, dexForm) : dexPick;
    const newKey = form !== null ? formKey(id, form) : id;
    const was = (key) => entryEl.querySelector(`[data-key="${key}"]`)?.getBoundingClientRect();
    const fromMain = was(oldKey); // the big sprite now
    const fromSmall = was(newKey); // the small sprite that was tapped
    dexPick = id;
    dexForm = form;
    renderEntry({ fade: true });
    if (!fromMain || !fromSmall || reduceMotion()) return;
    const play = (key, from) => {
      const el = entryEl.querySelector(`[data-key="${key}"]`);
      if (!el) return;
      const to = el.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` },
        { transform: 'none' },
      ], { duration: 420, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' });
    };
    play(newKey, fromSmall); // grows from the small spot
    play(oldKey, fromMain); // shrinks from the big spot
  }

  function renderEntry({ fade = false } = {}) {
    const base = catalog[dexPick];
    if (!base) return closeEntry();
    const isForm = dexForm !== null && Boolean(formsOf(base)[dexForm]);
    const def = isForm ? formDef(base, dexForm) : base;
    const star = dexStar;
    const copycat = isCopycat(def);
    const v = dexLevelValues(def, star, isForm ? base : null, dexForm ?? 0);
    const st = unitStats(def, star);
    // Each number gets room for its widest value at any level, so chips keep
    // their size as the level changes.
    const all = [0, 1, 2, 3].map((s2) => dexLevelValues(def, s2, isForm ? base : null, dexForm ?? 0));
    const width = (k) => Math.max(...all.map((x) => String(x[k] ?? '').length));
    const chip = (k, label, value) => `<span class="dex-chip"${k ? ` data-k="${k}"` : ''}><small>${label}</small><b${k ? ` style="min-width:${width(k)}ch"` : ''}>${value}</b></span>`;
    const chips = [
      chip('hp', 'HP', v.hp),
      !copycat && chip('dmg', 'Damage', v.dmg),
      !copycat && chip('', 'Attacks every', `${attackTime(st)}s`),
      !copycat && chip('', 'Range', def.range > 1 ? `${def.range} tiles` : 'Melee'),
      chip('', 'Speed', SPEED_NAME[def.moveSpeed]),
    ].filter(Boolean).join('');
    const power = isForm
      ? `<div class="dex-power"><h3>${esc(base.ability.name)} ${formsOf(base)[dexForm].flavor ? 'flavour' : 'form'}</h3><p data-k="power">${v.power}</p></div>`
      : def.ability ? `<div class="dex-power"><h3>${esc(def.ability.name)} <span class="pw-when">${powerText(def, star, catalog).when}</span></h3><p data-k="power">${v.power}</p></div>` : '';

    // Related Pokémon: [def, attributes, label, key].
    const related = [];
    const forms = formsOf(base);
    if (isForm) related.push([base, `data-dex="${dexPick}"`, `Transforms from ${base.name}`, dexPick]);
    forms.forEach((f, i) => {
      if (isForm && i === dexForm) return;
      related.push([formDef(base, i), `data-dex-form="${dexPick}:${i}"`, `${isForm ? 'Also becomes' : forms.length > 1 ? 'Can become' : 'Transforms into'} ${f.name}`, formKey(dexPick, i)]);
    });
    if (!isForm && ['summon', 'darts'].includes(def.ability?.kind) && catalog[def.ability.unit]) related.push([catalog[def.ability.unit], `data-dex="${def.ability.unit}"`, `Summons ${catalog[def.ability.unit].name}`, def.ability.unit]);
    if (def.summon) for (const t of summonersOf(dexPick)) related.push([catalog[t], `data-dex="${t}"`, `Summoned by ${catalog[t].name}`, t]);
    const sprite = (d, cls, key) => `<span class="portrait ${cls}" data-facing="down" data-key="${key}"><span class="sprite" ${spriteStyle(d)}></span></span>`;
    const relatedHtml = related.map(([d, attrs, label, key]) => `<button class="dex-rel" ${attrs} title="${esc(label)}" aria-label="${esc(label)}">${sprite(d, 'dex-rel-sprite', key)}</button>`).join('');

    const tag = isForm ? 'Transformed form' : def.summon ? 'Summoned in battle' : `${def.cost} coins`;
    entryEl.querySelector('.dex-panel').dataset.type = def.type;
    entryEl.querySelector('.dex-panel').innerHTML = `
      <button id="entry-close" class="ghost" aria-label="Close">✕</button>
      <section class="dex-detail${fade ? ' refresh' : ''}" data-type="${def.type}">
        <div class="dex-hero">
          <div class="dex-figure">
            <div class="dex-art">
              ${sprite(def, 'dex-portrait', isForm ? formKey(dexPick, dexForm) : dexPick)}
              ${relatedHtml ? `<div class="dex-rels">${relatedHtml}</div>` : ''}
            </div>
            <button id="dex-level" class="dex-level" title="Tap for the next level (→)" aria-label="Level: ${LEVEL_NAMES[star]}. Tap for the next level."><span class="stars s${star}">${levelMark(star)}</span></button>
          </div>
          <div class="dex-title">
            <h2>${esc(def.name)}</h2>
            <p class="dex-tags"><span class="dex-type">${typeName(def.type)}</span><span>${tag}</span></p>
            ${related.length ? `<p class="dex-rel-names">${related.map(([, attrs, label]) => `<button class="linkish" ${attrs}>${esc(label)}</button>`).join('')}</p>` : ''}
          </div>
        </div>
        <div class="dex-statbox">
          ${copycat ? '' : radarSvg(radarValues(def, star))}
          <div class="dex-chips">${chips}</div>
        </div>
        ${power}
      </section>`;
  }

  // A standing notice about the online connection (null hides it).
  let netEl = null;
  function setNetStatus(text) {
    if (!text) { netEl?.remove(); netEl = null; return; }
    if (!netEl) {
      netEl = document.createElement('div');
      netEl.className = 'net-status';
      netEl.setAttribute('role', 'status');
      document.body.append(netEl);
    }
    netEl.textContent = text;
  }

  return { render, toast, showLobby, showFriends, setOnline, setDeadline, setNetStatus, netStatus: () => netEl?.textContent ?? null, playIntro, lobbyView: () => lobbyView };
}
