# Saved versions

Snapshots of a Pokémon's design before trying something new, so it can be put back.

| Saved | Git tag | What it holds |
|---|---|---|
| Dragapult + Dreepy (game 0.33.2) | `dragapult-v1` | `dragapult-v1.json`: stats, ability settings, rules and win rates |

To restore one, bring back the tagged versions of the files that define it (for Dragapult:
`data/units.json` entries `dragapult` and `dreepy`, the darts code in `src/combat.js`, its
text and animations in `src/ui.js` and `styles.css`, and its tests in `tests/run.js`), for example
`git checkout dragapult-v1 -- src/combat.js`, then re-apply any unrelated changes made since.
