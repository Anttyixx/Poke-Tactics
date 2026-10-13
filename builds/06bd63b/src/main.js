// Entry point. Three ways to play, all through the same dispatch() -> applyIntent():
//   bot   - you (player 0) vs. the local bot (player 1)
//   host  - you (player 0) vs. a friend online. This browser runs the match: the
//           friend's intents arrive over the connection, are validated here like
//           anyone's, and the new state is sent back after every change.
//   guest - you (player 1) on a friend's match. Intents go to the host; the
//           screen only ever shows the state the host sends.
//
// Protocol (JSON over the PeerJS connection; pings and goodbyes live in net.js):
//   guest -> host  { type: 'hello', version, name, avatar, guestId }   first message; sent again with the
//                  same guestId after a dropped connection, to pick the match back up
//                  { type: 'intent', intent }
//                  { type: 'rematch' }                 "Play again" after a match
//   host -> guest  { type: 'state', state }            after every change
//                  { type: 'reject', error }           the guest's intent was refused
//                  { type: 'refuse', error }           can't play (different versions)
//                  { type: 'full' }                    someone else already joined
//                  { type: 'log', log }                the match log (at game over, or on request)
//                  { type: 'resync' }                  "I can't hear you": the guest replaces its connection
//   guest -> host  { type: 'getLog' }                  ask for the match log mid-match
//                  { type: 'sync' }                    "are you there?": the host answers with the state

import { createGame, applyIntent } from './game.js?v=06bd63b';
import { botTurn } from './bot.js?v=06bd63b';
import { createUI } from './ui.js?v=06bd63b';
import { hashSeed } from './rng.js?v=06bd63b';
import { hostRoom, joinRoom, cleanCode, isCode, checkConnection, randomCode, GONE_MS } from './net.js?v=06bd63b';
import { loadProfile, saveProfile, recordBattle, recordMatch, removeFriend, cleanName, validAvatar, BOT_AVATAR, DEFAULT_AVATAR } from './profile.js?v=06bd63b';

const BOT = 1;
// Online, each planning phase lasts this long; then everyone still planning is
// locked in as they are. The host's clock decides; both screens count down.
const PLAN_SECONDS = 30;

const catalogText = await (await fetch('data/units.json?v=06bd63b')).text();
const catalog = JSON.parse(catalogText);
// What's new: newest first. Add an entry to data/changelog.json with each update.
const changelog = await fetch('data/changelog.json?v=06bd63b').then((r) => (r.ok ? r.json() : [])).catch(() => []);
// Both players must run the same rules and Pokémon. The deploy tags every file
// with its build (?v=...); locally there's no tag, so compare the data instead.
const VERSION = `${new URL(import.meta.url).searchParams.get('v') ?? 'local'}:${hashSeed(catalogText)}`;

let state;
let firstGame = true;
let mode = 'bot'; // 'bot' | 'host' | 'guest'
let link = null; // the connection to the friend, online
let room = null; // host: the open room ({ code, cancel }), kept for the whole match so the guest can rejoin
let guestId = null; // host: who the guest is; guest: who we are (to rejoin after a drop)
let away = false; // the friend has gone quiet or their connection dropped
let giveUpTimer = 0; // host: ends the match if a dropped guest doesn't come back
let awayTimer = 0; // host: moves an away guest past the battle results
let profile = loadProfile(); // name and picture, saved in this browser
const myName = () => profile.name || 'You';
let names = [myName(), 'Bot'];
let avatars = [profile.avatar, BOT_AVATAR];
let me = 0; // which player this browser is
let timerKey = null; // the planning phase the countdown belongs to ("seed:round")
let lockTimer = 0;
// Every move both players make, in order. With the game's seed this rebuilds
// the whole match exactly (tools/replay.mjs), for analysis after a PvP game.
// Kept where the rules run (host, or bot games); the guest gets a copy.
let matchLog = null;
let logWaiters = []; // guest: callbacks waiting for the host's copy
const BUILD = new URL(import.meta.url).searchParams.get('v') ?? 'local';

