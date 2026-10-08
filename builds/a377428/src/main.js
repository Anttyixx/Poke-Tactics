// Phase 1 entry point: one human (player 0) vs. the local bot (player 1).
// Every state change goes through dispatch() -> applyIntent(). In Phase 3 the
// host keeps this shape: the bot's seat is taken by intents arriving from the
// guest's connection, and the host broadcasts state after each dispatch.

import { createGame, applyIntent } from './game.js?v=a377428';
import { botTurn } from './bot.js?v=a377428';
import { createUI } from './ui.js?v=a377428';
import { hashSeed } from './rng.js?v=a377428';

const HUMAN = 0;
const BOT = 1;

const catalog = await (await fetch('data/units.json?v=a377428')).json();
let state;
let firstGame = true;

const ui = createUI({
  catalog,
  viewer: HUMAN,
  onIntent: (intent) => dispatch(HUMAN, intent),
  onNewGame: newGame,
});

function newGame() {
  const params = new URLSearchParams(location.search);
  // ?seed=anything makes the first match reproducible (handy for bug reports).
  const param = params.get('seed');
  const seed = firstGame && param ? hashSeed(param) : crypto.getRandomValues(new Uint32Array(1))[0];
  firstGame = false;
  // ?unit=<id> puts that unit in the first slot of every shop (for testing new units).
  const featured = params.get('unit')?.toLowerCase() || null;
  state = createGame({ seed, catalog, names: ['You', 'Bot'], featured });
  if (featured && !state.featured) setTimeout(() => ui.toast(`Unknown unit "${featured}" in ?unit=`), 0);
  runBot();
  ui.render(state);
}

function dispatch(player, intent) {
  const res = applyIntent(state, catalog, player, intent);
  if (!res.ok) {
    if (player === HUMAN) ui.toast(res.error);
    else console.warn('Bot intent rejected', intent, res.error);
    return res;
  }
  runBot();
  ui.render(state);
  return res;
}

function runBot() {
  if (state.players[BOT].ready) return;
  const send = (intent) => applyIntent(state, catalog, BOT, intent);
  if (state.phase === 'planning' || state.phase === 'leader') botTurn(state, catalog, BOT, send);
  else if (state.phase === 'combat') send({ type: 'continue' });
}

// Debug handle for the browser console: `game.state`
window.game = { get state() { return state; }, catalog, dispatch };

newGame();
