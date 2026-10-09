// Seeded PRNG (mulberry32). The whole generator state is one uint32 stored on a
// plain object (`holder.rng`), so it lives inside JSON game state and can be
// serialized, sent over the network, and replayed exactly.
// Never use Math.random() inside game rules or combat — only to pick a seed.

export function rand(holder) {
  let t = (holder.rng = (holder.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(holder, n) {
  return Math.floor(rand(holder) * n);
}

// FNV-1a hash so a readable seed like "?seed=test" maps to a uint32.
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
