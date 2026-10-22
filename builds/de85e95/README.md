# Auto Battler (working title)

A browser-based 1v1 auto-battler. Buy units, place them on your half of the grid,
then watch the fight play out by itself. Plain HTML/CSS/JS with ES modules. There is
no build step, and it deploys to GitHub Pages as static files. Online play runs on a small
Cloudflare Worker (`server/`), deployed by the same workflow.

**Status:** play against the bot, a random opponent online, or a friend by their friend code.

## Online play

The start screen has one **Battle** button. It opens a pop-up with two cards, **Duel** and
**Arena**: tapping a card joins that mode's matchmaking queue ("Waiting for opponent" until
enough players are found); the small **Training** button in each card's top-right corner plays
the same mode against bots instead. Friends (the people button) can send a battle request.

**Teams are built before a match**, in the **Team builder** (the button under Battle): up to 3
saved teams of 6 Pokémon, kept in the browser's profile (`teams` and `team` in
`poke-tactics-profile`, see `src/profile.js`). The one marked **In use** is the battle team; Battle
stays locked until one is finished. When a match starts, the game sends that team for you
(the usual `chooseTeam` intent) and waits for the others; the old in-match picker only shows if
there's no usable team.

- **Duel** (1 vs 1): the classic match against one random opponent.
- **Arena** (4 players): online, the queue (`/queue?mode=arena`, its own Durable Object)
  waits until 4 players are looking, showing how many have joined. Everyone brings their saved team as
  usual; each round the players still in are paired up in 1v1 battles that work exactly like a
  duel. Pairings avoid last round's opponent whenever possible, then whoever has met least
  often (ties broken by the match seed). With 3 left, one player sits the round out: no
  battle, no damage, the round's 5 coins, and never the same player twice in a row. A player
  at 0 HP is out; the last one standing wins. If everyone left is knocked out in the same
  round, whoever had the most HP going in wins (a draw only if that's a tie too). Leaving an
  arena knocks you out on the spot; the others play on. There's no rematch: everyone goes back
  to the start screen. Each player watches their own battle (shown as a duel, from their own
  side), with everyone's HP and pairings in a standings strip under the HUD
  (`viewFor()` in `src/game.js` builds each player's view). The game over screen shows the
  final places. **Training** (the Arena card's corner button) is an arena against 3 bots (each bot plays
  its own 1v1 view of the match), with **Play again** at the end.

- **The match runs on a server**, not in either player's browser: a Cloudflare Worker
  (`server/worker.js`) with one Durable Object per match, found by its code. It runs the
  same rules code as the game (`src/game.js`, `data/units.json`), checks every move with
  `applyIntent()`, and sends both players the new state after every change. A phone locking
  or a page reloading never stops the match. Another Durable Object is the matchmaking queue.
- Browsers talk to it over a WebSocket (`src/online.js`, protocol at the top of the file):
  plain HTTPS, so it works on any network that can open a website (no relay needed).
- **Each planning phase lasts 30 seconds** on the server's clock (both screens count down);
  then anyone still planning is locked in as they are. After a battle has played out, anyone
  who hasn't moved on within 20 seconds is moved on. (The game moves on by itself: when a
  fight ends the winners dance for about 2 seconds, the loser's HP drains in their container,
  then the board animates back to the planning setup; there is no results pop-up.)
- **Fights play at one fixed speed** for everyone (no speed buttons), and online there is no
  Skip, so nobody finishes a round before their opponent. Pressing Fight! turns your Pokémon
  around to face the enemy; during the fight the shop slides off screen and the board grows.
- **Dropping out and coming back:** each browser keeps a random player id
  (`poke-tactics-pid` in localStorage), which is how the server knows a returning player. The
  connection pings every 5 seconds; silence for 15 seconds, the page coming back on screen,
  or the network coming back makes it reconnect at once, straight back into the match. Moves
  made while reconnecting are sent when it's back. The other player sees a notice while
  someone's away; the match carries on (the absent player is locked in each round).
- **Reloads:** the match's code is saved (`poke-tactics-session`, 15 minutes); after a
  reload the game offers **Rejoin the match**.
- **Leaving:** **Leave match** ends it for both at once. A room nobody is connected to is
  deleted after 15 minutes.
- **Versions:** the server only lets in players on the same build as itself (the deploy
  tags both with the commit), so everyone runs the same rules. An old tab is told to refresh.
- **Screen stays on** during online matches (Screen Wake Lock API, where the browser allows
  it): a phone locking itself pauses the page.
- **Connection log:** each browser notes what its connection did; it's included in the
  copied match log under `connection`. The last online match's log is kept in localStorage
  (`poke-tactics-last-log`): **Copy match log** on the "Match ended" screen, or **Menu → Last
  online match log** on the start screen.
- **Battle → Check my connection** checks the server can be reached and is on your version.
- **Friends** (menu → Friends): every player has a 6-character
  friend code. Enter a friend's code to send a request; they accept or decline. The list shows who's
  online, in a battle or offline, live. **⚔ Battle** on an online friend, or **Battle a friend** on
  the start screen with any player's friend code (no need to be friends first), sends a battle
  request (they have 45 seconds to accept); accepting starts a match for the two of you. A player already in
  an online match automatically turns requests down. Friends are kept on the server (the `Presence`
  Durable Object), tied to the browser's player id: another browser or device, or cleared site data,
  is a new player with a new code. Friend codes are the only id players see of each other.

### The server (`server/`)

- Deployed by `.github/workflows/pages.yml` on every push: `dev` → Worker `poke-tactics-dev`,
  `main` → `poke-tactics`, each with its own matches. The workflow writes the Worker's address
  into `src/server-config.js` in the published site. It needs two repository secrets:
  `CLOUDFLARE_API_TOKEN` (an API token from the "Edit Cloudflare Workers" template) and
  `CLOUDFLARE_ACCOUNT_ID`. Without them, or if the server deploy fails, the site still deploys
  with online play off (the run shows a warning or error).
- Free plan: Workers plus SQLite-backed Durable Objects, with WebSocket hibernation so idle
  connections cost nothing.
- **Run it locally:** `cd server && npm install && npm run dev` (Wrangler, port 8787), then
  open the game with `?server=http://localhost:8787`. Locally both sides use the build
  `local`.

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
node tools/match.mjs "beheeyem,infernape,ditto,vespiquen,lilligant,hoopa" "coalossal,torterra,golem,minior,annihilape,decidueye" --games=500 --place=smart
```

`--place=smart` makes the simulated players reposition before every fight to counter the
opponent's lineup from the round before (`tools/placer.mjs`), the way a real player would;
`--place-a` / `--place-b` set each side separately. `balance.mjs --smart` does the same for
the whole study (`--smart=classic`: the older, slower search). Games run on every CPU core at
once: on 4 cores, 10,000 games take about half a minute, or about 4.5 minutes with `--smart`.
All tools use the game's own code (`src/combat.js`, `src/game.js`,
`src/bot.js`), so they stay accurate as the game changes.

One Pokémon in depth (best squares, rows and columns, hardest and easiest opponents, best
teammates, who knocks it out, stats by star), as a console summary and an HTML report:

```sh
node tools/focus.mjs dragapult --games=4000 [--smart]   # -> tools/out/focus-dragapult.html
```

A real match: in the game, **Menu → Match log** (or **Copy match log** after a match) copies
the game's seed and every move both players made, plus your notes. Save it to a file, then:

```sh
node tools/replay.mjs match.json [--patch=patch.json]
```

It rebuilds the match exactly with the stats of the build it was played on (read from git
history) and, for every fight, checks how much was luck (the same boards with other seeds),
whether the loser could have won with a different arrangement of the same Pokémon, and, with
`--patch`, whether changed stats would have changed the result. It also writes an easy-to-read
page, `tools/out/replay-<seed>.html` (`--summary=notes.html` adds written takeaways at the top).

The bot (`src/bot.js`) rearranges its board before every fight by a fixed set of rules (tanks in
the middle of the front, ranged at the edge of their range, healers behind the front line, divers
up front, Beheeyem's Psywave column left empty, leaning toward the enemy's stronger side), each
placement with its reason. `node tools/bot-rules.mjs` measures them: full games of the rule-based
bot against the old bot, which left units where it bought them.

`balance.mjs` also takes a patch file (`node tools/balance.mjs 20000 out.json patch.json`) to
test a set of changes together. Team styles to pit against each other live in `ARCHETYPES`.

## How to play

- **Start:** the game opens on a start screen; **Battle** plays a friend online (above); **Training** plays the bot. Pokémon are shown as
  cards (cost in the corner); tap one to pick it, or its **i** for its stats and ability.
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
  that troop up instead (click anywhere on your side): 1 copy = ★, 2 = ★★, 3 = ★★★, 4 = a shiny star. Each
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
  has a `critChance`% chance to crit for 50% more damage (abilities never crit). Each tick resolves
  simultaneously, and crit luck is shared slot for slot between the sides, so neither side gets an edge.
- **Abilities:** every Pokémon has one. Most count attacks (the purple bar). Every fight starts with the bar
  empty and a full attack cooldown before anyone's first hit, and progress is never lost mid-fight:
  - Mawile, **Jaw Lock**: after 8 attacks, the next hits for 130% and stuns for 1s. *Disabled for now*
    (`"disabled": true` in units.json keeps a Pokémon out of team picks, shops and the Pokédex).
  - Beheeyem, **Psywave**: at the start of battle, a wave flies down its column to the other end of the
    board. The first enemy it hits takes 50% and is carried to that end, then is stunned for 1s; anyone
    already there is pushed to the side. Both sit out until the wave lands.
  - Toxtricity (cost 3, Ranged, range 2, attacks every 1.25s), **Overdrive**: every 3 attacks, each ally
    directly left, right, in front of and behind it that has an ability counter gains +2 toward its ability
    (never past full; at the end of the tick, like all ability progress).
  - Vespiquen, **Attack Order**: every 7 attacks, summons 2 Combee beside it: its sides first, then
    behind, in front, and the diagonals from back to front. Combee come at Vespiquen's star level. They fight but never count as survivors for round damage. With no free square,
    the ability stays charged and tries again after the next attack.
  - Coalossal, **Heat Crash**: after 4 attacks, the next hits for 130%, knocks the target back 2 squares
    and stuns it for 3s.
  - Decidueye, **Phantom Force**: after 6 attacks, invisible for 3s and attacks 50% faster. Enemies can't
    target or follow an invisible unit.
  - Infernape, **Blaze**: after 7 attacks, attacks 50% faster for 3s. Each hit while it lasts burns the
    target for 20% of Infernape's damage every second for 3s (another hit restarts the burn).
  - Hoopa (cost 3, Special, range 2, attacks every 1.0s), **Binding Ring**: after 4 attacks it holds its
    charge until an enemy is about to change squares by itself (a step, or an ability that moves it, like
    a dash or a zip), and binds that one just before it goes, so the move (or the dash or zip) never happens; being
    shoved by an attack doesn't count. A bound Pokémon still attacks anything in range, but the rings
    stop 3 tries to move in all (that first one included, walking or moving abilities), then break. They also snap at once if it's shoved or knocked to another
    square, or knocked out.
  - Amoonguss (cost 4, Tank), **Rage Powder**: always on (no counter). An enemy picking a new target
    goes for Amoonguss if it can already hit it without moving; one that would have to move picks as usual.
  - Annihilape (cost 4, Tank), **Rage Fist**: each attack in a row without moving makes it attack
    12% faster, with no cap. Moving (or being moved) resets it.
  - Dragapult (cost 4, Ranged, range 3), **Dragon Darts**: after each attack made while a Dreepy is
    home (at most 2 can be out at once; with both out, attacks don't charge it), its next action (an attack or a step, after its usual 0.8s wait)
    fires one Dreepy instead, at the farthest enemy outside the 3x3 around it (never at a Pokémon
    right next to it; with none that far, it just attacks). The Dreepy crashes into its target for 35
    damage at ★ (125 / 163 / 179 at higher levels) and a 0.5s stun, taking its square and shoving it aside (a
    shield breaks instead); once the stun wears off the target attacks that Dreepy right away until
    it faints. Dreepy have 161 HP and hit for 12 every 0.5s at ★, growing slowly with level. A fainted
    Dreepy flies back (0.5s). Dragapult: 840 HP, 50 damage every 0.8s. Darts fire at the end of the
    tick, aiming and landing from where everyone stood when it began, so neither side gets an edge.
  - Greninja, **Battle Bond**: after 4 attacks, becomes Ash-Greninja for the rest of the fight: fast
    movement, attacks every 0.8s, more damage (105 at ★), range 3 (same HP).
  - Torterra, **Earthquake**: with every 5th attack, every enemy on the board takes 30% and is stunned 1.5s.
  - Lilligant, **Aromatherapy**: every attack heals your Pokémon in the 3x3 around the square it hits
    (diagonals too), for 60% of its damage.
  - Golem, **Self-Destruct**: when knocked out it stays on its square for 1s (it can't be hit), then
    explodes for 300% on enemies in the 3x3 square around it. The fight waits for it.
  - Frosmoth (cost 3, Special, range 2, attacks every 1.25s), **Frostbite**: no charged ability. Every
    hit chills the target for 3s: it attacks 30% slower and waits 30% longer between steps; another
    hit restarts the timer. Chills land at the end of the tick, like stuns. Chilled Pokémon are
    tinted blue with a snowflake badge.
  - Alcremie (cost 3, Healer, range 2, attacks every 1.25s), **Sweet Treat**: every 4 attacks it
    changes into a random flavour (seeded, so replays match) and treats one ally for 3s. Matcha
    Cream heals the ally with the lowest share of HP for 600% of its damage, a chunk every second;
    Ruby Cream makes the hardest-hitting ally attack 100% faster; Mint Cream shields the ally most
    enemies are attacking: 40% less damage, and the first stun or shove (knockback, Psywave) that
    would land breaks the shield instead, blocking anything else in that same tick. Treats land
    at the end of the tick. Shielded Pokémon show a bubble.
  - Minior, **Shining Star**: Rock form is a slow, soft-hitting wall (very slow, 30 damage every 3.0s)
    with a 1100 **shield** over its 600 HP. When the shield breaks (at the end of that tick) it spends
    0.5s transforming, immune to everything (damage, stuns, knockbacks, sudden death), then becomes Star
    Form for the rest of the fight, with its HP untouched. Being knocked out is a real knockout. Changing sends out a shock wave
    that stuns every enemy in the 3x3 around it for 1s. Star Form attacks every 0.3s for 20 and doesn't
    walk: it zips straight to the open square beside its target (if all are taken, it walks). Its own
    ability, every 10 attacks: it picks a different enemy (a seeded pick among those with a free square
    beside them) and zips there; with no other enemy to reach it moves to another square beside its
    target, and with none free it stays. The purple bar counts toward the next hop. A form with a
    faster attack speed doesn't wait out the old form's attack timer.
  - Tapu Koko (range 2, attacks every 1.1s), **Wild Charge**: after 4 attacks, the next dashes in a straight line onto the
    farthest enemy's square, shoving it to a square beside it (a shield, no room, or a target that moved
    this tick or is itself charged to dash: it stops on the open square next to it instead). It dashes
    whenever that enemy isn't already right next to it; otherwise it hits from where it stands. The dash takes 0.1s per square (at least 0.2s), and Tapu Koko is immune to
    everything on the way. When it arrives it hits for 200% and stuns the target for 1.5s; every enemy it
    passed through takes 30% and is stunned for 0.5s.
  - Ditto, **Transform**: walks (medium speed) toward the nearest enemy until it's within that enemy's
    range, then takes 1s to transform into it, copying its max HP, damage, attack speed, range and crit
    (not its ability or movement). The copy's HP and damage are 60% / 78% / 95% / 108% of the original's,
    by Ditto's level. It keeps its share of HP across the change, shows the copied sprite in
    Ditto's colours, and doesn't move while transformed. When the copied Pokémon faints or no enemy is in
    range, it turns back into Ditto and walks to the next nearest.
- **Healing** (Lilligant, Alcremie) lands at the end of each tick, like stuns, so it never depends on who
  acted first; a Pokémon knocked out that tick stays knocked out.
- **Stuns:** a stunned Pokémon can't move or attack. When a stun (or a Psywave ride) ends, it picks the
  nearest enemy as its target again rather than going back to its old one.
- **Displacement:** when a Pokémon is launched onto an occupied square (Heat Crash, Psywave), the one
  standing there moves to its own left, else its right, else back (toward its own back row), else
  forward, else a diagonal (back ones first). If all of those are taken, the launched Pokémon lands
  on the closest free square instead.
- **Sudden death:** fights have a 30-second timer. When it runs out, every Pokémon still standing loses
  300 HP per second (the same for everyone; a shield wears down first, like any damage) while the fight
  carries on, so the weakest fall first until one side is knocked out.
- **Shields:** some Pokémon (Minior) start with a shield, a second bar above their HP. While it lasts it
  takes every hit and HP can't go down; a hit bigger than what's left breaks it and the rest is wasted.
  A broken shield is gone for the fight, and healing only ever restores HP.
- **Damage:** the loser takes `round + 2 × (copies in the winner's surviving troops)`. A draw (the last
  Pokémon on both sides fall at the same moment) costs each player `ceil(round / 2)`. Everyone starts at 100 HP.
- **Keys:** `D` reroll, `F` fight, `E` sell the selected troop, `Space` skip the combat replay (training only), `P` Pokédex,
  `M` menu (How to play, Pokédex, New game), `Esc` deselect or close.

## Project layout

```
index.html          page shell
styles.css
assets/sprites/     walk sheets: 256x256, 4x4 grid of 64px frames;
                    rows = facing down, left, right, up; columns = walk cycle
data/units.json     unit catalog: cost, hp and damage per star, range, moveSpeed tier,
                    secPerHit, critChance, energy (attacks per ability) and the ability
                    ("ability"). "summon": true units (Combee) only appear in battle
src/rng.js          seeded PRNG whose state is stored in game state
src/combat.js       simulate(catalog, boards). Pure and deterministic, returns an event log
src/game.js         rules: createGame(), applyIntent(). The only thing that changes state
src/bot.js          dummy opponent. Uses the same intents as a human
src/ui.js           DOM rendering, input -> intents, replays combat from the event log
src/main.js         wires game + bot + UI together; online matches through src/online.js
src/online.js       WebSocket connection to the game server, reconnecting by itself
src/server-config.js  the server's address (written by the deploy)
server/             the online game server (Cloudflare Worker + Durable Objects)
src/profile.js      the player's profile (name + picture), saved in localStorage
tests/run.js        Node test runner
.github/workflows/pages.yml   deploys main -> / and dev -> /dev/
```


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

## Architecture notes (server-authoritative)

The same rules code runs the bot game in the browser and every online match on the server:

- **One state object, one way to change it.** All match state is in a plain JSON object.
  The UI never mutates it. Clicks become intents (`buy`, `sell`, `reroll`, `move`, `ready`,
  `continue`) and go through `applyIntent(state, catalog, player, intent)`, which validates them.
  The bot plays through this API; online, both players' intents reach it on the server.
- **Deterministic, pure combat.** `simulate()` uses integer math and fixed tie-breaking. It never
  calls `Math.random`. It returns an event log (`move`, `attack`, `damage`, `cast`, …). Clients
  only replay that log, which is the "render from received state" model in the brief.
- **Seeded, per-player RNG.** Shop rolls use an RNG whose state is stored in each player's
  state. The server owns it, and one player's rerolls can't change the other player's shops.
- **Symmetric seats.** Both players place units in "own" coordinates (front line = row 0) and the
  simulation mirrors side 1. The UI flips the view so each player sees their own side at the bottom.
- **Phases advance on "everyone ready."** Combat starts when every player sends `ready`. The next
  round starts when everyone sends `continue`. That's the same handshake two remote players need.
