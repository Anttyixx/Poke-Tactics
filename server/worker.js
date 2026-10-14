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
//   wss://<worker>/presence?pid=..&name=..&avatar=..&build=..   (friends, online status, battle requests)
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
    if (url.pathname === '/presence') return env.PRESENCE.get(env.PRESENCE.idFromName('presence')).fetch(req);
    if (url.pathname === '/room') {
      const code = q.get('code');
      if (!isCode(code)) return refuse('notfound', 'Codes are 5 letters and numbers, like KOKO4.');
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
    }
    return new Response('Not found', { status: 404 });
  },
};

// A new room for two players who've already agreed to play (matchmaking, or a
// friend accepting a battle request). Returns its code, or null.
async function createRoom(env, players) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://room/init', {
      method: 'POST', body: JSON.stringify({ code, players }),
    });
    if (res.ok) return code;
  }
  return null;
}

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
      const code = await createRoom(this.env, [{ pid: them.pid, name: them.name, avatar: them.avatar }, me]);
      if (code) for (const ws of [other, server]) { send(ws, { type: 'matched', code }); try { ws.close(1000, 'matched'); } catch {} }
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

// ---- friends -------------------------------------------------------------------

// Everyone with the game open keeps a connection here. It knows who's online,
// keeps each player's friends (stored, so they're there next time), and passes
// battle requests between friends.
//
// Players are known to each other only by their friend code (6 characters);
// the player id stays private between a browser and the server.
//
// To the server: { type: 'add', code } (send a friend request, or accept theirs),
// 'accept' / 'decline' / 'cancel' / 'remove' { code }, { type: 'challenge', code }
// (battle request to anyone, by friend code), { type: 'withdraw', code }, { type: 'answer',
// code, accept }, { type: 'status', status: 'online' | 'battling' },
// { type: 'profile', name, avatar }, 'ping'.
// From the server: { type: 'me', code }, { type: 'friends', friends: [{ code,
// name, avatar, status }], incoming: [..], outgoing: [..] }, { type: 'challenge',
// from }, { type: 'challengeSent', to }, { type: 'challengeEnded', code, name,
// reason }, { type: 'matched', code }, { type: 'notice', text }, 'pong'.

const FRIEND_CODE_LENGTH = 6;
const FRIENDS_MAX = 100;
const REQUESTS_MAX = 50;
const CHALLENGE_MS = 45_000; // a battle request expires after this long
const without = (list, x) => list.filter((y) => y !== x);
const withOne = (list, x) => (list.includes(x) ? list : [...list, x]);

export class Presence extends DurableObject {
  user(pid) { return this.ctx.storage.get(`u:${pid}`); }
  async put(...users) { for (const u of users) await this.ctx.storage.put(`u:${u.pid}`, u); }
  async byCode(code) {
    const clean = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pid = clean.length === FRIEND_CODE_LENGTH ? await this.ctx.storage.get(`c:${clean}`) : null;
    return pid ? this.user(pid) : null;
  }

  socketsOf(pid, except = null) {
    return this.ctx.getWebSockets(pid).filter((ws) => ws !== except && ws.readyState === OPEN);
  }
  statusOf(pid, except = null) {
    const socks = this.socketsOf(pid, except);
    if (!socks.length) return 'offline';
    return socks.some((ws) => ws.deserializeAttachment()?.status === 'battling') ? 'battling' : 'online';
  }
  tell(pid, msg) { for (const ws of this.socketsOf(pid)) send(ws, msg); }

  // Everything one player's friends screen shows.
  async snapshot(u, except = null) {
    const card = async (pid) => {
      const f = await this.user(pid);
      return f && { code: f.code, name: f.name, avatar: f.avatar, status: this.statusOf(pid, except) };
    };
    const list = async (pids) => (await Promise.all(pids.map(card))).filter(Boolean);
    return { type: 'friends', friends: await list(u.friends), incoming: await list(u.incoming), outgoing: await list(u.outgoing) };
  }
  async refresh(pids, except = null) {
    for (const pid of new Set(pids)) {
      if (!this.socketsOf(pid, except).length) continue;
      const u = await this.user(pid);
      if (u) this.tell(pid, await this.snapshot(u, except));
    }
  }

