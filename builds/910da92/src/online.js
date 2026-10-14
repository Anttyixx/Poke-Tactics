// Online play: a WebSocket to the game server (server/worker.js). The server
// runs every match, so neither player's browser is in charge; this side only
// sends what the player does and shows what the server sends back.
//
// The connection repairs itself: if it closes, goes silent, the network comes
// back or the page comes back on screen, it reconnects, and the server puts
// the player straight back into their match (it knows them by their player id,
// which this browser keeps).
//
// Messages (JSON). To the server: { type: 'intent', intent }, 'rematch',
// 'getLog', 'sync', 'leave', 'ping'. From the server: { type: 'welcome', code,
// you }, { type: 'state', state, deadlineIn }, { type: 'presence', connected },
// { type: 'reject', error }, { type: 'log', log }, { type: 'ended', reason, who },
// { type: 'refuse', reason, text }, 'pong'; from the queue: 'waiting',
// { type: 'matched', code }.

import { SERVER_URL } from './server-config.js?v=910da92';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L: codes get read out loud
const CODE_LENGTH = 5;
export const randomCode = () => Array.from(crypto.getRandomValues(new Uint32Array(CODE_LENGTH)), (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
export const cleanCode = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
export const isCode = (code) => typeof code === 'string' && code.length === CODE_LENGTH && [...code].every((c) => CODE_CHARS.includes(c));

const PING_MS = 5000;
const DEAD_MS = 15000; // nothing heard for this long: the connection is dead even if it looks open

export const serverUrl = () => new URLSearchParams(location.search).get('server') || SERVER_URL;

// What happened to the connection, newest last (copied into the match log so
// a dropped match can be looked into afterwards).
export const netLog = [];
export function note(text) {
  netLog.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (netLog.length > 300) netLog.splice(0, netLog.length - 300);
}

// This browser's player id: how the server recognises a returning player.
export function playerId() {
  const KEY = 'poke-tactics-pid';
  try {
    let id = localStorage.getItem(KEY);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id ?? '')) { id = randomCode() + randomCode() + randomCode(); localStorage.setItem(KEY, id); }
    return id;
  } catch {
    playerId.fallback ??= randomCode() + randomCode() + randomCode();
    return playerId.fallback;
  }
}

// Is the server there? { ok, build } or null.
export async function checkServer() {
  const base = serverUrl();
  if (!base) return null;
  try {
    const res = await fetch(new URL('/health', base), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// Open `path` ('/room' or '/queue') with `params`, and keep it open until
// close(). onMessage(msg) gets every message; onStatus(s) gets 'open',
// 'reconnecting' or 'replaced' (this match was opened in another tab).
export function connect(path, params, { onMessage, onStatus = () => {} }) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let lastHeard = 0;
  let retryTimer = 0;
  const outbox = []; // what the player did while the connection was down; sent on reconnect

  const url = () => {
    const u = new URL(path, serverUrl().replace(/^http/, 'ws'));
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
    return u;
  };
  const retry = (why) => {
    if (closed) return;
    clearTimeout(retryTimer);
    const delay = attempt === 0 ? 0 : Math.min(8000, 500 * 2 ** (attempt - 1));
    attempt++;
    note(`${why}; reconnecting${delay ? ` in ${delay / 1000}s` : ''}`);
    onStatus('reconnecting');
    retryTimer = setTimeout(open, delay);
  };
  const drop = (why) => {
    const s = ws;
    ws = null;
    try { s?.close(); } catch {}
    retry(why);
  };
  function open() {
    if (closed) return;
    clearTimeout(retryTimer);
    let sock;
    try { sock = new WebSocket(url()); } catch (err) { return retry(`couldn't connect (${err.message})`); }
    ws = sock;
    lastHeard = Date.now(); // counts as heard: a connection stuck opening times out like a silent one
    sock.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      lastHeard = Date.now();
      note(`${path}: connected`);
      onStatus('open');
      while (outbox.length && sock.readyState === 1) sock.send(outbox.shift());
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.type !== 'pong') onMessage(msg);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      if (closed) return;
      if (e.code === 4001) { note('opened somewhere else'); closed = true; return onStatus('replaced'); }
      if (e.code === 4000) return; // refused: the message saying why has been handled
      retry(`connection closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
    };
  }

  // Keep-alive: a ping every few seconds; silence means the connection is dead.
  const pinger = setInterval(() => {
    if (closed || !ws) return;
    // Silent too long, whatever state it claims (one stuck connecting or
    // closing counts too): give up on it and connect again.
    if (Date.now() - lastHeard > DEAD_MS) return drop('no reply from the server');
    if (ws.readyState === 1) ws.send('{"type":"ping"}');
  }, PING_MS);
  // Back on screen or back online: make sure the connection still works now,
  // rather than waiting for the next ping to find out.
  const check = () => {
    if (closed || document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) { attempt = 0; clearTimeout(retryTimer); return open(); }
    if (ws.readyState !== 1) return;
    const asked = Date.now();
    ws.send('{"type":"ping"}');
    setTimeout(() => { if (!closed && ws && lastHeard < asked) drop('no reply after coming back'); }, 3000);
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);

  open();
  return {
    send(msg) {
      const text = JSON.stringify(msg);
      if (ws?.readyState === 1) ws.send(text);
      else if (msg.type === 'intent' && outbox.length < 30) outbox.push(text);
    },
    close() {
      closed = true;
      clearInterval(pinger);
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      try { ws?.close(1000, 'bye'); } catch {}
      ws = null;
    },
  };
}
