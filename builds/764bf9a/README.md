# Auto Battler (working title)

A browser-based 1v1 auto-battler. Buy units, place them on your half of the grid,
then watch the fight play out by itself. Plain HTML/CSS/JS with ES modules. There is
no build step and no dependencies, and it deploys to GitHub Pages as static files.

**Status: Phase 1, a single-player loop against a bot.** PeerJS host/join (Phase 2) and
host-authoritative multiplayer (Phase 3) are not started yet.

## Run locally

ES modules and `fetch()` don't work from `file://`, so serve the folder over HTTP:

```sh
python3 -m http.server 8000      # or: npm start
# open http://localhost:8000
```

Add `?unit=<id>` (e.g. `?unit=beheeyem`) to put that troop in the first shop slot whenever your pool still has a copy, for testing new units.
Add `?seed=anything` to the URL to make the first match reproducible, which helps with bug reports.
In the browser console, `game.state` shows the live game state.

## Tests

```sh
node tests/run.js                # or: npm test   (Node 18+, no install needed)
```

The tests cover what Phase 3 depends on. A full bot-vs-bot match is identical for the
same seed. State survives JSON round-trips. `simulate()` is pure. `applyIntent()` rejects
malformed or out-of-phase intents and leaves state unchanged when it does.

## How to play

- **Team:** before round 1, each player picks 6 Pokémon. Each one puts 4 copies into that player's own
  pool. The board starts empty: everything you field, you buy.
- **Coins:** you start with 6. After each battle the winner gets 6 coins and the loser 9 (a draw pays
  both 9). Coins carry over between rounds with no cap. Troops cost 2–5 coins per copy.
- **Shop:** 3 slots, drawn from your pool (never more copies than the pool holds). The shop refreshes
  by itself after every battle.
- **Rerolls:** free, but limited. You start with 3 and get 1 more each round, up to a maximum of 3.
  When you're out, you can't reroll until the next round.
- **Buying:** click a shop troop, then a square on your half (or drag the card onto the board). A copy
  you buy leaves your pool. There is no bench.
- **Stars:** each troop can be on the board only once. Buying a copy of a troop you already field levels
  that troop up instead (click anywhere on your side): 1 copy = 0★, 2 = ★, 3 = ★★, 4 = ★★★. Each
  Pokémon lists its own HP and damage for every star level. Moving a troop onto another unit swaps them.
- **Selling:** drag a troop onto the shop (or press Sell) for its cost in coins per copy; all its copies go back
  to your pool.
- **Board:** your half is 5×4 (the board is 5 wide by 8 tall); the row next to the centre line is the
  front. There is no limit on how many troops you field.
- **Combat:** units target the nearest enemy they can reach and walk (pathing around anyone in the way)
  into range one square at a time (up/down/left/right). Movement speed is a tier: fast 0.5s per square,
  medium 0.8s, slow 1.0s, very slow 1.3s. A unit attacks every `secPerHit` seconds; each basic attack
  has a `critChance`% chance to crit for 50% more damage (powers never crit). Each tick resolves
  simultaneously, and crit luck is shared slot for slot between the sides, so neither side gets an edge.
- **Powers:** every Pokémon has one. Most count attacks (the purple bar). Every fight starts with the bar
  empty and a full attack cooldown before anyone's first hit, and progress is never lost mid-fight:
  - Mawile, **Jaw Lock**: after 8 attacks, the next hits for 130% and stuns for 1s.
  - Beheeyem, **Psywave**: at the start of battle, a wave down its column hits the first enemy for 50% and
    knocks it to the far end of the column; anyone already there is pushed to the side.
  - Toxtricity, **Thunderbolt**: every 8th attack also zaps the farthest enemy for 80%.
  - Vespiquen, **Attack Order**: every 7 attacks, summons a Combee next to it (same star level). Combee
    fight but never count as survivors for round damage. With no free square, the power stays charged
    and tries again after the next attack.
  - Coalossal, **Heat Crash**: after 6 attacks, the next hits for 130%, knocks the target back 2 squares
    (or to the closest free square) and stuns it for 1s.
  - Decidueye, **Phantom Force**: after 8 attacks, invisible for 3s and attacks 30% faster. Enemies can't
    target or follow an invisible unit.
  - Greninja, **Night Slash**: after 6 attacks, the next teleports beside the farthest enemy (if it's out of
    reach), hits for 130% and heals 10% of the damage dealt.
  - Infernape, **Blaze**: after 7 attacks, attacks 50% faster for 3s.
