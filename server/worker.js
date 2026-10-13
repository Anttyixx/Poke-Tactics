// Online play server: a Cloudflare Worker.
//
// Each match is a Durable Object ("Room"), found by its 5-letter code. It runs
// the match with the same rules code as the game (src/game.js), so neither
// player's browser is in charge: a phone locking or a page reloading never
// stops the match, and a player who drops just connects again. One more
// Durable Object ("Queue") pairs up players looking for a random opponent.
//
// Players talk to it over a WebSocket (protocol in src/online.js):
//   wss://<worker>/room?code=CODE&pid=..&name=..&avatar=..&build=..[&create=1]
//   wss://<worker>/queue?pid=..&name=..&avatar=..&build=..
// `pid` is a random id each browser keeps: it's how a returning player is
// recognised. `build` must match this deploy, so both players and the server
// always run the same rules.

import { DurableObject } from 'cloudflare:workers';
import { createGame, applyIntent } from '../src/game.js';
import catalog from '../data/units.json';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const isCode = (c) => typeof c === 'string' && c.length === 5 && [...c].every((ch) => CODE_CHARS.includes(ch));
const randomCode = () => Array.from(crypto.getRandomValues(new Uint32Array(5)), (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
const isPid = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(p);
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
const cleanAvatar = (s) => (typeof s === 'string' && /^[a-z0-9-]{1,24}$/.test(s) ? s : null);

const PLAN_MS = 30_000; // each planning phase; then anyone not ready is locked in
const RESULTS_MS = 20_000; // after a battle has played out, anyone who hasn't continued is moved on
const IDLE_MS = 15 * 60_000; // nobody connected for this long: the room is deleted

const OPEN = 1; // WebSocket.READY_STATE_OPEN
const send = (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch {} };

// A WebSocket that only says why it can't let you in, then closes.
function refuse(reason, text) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  send(server, { type: 'refuse', reason, text });
  server.close(4000, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, build: env.BUILD }, { headers: { 'access-control-allow-origin': '*' } });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Poke Tactics game server', { status: 200 });
    const q = url.searchParams;
    if (q.get('build') !== env.BUILD) return refuse('version', 'This version of the game is out of date. Refresh the page (or open the latest link) and try again.');
    if (!isPid(q.get('pid'))) return refuse('bad', 'Something went wrong. Refresh the page and try again.');
    if (url.pathname === '/queue') return env.QUEUE.get(env.QUEUE.idFromName('queue')).fetch(req);
    if (url.pathname === '/room') {
      const code = q.get('code');
      if (!isCode(code)) return refuse('notfound', 'Codes are 5 letters and numbers, like KOKO4.');
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
    }
    return new Response('Not found', { status: 404 });
  },
};

// ---- a match ---------------------------------------------------------------

export class Room extends DurableObject {
  // The room is kept in storage (so it survives the object being unloaded
  // between messages) and cached here.
  async load() {
    if (this.room === undefined) this.room = (await this.ctx.storage.get('room')) ?? null;
    return this.room;
  }
  async save() {
    await this.ctx.storage.put('room', this.room);
  }

