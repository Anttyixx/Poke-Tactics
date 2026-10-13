# Auto Battler (working title)

A browser-based 1v1 auto-battler. Buy units, place them on your half of the grid,
then watch the fight play out by itself. Plain HTML/CSS/JS with ES modules. There is
no build step, and it deploys to GitHub Pages as static files. The only third-party
code is PeerJS (MIT, copied into `vendor/`) for online play.

**Status:** play against the bot, or a friend online with a game code.

## Online play

**Battle** on the start screen. One player taps **Create game** and gets a
5-character code (and an invite link, `?join=CODE`); the other enters it under **Join**.

- When the two connect, a battle-style screen wipe shows both trainers' names.
- Each planning phase lasts 30 seconds (the Fight button counts down, red for the last 10).
  When time runs out, anyone still planning is locked in as they are. The host's clock decides.
- Browsers connect directly over WebRTC (`src/net.js`); PeerJS's free public server only
  introduces them. Strict networks (some school/work Wi-Fi, some mobile data) can block
  direct connections; then the join fails with a message suggesting another network.
- The host's browser runs the match (`src/main.js`): the guest sends intents, the host
  validates them with `applyIntent()` like anyone's and sends the new state back after
  every change. Both players must run the same build; otherwise the join is refused.
- A heartbeat notices a friend who leaves or loses connection; the other player is told
  the match ended. **Leave match** in the menu disconnects. After a match: **Rematch**.
- Players on different networks often can't connect directly; then a TURN relay from
  Metered.ca carries the messages (`src/net-config.js`). Its username and password (from
  "New credential" in Metered's TURN dashboard) live in the `METERED_TURN_USERNAME` and
  `METERED_TURN_PASSWORD` repository secrets; the deploy workflow writes them into the site.
- **Battle → Check my connection** shows whether the relay login is set and whether
  direct and relayed routes work on that device.
- `?peer=host:port` uses your own PeerJS server instead of the public one, e.g.
  `npx peerjs --port 9000` for testing two tabs locally.

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

## What's new (changelog)

`data/changelog.json` feeds the in-game **What's new** screen (start screen and Menu). Add an
entry at the **top** for every update players should hear about; a new `id` shows players an
unread dot until they open it.

```json
{ "id": "2026-10-12-balance", "version": "0.6.0", "date": "2026-10-12", "title": "Balance update",
  "intro": "Optional sentence.",
  "changes": [ { "pokemon": "mawile", "kind": "buff", "text": "Cost 5 → 4." } ] }
```

`kind` is `buff`, `nerf`, `new`, `change` or `fix`; `pokemon` (optional) shows its sprite.
The newest entry's `version` is the game's version, shown on the start screen and in its menu
(with the build), so bump it with each entry: patch (0.6.1 → 0.6.2) for fixes and small changes,
minor (0.6 → 0.7) for bigger updates.

## Balance testing

`tools/` plays thousands of full bot-vs-bot games (team pick, shop, every round) and
summarizes what each Pokémon did. It's for development only and isn't deployed.

```sh
node tools/balance.mjs 20000     # random-team games + archetype games -> tools/out/balance.json
node tools/analyze.mjs           # win rates, damage, survival, pairs -> tools/out/summary.json
node tools/sweep.mjs             # try stat changes one at a time without editing units.json
```

Two specific teams, with each team's stats per Pokémon:

```sh
node tools/match.mjs "beheeyem,infernape,ditto,vespiquen,lilligant,hoopa" "coalossal,torterra,golem,minior,mawile,decidueye" --games=500 --place=smart
```

`--place=smart` makes the simulated players reposition before every fight to counter the
opponent's lineup from the round before (`tools/placer.mjs`), the way a real player would;
`--place-a` / `--place-b` set each side separately. `balance.mjs --smart` does the same for
the whole study. All tools use the game's own code (`src/combat.js`, `src/game.js`,
`src/bot.js`), so they stay accurate as the game changes.

One Pokémon in depth (best squares, rows and columns, hardest and easiest opponents, best
teammates, who knocks it out, stats by star), as a console summary and an HTML report:

```sh
node tools/focus.mjs mawile --games=4000 [--smart]   # -> tools/out/focus-mawile.html
```

A real match: in the game, **Menu → Match log** (or **Copy match log** after a match) copies
the game's seed and every move both players made, plus your notes. Save it to a file, then:

```sh
node tools/replay.mjs match.json [--patch=patch.json]
```

It rebuilds the match exactly with the stats of the build it was played on (read from git
history) and, for every fight, checks how much was luck (the same boards with other seeds),
whether the loser could have won with a different arrangement of the same Pokémon, and, with
`--patch`, whether changed stats would have changed the result.

