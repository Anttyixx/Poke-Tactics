// How much the bot's layout rules (src/bot.js) are worth: full bot-vs-bot games
// where one side rearranges its board by the rules before every fight and the
// other is the old bot, which leaves each Pokémon where it was bought.
//
//   node tools/bot-rules.mjs [games=4000]
//
// Teams are random; in half the games both sides get the same team, so only
// the layout differs. Sides alternate.

import { readFileSync } from 'node:fs';
import { playGame } from './balance.mjs';
import { hashSeed } from '../src/rng.js';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const troops = Object.keys(catalog).filter((id) => !catalog[id].summon && !catalog[id].disabled);
const N = Number(process.argv[2] ?? 4000);
const pick = (seed, salt) => [...troops].map((t, k) => [hashSeed(`${seed}-${salt}-${t}-${k}`), t]).sort((a, b) => a[0] - b[0]).slice(0, 6).map((x) => x[1]);

const tally = { all: [0, 0], same: [0, 0] };
for (let i = 0; i < N; i++) {
  const seed = hashSeed(`bot-rules-${i}`);
  const same = i % 2 === 0;
  const a = pick(seed, 'a');
  const b = same ? a : pick(seed, 'b');
  const side = (i >> 1) % 2; // which side uses the rules
  const g = playGame(seed, [a, b], side === 0 ? ['default', 'basic'] : ['basic', 'default']);
  if (g.winner === null) continue;
  for (const k of same ? ['all', 'same'] : ['all']) { tally[k][1]++; if (g.winner === side) tally[k][0]++; }
}
const pct = ([w, n]) => `${((100 * w) / n).toFixed(1)}% ±${(196 * Math.sqrt(((w / n) * (1 - w / n)) / n)).toFixed(1)} of ${n} games`;
console.log(`Rule-based bot vs old bot: wins ${pct(tally.all)} · with the same team on both sides: ${pct(tally.same)}`);