const ui = createUI({
  catalog,
  viewer: 0,
  onIntent: (intent) => (mode === 'guest' ? sendIntent(intent) : dispatch(me, intent)),
  onNewGame: () => (mode === 'guest' ? link?.send({ type: 'rematch' }) : newGame()),
  onLobby: lobby,
  onProfile: updateProfile,
  onRemoveFriend: (id) => { profile = removeFriend(id); return profile; },
  getProfile: () => profile,
  getLog,
  changelog,
  version: changelog[0]?.version ?? null,
  build: new URL(import.meta.url).searchParams.get('v'),
});

function getLog() {
  if (mode !== 'guest') return Promise.resolve(matchLog);
  return new Promise((resolve) => {
    logWaiters.push(resolve);
    link?.send({ type: 'getLog' });
    setTimeout(() => { logWaiters = logWaiters.filter((w) => w !== resolve); resolve(matchLog); }, 4000);
  });
}

const record = (player, intent) => matchLog?.intents.push([player, intent]);

function newGame() {
  const params = new URLSearchParams(location.search);
  // ?seed=anything makes the first match reproducible (handy for bug reports).
  const param = params.get('seed');
  const seed = firstGame && param ? hashSeed(param) : crypto.getRandomValues(new Uint32Array(1))[0];
  firstGame = false;
  // ?unit=<id> puts that unit in the first slot of every shop (for testing new units).
  const featured = mode === 'bot' ? params.get('unit')?.toLowerCase() || null : null;
  state = createGame({ seed, catalog, names, avatars, featured });
  matchLog = {
    format: 'poke-tactics-match', v: 1, build: BUILD, catalogHash: hashSeed(catalogText),
    mode: mode === 'bot' ? 'training' : 'pvp', started: new Date().toISOString(),
    seed: state.seed, names: [...names], featured: state.featured, intents: [],
  };
  if (featured && !state.featured) setTimeout(() => ui.toast(`Unknown unit "${featured}" in ?unit=`), 0);
  runBot();
  show();
  broadcast();
}

function dispatch(player, intent) {
  const res = applyIntent(state, catalog, player, intent);
  if (res.ok) record(player, intent);
  if (!res.ok) {
    if (player === me) ui.toast(res.error);
    else if (mode === 'host') link?.send({ type: 'reject', error: res.error });
    else console.warn('Bot intent rejected', intent, res.error);
    return res;
  }
  runBot();
  show();
  broadcast();
  return res;
}

function runBot() {
  if (mode !== 'bot' || state.players[BOT].ready) return;
  const send = (intent) => {
    const res = applyIntent(state, catalog, BOT, intent);
    if (res.ok) record(BOT, intent);
    return res;
  };
  if (state.phase === 'planning' || state.phase === 'team') botTurn(state, catalog, BOT, send);
  else if (state.phase === 'combat') send({ type: 'continue' });
}

function show() {
  trackStats();
  ui.render(state);
  planClock();
  awayContinue();
}

// Host: a guest who's away can't press Continue after a battle. Once the
// battle has had time to play out, continue for them so the match goes on.
let awayKey = null;
function awayContinue() {
  if (mode !== 'host' || !away || state.phase !== 'combat' || state.players[1].ready) return;
  const key = `${state.seed}:${state.round}`;
  if (key === awayKey) return;
  awayKey = key;
  clearTimeout(awayTimer);
  awayTimer = setTimeout(() => {
    if (mode === 'host' && away && state.phase === 'combat' && `${state.seed}:${state.round}` === key && !state.players[1].ready) dispatch(1, { type: 'continue' });
  }, state.combat.result.ticks * 100 + 5000);
}

// Profile stats: each battle counts the Pokémon this player fielded; each
// finished match counts a win, loss or draw (online and training separately).
let trackedKey = null;
function trackStats() {
  const key = `${state.seed}:${state.round}:${state.phase}`;
  if (key === trackedKey) return;
  trackedKey = key;
  if (state.phase === 'combat') {
    profile = recordBattle(state.combat.result.initial.filter((u) => u.side === me && !u.summoned).map((u) => u.unitId));
  } else if (state.phase === 'gameover') {
    profile = recordMatch(mode === 'bot' ? 'training' : 'online', state.winner === me ? 'win' : state.winner === null ? 'draw' : 'loss');
  }
}

