// Entry point. Two ways to play, both shown by the same UI:
//   bot    - you (player 0) vs. the local bot (player 1). The rules run here,
//            through dispatch() -> applyIntent().
//   online - vs. a friend or a random opponent. The match runs on the game
//            server (server/worker.js, on Cloudflare); this browser sends what
//            the player does and shows the state the server sends back
//            (connection: src/online.js).

import { createGame, applyIntent } from './game.js?v=47bdeea';
import { botTurn } from './bot.js?v=47bdeea';
import { fightSummary } from './matchlog.js?v=47bdeea';
import { createUI } from './ui.js?v=47bdeea';
import { hashSeed } from './rng.js?v=47bdeea';
import { connect, isCode, playerId, serverUrl, checkServer, netLog, note } from './online.js?v=47bdeea';
import { loadProfile, saveProfile, recordBattle, recordMatch, BOT_AVATAR } from './profile.js?v=47bdeea';

const BOT = 1;

const catalogText = await (await fetch('data/units.json?v=47bdeea')).text();
const catalog = JSON.parse(catalogText);
// What's new: newest first. Add an entry to data/changelog.json with each update.
const changelog = await fetch('data/changelog.json?v=47bdeea').then((r) => (r.ok ? r.json() : [])).catch(() => []);
// Which deploy this is (the deploy tags every file with ?v=<commit>). The
// server only lets in players on its own build, so everyone runs the same rules.
const BUILD = new URL(import.meta.url).searchParams.get('v') ?? 'local';

let state;
let firstGame = true;
let mode = 'bot'; // 'bot' | 'online'
let conn = null; // online: the connection to the server (a room, or the queue)
let roomCode = null; // online: the match's code
let profile = loadProfile(); // name and picture, saved in this browser
const myName = () => profile.name || 'You';
let names = [myName(), 'Bot'];
let avatars = [profile.avatar, BOT_AVATAR];
let me = 0; // which player this browser is
// Every move both players make, in order. With the game's seed this rebuilds
// the whole match exactly (tools/replay.mjs), for analysis afterwards. Online,
// the server keeps it and sends a copy.
let matchLog = null;
let logWaiters = [];

const ui = createUI({
  catalog,
  viewer: 0,
  onIntent: (intent) => (mode === 'online' ? sendIntent(intent) : dispatch(me, intent)),
  onNewGame: () => (mode === 'online' ? conn?.send({ type: 'rematch' }) : newGame()),
  onLobby: lobby,
  onProfile: updateProfile,
  onFriends: friendAction,
  getFriends: () => friends,
  getProfile: () => profile,
  getLastLog: () => { try { return localStorage.getItem(LAST_LOG_KEY); } catch { return null; } },
  getLog,
  changelog,
  version: changelog[0]?.version ?? null,
  build: new URL(import.meta.url).searchParams.get('v'),
});

// The match log, plus this browser's connection log (what happened to the
// online connection, for looking into drops).
function getLog() {
  const withNet = (log) => (log ? { ...log, fights: fightsFor(log.seed), ...(mode !== 'bot' && { connection: [...netLog] }) } : log);
  if (mode !== 'online') return Promise.resolve(withNet(matchLog));
  return new Promise((resolve) => {
    const done = (log) => resolve(withNet(log));
    logWaiters.push(done);
    conn?.send({ type: 'getLog' });
    setTimeout(() => { logWaiters = logWaiters.filter((w) => w !== done); done(matchLog); }, 4000);
  });
}

// The current online match's code is kept in this browser, so after a reload
// (phones often reload pages that were in the background) the player can go
// straight back in. The server keeps the match itself.
const SESSION_KEY = 'poke-tactics-session';
const SESSION_MS = 15 * 60 * 1000; // the server forgets an empty room after 15 minutes
function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code: roomCode, opponent: state?.players[1 - me]?.name ?? null, at: Date.now() })); } catch {}
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (s && Date.now() - s.at < SESSION_MS && isCode(s.code)) return s;
  } catch {}
  return null;
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}
// The last online match's log with this browser's connection log, kept so it
// can still be copied after a drop or a reload (Match ended screen, start menu).
const LAST_LOG_KEY = 'poke-tactics-last-log';
function lastLogText() {
  const base = matchLog ?? { format: 'poke-tactics-match', v: 1, build: BUILD, mode: 'pvp', seed: state?.seed, names: state?.players.map((p) => p.name) };
  return JSON.stringify({ ...base, code: roomCode, player: me, round: state?.round, fights: fightsFor(base.seed), connection: [...netLog], copied: new Date().toISOString() });
}
function saveLastLog() {
  if (mode === 'bot') return;
  try { localStorage.setItem(LAST_LOG_KEY, lastLogText()); } catch {}
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
}

