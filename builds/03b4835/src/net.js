// Online play over WebRTC (PeerJS). Two browsers talk directly; PeerJS's free
// public server only introduces them. The host's room code is its peer id, so
// a friend can connect with just the code.
//
// Messages are plain JSON objects; see main.js for the protocol. A heartbeat
// notices a friend who closed the tab or lost their connection, since WebRTC
// doesn't always report that on its own.

import { TURN_URLS, TURN_USERNAME, TURN_PASSWORD } from './net-config.js?v=03b4835';

const PEERJS_SRC = 'vendor/peerjs-1.5.4.min.js';
const ID_PREFIX = 'poke-tactics-';
// No 0/O or 1/I/L: codes get read out loud and typed on phones.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const PING_MS = 2000;
const TIMEOUT_MS = 9000; // no message for this long = disconnected
const CONNECT_MS = 20000; // give up joining after this long (a relayed connection can take a while)

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
function wrap(conn, peer, { onMessage, onClose }) {
  let closed = false;
  let lastSeen = Date.now();
  const send = (msg) => { if (!closed && conn.open) conn.send(msg); };
  const close = (reason = 'left') => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    window.removeEventListener('pagehide', bye);
    try { conn.send({ type: 'bye' }); } catch {}
    setTimeout(() => { try { conn.close(); } catch {} try { peer.destroy(); } catch {} }, 100);
    onClose(reason);
  };
  const bye = () => { try { conn.send({ type: 'bye' }); } catch {} };
  window.addEventListener('pagehide', bye);
  const timer = setInterval(() => {
    if (Date.now() - lastSeen > TIMEOUT_MS) close('timeout');
    else send({ type: 'ping' });
  }, PING_MS);
  conn.on('data', (msg) => {
    lastSeen = Date.now();
    if (closed || !msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') return;
    if (msg.type === 'bye') return close('left');
    onMessage(msg);
  });
  conn.on('close', () => close('left'));
  conn.on('error', () => close('error'));
  peer.on('disconnected', () => { try { peer.reconnect(); } catch {} }); // the broker, not the friend
  return { send, close: () => close('self') };
}

// Host a room. Resolves with { code, cancel } once the code is live;
// `onGuest(link)` fires when a friend connects (link = { send, close }).
// Only the first friend gets in; anyone else is told the game is full.
export async function hostRoom({ onGuest, onMessage, onClose, onError }) {
  const Peer = await loadPeerJS();
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomCode();
    const peer = new Peer(ID_PREFIX + code, await peerOptions());
    const result = await new Promise((resolve) => {
      peer.once('open', () => resolve('open'));
      peer.once('error', (err) => resolve(err));
    });
    if (result === 'open') {
      let link = null;
      let onGuestWrapped = null; // stops the waiting-room keep-alive
      peer.on('connection', (conn) => {
        // The friend may send before this side sees the connection open: keep
        // those messages and replay them once we're listening.
        const early = [];
        const keep = (msg) => early.push(msg);
        conn.on('data', keep);
        conn.on('open', () => {
          conn.off('data', keep);
          if (link) { conn.send({ type: 'full' }); setTimeout(() => conn.close(), 200); return; }
          link = wrap(conn, peer, { onMessage: (msg) => onMessage(msg, link), onClose });
          onGuestWrapped?.();
          onGuest(link);
          for (const msg of early) conn.emit('data', msg);
        });
      });
      // Stay reachable while waiting: phones drop the matchmaking connection
      // when the page goes to the background (e.g. to text the code to a
      // friend). Re-register the same code as soon as it drops or we're back.
      const rejoin = () => { if (!link && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch {} } };
      peer.on('disconnected', () => setTimeout(rejoin, 500));
      document.addEventListener('visibilitychange', rejoin);
      const keepAlive = setInterval(rejoin, 3000);
      peer.on('error', (err) => {
        if (link) return;
        if (['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected'].includes(err?.type)) return setTimeout(rejoin, 1000);
        onError(friendlyError(err));
      });
      const stop = () => { clearInterval(keepAlive); document.removeEventListener('visibilitychange', rejoin); };
      onGuestWrapped = stop;
      return { code, cancel: () => { stop(); if (!link) peer.destroy(); } };
    }
    peer.destroy();
    if (result?.type !== 'unavailable-id') throw new Error(friendlyError(result));
  }
  throw new Error('Couldn\'t create a game code. Try again.');
}

// Join a friend's room. Resolves with { send, close } once connected.
export async function joinRoom(code, { onMessage, onClose }) {
  const Peer = await loadPeerJS();
  const peer = new Peer(await peerOptions());
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
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
        resolve(wrap(conn, peer, { onMessage, onClose }));
      });
    });
  });
}