// Start the countdown when a new planning phase begins (online only).
function planClock() {
  if (mode === 'bot' || state.phase !== 'planning') return;
  const key = `${state.seed}:${state.round}`;
  if (key === timerKey) return;
  timerKey = key;
  ui.setDeadline(Date.now() + PLAN_SECONDS * 1000);
  if (mode !== 'host') return;
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    if (mode !== 'host' || state.phase !== 'planning' || `${state.seed}:${state.round}` !== key) return;
    for (const p of [0, 1]) if (state.phase === 'planning' && !state.players[p].ready) dispatch(p, { type: 'ready' });
  }, PLAN_SECONDS * 1000);
}

const broadcast = () => {
  if (mode !== 'host') return;
  link?.send({ type: 'state', state });
  if (state.phase === 'gameover') link?.send({ type: 'log', log: matchLog });
};

// The guest can't check intents itself (the host has the real state), so it
// reports success; a refusal comes back as a toast.
function sendIntent(intent) {
  link?.send({ type: 'intent', intent });
  return { ok: true };
}

// ---- online ----------------------------------------------------------------

const savedName = () => profile.name;
// The name typed in the lobby is saved to the profile too.
function playerName(name) {
  const clean = cleanName(name);
  if (clean !== profile.name) profile = saveProfile({ ...profile, name: clean });
  return clean;
}

// The profile screen saved a new name or picture. In a game against the bot it
// shows right away; online, from the next match.
function updateProfile(next) {
  profile = saveProfile(next);
  if (mode === 'bot') {
    names = [myName(), 'Bot'];
    avatars = [profile.avatar, BOT_AVATAR];
    if (state) { state.players[0].name = names[0]; state.players[0].avatar = avatars[0]; show(); }
  }
  return profile;
}

function lobby(action, data = {}) {
  if (action === 'open') {
    const join = cleanCode(new URLSearchParams(location.search).get('join'));
    return ui.showLobby('menu', { name: savedName(), code: join });
  }
  if (action === 'host') return host(playerName(data.name) || 'Player 1');
  if (action === 'join') {
    const code = cleanCode(data.code);
    if (!isCode(code)) return ui.toast('Codes are 5 letters and numbers, like KOKO4.');
    return join(code, playerName(data.name) || 'Player 2');
  }
  if (action === 'cancel') { stopHosting(); link = null; return ui.showLobby('menu', { name: savedName() }); }
  if (action === 'leave') return leave();
  if (action === 'check') {
    ui.showLobby('checking');
    return checkConnection().then((result) => {
      console.info('Connection check', result);
      if (ui.lobbyView() === 'checking') ui.showLobby('check', result);
    });
  }
  if (action === 'home') return goHome();
}

async function host(name) {
  stopHosting();
  ui.showLobby('connecting', { text: 'Creating a game…' });
  try {
    const r = await hostRoom({
      onMessage: hostMessage,
      onClose: hostLinkClosed,
      onQuiet: (quiet, l) => { if (l === link && mode === 'host') { setAway(quiet); if (quiet) nudge(l); } },
      onError: (error) => { stopHosting(); ui.showLobby('error', { error }); },
    });
    room = r;
    guestId = null;
    names = [name, 'Friend'];
    avatars = [profile.avatar, DEFAULT_AVATAR];
    const url = new URL(location.href);
    url.search = `?join=${r.code}`;
    ui.showLobby('hosting', { code: r.code, link: url.href });
  } catch (err) {
    ui.showLobby('error', { error: err.message });
  }
}

function hostMessage(msg, l) {
  if (msg.type === 'hello') {
    if (l === link) return; // a repeat (the guest re-sends until the game starts)
    if (mode === 'host') {
      // Mid-match: only the same guest, coming back after a dropped connection.
      if (typeof msg.guestId === 'string' && msg.guestId === guestId) {
        const old = link;
        link = l;
        old?.close();
        clearTimeout(giveUpTimer);
        setAway(false);
        l.send({ type: 'state', state });
      } else {
        l.send({ type: 'full' });
        setTimeout(() => l.close(), 300);
      }
      return;
    }
    if (!room) return;
    if (msg.version !== VERSION) {
      l.send({ type: 'refuse', error: 'You and your friend have different versions of the game. Both of you refresh the page (or open the same link) and try again.' });
      setTimeout(() => l.close(), 300);
      ui.showLobby('error', { error: 'Your friend has a different version of the game. Both of you refresh the page (or open the same link) and try again.' });
      stopHosting();
      return;
    }
    link = l;
    guestId = typeof msg.guestId === 'string' ? msg.guestId.slice(0, 40) : null;
    mode = 'host';
    me = 0;
    names = [names[0], cleanName(msg.name) || 'Player 2'];
    avatars = [profile.avatar, validAvatar(msg.avatar) ? msg.avatar : DEFAULT_AVATAR]; // untrusted: only known pictures
    ui.setOnline({ viewer: 0 });
    newGame();
    ui.playIntro(names, avatars);
  } else if (mode !== 'host' || l !== link) {
    // Not in a match yet, or not the player: ignore anything else.
  } else if (msg.type === 'intent') {
    dispatch(1, msg.intent);
  } else if (msg.type === 'getLog') {
    l.send({ type: 'log', log: matchLog });
  } else if (msg.type === 'sync') {
    l.send({ type: 'state', state });
  } else if (msg.type === 'rematch' && state.phase === 'gameover') {
    newGame();
  }
}