function dispatch(player, intent) {
  const res = applyIntent(state, catalog, player, intent);
  if (res.ok) record(player, intent);
  if (!res.ok) {
    if (player === me) ui.toast(res.error);
    else console.warn('Bot intent rejected', intent, res.error);
    return res;
  }
  runBot();
  show();
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

// Online, keep the screen on: phones lock themselves after a short while
// without a touch (often mid-match, while watching a battle), which pauses the
// page and drops the connection. The browser releases the lock whenever the
// page is hidden, so it's asked for again when the page is back.
let wakeLock = null;
async function keepAwake() {
  const want = mode !== 'bot' && document.visibilityState === 'visible';
  if (!want) { wakeLock?.release().catch(() => {}); wakeLock = null; return; }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    if (wakeLock) note('screen kept on');
  } catch (err) {
    if (!wakeRefused) note(`screen wake lock refused: ${err?.name ?? err}`);
    wakeRefused = true;
  }
}
let wakeRefused = false;
document.addEventListener('visibilitychange', () => keepAwake());
document.addEventListener('pointerdown', () => { if (mode !== 'bot' && !(wakeLock && !wakeLock.released)) keepAwake(); });

function show() {
  shareStatus();
  trackStats();
  saveLastLog();
  keepAwake();
  ui.render(state);
}

// Each fight's seed and chance outcomes (Alcremie's flavours, Minior's hops,
// crits), kept for the match log so a reader can see what happened by chance.
let fightLog = { seed: null, list: [] };
function noteFight() {
  if (fightLog.seed !== state.seed) fightLog = { seed: state.seed, list: [] };
  if (fightLog.list.some((f) => f.round === state.combat.round)) return;
  fightLog.list.push(fightSummary(state.combat, catalog, state.players.map((p) => p.name)));
}
const fightsFor = (seed) => (fightLog.seed === seed ? fightLog.list : []);

// Profile stats: each battle counts the Pokémon this player fielded; each
// finished match counts a win, loss or draw (online and training separately).
let trackedKey = null;
function trackStats() {
  const key = `${state.seed}:${state.round}:${state.phase}`;
  if (key === trackedKey) return;
  trackedKey = key;
  if (state.phase === 'combat') {
    noteFight();
    profile = recordBattle(state.combat.result.initial.filter((u) => u.side === me && !u.summoned).map((u) => u.unitId));
  } else if (state.phase === 'gameover') {
    profile = recordMatch(mode === 'bot' ? 'training' : 'online', state.winner === me ? 'win' : state.winner === null ? 'draw' : 'loss');
  }
}

// Online, intents go to the server; a refusal comes back as a toast.
function sendIntent(intent) {
  conn?.send({ type: 'intent', intent });
  return { ok: true };
}

// ---- online ----------------------------------------------------------------

const savedName = () => profile.name;
// The profile screen saved a new name or picture. In a game against the bot it
// shows right away; online, from the next match.
function updateProfile(next) {
  profile = saveProfile(next);
  presence?.send({ type: 'profile', name: profile.name || 'Player', avatar: profile.avatar });
  if (mode === 'bot') {
    names = [myName(), 'Bot'];
    avatars = [profile.avatar, BOT_AVATAR];
    if (state) { state.players[0].name = names[0]; state.players[0].avatar = avatars[0]; show(); }
  }
  return profile;
}

const NO_SERVER = 'Online play isn\'t available in this copy of the game.';

function lobby(action, data = {}) {
  // Battle: straight into the queue for the next player looking.
  if (action === 'open' || action === 'queue') return serverUrl() ? findMatch() : ui.showLobby('error', { error: NO_SERVER });
  // Battle a friend: send a battle request to a friend code.
  if (action === 'friend') return serverUrl() ? ui.showLobby('friend', { myCode: friends.code }) : ui.showLobby('error', { error: NO_SERVER });
  if (action === 'challenge') {
    const code = String(data.friendCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) return ui.toast('Friend codes are 6 letters and numbers.');
    if (code === friends.code) return ui.toast('That\'s your own friend code!');
    return friendAction('challenge', code);
  }
  if (action === 'cancel') { stopOnline(); return goHome(); }
  if (action === 'leave') return leave();
  if (action === 'check') {
    ui.showLobby('checking');
    return checkServer().then((health) => {
      if (ui.lobbyView() === 'checking') ui.showLobby('check', { ok: Boolean(health), sameVersion: health?.build === BUILD, configured: Boolean(serverUrl()) });
    });
  }
  if (action === 'home') { stopOnline(); return goHome(); }
  if (action === 'resume') {
    const saved = loadSession();
    if (!saved || !serverUrl()) { ui.toast('That match has expired.'); return goHome(); }
    return openRoom(saved.code, { resuming: true });
  }
  if (action === 'discard') { clearSession(); return goHome(); }
}

