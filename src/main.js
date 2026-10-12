// Entry point. Three ways to play, all through the same dispatch() -> applyIntent():
//   bot   - you (player 0) vs. the local bot (player 1)
//   host  - you (player 0) vs. a friend online. This browser runs the match: the
//           friend's intents arrive over the connection, are validated here like
//           anyone's, and the new state is sent back after every change.
//   guest - you (player 1) on a friend's match. Intents go to the host; the
//           screen only ever shows the state the host sends.
//
// Protocol (JSON over the PeerJS connection; pings and goodbyes live in net.js):
//   guest -> host  { type: 'hello', version, name }   first message
//                  { type: 'intent', intent }
//                  { type: 'rematch' }                 "Play again" after a match
//   host -> guest  { type: 'state', state }            after every change
//                  { type: 'reject', error }           the guest's intent was refused
//                  { type: 'refuse', error }           can't play (different versions)
//                  { type: 'full' }                    someone else already joined

import { createGame, applyIntent } from './game.js';
import { botTurn } from './bot.js';
import { createUI } from './ui.js';
import { hashSeed } from './rng.js';
import { hostRoom, joinRoom, cleanCode, isCode, checkConnection } from './net.js';

const BOT = 1;
// Online, each planning phase lasts this long; then everyone still planning is
// locked in as they are. The host's clock decides; both screens count down.
const PLAN_SECONDS = 30;
const NAME_KEY = 'poke-tactics-name';

const catalogText = await (await fetch('data/units.json')).text();
const catalog = JSON.parse(catalogText);
// Both players must run the same rules and Pokémon. The deploy tags every file
// with its build (?v=...); locally there's no tag, so compare the data instead.
const VERSION = `${new URL(import.meta.url).searchParams.get('v') ?? 'local'}:${hashSeed(catalogText)}`;

let state;
let firstGame = true;
let mode = 'bot'; // 'bot' | 'host' | 'guest'
let link = null; // the connection to the friend, online
let hosting = null; // a room waiting for a friend: { code, cancel }
let names = ['You', 'Bot'];
let me = 0; // which player this browser is
let timerKey = null; // the planning phase the countdown belongs to ("seed:round")
let lockTimer = 0;

const ui = createUI({
  catalog,
  viewer: 0,
  onIntent: (intent) => (mode === 'guest' ? sendIntent(intent) : dispatch(me, intent)),
  onNewGame: () => (mode === 'guest' ? link?.send({ type: 'rematch' }) : newGame()),
  onLobby: lobby,
});

function newGame() {
  const params = new URLSearchParams(location.search);
  // ?seed=anything makes the first match reproducible (handy for bug reports).
  const param = params.get('seed');
  const seed = firstGame && param ? hashSeed(param) : crypto.getRandomValues(new Uint32Array(1))[0];
  firstGame = false;
  // ?unit=<id> puts that unit in the first slot of every shop (for testing new units).
  const featured = mode === 'bot' ? params.get('unit')?.toLowerCase() || null : null;
  state = createGame({ seed, catalog, names, featured });
  if (featured && !state.featured) setTimeout(() => ui.toast(`Unknown unit "${featured}" in ?unit=`), 0);
  runBot();
  show();
  broadcast();
}

function dispatch(player, intent) {
  const res = applyIntent(state, catalog, player, intent);
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
  const send = (intent) => applyIntent(state, catalog, BOT, intent);
  if (state.phase === 'planning' || state.phase === 'team') botTurn(state, catalog, BOT, send);
  else if (state.phase === 'combat') send({ type: 'continue' });
}

function show() {
  ui.render(state);
  planClock();
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

const broadcast = () => { if (mode === 'host') link?.send({ type: 'state', state }); };

// The guest can't check intents itself (the host has the real state), so it
// reports success; a refusal comes back as a toast.
function sendIntent(intent) {
  link?.send({ type: 'intent', intent });
  return { ok: true };
}

// ---- online ----------------------------------------------------------------

const savedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
function playerName(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  try { localStorage.setItem(NAME_KEY, clean); } catch {}
  return clean;
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
    names = [names[0], String(msg.name ?? '').slice(0, 16) || 'Player 2'];
    ui.setOnline({ viewer: 0 });
    newGame();
    ui.playIntro(names);
  } else if (mode !== 'host') {
    // Not in a match yet: ignore anything else.
  } else if (msg.type === 'intent') {
    dispatch(1, msg.intent);
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
            ui.playIntro([msg.state.players[1].name, msg.state.players[0].name]);
          }
          state = msg.state;
          show();
        } else if (msg.type === 'reject') ui.toast(msg.error);
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
    const hello = () => { if (!started && link === l) { l.send({ type: 'hello', version: VERSION, name }); setTimeout(hello, 1000); } };
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
  names = ['You', 'Bot'];
  ui.setOnline(null);
  newGame();
}

// Debug handle for the browser console: `game.state`
window.game = { get state() { return state; }, get mode() { return mode; }, catalog, dispatch };

newGame();
// A shared invite link (?join=CODE) goes straight to the join screen.
if (new URLSearchParams(location.search).get('join')) lobby('open');