  // Sockets of players who are connected right now (optionally not counting one that's closing).
  sockets(except = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === OPEN);
  }
  connected(except = null) {
    const live = new Set(this.sockets(except).map((ws) => ws.deserializeAttachment()?.pid));
    return this.room.players.map((p) => live.has(p.pid));
  }
  broadcast(msg, except = null) {
    for (const ws of this.sockets(except)) send(ws, msg);
  }
  stateMsg() {
    const { state, deadline } = this.room;
    return { type: 'state', state, deadlineIn: state?.phase === 'planning' && deadline ? Math.max(0, deadline - Date.now()) : null };
  }
  presence(except = null) {
    this.broadcast({ type: 'presence', connected: this.connected(except) }, except);
  }

  newRoom(code, players) {
    this.room = { code, players, state: null, log: null, deadline: null, phaseKey: null, ended: null, lastActive: Date.now() };
  }

  startGame() {
    const r = this.room;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const names = r.players.map((p) => p.name);
    r.state = createGame({ seed, catalog, names, avatars: r.players.map((p) => p.avatar) });
    r.log = { format: 'poke-tactics-match', v: 1, build: this.env.BUILD, mode: 'pvp', started: new Date().toISOString(), seed, names, featured: null, intents: [] };
    r.phaseKey = null;
  }

  // After every change: new deadlines for a new phase, tell everyone, save.
  async changed() {
    const r = this.room;
    const s = r.state;
    if (s) {
      const key = `${s.seed}:${s.round}:${s.phase}`;
      if (key !== r.phaseKey) {
        r.phaseKey = key;
        r.deadline = s.phase === 'planning' ? Date.now() + PLAN_MS
          : s.phase === 'combat' ? Date.now() + s.combat.result.ticks * 100 + RESULTS_MS
          : null;
      }
    }
    this.broadcast(this.stateMsg());
    if (s?.phase === 'gameover') this.broadcast({ type: 'log', log: r.log });
    await this.save();
    await this.schedule();
  }

  async schedule() {
    const r = this.room;
    const anyone = this.connected().some(Boolean);
    const cleanup = (anyone ? Date.now() : r.lastActive) + IDLE_MS;
    await this.ctx.storage.setAlarm(Math.min(cleanup, r.deadline ?? Infinity));
  }

  async fetch(req) {
    const url = new URL(req.url);
    await this.load();

    // The queue made a match: both players are already in.
    if (url.pathname === '/init') {
      const { code, players } = await req.json();
      if (this.room && !this.room.ended && this.room.players.length) return new Response('taken', { status: 409 });
      this.newRoom(code, players);
      this.startGame();
      await this.changed();
      return new Response('ok');
    }

    const q = url.searchParams;
    const pid = q.get('pid');
    const me = { pid, name: cleanName(q.get('name')) || 'Player', avatar: cleanAvatar(q.get('avatar')) };
    const code = q.get('code');
    let r = this.room;
    if (q.get('create') === '1') {
      if (r && !r.ended && r.players.length && !r.players.some((p) => p.pid === pid)) return refuse('taken', 'That code is in use.');
      if (!r || r.ended) { this.newRoom(code, [me]); r = this.room; }
    } else if (!r || r.ended) {
      return refuse('notfound', r?.ended ? 'That match has ended.' : 'No game found with that code. Check the code, or ask your friend to create a new one.');
    }
    let you = r.players.findIndex((p) => p.pid === pid);
    if (you < 0) {
      if (r.players.length >= 2 || r.state) return refuse('full', 'That game already has two players.');
      r.players.push(me);
      you = 1;
    }
    if (!r.state) r.players[you] = me; // before the match starts, names and pictures can change

    // A newer connection from the same player replaces the old one.
    for (const old of this.ctx.getWebSockets(pid)) { try { old.close(4001, 'replaced'); } catch {} }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [pid]);
    server.serializeAttachment({ pid });
    r.lastActive = Date.now();

    // Nobody was here to play: the clock was stopped. Give a fresh one.
    if (r.deadline && r.deadline < Date.now() + 5000 && !this.connected(server).some(Boolean)) {
      r.deadline = Date.now() + (r.state?.phase === 'planning' ? PLAN_MS : RESULTS_MS);
    }
    send(server, { type: 'welcome', code: r.code, you });
    if (!r.state && r.players.length === 2) {
      this.startGame();
      await this.changed();
    } else {
      if (r.state) send(server, this.stateMsg());
      await this.save();
      await this.schedule();
    }
    this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    const r = this.room;
    if (!r || r.ended) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const pid = ws.deserializeAttachment()?.pid;
    const you = r.players.findIndex((p) => p.pid === pid);
    if (you < 0 || !msg || typeof msg !== 'object') return;
    r.lastActive = Date.now();
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    if (msg.type === 'sync') return send(ws, this.stateMsg());
    if (msg.type === 'getLog') return send(ws, { type: 'log', log: r.log });
    if (msg.type === 'intent' && r.state) {
      const res = applyIntent(r.state, catalog, you, msg.intent);
      if (!res.ok) return send(ws, { type: 'reject', error: res.error });
      r.log.intents.push([you, msg.intent]);
      return this.changed();
    }
    if (msg.type === 'rematch' && r.state?.phase === 'gameover') {
      this.startGame();
      return this.changed();
    }
    if (msg.type === 'leave') {
      r.ended = 'left';
      this.broadcast({ type: 'ended', reason: 'left', who: r.players[you].name }, ws);
      await this.save();
      for (const s of this.ctx.getWebSockets()) { try { s.close(1000, 'ended'); } catch {} }
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} // complete the closing handshake
    await this.load();
    if (!this.room || this.room.ended) return;
    this.room.lastActive = Date.now();
    this.presence(ws);
    await this.save();
    await this.schedule();
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws, 1011, 'error');
  }

  async alarm() {
    await this.load();
    const r = this.room;
    if (!r) return;
    const anyone = this.connected().some(Boolean);
    if (!anyone && Date.now() >= r.lastActive + IDLE_MS - 1000) {
      // Abandoned: forget the room.
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    const s = r.state;
    if (anyone && s && r.deadline && Date.now() >= r.deadline - 50) {
      // Time's up: lock in whoever is still planning, or move everyone past
      // the battle results.
      const type = s.phase === 'planning' ? 'ready' : s.phase === 'combat' ? 'continue' : null;
      r.deadline = null;
      if (type) {
        for (const p of [0, 1]) {
          if (r.state.phase === s.phase && !r.state.players[p].ready) {
            const res = applyIntent(r.state, catalog, p, { type });
            if (res.ok) r.log.intents.push([p, { type }]);
          }
        }
      }
      return this.changed();
    }
    await this.save();
    await this.schedule();
  }
}

// ---- matchmaking -------------------------------------------------------------

// Players waiting for a random opponent. The first two (on the same build)
// get a fresh room together; each is told its code and joins it.
export class Queue extends DurableObject {
  async fetch(req) {
    const q = new URL(req.url).searchParams;
    const me = { pid: q.get('pid'), name: cleanName(q.get('name')) || 'Player', avatar: cleanAvatar(q.get('avatar')) };
    // The same player looking again replaces their old place in the queue.
    for (const old of this.ctx.getWebSockets(me.pid)) { try { old.close(4001, 'replaced'); } catch {} }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [me.pid]);
    server.serializeAttachment({ ...me, matching: false });
    send(server, { type: 'waiting' });
    // Pair with whoever has waited longest.
    const other = this.ctx.getWebSockets().find((ws) => ws !== server && ws.readyState === OPEN
      && !ws.deserializeAttachment()?.matching && ws.deserializeAttachment()?.pid !== me.pid);
    if (other) {
      const them = other.deserializeAttachment();
      other.serializeAttachment({ ...them, matching: true });
      server.serializeAttachment({ ...me, matching: true });
      const players = [{ pid: them.pid, name: them.name, avatar: them.avatar }, me];
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        const res = await this.env.ROOMS.get(this.env.ROOMS.idFromName(code)).fetch('https://room/init', {
          method: 'POST', body: JSON.stringify({ code, players }),
        });
        if (res.ok) {
          for (const ws of [other, server]) { send(ws, { type: 'matched', code }); try { ws.close(1000, 'matched'); } catch {} }
          break;
        }
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (raw === '{"type":"ping"}') send(ws, { type: 'pong' });
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }
}
