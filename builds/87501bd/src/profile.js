// The player's profile (name and picture), saved in this browser with
// localStorage so it's still there after closing the tab or browser. Nothing
// leaves the browser except the name and picture id shown to an online
// opponent. Clearing the site's data (or a private window) starts fresh.

const KEY = 'poke-tactics-profile';
const OLD_NAME_KEY = 'poke-tactics-name'; // before profiles, only the name was kept

export const NAME_MAX = 16;
// Profile pictures: the front-facing frame of these sprites, cropped and
// centred into assets/avatars/ by tools/make-avatars.py.
export const AVATARS = [
  'infernape', 'greninja', 'ash-greninja', 'decidueye', 'tapukoko', 'mawile',
  'lilligant', 'vespiquen', 'combee', 'hoopa', 'beheeyem', 'toxtricity',
  'torterra', 'golem', 'coalossal', 'minior', 'minior-star', 'ditto', 'frosmoth',
  'alcremie', 'alcremie-matcha', 'alcremie-ruby', 'alcremie-mint',
  'hoopa-unbound', 'amoonguss', 'annihilape', 'dragapult', 'dreepy',
];
export const DEFAULT_AVATAR = 'ditto';
export const BOT_AVATAR = 'golem';

export const avatarUrl = (id) => `assets/avatars/${validAvatar(id) ? id : DEFAULT_AVATAR}.png`;
export const validAvatar = (id) => typeof id === 'string' && AVATARS.includes(id);
export const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
const record = (r) => ({ wins: count(r?.wins), losses: count(r?.losses), draws: count(r?.draws) });
const MODES = ['online', 'training'];
export const FRIENDS_MAX = 50;

// Stats kept for the profile screen: match results per mode, and how many
// battles each Pokémon has been on the player's board for.
function cleanStats(s) {
  const troops = {};
  for (const [id, n] of Object.entries(s?.troops ?? {})) if (/^[a-z0-9-]{1,32}$/.test(id) && count(n)) troops[id] = count(n);
  return { online: record(s?.online), training: record(s?.training), troops };
}
// Friends: { id, name, avatar }. Adding friends comes later (codes); the
// profile screen can already list and remove them.
function cleanFriends(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter((f) => f && typeof f.id === 'string' && f.id && !seen.has(f.id) && seen.add(f.id))
    .slice(0, FRIENDS_MAX)
    .map((f) => ({ id: f.id.slice(0, 64), name: cleanName(f.name) || 'Friend', avatar: validAvatar(f.avatar) ? f.avatar : DEFAULT_AVATAR }));
}

// { name, avatar, stats, friends, saved } - `saved` is false until the player
// has set up a name or picture.
export function loadProfile() {
  let data = null;
  try { data = JSON.parse(read(KEY) ?? 'null'); } catch {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = null;
  const oldName = cleanName(read(OLD_NAME_KEY));
  return {
    name: data ? cleanName(data.name) : oldName,
    avatar: validAvatar(data?.avatar) ? data.avatar : DEFAULT_AVATAR,
    stats: cleanStats(data?.stats),
    friends: cleanFriends(data?.friends),
    saved: data ? data.saved !== false : Boolean(oldName),
  };
}

function store(profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); return true; } catch { return false; }
}

// Save a new name and picture, keeping stats and friends. Returns the profile;
// `stored` is false if the browser refused to save it.
export function saveProfile({ name, avatar }) {
  const profile = { ...loadProfile(), name: cleanName(name), avatar: validAvatar(avatar) ? avatar : DEFAULT_AVATAR, saved: true };
  return { ...profile, stored: store(profile) };
}

// After a match: `result` is 'win', 'loss' or 'draw'; `mode` 'online' or 'training'.
export function recordMatch(mode, result) {
  const profile = loadProfile();
  const key = { win: 'wins', loss: 'losses', draw: 'draws' }[result];
  if (!MODES.includes(mode) || !key) return profile;
  profile.stats[mode][key]++;
  store(profile);
  return profile;
}

// Before each battle: every Pokémon the player fields counts one battle.
export function recordBattle(unitIds) {
  const profile = loadProfile();
  for (const id of new Set(unitIds)) profile.stats.troops[id] = (profile.stats.troops[id] ?? 0) + 1;
  store(profile);
  return profile;
}

// The Pokémon fielded in the most battles: { id, battles } or null.
export function favouriteTroop(stats) {
  let best = null;
  for (const [id, n] of Object.entries(stats.troops)) if (!best || n > best.battles || (n === best.battles && id < best.id)) best = { id, battles: n };
  return best;
}

export function addFriend(friend) {
  const profile = loadProfile();
  profile.friends = cleanFriends([...profile.friends.filter((f) => f.id !== friend?.id), friend]);
  store(profile);
  return profile;
}

export function removeFriend(id) {
  const profile = loadProfile();
  profile.friends = profile.friends.filter((f) => f.id !== id);
  store(profile);
  return profile;
}
