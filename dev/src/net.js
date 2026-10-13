// Online play over WebRTC (PeerJS). Two browsers talk directly; PeerJS's free
// public server only introduces them. The host's room code is its peer id, so
// a friend can connect with just the code.
//
// Messages are plain JSON objects; see main.js for the protocol. A heartbeat
// notices when a friend goes quiet. Quiet isn't gone: phones pause the page
// whenever the screen locks or the player switches apps, so a quiet friend is
// only reported (onQuiet), and the match carries on without them. Only a
// friend who leaves, or stays silent for GONE_MS, ends it. A guest whose
// connection drops reconnects to the same room (main.js resumes the match).

import { TURN_URLS, TURN_USERNAME, TURN_PASSWORD } from './net-config.js?v=aa11be7';

const PEERJS_SRC = 'vendor/peerjs-1.5.4.min.js';
const ID_PREFIX = 'poke-tactics-';
// No 0/O or 1/I/L: codes get read out loud and typed on phones.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const PING_MS = 2000;
const QUIET_MS = 7000; // no message for this long: the friend's page is probably asleep
export const GONE_MS = 120000; // no message for this long: give up on them
const CONNECT_MS = 20000; // give up joining after this long (a relayed connection can take a while)

// What happened to the connection, newest last (copied into the match log so
// a dropped match can be looked into afterwards).
export const netLog = [];
export function note(text) {
  netLog.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (netLog.length > 300) netLog.splice(0, netLog.length - 300);
}

// Which kind of route a connection took: 'host'/'srflx' = direct, 'relay' = TURN.
async function routeOf(conn) {
  try {
    const stats = await conn.peerConnection.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const local = pair && stats.get(pair.localCandidateId);
    return local ? `${local.candidateType}${local.relayProtocol ? `/${local.relayProtocol}` : ''}` : 'unknown';
  } catch { return 'unknown'; }
}
function watch(conn, who) {
  routeOf(conn).then((r) => note(`${who}: connected via ${r}`));
  conn.peerConnection?.addEventListener('iceconnectionstatechange', () => note(`${who}: ice ${conn.peerConnection.iceConnectionState}`));
}