  async fetch(req) {
    const q = new URL(req.url).searchParams;
    const pid = q.get('pid');
    let u = await this.user(pid);
    if (!u) {
      let code;
      do code = Array.from(crypto.getRandomValues(new Uint32Array(FRIEND_CODE_LENGTH)), (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
      while (await this.ctx.storage.get(`c:${code}`));
      u = { pid, code, name: 'Player', avatar: null, friends: [], incoming: [], outgoing: [] };
      await this.ctx.storage.put(`c:${code}`, pid);
    }
    u.name = cleanName(q.get('name')) || u.name;
    u.avatar = cleanAvatar(q.get('avatar')) ?? u.avatar;
    await this.put(u);
    const wasOnline = this.socketsOf(pid).length > 0;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [pid]);
    server.serializeAttachment({ pid, status: 'online', build: q.get('build') });
    send(server, { type: 'me', code: u.code });
    send(server, await this.snapshot(u));
    if (!wasOnline) await this.refresh([...u.friends, ...u.incoming, ...u.outgoing]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    const att = ws.deserializeAttachment();
    const me = await this.user(att?.pid);
    if (!me) return;
    const notice = (text) => send(ws, { type: 'notice', text });

    if (msg.type === 'status') {
      if (msg.status !== 'online' && msg.status !== 'battling') return;
      ws.serializeAttachment({ ...att, status: msg.status });
      return this.refresh(me.friends);
    }
    if (msg.type === 'profile') {
      me.name = cleanName(msg.name) || me.name;
      me.avatar = cleanAvatar(msg.avatar) ?? me.avatar;
      await this.put(me);
      return this.refresh([...me.friends, ...me.incoming, ...me.outgoing]);
    }

    const them = await this.byCode(msg.code);
    if (!them) return notice(msg.type === 'add' ? 'No player has that friend code. Check it and try again.' : 'That player wasn\'t found.');
    if (them.pid === me.pid) return notice('That\'s your own friend code!');

    if (msg.type === 'add') {
      if (me.friends.includes(them.pid)) return notice(`You and ${them.name} are already friends.`);
      if (me.incoming.includes(them.pid)) return this.befriend(me, them); // they asked first
      if (me.friends.length >= FRIENDS_MAX) return notice('Your friends list is full.');
      if (them.incoming.length >= REQUESTS_MAX) return notice(`${them.name} has too many friend requests right now.`);
      me.outgoing = withOne(me.outgoing, them.pid);
      them.incoming = withOne(them.incoming, me.pid);
      await this.put(me, them);
      notice(`Friend request sent to ${them.name}.`);
      return this.refresh([me.pid, them.pid]);
    }
    if (msg.type === 'accept') {
      if (!me.incoming.includes(them.pid)) return notice('That friend request isn\'t there any more.');
      return this.befriend(me, them);
    }
    if (msg.type === 'decline' || msg.type === 'cancel' || msg.type === 'remove') {
      me.incoming = without(me.incoming, them.pid); them.outgoing = without(them.outgoing, me.pid);
      me.outgoing = without(me.outgoing, them.pid); them.incoming = without(them.incoming, me.pid);
      if (msg.type === 'remove') { me.friends = without(me.friends, them.pid); them.friends = without(them.friends, me.pid); }
      await this.put(me, them);
      return this.refresh([me.pid, them.pid]);
    }

    if (msg.type === 'challenge') {
      const status = this.statusOf(them.pid);
      if (status === 'offline') return notice(`${them.name} isn't online right now.`);
      if (status === 'battling') return notice(`${them.name} is in a battle right now.`);
      if (!this.socketsOf(them.pid).some((s) => s.deserializeAttachment()?.build === att.build)) {
        return notice(`${them.name} is on a different version of the game. Both of you refresh the page and try again.`);
      }
      await this.ctx.storage.put(`ch:${me.pid}`, { to: them.pid, at: Date.now() });
      this.tell(them.pid, { type: 'challenge', from: { code: me.code, name: me.name, avatar: me.avatar }, expiresIn: CHALLENGE_MS });
      this.tell(me.pid, { type: 'challengeSent', to: { code: them.code, name: them.name, avatar: them.avatar }, expiresIn: CHALLENGE_MS });
      return this.ctx.storage.setAlarm(Date.now() + CHALLENGE_MS + 500);
    }
    if (msg.type === 'withdraw') {
      const ch = await this.ctx.storage.get(`ch:${me.pid}`);
      if (ch?.to !== them.pid) return;
      await this.ctx.storage.delete(`ch:${me.pid}`);
      return this.tell(them.pid, { type: 'challengeEnded', code: me.code, name: me.name, reason: 'cancelled' });
    }
    if (msg.type === 'answer') {
      const ch = await this.ctx.storage.get(`ch:${them.pid}`);
      if (ch?.to !== me.pid || Date.now() - ch.at > CHALLENGE_MS) {
        this.tell(me.pid, { type: 'challengeEnded', code: them.code, name: them.name, reason: 'expired' });
        return;
      }
      await this.ctx.storage.delete(`ch:${them.pid}`);
      if (!msg.accept) return this.tell(them.pid, { type: 'challengeEnded', code: me.code, name: me.name, reason: 'declined' });
      const code = await createRoom(this.env, [
        { pid: them.pid, name: them.name, avatar: them.avatar },
        { pid: me.pid, name: me.name, avatar: me.avatar },
      ]);
      if (!code) return notice('Couldn\'t start the battle. Try again.');
      this.tell(them.pid, { type: 'matched', code });
      this.tell(me.pid, { type: 'matched', code });
    }
  }

  async befriend(me, them) {
    me.incoming = without(me.incoming, them.pid); them.outgoing = without(them.outgoing, me.pid);
    me.outgoing = without(me.outgoing, them.pid); them.incoming = without(them.incoming, me.pid);
    me.friends = withOne(me.friends, them.pid); them.friends = withOne(them.friends, me.pid);
    await this.put(me, them);
    this.tell(me.pid, { type: 'notice', text: `You and ${them.name} are now friends.` });
    this.tell(them.pid, { type: 'notice', text: `You and ${me.name} are now friends.` });
    return this.refresh([me.pid, them.pid]);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid || this.socketsOf(pid, ws).length) return; // still here in another tab
    const me = await this.user(pid);
    if (!me) return;
    // Gone: their battle request goes with them, and friends see them offline.
    const ch = await this.ctx.storage.get(`ch:${pid}`);
    if (ch) {
      await this.ctx.storage.delete(`ch:${pid}`);
      this.tell(ch.to, { type: 'challengeEnded', code: me.code, name: me.name, reason: 'cancelled' });
    }
    await this.refresh([...me.friends, ...me.incoming, ...me.outgoing], ws);
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws, 1011);
  }

  // Battle requests nobody answered.
  async alarm() {
    const pending = await this.ctx.storage.list({ prefix: 'ch:' });
    let next = Infinity;
    for (const [key, ch] of pending) {
      if (Date.now() - ch.at >= CHALLENGE_MS) {
        await this.ctx.storage.delete(key);
        const from = await this.user(key.slice(3));
        const to = await this.user(ch.to);
        if (from && to) {
          this.tell(from.pid, { type: 'challengeEnded', code: to.code, name: to.name, reason: 'expired' });
          this.tell(to.pid, { type: 'challengeEnded', code: from.code, name: from.name, reason: 'expired' });
        }
      } else next = Math.min(next, ch.at + CHALLENGE_MS + 500);
    }
    if (next < Infinity) await this.ctx.storage.setAlarm(next);
  }
}