// Host: the guest has gone quiet. Their page may be asleep, or their messages
// may not be getting through even though ours reach them; keep telling them to
// reconnect until they're back.
let nudgeTimer = 0;
function nudge(l) {
  clearInterval(nudgeTimer);
  l.send({ type: 'resync' });
  nudgeTimer = setInterval(() => {
    if (mode !== 'host' || link !== l || !away) return clearInterval(nudgeTimer);
    l.send({ type: 'resync' });
  }, 3000);
}

// Host: a connection closed. Only the player's matters. If it broke (rather
// than the guest leaving), keep the match going and wait for them to rejoin.
function hostLinkClosed(reason, l) {
  if (l !== link) return;
  link = null;
  if (mode !== 'host') return; // still in the waiting room: wait for someone else
  if (reason === 'lost') {
    setAway(true);
    clearTimeout(giveUpTimer);
    giveUpTimer = setTimeout(() => { if (mode === 'host' && !link) disconnected('timeout'); }, GONE_MS);
    return;
  }
  disconnected(reason);
}

// The friend went quiet or dropped (true), or is back (false).
function setAway(isAway) {
  if (away === isAway) return;
  away = isAway;
  const who = mode === 'host' ? names[1] : state?.players[0]?.name ?? 'your friend';
  if (isAway) {
    ui.setNetStatus(mode === 'host'
      ? `${who}'s connection dropped. They're locked in when the timer runs out; waiting for them to come back…`
      : `Lost touch with ${who}. Reconnecting…`);
    awayKey = null;
    if (state) awayContinue();
  } else {
    ui.setNetStatus(null);
    clearTimeout(awayTimer);
    ui.toast(mode === 'host' ? `${who} is back` : 'Reconnected');
  }
}

// Guest: check the connection still works (set while in a match).
let guestResync = null;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') guestResync?.(); });