const who = () => ({ pid: playerId(), name: savedName() || 'Player', avatar: profile.avatar, build: BUILD });

function stopOnline() {
  conn?.close();
  conn = null;
  ui.setNetStatus(null);
}

// Find a random opponent: wait in the server's queue until it pairs us up,
// then join the room it made.
function findMatch() {
  stopOnline();
  ui.showLobby('queue');
  note('looking for a match');
  const c = connect('/queue', who(), {
    onMessage: (msg) => {
      if (c !== conn) return;
      if (msg.type === 'matched') { note(`matched: ${msg.code}`); stopOnline(); openRoom(msg.code); }
      else if (msg.type === 'refuse') { stopOnline(); ui.showLobby('error', { error: msg.text }); }
    },
    onStatus: (s) => { if (c === conn && s === 'replaced') { stopOnline(); goHome(); } },
  });
  conn = c;
}

// Create (create: true), join or rejoin the room with this code.
function openRoom(code, { resuming = false } = {}) {
  stopOnline();
  roomCode = code;
  let inMatch = false; // this connection has had a state with a match in it
  let lastSeed = null;
  let planKey = null;
  ui.showLobby('connecting', { text: resuming ? 'Getting back into your match…' : 'Opponent found! Starting the battle…', cancel: true });
  note(`joining ${code}`);
  const c = connect('/room', { ...who(), code }, {
    onMessage: (msg) => {
      if (c !== conn) return;
      if (msg.type === 'welcome') {
        me = msg.you;
      } else if (msg.type === 'state') {
        const next = msg.state;
        if (mode !== 'online') {
          mode = 'online';
          ui.setOnline({ viewer: me });
        }
        // A new match (the first, or a rematch): play the intro.
        if (next.seed !== lastSeed) {
          lastSeed = next.seed;
          if (next.phase === 'team' && !next.players[me].ready) {
            ui.playIntro([next.players[me].name, next.players[1 - me].name], [next.players[me].avatar, next.players[1 - me].avatar]);
          }
          matchLog = null;
        }
        inMatch = true;
        state = next;
        if (state.phase === 'gameover') clearSession(); else saveSession();
        // The server's clock decides when planning ends; both screens count down.
        if (state.phase === 'planning' && msg.deadlineIn !== null && msg.deadlineIn !== undefined) {
          const key = `${state.seed}:${state.round}`;
          if (key !== planKey) { planKey = key; ui.setDeadline(Date.now() + msg.deadlineIn); }
        } else if (state.phase !== 'planning') { planKey = null; ui.setDeadline(null); }
        ui.setNetStatus(null);
        show();
      } else if (msg.type === 'presence') {
        const there = msg.connected?.[1 - me];
        const name = state?.players[1 - me]?.name ?? 'Your opponent';
        if (inMatch && state?.phase !== 'gameover') {
          if (there === false) ui.setNetStatus(`${name}'s connection dropped. They're locked in when the timer runs out; waiting for them to come back…`);
          else if (there) { if (ui.netStatus()) ui.toast(`${name} is back`); ui.setNetStatus(null); }
        }
      } else if (msg.type === 'reject') ui.toast(msg.error);
      else if (msg.type === 'log') {
        matchLog = msg.log;
        for (const w of logWaiters) w(matchLog);
        logWaiters = [];
      } else if (msg.type === 'ended') {
        endMatch(`${msg.who ?? 'Your opponent'} left the game.`);
      } else if (msg.type === 'refuse') {
        note(`refused: ${msg.reason}`);
        stopOnline();
        clearSession();
        if (mode === 'online') return endMatch(msg.text);
        ui.showLobby('error', { error: msg.text });
      }
    },
    onStatus: (s) => {
      if (c !== conn) return;
      if (s === 'reconnecting' && inMatch) ui.setNetStatus('Connection lost. Reconnecting…');
      if (s === 'replaced') { conn = null; endMatch('This match was opened somewhere else (another tab or device).'); }
    },
  });
  conn = c;
}

// The match is over for good (opponent left, or we can't get back in).
function endMatch(text) {
  note(`match ended: ${text}`);
  saveLastLog();
  const log = lastLogText();
  stopOnline();
  clearSession();
  ui.setDeadline(null);
  ui.showLobby('disconnected', { log, error: text });
}

