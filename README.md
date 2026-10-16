# 1v1me

A 1v1 MOBA-style web game: PixiJS client and an authoritative Colyseus server, written in
TypeScript and sharing one simulation.

```bash
npm install
npm run dev     # server on :2568 + client (Vite prints its URL)
npm test        # sim rules, prediction over a fake laggy network, server integration
npm run typecheck
```

The start menu offers three modes:

| Mode | What runs where |
|---|---|
| **Find a duel** | Online 1v1. Open two tabs or browsers to play yourself |
| **Online practice** | You vs the practice bot, with the bot running on the server |
| **Offline practice** | Everything in the browser, no server needed |

Set `VITE_SERVER_URL` to point the client at a server elsewhere (default: this host on
port 2568), and `PORT` to change the server port.

## Controls

| Input | Action |
|---|---|
| Right-click | Move, or attack an enemy under the cursor. Hold to keep moving toward the cursor |
| A + left-click | Attack-move |
| Q W E R | Cast, per your cast mode (see Settings). Right-click while aiming cancels |
| S | Stop |
| Space | Center the camera on your champion |
| Y | Lock or unlock the camera (edge-pan when unlocked) |

**Settings** (start page) has LoL's three cast modes, as a default plus per-key overrides,
saved in the browser:

| Mode | Behavior |
|---|---|
| Quick cast | Casts at the cursor the moment the key goes down |
| Quick cast with indicator (default) | Hold to aim, release to cast |
| Normal cast | Press to aim, left-click to cast; press the key again to put it away |

## How online play works

- **The server is authoritative.** `src/net/authority.ts` owns the only real `World`;
  `server/DuelRoom.ts` steps it at 30 Hz with Colyseus's fixed timestep. Clients send
  numbered commands (move, attack, cast…). The server validates each one and applies it
  to that client's own unit; a client never picks which unit it controls.
- **Snapshots.** Every tick each client gets a snapshot: units, projectiles, that tick's
  events, plus a private part with its own current order and the last command the server
  applied (and on which tick). These are plain messages, not Colyseus Schema state.
- **Prediction (your champion).** `src/client/prediction.ts` applies your commands to a
  local World immediately. On each snapshot it resets your champion to the server's
  state and replays the commands the server hasn't seen yet, at the ticks they originally
  ran on (using the measured client→server tick offset). Any remaining mismatch is
  blended out over ~60 ms; big ones, like respawns, snap. Only your own champion is
  predicted. Projectiles, damage and the opponent always come from the server.
- **Interpolation (everything else).** Other units and projectiles are drawn about 2 ticks
  (~66 ms) behind the newest snapshot, and events play when the drawing catches up.
- **Comparing.** Add `?predict=0` to the URL to turn prediction off. Simulate lag with
  `COLYSEUS_LATENCY=150 npm run dev:server` (round trip in ms). The top-right HUD shows
  the measured round trip.
- **Your missiles.** Your attacks and skillshots are drawn locally the moment the
  prediction releases them (`src/client/cosmetic.ts`); the server's copies of them are
  hidden. Whether they hit is still decided by the server, so damage numbers arrive
  about a round trip after the visual impact.
- **Not yet:** reconnection and rematches.

## Champion: Wayfinder

The playable champion mirrors **Ezreal's kit** (mechanics and level-1 / rank-1 numbers from
the LoL wiki, with 60 AD and no bonus AD/AP). Names and visuals are original, since
Riot's names and art are theirs. There is no armor or magic resist yet, so physical and
magic damage are treated the same.

| Key | Ability | What it does |
|---|---|---|
| Passive | Spell Momentum | Each enemy hit by an ability: +10% attack speed for 6 s, up to 5 stacks |
| Q | Arcane Bolt | 1200-range skillshot, 98 damage. On hit, all cooldowns −1.5 s |
| W | Rune Orb | Wide skillshot that marks the first enemy for 4 s. Your next attack or ability on it detonates for 80; an ability detonation refunds 60 mana plus its cost |
| E | Phase Step | Blink up to 475, then a homing bolt (80) at the nearest enemy within 750, preferring marked ones |
| R | Skyline Barrage | 1 s rooted cast, then a map-wide, 320-wide barrage that pierces, 350 to each enemy hit |

Prediction covers the blink and your casts. Hits, marks, cooldown refunds, mana refunds
and passive stacks come from the server.

## Champion: Shadeblade