async function join(code, name) {
  stopHosting();
  ui.showLobby('connecting', { text: `Joining ${code}…`, cancel: true });
  guestId = randomCode() + randomCode();
  const myId = guestId;
  const live = () => guestId === myId;
  let started = false;
  let statesSeen = 0;
  let reconnecting = false;
  let giveUpAt = 0; // while getting back in: when to stop trying
  let syncTimer = 0;

  // Each connection gets its own handlers, and only the current one counts:
  // an old connection that closes or wakes up late can't disturb the new one.
  const handlersFor = (box) => ({
    onMessage: (msg) => {
      if (!live() || box.link !== link) return;
      if (msg.type === 'state') {
        statesSeen++;
        giveUpAt = 0;
        clearTimeout(syncTimer);
        if (!started) {
          started = true;
          mode = 'guest';
          me = 1;
          ui.setOnline({ viewer: 1 });
          const [mine, theirs] = [msg.state.players[1], msg.state.players[0]];
          ui.playIntro([mine.name, theirs.name], [mine.avatar, theirs.avatar]);
        }
        state = msg.state;
        show();
        setAway(false); // the host answered: we're really back
      } else if (msg.type === 'reject') ui.toast(msg.error);
      else if (msg.type === 'resync') {
        // The host can't hear us: this connection only works one way. Replace it.
        if (started && !reconnecting) { const l = link; link = null; l.drop(); reconnect(); }
      } else if (msg.type === 'log') {
        matchLog = msg.log;
        for (const w of logWaiters) w(matchLog);
        logWaiters = [];
      } else if (msg.type === 'refuse' || msg.type === 'full') {
        const l = link;
        link = null;
        l?.close();
        if (started) return disconnected('refused');
        ui.showLobby('error', { error: msg.type === 'full' ? 'That game already has two players.' : msg.error });
      }
    },
    // Gone quiet: check whether the host is still there.
    onQuiet: (quiet) => { if (live() && box.link === link && started && quiet) { setAway(true); resync(); } },
    onClose: (reason) => {
      if (!live() || box.link !== link || reason === 'self') return;
      link = null;
      if (started && reason !== 'left') return reconnect();
      disconnected(reason);
    },
  });

  // Say hello until a state arrives, in case the first one is lost.
  const greet = (l) => {
    const before = statesSeen;
    const hello = () => {
      if (link !== l || statesSeen !== before) return;
      l.send({ type: 'hello', version: VERSION, name, avatar: profile.avatar, guestId: myId });
      setTimeout(hello, 1000);
    };
    hello();
  };

  // Ask the host for the state. No answer in a few seconds means this
  // connection is dead even if it looks open (phones often wake up like
  // that): replace it.
  const resync = () => {
    if (!live() || mode !== 'guest' || !link || reconnecting) return;
    const l = link;
    const before = statesSeen;
    l.send({ type: 'sync' });
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (live() && link === l && statesSeen === before) { link = null; l.drop(); reconnect(); }
    }, 4000);
  };
  guestResync = resync;

  // Mid-match the connection broke: get back into the same room. The host
  // knows us by guestId and picks the match back up.
  const reconnect = async () => {
    if (reconnecting) return;
    reconnecting = true;
    setAway(true);
    giveUpAt ||= Date.now() + GONE_MS;
    while (live() && mode === 'guest' && !link) {
      if (Date.now() > giveUpAt) { reconnecting = false; return disconnected('timeout'); }
      try {
        const box = {};
        const l = await joinRoom(code, handlersFor(box));
        if (!live() || mode !== 'guest' || link) { l.drop(); break; }
        box.link = l;
        link = l;
        greet(l); // "Reconnected" shows once the host sends the state back
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    reconnecting = false;
  };

  try {
    const box = {};
    const l = await joinRoom(code, handlersFor(box));
    if (ui.lobbyView() !== 'connecting' || !live()) { l.close(); return; } // cancelled while connecting
    box.link = l;
    link = l;
    greet(l);
    ui.showLobby('connecting', { text: 'Connected! Waiting for the game to start…' });
  } catch (err) {
    if (ui.lobbyView() === 'connecting') ui.showLobby('error', { error: err.message });
  }
}

function stopHosting() {
  room?.cancel();
  room = null;
}

// The match is over for good: tell the player why.
function disconnected(reason) {
  const wasPlaying = mode !== 'bot';
  link?.close();
  link = null;
  stopHosting();
  guestId = null;
  clearTimeout(lockTimer); // nobody to lock in any more
  clearTimeout(giveUpTimer);
  clearTimeout(awayTimer);
  away = false;
  ui.setNetStatus(null);
  ui.setDeadline(null);
  if (reason === 'self' || !wasPlaying) return;
  const who = mode === 'host' ? names[1] : state?.players[0]?.name ?? names[0];
  ui.showLobby('disconnected', { error: reason === 'timeout' ? `Lost the connection to ${who}.` : reason === 'refused' ? `Couldn't get back into the game with ${who}.` : `${who} left the game.` });
}

function leave() {
  link?.close();
  link = null;
  guestId = null;
  goHome();
}

// Back to the start screen with a fresh game against the bot.
function goHome() {
  stopHosting();
  guestId = null;
  clearTimeout(giveUpTimer);
  clearTimeout(awayTimer);
  away = false;
  ui.setNetStatus(null);
  clearTimeout(lockTimer);
  timerKey = null;
  mode = 'bot';
  me = 0;
  names = [myName(), 'Bot'];
  avatars = [profile.avatar, BOT_AVATAR];
  ui.setOnline(null);
  newGame();
}

// Debug handle for the browser console: `game.state`
window.game = { get state() { return state; }, get mode() { return mode; }, catalog, dispatch };

newGame();
// A shared invite link (?join=CODE) goes straight to the join screen.
if (new URLSearchParams(location.search).get('join')) lobby('open');
