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
  'torterra', 'golem', 'coalossal', 'minior', 'minior-star', 'ditto',
];
export const DEFAULT_AVATAR = 'ditto';
export const BOT_AVATAR = 'golem';

export const avatarUrl = (id) => `assets/avatars/${validAvatar(id) ? id : DEFAULT_AVATAR}.png`;
export const validAvatar = (id) => typeof id === 'string' && AVATARS.includes(id);
export const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// { name, avatar, saved } - `saved` is false until the player has set one up.
export function loadProfile() {
  let data = null;
  try { data = JSON.parse(read(KEY) ?? 'null'); } catch {}
  if (data && typeof data === 'object') {
    return { name: cleanName(data.name), avatar: validAvatar(data.avatar) ? data.avatar : DEFAULT_AVATAR, saved: true };
  }
  const oldName = cleanName(read(OLD_NAME_KEY));
  return { name: oldName, avatar: DEFAULT_AVATAR, saved: Boolean(oldName) };
}

// Returns the cleaned profile; `stored` is false if the browser refused to save it.
export function saveProfile({ name, avatar }) {
  const profile = { name: cleanName(name), avatar: validAvatar(avatar) ? avatar : DEFAULT_AVATAR };
  let stored = true;
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { stored = false; }
  return { ...profile, saved: true, stored };
}