A melee assassin whose kit mirrors **Zed's** (level-1 / rank-1 numbers from the LoL wiki,
63 AD, no bonus AD). It uses **energy** (200, +10/s) instead of mana.

| Key | Ability | What it does |
|---|---|---|
| Passive | Prey on the Weak | Attacks on a target under 50% health add 5% of its max health; once per 10 s per target |
| Q | Night Star | 925-range shuriken that pierces: 80 to the first enemy, 48 to the rest |
| W | Echo Shadow | A shadow dashes up to 650 away and copies Q and E for 5.25 s. Recast: swap places with it (once). Hitting an enemy with both his and a shadow's copy of one ability refunds 30 energy |
| E | Umbral Slash | Instant 315-radius slash around him and each shadow; 70 to each enemy once. Shadow hits slow 20% (30% if hit twice) for 1.5 s; each champion hit by his own slash takes 3 s off W |
| R | Final Mark | Target an enemy within 625: untargetable, 0.6 s later dash just behind them. The mark detonates after 3 s for 25% of the damage he dealt meanwhile. A shadow stays at the start; recast swaps back to it |

Pick the champion on the start page. Prediction covers his shadow placement, swaps and the
R dash; slows, the mark, refunds and damage come from the server.

## Practice bot

`src/sim/bot.ts` plays any champion, deciding about 8 times a second through the same
commands a player sends:

- **Auto-attacks.** Ranged, it orb-walks: attacks when its timer is up, repositions to
  about 90% of its range during the backswing, and never cancels its own windup. Melee, it
  chases and swings.
- **Abilities, by kind.** Skillshots are aimed with lead on your movement plus some random
  error. A global ult is saved to finish you. It blinks away when low and you're close, or
  in to finish. Shadow champions set up the shadow before Q/E so the copies join in, slash
  when you're in reach, death-mark when you're low or the combo is ready, and swap to
  escape or chase.
- **Dodging.** It sidesteps your skillshots (from the cast telegraph or the missile) after
  a 0.25 s reaction, but only tries 60% of the time, and blinks if walking is too slow.

Tune it with `BotOptions` (reaction, dodge chance, aim error, lead). The bot plays
Wayfinder.

## Tuning the feel

- **Attack windup.** Each auto-attack spends `windupPct` of its period winding up (LoL's
  formula with the default windup modifier of 1). Moving during the windup cancels the
  attack and refunds it, except in the last game tick (LoL's grace period), when the
  attack is committed. Moving after it (the backswing) keeps the hit, which is how
  orb-walking works. The HUD bar shows which phase you're in.
- **Range and hitboxes.** Champions have LoL's 65-unit gameplay radius, and attack range
  is edge to edge, so 550 range reaches 680 between centers. Skillshot range is measured
  from the caster's center.
- **Abilities.** Champions have Q/W/E/R slots holding data-driven abilities: `skillshot`
  (stops at the first enemy or pierces, with on-hit effects such as cooldown refunds and
  marks), `blink` (with an optional homing bolt), `shadow` (a placeable copy that mimics
  chosen abilities and can be swapped with), `area` (instant circle around the caster and
  its shadows) and `deathMark` (unit-targeted dash and delayed detonation). Casts root
  the caster for their cast time; abilities with no cast time are instant. Statuses cover
  marks, attack-speed stacks, slows and untargetability. Enemy skillshot casts, including
  their shadows' copies, are shown on the floor so you can dodge them.
- **Tilted camera.** The ground layer is squashed vertically (`TILT`) to fake LoL's angled
  camera, while units stay upright.

All numbers are in [`src/sim/defs.ts`](src/sim/defs.ts).

## Layout

```
src/sim/      pure game rules (no DOM/Pixi), shared by server and client
  world.ts    units, orders, attacks, abilities, projectiles, fixed-step update
  defs.ts     champions and abilities, tick rate, map size
  bot.ts      practice bot: plays any champion through normal commands (see below)
src/net/      wire protocol (messages, snapshots, validation) and the Authority (server game logic)
src/client/   PixiJS rendering, camera, input, HUD
  session.ts  where state comes from: OfflineSession (local World) or OnlineSession (server)
  prediction.ts  client-side prediction and reconciliation for your own champion
server/       Colyseus server and the DuelRoom
```

## Next steps

1. Levels and items, so attack speed and damage can reach mid-game values.
2. Reconnection and a rematch/end-of-game flow (win condition, end screen).
3. Armor/magic resist and levels or items, then a second champion.
4. Map with walls and pathfinding, then minions and towers.