function leave() {
  conn?.send({ type: 'leave' });
  const c = conn;
  conn = null;
  setTimeout(() => c?.close(), 300); // let the goodbye go out
  clearSession();
  ui.setNetStatus(null);
  goHome();
}

// Back to the start screen with a fresh game against the bot.
function goHome() {
  stopOnline();
  ui.setDeadline(null);
  mode = 'bot';
  me = 0;
  roomCode = null;
  names = [myName(), 'Bot'];
  avatars = [profile.avatar, BOT_AVATAR];
  ui.setOnline(null);
  newGame();
}

// ---- friends ----------------------------------------------------------------
// While the game is open it keeps a connection to the server's friends service
// (server/worker.js, Presence): friend requests, who's online, battle requests.

let presence = null;
// What the friends screen shows: { available, code, friends, incoming, outgoing,
// challenge (a request to us), waiting (our request to a friend) }.
const friends = { available: false, code: null, friends: [], incoming: [], outgoing: [], challenge: null, waiting: null };
let sharedStatus = null;

function startPresence() {
  if (!serverUrl()) return;
  friends.available = true;
  presence = connect('/presence', who(), {
    onMessage: (msg) => {
      if (msg.type === 'me') friends.code = msg.code;
      else if (msg.type === 'friends') Object.assign(friends, { friends: msg.friends, incoming: msg.incoming, outgoing: msg.outgoing });
      else if (msg.type === 'notice') ui.toast(msg.text);
      else if (msg.type === 'challenge') {
        // Already in a battle (or looking for one): say no for them.
        if (mode === 'online' || conn) { presence.send({ type: 'answer', code: msg.from.code, accept: false }); return; }
        friends.challenge = { ...msg.from, until: Date.now() + msg.expiresIn };
      } else if (msg.type === 'challengeSent') {
        friends.waiting = { ...msg.to, until: Date.now() + msg.expiresIn };
      } else if (msg.type === 'challengeEnded') {
        if (friends.waiting?.code === msg.code) {
          friends.waiting = null;
          ui.toast(msg.reason === 'declined' ? `${msg.name} can't battle right now.` : msg.reason === 'expired' ? `${msg.name} didn't answer.` : `${msg.name} is no longer available.`);
        }
        if (friends.challenge?.code === msg.code) {
          friends.challenge = null;
          if (msg.reason === 'cancelled') ui.toast(`${msg.name} cancelled the battle request.`);
        }
      } else if (msg.type === 'matched') {
        friends.challenge = friends.waiting = null;
        ui.showFriends();
        note(`friend battle: ${msg.code}`);
        openRoom(msg.code);
        return;
      }
      ui.showFriends();
    },
    onStatus: (s) => { if (s === 'open') sharedStatus = null; shareStatus(); },
  });
  ui.showFriends();
}

// Friends see "In a battle" while we're in an online match.
function shareStatus() {
  const status = mode === 'online' ? 'battling' : 'online';
  if (!presence || status === sharedStatus) return;
  sharedStatus = status;
  presence.send({ type: 'status', status });
}

function friendAction(action, code) {
  if (!presence) return ui.toast('Friends need online play, which isn\'t available in this copy of the game.');
  if (action === 'add') {
    const clean = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 6) return ui.toast('Friend codes are 6 letters and numbers.');
    return presence.send({ type: 'add', code: clean });
  }
  if (action === 'accept-battle' || action === 'decline-battle') {
    const ch = friends.challenge;
    friends.challenge = null;
    ui.showFriends();
    if (ch) presence.send({ type: 'answer', code: ch.code, accept: action === 'accept-battle' });
    return;
  }
  if (action === 'withdraw') {
    const w = friends.waiting;
    friends.waiting = null;
    ui.showFriends();
    if (w) presence.send({ type: 'withdraw', code: w.code });
    return;
  }
  if (['accept', 'decline', 'cancel', 'remove', 'challenge'].includes(action)) presence.send({ type: action, code });
}

// Debug handle for the browser console: `game.state`
window.game = { get state() { return state; }, get mode() { return mode; }, catalog, dispatch };

newGame();
startPresence();
// An online match this browser was in (before a reload) can be picked back up.
const unfinished = serverUrl() ? loadSession() : null;
if (unfinished) ui.showLobby('resume', { code: unfinished.code, opponent: unfinished.opponent });
// The first screen is drawn: show the page (index.html keeps it hidden while loading).
document.documentElement.classList.remove('booting');