`balance.mjs` also takes a patch file (`node tools/balance.mjs 20000 out.json patch.json`) to
test a set of changes together. Team styles to pit against each other live in `ARCHETYPES`.

## How to play

- **Start:** the game opens on a start screen; **Battle** plays a friend online (above); **Training** plays the bot. Pokémon are shown as
  cards (cost in the corner); tap one to pick it, or its **i** for its stats and power.
- **Profile:** the chip at the top left of the start screen (or Menu → Profile) sets your name and
  a profile picture from a fixed list (the Pokémon sprites' front frame, cropped and centred into
  `assets/avatars/`; to change the list, edit `AVATARS` in `src/profile.js` and run
  `python3 tools/make-avatars.py`, which needs Pillow). It's saved in the browser's localStorage under
  `poke-tactics-profile`, so it's still there after closing the browser; clearing site data or a
  private window starts fresh. Your name and picture show in the HUD and the versus intro; online,
  your opponent sees them too (the host only accepts pictures from the list). The name typed on the
  online lobby screen is saved to the profile as well.
  The profile screen also shows **stats** (wins, losses and draws for online and training matches,
  win rate, and the most used Pokémon: the one fielded in the most battles; matches left before the
  end aren't counted) and a **friends** list where friends can be removed. Adding friends isn't built
  yet; `addFriend()` in `src/profile.js` is ready for it. Stats and friends are saved with the profile.
- **Team:** before round 1, each player picks 6 Pokémon. Each one puts 4 copies into that player's own
  pool. The board starts empty: everything you field, you buy.
- **Coins:** you start with 10. Every round after that you get 5 coins, plus 1 for each of your own
  Pokémon knocked out in the battle just fought (summons like Combee don't count; the loser of a
  battle lost its whole board). Coins carry over between rounds with no cap. Troops cost 2–5 coins
  per copy.
- **Shop:** 3 slots, drawn from your pool (never more copies than the pool holds). It refreshes for
  free every time you buy a Pokémon, and by itself after every battle.
- **Rerolls:** 1 coin each, as many as you can pay for.
- **Buying:** click a shop troop, then a square on your half (or drag the card onto the board). A copy
  you buy leaves your pool. There is no bench.
- **Stars:** each troop can be on the board only once. Buying a copy of a troop you already field levels
  that troop up instead (click anywhere on your side): 1 copy = 0★, 2 = ★, 3 = ★★, 4 = ★★★. Each
  Pokémon lists its own HP and damage for every star level. Moving a troop onto another unit swaps them.
- **Selling:** drag a troop onto the shop (or press Sell) for its cost in coins per copy; all its copies go back
  to your pool.
- **Scouting:** while you plan, the enemy half shows (faded) where the opponent placed their Pokémon
  last round. Their current lineup stays hidden until the fight.
- **Board:** your half is 5×4 (the board is 5 wide by 8 tall); the row next to the centre line is the
  front. There is no limit on how many troops you field.
- **Combat:** units target the nearest enemy they can reach and walk (pathing around anyone in the way)
  into range one square at a time (up/down/left/right). Distance (for picking the nearest or
  farthest enemy) is the number of steps between two squares, so a diagonal neighbour is 2 away.
  Attack range is a square around the Pokémon instead: range 1 (melee) covers the 3x3 around
  it, diagonals included; range 2 the 5x5; and so on. Each step takes 0.5s; movement speed is how long a unit waits before each
  step (before its first one too): very fast 0.35s, fast 0.5s, medium 0.8s, slow 1.0s, very slow 1.3s,
  super slow 2.0s. So a medium unit covers a square every 1.3s. A unit can't attack until it finishes its step. A unit attacks every `secPerHit` seconds; each basic attack
  has a `critChance`% chance to crit for 50% more damage (powers never crit). Each tick resolves
  simultaneously, and crit luck is shared slot for slot between the sides, so neither side gets an edge.
- **Powers:** every Pokémon has one. Most count attacks (the purple bar). Every fight starts with the bar
  empty and a full attack cooldown before anyone's first hit, and progress is never lost mid-fight:
  - Mawile, **Jaw Lock**: after 8 attacks, the next hits for 130% and stuns for 1s.
  - Beheeyem, **Psywave**: at the start of battle, a wave flies down its column to the other end of the
    board. The first enemy it hits takes 50% and is carried to that end, then is stunned for 1s; anyone
    already there is pushed to the side. Both sit out until the wave lands.
  - Toxtricity, **Thunderbolt**: every 8th attack also zaps the farthest enemy for 80%.
  - Vespiquen, **Attack Order**: every 6 attacks, summons 2 Combee beside it: its sides first, then
    behind, in front, and the diagonals from back to front. Combee come at Vespiquen's star level. They fight but never count as survivors for round damage. With no free square,
    the power stays charged and tries again after the next attack.
  - Coalossal, **Heat Crash**: after 6 attacks, the next hits for 130%, knocks the target back 2 squares
    and stuns it for 1s.
  - Decidueye, **Phantom Force**: after 8 attacks, invisible for 3s and attacks 30% faster. Enemies can't
    target or follow an invisible unit.
  - Infernape, **Blaze**: after 7 attacks, attacks 50% faster for 3s.
  - Hoopa, **Hyperspace Hole**: after 6 attacks, the next teleports beside the farthest enemy (if it's out
    of reach), hits for 130% and heals 10% of the damage dealt. (The old Greninja's stats and power.)
  - Greninja, **Battle Bond**: after 5 attacks, becomes Ash-Greninja for the rest of the fight: fast
    movement, attacks every 0.8s, more damage, range 3 (same HP).
  - Torterra, **Earthquake**: with every 5th attack, every enemy on the board takes 30% and is stunned 1s.
  - Lilligant, **Aromatherapy**: every attack heals your Pokémon directly left, right, above and below the
    square it hits, for 50% of its damage.
  - Golem, **Self-Destruct**: when knocked out it stays on its square for 3s (it can't be hit), then
    explodes for 300% on enemies in the 3x3 square around it. The fight waits for it.
  - Minior, **Shining Star**: two lives. Rock form is a slow, soft-hitting wall (very slow, 30 damage
    every 3.0s, 1100 HP). When it would be knocked out it doesn't faint: at the end of that tick it gets
    Star Form's own HP (600), spends 0.5s transforming, immune to everything (damage, stuns, knockbacks,
    sudden death), then becomes Star Form for the rest of the fight. Changing sends out a shock wave
    that stuns every enemy in the 3x3 around it for 1s. Star Form attacks every 0.3s for 20 and doesn't
    walk: it zips straight to the open square beside its target (if all are taken, it walks). Its own
    power, every 10 attacks: it picks a different enemy (a seeded pick among those with a free square
    beside them) and zips there; with no other enemy to reach it moves to another square beside its
    target, and with none free it stays. The purple bar counts toward the next hop. A form with a
    faster attack speed doesn't wait out the old form's attack timer.
  - Tapu Koko (range 2, attacks every 1.1s), **Wild Charge**: after 4 attacks, the next dashes in a straight line to the open square
    next to the farthest enemy (closest to Tapu Koko). The dash takes 0.1s per square (at least 0.2s),
    and Tapu Koko is immune to everything on the way. When it arrives it hits for 150%; the target and
    every enemy it passed through are stunned for 1s.
  - Ditto, **Transform**: walks (medium speed) toward the nearest enemy until it's within that enemy's
    range, then takes 0.5s to transform into it, copying its max HP, damage, attack speed, range and crit
    (not its power or movement). It keeps its share of HP across the change, shows the copied sprite in
    Ditto's colours, and doesn't move while transformed. When the copied Pokémon faints or no enemy is in
    range, it turns back into Ditto and walks to the next nearest.
- **Healing** (Lilligant, Hoopa) lands at the end of each tick, like stuns, so it never depends on who
  acted first; a Pokémon knocked out that tick stays knocked out.
- **Stuns:** a stunned Pokémon can't move or attack. When a stun (or a Psywave ride) ends, it picks the
  nearest enemy as its target again rather than going back to its old one.
- **Displacement:** when a Pokémon is launched onto an occupied square (Heat Crash, Psywave), the one
  standing there moves to its own left, else its right, else back (toward its own back row), else
  forward, else a diagonal (back ones first). If all of those are taken, the launched Pokémon lands
  on the closest free square instead.
- **Sudden death:** fights have a 30-second timer. When it runs out, every Pokémon still standing loses
  300 HP per second (the same for everyone, ignoring shields) while the fight carries on, so the weakest
  fall first until one side is knocked out.
- **Damage:** the loser takes `round + 2 × (copies in the winner's surviving troops)`. A draw (the last
  Pokémon on both sides fall at the same moment) costs each player `ceil(round / 2)`. Everyone starts at 100 HP.
- **Keys:** `D` reroll, `F` fight, `E` sell the selected troop, `Space` skip the combat replay, `P` Pokédex,
  `M` menu (How to play, Pokédex, New game), `Esc` deselect or close.

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
src/profile.js      the player's profile (name + picture), saved in localStorage
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
