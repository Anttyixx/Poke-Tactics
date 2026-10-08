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

- **Shop:** you get 5 gold per round, plus 1 gold of interest per 10 banked (max +5), plus 1 gold for a win.
  Units cost 1–3 gold. Rerolling costs 2 gold. Higher-cost units show up more often in later rounds.
- **Board:** you place units on your 8×4 half. The row next to the centre line is the front.
  You can field 3 units at first, and the cap rises by 1 every 2 rounds up to 8. The bench holds 8.
- **Merging:** 3 copies of the same unit make a ★★ unit (×1.8 stats). 3 ★★ units make a ★★★ unit (×3.2).
- **Combat:** units target the nearest enemy, walk into range and attack. Each attack builds mana,
  and so does taking a hit. At full mana a unit casts its ability instead of attacking.
- **Damage:** the loser takes `round + 2 × (stars of the winner's surviving units)`. A draw (both sides
  wiped out, or the 30s timer runs out) costs each player `ceil(round / 2)`. Everyone starts at 100 HP.
- **Keys:** `D` reroll, `F` fight, `E` sell the selected unit, `Space` skip the combat replay, `Esc` deselect.

## Project layout

```
index.html          page shell
styles.css
data/units.json     unit catalog (stats + ability). Add units here; no code change needed
                    unless you add a new ability "kind"
src/rng.js          seeded PRNG whose state is stored in game state
src/combat.js       simulate(catalog, boards). Pure and deterministic, returns an event log
src/game.js         rules: createGame(), applyIntent(). The only thing that changes state
src/bot.js          dummy opponent. Uses the same intents as a human
src/ui.js           DOM rendering, input -> intents, replays combat from the event log
src/main.js         wires game + bot + UI together (single player)
tests/run.js        Node test runner
```

`src/network.js` will arrive in Phase 2.

## Deploy to GitHub Pages

1. Merge to `main`.
2. In the repo on GitHub, open **Settings → Pages → Build and deployment**. Set Source to *Deploy from a branch*,
   Branch to `main`, and folder to `/ (root)`.
3. The site will be at `https://<user>.github.io/<repo>/`. All paths are relative, so the project-site subpath works.

`.nojekyll` turns off Jekyll processing so files are served exactly as committed.

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