- **Sudden death:** fights have a 30-second timer. When it runs out, every Pokémon still standing loses
  300 HP per second (the same for everyone, ignoring shields) while the fight carries on, so the weakest
  fall first until one side is knocked out.
- **Damage:** the loser takes `round + 2 × (copies in the winner's surviving troops)`. A draw (the last
  Pokémon on both sides fall at the same moment) costs each player `ceil(round / 2)`. Everyone starts at 100 HP.
- **Keys:** `D` reroll, `F` fight, `E` sell the selected troop, `Space` skip the combat replay, `Esc` deselect.

## Project layout

```
index.html          page shell
styles.css
assets/sprites/     walk sheets: 256x256, 4x4 grid of 64px frames;
                    rows = facing down, left, right, up; columns = walk cycle
data/units.json     unit catalog: cost, hp and damage per star, range, moveSpeed tier,
                    secPerHit, critChance, energy (attacks per power) and the power
                    ("ability"). "summon": true units (Combee) only appear in battle
src/rng.js          seeded PRNG whose state is stored in game state
src/combat.js       simulate(catalog, boards). Pure and deterministic, returns an event log
src/game.js         rules: createGame(), applyIntent(). The only thing that changes state
src/bot.js          dummy opponent. Uses the same intents as a human
src/ui.js           DOM rendering, input -> intents, replays combat from the event log
src/main.js         wires game + bot + UI together (single player)
tests/run.js        Node test runner
.github/workflows/pages.yml   deploys main -> / and dev -> /dev/
```

`src/network.js` will arrive in Phase 2.

## Hosting and branches

| Branch | Purpose | URL |
| --- | --- | --- |
| `main` | Stable. Only merge into it from `dev` when a version is ready. | `https://<user>.github.io/<repo>/` |
| `dev`  | Day-to-day work. Merge feature branches here. | `https://<user>.github.io/<repo>/dev/` |

`.github/workflows/pages.yml` runs on every push to `main` or `dev`. It runs the tests, then
copies that branch's files into its own folder on the `gh-pages` branch, which is what Pages
serves. A failing test blocks the deploy. A small badge in the corner of each build shows
`stable` or `dev` plus the commit it came from.

Until `main` has a release, the root page links to the dev build.

**Per-build links.** Every deploy is also published permanently at
`https://<user>.github.io/<repo>/builds/<commit>/`, and `/builds/` lists them newest first
(the last 30 are kept). `/dev/` and the root can be cached by browsers for up to 10 minutes
after an update, but a build link is a brand-new address, so it shows the update as soon as
Pages has published it (usually within a minute of the push). Each workflow run also prints its
build link as a notice in the Actions tab.

**One-time setup** (after the first workflow run has created the `gh-pages` branch):
in **Settings → Pages → Build and deployment**, set Source to *Deploy from a branch*,
Branch to `gh-pages`, and folder to `/ (root)`.

**Releasing:** open a PR from `dev` to `main` and merge it. The stable site updates a minute later.

All asset paths are relative, so the game works at both the site root and `/dev/`.

## Architecture notes for Phase 3 (host-authoritative)

The Phase 1 code is built to make the multiplayer phase easy:

- **One state object, one way to change it.** All match state is in a plain JSON object.
  The UI never mutates it. Clicks become intents (`buy`, `sell`, `reroll`, `move`, `ready`,
  `continue`) and go through `applyIntent(state, catalog, player, intent)`, which validates them.
  The bot already plays through this API, so in Phase 3 the guest's intents just replace the bot's.
- **Deterministic, pure combat.** `simulate()` uses integer math and fixed tie-breaking. It never
  calls `Math.random`. It returns an event log (`move`, `attack`, `damage`, `cast`, …). Clients
  only replay that log, which is the "render from received state" model in the brief.
- **Seeded, per-player RNG.** Shop rolls use an RNG whose state is stored in each player's
  state. The host owns it, and one player's rerolls can't change the other player's shops.
- **Symmetric seats.** Both players place units in "own" coordinates (front line = row 0) and the
  simulation mirrors side 1. The UI flips the view so each player sees their own side at the bottom.
- **Phases advance on "everyone ready."** Combat starts when every player sends `ready`. The next
  round starts when everyone sends `continue`. That's the same handshake two remote players need.