export const randomCode = () => Array.from(crypto.getRandomValues(new Uint32Array(CODE_LENGTH)), (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
export const cleanCode = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
export const isCode = (code) => code.length === CODE_LENGTH && [...code].every((c) => CODE_CHARS.includes(c));

let peerLib = null;
function loadPeerJS() {
  peerLib ??= new Promise((resolve, reject) => {
    if (window.Peer) return resolve(window.Peer);
    const s = document.createElement('script');
    s.src = PEERJS_SRC;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS failed to load')));
    s.onerror = () => { peerLib = null; reject(new Error('PeerJS failed to load')); };
    document.head.append(s);
  });
  return peerLib;
}

// How the two browsers find a route to each other. STUN servers let them
// connect directly through most home routers; when a router or carrier blocks
// that, TURN relays carry the messages instead (see net-config.js).
const STUN = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const PEERJS_TURN = { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' };
// The relay login (see net-config.js): { list, status }, status 'ok' or 'missing'.
const relay = TURN_USERNAME && TURN_PASSWORD
  ? { list: [{ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_PASSWORD }], status: 'ok' }
  : { list: [], status: 'missing' };
const relayCredentials = async () => relay;
async function iceServers() {
  return [...STUN, ...(await relayCredentials()).list, PEERJS_TURN];
}

// What this device can do, for the "Check my connection" screen: whether the
// relay key works, and which kinds of route the browser finds. 'srflx' =
// direct through the router (STUN), 'relay' = through the Metered relay.
export async function checkConnection() {
  const { list, status } = await relayCredentials();
  const types = new Set();
  try {
    const pc = new RTCPeerConnection({ iceServers: [...STUN, ...list] });
    pc.createDataChannel('check');
    pc.onicecandidate = (e) => {
      const m = / typ ([a-z]+)/.exec(e.candidate?.candidate ?? '');
      if (m) types.add(m[1]);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const stop = setTimeout(resolve, 8000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(stop); resolve(); } };
    });
    pc.close();
  } catch {}
  return { key: status, servers: list.length, direct: types.has('srflx'), relay: types.has('relay') };
}
export const hasRelay = () => relay.status === 'ok';

// ?peer=host:port uses your own PeerJS server instead of the public one
// (for testing, or if the public one is down).
async function peerOptions() {
  const config = { iceServers: await iceServers() };
  const custom = new URLSearchParams(location.search).get('peer');
  if (!custom) return { debug: 0, config };
  const [host, port] = custom.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:', debug: 0, config };
}

const friendlyError = (err) => {
  switch (err?.type) {
    case 'peer-unavailable': return 'No game found with that code. Check the code, or ask your friend to create a new one.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return 'Couldn\'t reach the matchmaking server. Check your internet connection and try again.';
    case 'browser-incompatible': return 'This browser doesn\'t support online play. Try an up-to-date Chrome, Safari, Firefox or Edge.';
    case 'webrtc': return 'Couldn\'t connect to your friend. One of your networks may be blocking direct connections; try a different network (e.g. home Wi-Fi instead of school or mobile data).';
    default: return err?.message || 'Something went wrong with the connection.';
  }
};

// Wrap a PeerJS DataConnection: JSON messages in, heartbeat, one close callback.
// onClose(reason): 'left' (the friend left the match), 'lost' (the connection
// broke, or the friend closed or reloaded the page), 'timeout' (silent for
// GONE_MS) or 'self' (we closed it).
// onQuiet(true/false): the friend went quiet / is back.
function wrap(conn, { onMessage, onClose, onQuiet = () => {}, after = () => {} }) {
  let closed = false;
  let quiet = false;
  let lastSeen = Date.now();
  let lastTick = Date.now();
  const send = (msg) => { if (!closed && conn.open) { try { conn.send(msg); } catch {} } };
  const end = (reason) => {
    if (closed) return;
    closed = true;
    note(`connection closed: ${reason}`);
    clearInterval(timer);
    window.removeEventListener('pagehide', bye);
    setTimeout(() => { try { conn.close(); } catch {} after(); }, 100);
    onClose(reason);
  };
  // Closing or reloading the page: a browser can't tell the two apart, and a
  // reload comes straight back, so this is only "gone for now" ('lost' on the
  // other side, which waits for a rejoin). Leaving on purpose (close()) is a
  // real goodbye.
  const bye = (e) => { if (!e?.persisted) send({ type: 'gone' }); };
  window.addEventListener('pagehide', bye);
  const timer = setInterval(() => {
    const now = Date.now();
    // This page was asleep itself (timers stopped): give the friend a fresh
    // chance instead of blaming them for our silence.
    if (now - lastTick > 3 * PING_MS) lastSeen = now;
    lastTick = now;
    const silent = now - lastSeen;
    if (silent > GONE_MS) return end('timeout');
    if (silent > QUIET_MS && !quiet) { quiet = true; note('friend went quiet'); onQuiet(true); }
    send({ type: 'ping' });
  }, PING_MS);
  conn.on('data', (msg) => {
    lastSeen = Date.now();
    if (quiet && !closed) { quiet = false; note('friend is back'); onQuiet(false); }
    if (closed || !msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') return;
    if (msg.type === 'bye') return end('left');
    if (msg.type === 'gone') return end('lost');
    onMessage(msg);
  });
  conn.on('close', () => end('lost'));
  conn.on('error', () => end('lost'));
  // close(): say goodbye and hang up. drop(): hang up without a goodbye (the
  // connection seems dead; we're about to replace it, not leave).
  return { send, close: () => { send({ type: 'bye' }); end('self'); }, drop: () => end('self') };
}

// Host a room. Resolves with { code, cancel } once the code is live. Every
// friend who connects becomes a link ({ send, close }); main.js decides who
// plays (the first hello, or the same guest coming back). The room stays open
// for the whole match so a guest whose connection drops can rejoin; cancel()
// closes it.
const openResult = (peer) => new Promise((resolve) => {
  peer.once('open', () => resolve('open'));
  peer.once('error', (err) => resolve(err));
});

// Host a room. Resolves with { code, cancel } once the code is live. Pass
// `code` to open a room under a code used before (resuming a match after a
// reload). Every friend who connects becomes a link ({ send, close, drop });
// main.js decides who plays (the first hello, or the same guest coming back).
// The room stays open for the whole match so the guest can rejoin; cancel()
// closes it.
export async function hostRoom({ code: wanted = null, onMessage, onClose, onQuiet, onError }) {
  const Peer = await loadPeerJS();
  const options = await peerOptions();
  // A code we used before may still be held for a few seconds by our old
  // registration on the matchmaking server: keep asking for it.
  const tries = wanted ? 15 : 4;
  for (let attempt = 0; attempt < tries; attempt++) {
    const code = wanted ?? randomCode();
    const first = new Peer(ID_PREFIX + code, options);
    const result = await openResult(first);
    if (result === 'open') {
      note(`room ${code} open`);
      let started = false; // a friend has connected
      let closed = false;
      let peer = first;
      const peers = [first]; // every registration made; older ones may still carry the connection
      const onConnection = (conn) => {
        // The friend may send before this side sees the connection open: keep
        // those messages and replay them once we're listening.
        const early = [];
        const keep = (msg) => early.push(msg);
        conn.on('data', keep);
        conn.on('open', () => {
          conn.off('data', keep);
          started = true;
          watch(conn, 'guest');
          const link = wrap(conn, {
            onMessage: (msg) => onMessage(msg, link),
            onClose: (reason) => onClose(reason, link),
            onQuiet: (q) => onQuiet?.(q, link),
          });
          for (const msg of early) conn.emit('data', msg);
        });
      };
      // Stay reachable: the matchmaking connection drops now and then (phones
      // drop it whenever the page is in the background). Re-register the same
      // code as soon as it drops or we're back; if the old registration is
      // gone for good, register again from scratch.
      let renewing = false;
      const renew = async () => {
        if (renewing || closed) return;
        renewing = true;
        const p = new Peer(ID_PREFIX + code, options);
        const r = await openResult(p);
        renewing = false;
        if (r === 'open' && !closed) { peer = p; peers.push(p); attach(p); note('room registered again'); }
        else { try { p.destroy(); } catch {} note(`room re-register failed: ${r?.type ?? r}`); }
      };
      const rejoin = () => {
        if (closed) return;
        if (peer.destroyed) return renew();
        if (peer.disconnected) { note('matchmaking: reconnecting'); try { peer.reconnect(); } catch { renew(); } }
      };
      const attach = (p) => {
        p.on('connection', onConnection);
        p.on('disconnected', () => { if (p === peer) { note('matchmaking: disconnected'); setTimeout(rejoin, 500); } });
        p.on('error', (err) => {
          if (p !== peer) return;
          note(`matchmaking error: ${err?.type}`);
          if (err?.type === 'unavailable-id') return setTimeout(renew, 3000);
          if (['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected'].includes(err?.type)) return setTimeout(rejoin, 1000);
          if (!started) onError(friendlyError(err));
        });
      };
      attach(first);
      document.addEventListener('visibilitychange', rejoin);
      const keepAlive = setInterval(rejoin, 3000);
      const cancel = () => {
        closed = true;
        clearInterval(keepAlive);
        document.removeEventListener('visibilitychange', rejoin);
        setTimeout(() => { for (const p of peers) { try { p.destroy(); } catch {} } }, 150); // after any goodbye is sent
      };
      return { code, cancel };
    }
    first.destroy();
    if (result?.type !== 'unavailable-id') throw new Error(friendlyError(result));
    if (wanted) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(wanted ? 'Couldn\'t reopen the game. Start a new one.' : 'Couldn\'t create a game code. Try again.');
}

// Join a friend's room. Resolves with { send, close } once connected.
export async function joinRoom(code, { onMessage, onClose, onQuiet }) {
  const Peer = await loadPeerJS();
  const peer = new Peer(await peerOptions());
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      note(`join failed: ${typeof err === 'string' ? 'timed out' : err?.type ?? err}`);
      clearTimeout(timer);
      peer.destroy();
      reject(new Error(typeof err === 'string' ? err : friendlyError(err)));
    };
    const timer = setTimeout(() => fail('Couldn\'t connect to your friend\'s game. Check the code; if it\'s right, one of your networks may be blocking direct connections; try a different network.'), CONNECT_MS);
    peer.once('error', fail);
    peer.once('open', () => {
      const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
      conn.once('error', fail);
      conn.once('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        watch(conn, 'host');
        resolve(wrap(conn, { onMessage, onClose, onQuiet, after: () => { try { peer.destroy(); } catch {} } }));
      });
    });
  });
}
