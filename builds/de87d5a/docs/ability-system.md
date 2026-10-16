# Plan: building-block abilities

Status: **planned, not built.** This is the design to implement in a fresh session.

## Goal

Every power (and every basic attack) is described in `data/units.json` as a combination of
standard parts, instead of one hand-written `kind` per power in `src/combat.js`. Reworking a
power (new trigger, swapped effect, splash added) becomes a JSON edit, and the balance tools
(`tools/`) can test any combination without new code.

## Shape of an ability

```json
{
  "name": "Wild Charge",
  "when": { "every": 4, "attack": "next" },
  "effects": [
    { "dash": "farthestEnemy", "immune": true },
    { "damage": 150, "at": "target", "pattern": "single" },
    { "stun": 1.0, "to": ["target", "dashedThrough"] }
  ]
}
```

### When (trigger)
- `{ "every": N, "attack": "next" }`: after N attacks, the next attack is replaced by the power (empower).
- `{ "every": N, "attack": "also" }`: on the Nth attack, the power fires as well (instant).
- `"battleStart"`, `{ "hpBelow": 25 }`, `"knockedOut"`, `"everyAttack"` (passive), `{ "everySeconds": 3 }`.
- Charges reset to 0 each fight, as now; triggers with no charges don't show the purple bar.

### Who (target selectors)
`self`, `target` (current attack target), `nearestEnemy`, `farthestEnemy`, `allEnemies`,
`allAllies`, `lowestHpAlly`, `column` (first enemy down its column, Psywave), `dashedThrough`.

### Where it lands (hit pattern)
Placed on a centre (`at`: `target`, `self`, `landing` square after a dash/teleport):
- `"single"`, `"cross"` (+ shape), `{ "square": N }` (3x3 at 1, 5x5 at 2),
  `{ "line": N }` (straight on through the target), `"row"`, `"column"`, `{ "cone": N }`,
  `{ "cells": [[dx, dy], ...] }` (custom offsets).
- Offsets are in the attacker's facing: forward = toward the enemy side, mirrored for side 1,
  so both sides behave identically.
- `skipCentre: true`, per-ring falloff (`"falloff": [100, 50]`), and `affects`: `enemies` (default
  for damage), `allies` (default for heals), `all`.
- Basic attacks may also carry a pattern (`"attackPattern"`), e.g. every hit splashes a 3x3.

### What (effects)
`damage` (% of attack), `heal` (% of attack, or `lifesteal` % of damage dealt), `stun` (s),
`knockback` (squares), `pull` (squares, new), `dash` / `teleport` (to a selector),
`haste` (% , s), `invisible` (s), `shield` (% max HP, new), `immune` (s), `summon`
(unit, count by star, star), `transform` (form), `copy` (Ditto's rules), `explode`
(delay, used with `knockedOut`).

## Current powers rebuilt from parts

| Pokémon | Today's `kind` | As parts |
|---|---|---|
| Mawile | empower 130%, stun | every 8 → next: damage 130 at target; stun 1s target |
| Beheeyem | opening wave | battleStart: column → damage 50, carry to far end, stun 1s on landing |
| Toxtricity | snipe 80% | every 8 → also: damage 80 at farthestEnemy |
| Vespiquen | summon | every 6 → also: summon combee ×2 at own star, sides first |
| Coalossal | empower, knockback, stun | every 6 → next: damage 130, knockback 2, stun 1s |
| Decidueye | stealth + haste | every 8 → also: invisible 3s, haste 30% 3s |
| Hoopa | teleport, lifesteal | every 6 → next: teleport beside farthest, damage 130, lifesteal 10% |
| Infernape | haste | every 7 → also: haste 50% 3s |
| Greninja | transform | every 10 → also: transform Ash-Greninja |
| Torterra | quake | every 10 → also: damage 30 + stun 1s to allEnemies |
| Lilligant | splash heal | everyAttack: heal 50 at target, pattern cross, allies, skipCentre |
| Golem | self-destruct | knockedOut: explode after 3s, damage 300, pattern square 1 |
| Minior | low-HP transform | hpBelow 25: immune 0.5s, then transform Star Form |
| Tapu Koko | dash | every 4 → next: dash to farthest (immune), damage 150, stun target + dashedThrough |
| Ditto | copy | battleStart-ish: copy rules (walk into range, 0.5s, copy stats) |

## Rules that must hold for every part
The engine's fairness rules apply to every effect, exactly as today: stuns, heals, knockbacks,
transforms and HP changes resolve at the end of the tick; immunity and invisibility start on the
next tick; targeting reads start-of-tick positions; directions mirror for side 1. The mirror
fairness test in `tests/run.js` must keep passing.

## Build steps
1. Before touching anything, save a fingerprint of current results (see the speed-up commit:
   hash thousands of `playGame` results and raw `simulate` event logs).
2. Add the parts engine in `src/combat.js` (or `src/abilities.js`), with the current `kind`s
   translated to parts at load time, so `units.json` can migrate gradually.
3. Fingerprint must match **byte for byte**; all 46 tests must pass.
4. Migrate `units.json` to the parts format; fingerprint still identical.
5. Pokédex text (`describePower` in `src/ui.js`) and battle animations generated from parts.
6. Tools: patches replace a whole ability (`"ability!": {...}`); `tools/tune.mjs` sweeps a
   numeric field to a target win rate; power on/off comparison; power stats (fires per fight,
   first fire time, damage/heal/stun contributed) in `tools/focus.mjs`.
7. New effects (`pull`, `shield`, cones, etc.) each get a test like the existing power tests.
