// Tries candidate stat changes one at a time and reports each target's win rate
// in random-team games, against the unchanged game.
//   node tools/sweep.mjs [games=6000] [candidates.json] [out=tools/out/sweep.json]
// candidates.json: [{ "id": "mawile", "label": "HP x1.5", "patch": { ... } }, ...]
// With no candidates file, the built-in list below is used.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeJobs, runJobs } from './balance.mjs';

const catalog = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const scale = (arr, k) => arr.map((v) => Math.round(v * k));
const hp = (id, k) => ({ [id]: { hp: scale(catalog[id].hp, k) } });
const dmg = (id, k) => ({ [id]: { damage: scale(catalog[id].damage, k) } });
const merge = (...ps) => ps.reduce((a, p) => { for (const [id, f] of Object.entries(p)) a[id] = { ...a[id], ...f }; return a; }, {});

const BUILT_IN = [
  { id: 'beheeyem', label: 'Damage -15%', patch: dmg('beheeyem', 0.85) },
  { id: 'beheeyem', label: 'Damage -25%', patch: dmg('beheeyem', 0.75) },
  { id: 'beheeyem', label: 'Cost 2 → 3', patch: { beheeyem: { cost: 3 } } },
  { id: 'beheeyem', label: 'HP -20%', patch: hp('beheeyem', 0.8) },
  { id: 'infernape', label: 'HP -10%', patch: hp('infernape', 0.9) },
  { id: 'infernape', label: 'Cost 2 → 3', patch: { infernape: { cost: 3 } } },
  { id: 'mawile', label: 'HP +50%', patch: hp('mawile', 1.5) },
  { id: 'mawile', label: 'HP +80%', patch: hp('mawile', 1.8) },
  { id: 'mawile', label: 'HP +50%, power every 5', patch: merge(hp('mawile', 1.5), { mawile: { energy: 5 } }) },
  { id: 'mawile', label: 'Cost 5 → 4, HP +40%', patch: merge(hp('mawile', 1.4), { mawile: { cost: 4 } }) },
  { id: 'torterra', label: 'Power every 6', patch: { torterra: { energy: 6 } } },
  { id: 'torterra', label: 'Power every 5', patch: { torterra: { energy: 5 } } },
  { id: 'greninja', label: 'Power every 7', patch: { greninja: { energy: 7 } } },
  { id: 'greninja', label: 'Power every 6', patch: { greninja: { energy: 6 } } },
  { id: 'hoopa', label: 'HP +25%', patch: hp('hoopa', 1.25) },
  { id: 'hoopa', label: 'Power every 4', patch: { hoopa: { energy: 4 } } },
];

const games = Number(process.argv[2] ?? 6000);
const candidates = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : BUILT_IN;
const outPath = process.argv[4] ?? new URL('./out/sweep.json', import.meta.url).pathname;
const jobs = makeJobs(games, { randomOnly: true });

function winRates(results) {
  const tally = {};
  for (const g of results) {
    if (g.winner === null) continue;
    g.teams.forEach((team, side) => {
      for (const id of team) {
        tally[id] ??= { n: 0, w: 0 };
        tally[id].n++;
        if (g.winner === side) tally[id].w++;
      }
    });
  }
  return Object.fromEntries(Object.entries(tally).map(([id, t]) => [id, t.w / t.n]));
}

const t0 = Date.now();
const base = winRates(await runJobs(jobs));
const rows = [];
for (const c of candidates) {
  const wr = winRates(await runJobs(jobs, c.patch));
  rows.push({ ...c, before: base[c.id], after: wr[c.id] });
  console.log(`${c.id.padEnd(10)} ${c.label.padEnd(26)} ${(base[c.id] * 100).toFixed(1)}% -> ${(wr[c.id] * 100).toFixed(1)}%`);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ games, base, rows }, null, 1));
console.log(`${candidates.length} candidates x ${games} games in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
