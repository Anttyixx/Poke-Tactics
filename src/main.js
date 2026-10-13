// Entry point. Three ways to play, all through the same dispatch() -> applyIntent():
//   bot   - you (player 0) vs. the local bot (player 1)
//   host  - you (player 0) vs. a friend online. This browser runs the match: the
//           friend's intents arrive over the connection, are validated here like
//           anyone's, and the new state is sent back after every change.
//   guest - you (player 1) on a friend's match. Intents go to the host; the
//           screen only ever shows the state the host sends.
//
// Protocol (JSON over the PeerJS connection; pings and goodbyes live in net.js):
//   guest -> host  { type: 'hello', version, name, avatar }   first message
//                  { type: 'intent', intent }
//                  { type: 'rematch' }                 "Play again" after a match
//   host -> guest  { type: 'state', state }            after every change
//                  { type: 'reject', error }           the guest's intent was refused
//                  { type: 'refuse', error }           can't play (different versions)
//                  { type: 'full' }                    someone else already joined
//                  { type: 'log', log }                the match log (at game over, or on request)
//   guest -> host  { type: 'getLog' }                  ask for the match log mid-match

import { createGame, applyIntent } from './game.js';
import { botTurn } from './bot.js';
import { createUI } from './ui.js';
import { hashSeed } from './rng.js';
import { hostRoom, joinRoom, cleanCode, isCode, checkConnection } from './net.js';
import { loadProfile, saveProfile, recordBattle, recordMatch, removeFriend, cleanName, validAvatar, BOT_AVATAR, DEFAULT_AVATAR } from './profile.js';

const BOT = 1;
// Online, each planning phase lasts this long; then everyone still planning is
// locked in as they are. The host's clock decides; both screens count down.
const PLAN_SECONDS = 30;

const catalogText = await (await fetch('data/units.json')).text();
const catalog = JSON.parse(catalogText);
// What's new: newest first. Add an entry to data/changelog.json with each update.
const changelog = await fetch('data/changelog.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
// Both players must run the same rules and Pokémon. The deploy tags every file
// with its build (?v=...); locally there's no tag, so compare the data instead.
const VERSION = `${new URL(import.meta.url).searchParams.get('v') ?? 'local'}:${hashSeed(catalogText)}`;

let state;
let firstGame = true;
let mode = 'bot'; // 'bot' | 'host' | 'guest'
let link = null; // the connection to the friend, online
let hosting = null; // a room waiting for a friend: { code, cancel }
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
  if (action === 'cancel') { stopHosting(); return ui.showLobby('menu', { name: savedName() }); }
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
    const room = await hostRoom({
      onGuest: (l) => { link = l; },
      onMessage: hostMessage,
      onClose: (reason) => disconnected(reason),
      onError: (error) => { stopHosting(); ui.showLobby('error', { error }); },
    });
    hosting = room;
    names = [name, 'Friend'];
    avatars = [profile.avatar, DEFAULT_AVATAR];
    const url = new URL(location.href);
    url.search = `?join=${room.code}`;
    ui.showLobby('hosting', { code: room.code, link: url.href });
  } catch (err) {
    ui.showLobby('error', { error: err.message });
  }
}

function hostMessage(msg, l) {
  if (msg.type === 'hello') {
    if (mode === 'host') return; // a repeat (the guest re-sends until the game starts)
    if (msg.version !== VERSION) {
      l.send({ type: 'refuse', error: 'You and your friend have different versions of the game. Both of you refresh the page (or open the same link) and try again.' });
      setTimeout(() => l.close(), 300);
      link = null;
      hosting = null;
      ui.showLobby('error', { error: 'Your friend has a different version of the game. Both of you refresh the page (or open the same link) and try again.' });
      return;
    }
    hosting = null;
    mode = 'host';
    me = 0;
    names = [names[0], cleanName(msg.name) || 'Player 2'];
    avatars = [profile.avatar, validAvatar(msg.avatar) ? msg.avatar : DEFAULT_AVATAR]; // untrusted: only known pictures
    ui.setOnline({ viewer: 0 });
    newGame();
    ui.playIntro(names, avatars);
  } else if (mode !== 'host') {
    // Not in a match yet: ignore anything else.
  } else if (msg.type === 'intent') {
    dispatch(1, msg.intent);
  } else if (msg.type === 'getLog') {
    l.send({ type: 'log', log: matchLog });
  } else if (msg.type === 'rematch' && state.phase === 'gameover') {
    newGame();
  }
}

async function join(code, name) {
  stopHosting();
  ui.showLobby('connecting', { text: `Joining ${code}…`, cancel: true });
  let started = false;
  try {
    const l = await joinRoom(code, {
      onMessage: (msg) => {
        if (msg.type === 'state') {
          if (!started) {
            started = true;
            mode = 'guest';
            me = 1;
            ui.setOnline({ viewer: 1 });
            const [me, host] = [msg.state.players[1], msg.state.players[0]];
            ui.playIntro([me.name, host.name], [me.avatar, host.avatar]);
          }
          state = msg.state;
          show();
        } else if (msg.type === 'reject') ui.toast(msg.error);
        else if (msg.type === 'log') {
          matchLog = msg.log;
          for (const w of logWaiters) w(matchLog);
          logWaiters = [];
        }
        else if (msg.type === 'refuse' || msg.type === 'full') {
          link?.close();
          link = null;
          ui.showLobby('error', { error: msg.type === 'full' ? 'That game already has two players.' : msg.error });
        }
      },
      onClose: (reason) => disconnected(reason),
    });
    if (ui.lobbyView() !== 'connecting') { l.close(); return; } // cancelled while connecting
    link = l;
    // Say hello until the first state arrives, in case the first one is lost.
    const hello = () => { if (!started && link === l) { l.send({ type: 'hello', version: VERSION, name, avatar: profile.avatar }); setTimeout(hello, 1000); } };
    hello();
    ui.showLobby('connecting', { text: 'Connected! Waiting for the game to start…' });
  } catch (err) {
    if (ui.lobbyView() === 'connecting') ui.showLobby('error', { error: err.message });
  }
}

function stopHosting() {
  hosting?.cancel();
  hosting = null;
}

function disconnected(reason) {
  const wasPlaying = mode !== 'bot';
  link = null;
  clearTimeout(lockTimer); // nobody to lock in any more
  ui.setDeadline(null);
  if (reason === 'self' || !wasPlaying) return;
  const who = mode === 'host' ? names[1] : names[0];
  ui.showLobby('disconnected', { error: reason === 'timeout' ? `Lost the connection to ${who}.` : `${who} left the game.` });
}

function leave() {
  link?.close();
  link = null;
  goHome();
}

// Back to the start screen with a fresh game against the bot.
function goHome() {
  stopHosting();
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
