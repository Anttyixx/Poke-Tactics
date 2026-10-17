# Saved versions

Snapshots of a Pokémon's design before trying something new, so it can be put back.

| Saved | Commit | What it holds |
|---|---|---|
| Dragapult + Dreepy (game 0.33.2) | `45c1684` | `dragapult-v1.json`: stats, ability settings, rules and win rates |
| Hoopa with Hoopa Unbound (game 0.36.2) | `8a8a88d` | `hoopa-v1.json`: stats, ability settings and rules |

To restore one, bring back the tagged versions of the files that define it (for Dragapult:
`data/units.json` entries `dragapult` and `dreepy`, the darts code in `src/combat.js`, its
text and animations in `src/ui.js` and `styles.css`, and its tests in `tests/run.js`), for example
`git checkout 45c1684 -- src/combat.js`, then re-apply any unrelated changes made since.
