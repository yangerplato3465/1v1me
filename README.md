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
| A + left-click | Attack-move: attacks the enemy nearest your champion, or walks there attacking whatever comes into range (Settings → "Attack move on cursor" targets near the cursor first) |
| ` (hold) | Target champions only: clicks and attack-moves ignore minions and turrets |
| Q W E R | Cast, per your cast mode (see Settings). Right-click while aiming cancels |
| S | Stop, and pause auto-attack until your next order |
| Ctrl/Alt + Q W E R, or click **+** | Spend a skill point on that ability. Browsers keep Ctrl+W for closing the tab, so Alt works too; in full screen (Chrome/Edge) Ctrl+W reaches the game |
| **Full screen** button (menu, or bottom-right in game) | Toggle full screen. In Chrome/Edge it also captures the keyboard, so hold Esc to leave |
| Space (or F1) | Center on your champion; hold to keep following it, release to free the camera again |
| Y | Lock or unlock the camera |
| Screen edge, arrow keys, middle-button drag | Pan the free camera |

The camera works like LoL's (Controls and Hotkeys on the LoL wiki). It starts **free** by
default; Settings → "Camera at start" switches that, like LoL's Default Camera Mode. A
free camera jumps back to your champion when you respawn ("move camera on revive").
Locking or following uses LoL's **Per-Side Offset** by default: the view sits a bit toward
the enemy base (up-right from the blue side, down-left from the red side), so you see
more of the lane ahead. Settings → "Camera lock mode" → Fixed puts your champion dead
center instead. The offset is 17% of the screen height (`SIDE_OFFSET` in
`src/client/camera.ts`); LoL doesn't publish its exact amount.

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

## The lane

The map is a single mid lane running diagonally from the blue base (bottom left) to the red base (top right),
walled in by jungle, with the river across the middle. Each side has a fountain, one
outer turret, and minion waves. The rules follow LoL (minute-0 numbers from the LoL wiki):

- **Waves.** The first wave leaves at 0:10 (LoL: 0:30, shortened so practice starts
  sooner; `WAVES.firstAt`), then one every 30 s (25 s from 14:00, 20 s
  from 30:00). A wave walks out of the base single file, one minion every 0.792 s: 3
  melee, then the siege minion, then 3 casters. Siege minions join wave 3 and every 3rd
  wave after (every 2nd from 14:00, every wave from 25:00). From 14:00 a wave with a siege
  minion has one melee fewer, and from 30:00 every wave has one caster fewer. In a duel,
  waves start once both players are in.
- **Minions.** Melee 465 HP / 11 AD / 110 range, caster 284 / 21 / 550, siege 835 /
  37.5 / 300, all moving at 350. They deal **60% damage to champions** and to turrets
  (siege 84% to turrets). Against other minions they add bonus damage of 2% (melee), 3.5%
  (caster) or 5% (siege) of the target's current health.
- **Minion aggro.** Minions notice targets within 500 units and re-check every 0.25 s,
  between attacks, in LoL's order:
  1. an enemy champion attacking an allied champion within 1000 of the minion
  2. an enemy minion attacking an allied champion
  3. an enemy minion attacking an allied minion
  4. an enemy turret attacking an allied minion
  5. the closest enemy minion
  6. the closest enemy champion
  7. the closest enemy turret

  A minion only switches to something more urgent than its current target. Only basic
  attacks and unit-targeted abilities on a champion draw minions; skillshots don't. As of
  patch 26.10, hitting minions doesn't draw them either. A champion stays a priority for 2
  s after their last hit on an allied champion, then the minions go back to the wave. LoL
  says only "a short time", so 2 s is an estimate. Calls for help are ignored while a
  minion is hitting a turret.
- **Turret.** 9000 HP, 182 damage per shot at 0.83 shots/s, with 750 range from its center.
  It keeps a target until the target dies or leaves range. New targets go by type: siege,
  then melee, then caster minions, then champions. If it isn't already shooting a
  champion, an enemy champion damaging an allied champion within 1400 pulls it onto that
  champion; for turrets any damage counts, skillshots included. Its shots take 45% of a
  melee minion's max health, 70% of a caster's and 14% of a siege minion's. Each shot
  that hits a champion makes later shots stronger (+50% each, up to +150%). This wears off
  5 s after its last champion shot, and switching targets doesn't reset it. Only basic
  attacks damage it, and melee champions deal 20% more. Skillshots fly past it, and units
  walk around it.
- **Last hits.** Gold goes to whoever lands the killing blow (20 / 14 / 50 per minion, 300
  per champion, 50 per turret). The HUD shows your CS and gold. There are no items yet.
- **Fountain.** Standing in your own fountain heals 10% of max health and mana per second.
- **Ability rules on the lane.** Wayfinder's Rune Orb passes through minions (it only hits
  champions) and Skyline Barrage deals 150 to minions (rank 1), like Ezreal's W and R. Shadeblade's
  W cooldown refund and his death mark only count champions.
- **What you see.** Enemy turret range appears as a red ring when you get close, and
  turns bright while the turret is shooting you. A beam shows what each turret is
  targeting. Damage numbers only appear for damage you deal or take.
- **Sources.** These numbers are from the official LoL wiki pages for minions, the three
  minion types and turrets, plus coverage of patch 26.10.
- **Not modeled yet:** minion upgrades every 90 s (the wiki gives only start and end
  values), turret damage growth, plating, the 80% damage reduction when no enemy minions
  are near, armor and magic resist, the first wave ignoring champions, minions aggroing
  on a champion who blocks their path, unit collision between champions and minions
  (champions walk through them), experience and levels, inner turrets, inhibitor and
  nexus (there's no win condition yet), recall, and the fountain laser.

## Input feel

Things LoL does that make its controls feel responsive, from Riot's "The Art of Spell
Casting" tech blog (parts 1 and 2), Riot's patch 8.9 notes on input buffering, and the
LoL wiki's Basic attack and Cast time pages:

- **Postponed spells (input buffering).** A spell pressed while another is still casting
  (or during a dash), or in the last moments of its own cooldown, is held and goes off
  the moment it can. A newer press replaces it (Riot's example: E, W, Q casts E then Q),
  and a move, attack or stop clears it. Riot gives no exact window; queued spells last
  0.4 s here (`SPELL_BUFFER_SECONDS` in `src/sim/world.ts`).
- **Move-to-cast.** A unit-targeted ability (Final Mark) clicked on an enemy champion out
  of range walks you into range and then casts. Ground-targeted abilities clamp to max
  range, as LoL's do by default.
- **Auto attack.** LoL's default setting: an idle champion attacks the nearest enemy that
  comes into its attack range, without chasing it out. Stop (S) pauses it until your
  next order. Settings → "Auto attack" turns it off.
- **Attack-move targeting.** A-click scans for the enemy nearest your *champion* (LoL's
  default), or first near the cursor with "Attack move on cursor". Clicking directly on
  an enemy always attacks it.
- **Already in place:** the one-tick grace at the end of an attack windup, walking into
  range on an attack order, casts that root you but keep your move order for afterwards,
  and prediction of all of the above online.

## Levels and abilities

From the official LoL wiki (Experience, Champion ability and Champion statistic pages):

- **Start.** On the lane, both champions start at **level 3** with **3 skill points** and
  nothing learned. Abilities can't be cast until they have a rank. The bot learns Q, W
  and E right away.
- **Skill points.** One per level. A basic ability's next rank unlocks at every odd level
  (rank 2 at 3, rank 3 at 5, rank 4 at 7, rank 5 at 9; max 5). The ultimate can be
  learned at **6**, then ranked up at 11 and 16 (max 3). Points can be spent while dead.
  The HUD shows "+" over each ability that can take a point, rank pips under each slot,
  and your level with an experience ring.
- **Experience.** LoL's table: 280 to reach level 2, then 100 more per level (18,360 total
  for level 18, the cap). A minion's experience (melee 62, caster 31, siege 75) goes to
  enemy champions within 1500 of where it died, whoever killed it. When two share it,
  each gets 65%. A champion kill pays by the victim's level (42 at 1, up to 990 at 18) to
  the killer and to enemy champions within 1600. It pays 20% less per level the receiver
  is above the victim beyond the first (never below 40%), and 20% more per level below.
  Turrets give none.
- **Stat growth.** LoL's curve: `stat = base + g × (n − 1) × (0.7025 + 0.0175 × (n − 1))`,
  for health, mana, both regens and attack damage. Attack speed grows the same way as a
  bonus percentage. Health and mana gained on a level-up are added to the current amounts too.
- **Ranks.** Every number that changes by rank on the wiki uses the current rank: damage,
  cooldowns, costs, Shadeblade's slows, energy refund and stored damage. Arcane Bolt
  scales with total attack damage (130%), and Final Mark's detonation adds 100% of it.
- **Uncertain.** The wiki gives champion-kill experience only at level 1 (42) and 18
  (990); the levels between use the commonly cited table. Prey on the Weak's 5% / 7.5% /
  10% steps are assumed to come at levels 1 / 7 / 17. Minion level-ups and the minion
  catch-up experience bonus aren't modeled.
- **Tests and sandboxes.** `World.addUnit` without a `progression` gives a level-1
  champion with every ability at rank 1, which the ability tests rely on.

## Champion: Wayfinder

The playable champion mirrors **Ezreal's kit** (mechanics and rank-1 numbers from
the LoL wiki, with 60 AD and no bonus AD/AP). Names and visuals are original, since
Riot's names and art are theirs. There is no armor or magic resist yet, so physical and
magic damage are treated the same.

| Key | Ability | What it does |
|---|---|---|
| Passive | Spell Momentum | Each enemy hit by an ability: +10% attack speed for 6 s, up to 5 stacks |
| Q | Arcane Bolt | 1200-range skillshot, 98 damage. On hit, all cooldowns −1.5 s |
| W | Rune Orb | Wide skillshot that marks the first enemy for 4 s. Your next attack or ability on it detonates for 80; an ability detonation refunds 60 mana plus its cost |
| E | Phase Step | Blink up to 475, then a homing bolt (80) at the nearest enemy within 750, preferring marked ones |
| R | Skyline Barrage | 1 s rooted cast, then a map-wide, 320-wide barrage that pierces, 350 to each champion hit (150 to minions) |

Prediction covers the blink and your casts. Hits, marks, cooldown refunds, mana refunds
and passive stacks come from the server.

## Champion: Shadeblade

A melee assassin whose kit mirrors **Zed's** (rank-1 numbers from the LoL wiki, which grow with rank and level;
63 AD, no bonus AD). It uses **energy** (200, +10/s) instead of mana.

| Key | Ability | What it does |
|---|---|---|
| Passive | Prey on the Weak | Attacks on a target under 50% health add 5% of its max health; once per 10 s per target |
| Q | Night Star | 925-range shuriken that pierces: 80 to the first enemy, 48 to the rest |
| W | Echo Shadow | A shadow dashes up to 650 away and copies Q and E for 5.25 s. Recast: swap places with it (once). Hitting an enemy with both his and a shadow's copy of one ability refunds 30 energy |
| E | Umbral Slash | Instant 315-radius slash around him and each shadow; 70 to each enemy once. Shadow hits slow 20% (30% if hit twice) for 1.5 s; each champion hit by his own slash takes 3 s off W |
| R | Final Mark | Target an enemy within 625: untargetable, 0.6 s later dash just behind them. The mark detonates after 3 s for 100% of his AD plus 25% of the damage he dealt meanwhile. A shadow stays at the start; recast swaps back to it |

Pick the champion on the start page. Prediction covers his shadow placement, swaps and the
R dash; slows, the mark, refunds and damage come from the server.

## Practice bot

`src/sim/bot.ts` plays any champion, deciding about 8 times a second through the same
commands a player sends:

- **Laning.** It last-hits minions it can kill in one attack, otherwise pushes the lowest
  minion in reach, and otherwise waits behind its wave. It trades when you come close and
  aren't under your turret. It leaves enemy turret range when the turret targets it or has
  none of its minions to shoot instead, and it doesn't dive you under your turret.
- **Auto-attacks.** Ranged, it orb-walks: attacks when its timer is up, repositions to
  about 90% of its range during the backswing, and never cancels its own windup. Melee, it
  chases and swings.
- **Abilities, by kind.** Skillshots are aimed with lead on your movement plus some random
  error. A global ult is saved to finish you. It blinks away when low and you're close, or
  in to finish. Shadow champions set up the shadow before Q/E so the copies join in, slash
  when you're in reach, death-mark when you're low or the combo is ready, and swap to
  escape or chase.
- **Dodging.** It sidesteps your skillshots (from your cast or the missile) after
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
- **Skillshots in 3D.** Missiles fly at waist height (`MISSILE_HEIGHT`) and cast a shadow
  on the floor that is as wide as they hit, so you can dodge the shadow. They are sorted
  with the units by depth, so one passing behind you is drawn behind you. Because the
  camera draws champions tall, a missile passing behind a champion would show up across
  its head; so for skillshots a champion's hitbox reaches only 25 units behind it (up the
  screen, `CHAMPION_BACK_RADIUS`) instead of 65. The deepest hit is drawn at the
  shoulders, and a missile drawn at the head flies over. The full radius still counts in
  front and to the sides, and minions keep their full circle. Both players see the map
  turned the same way, so this is fair. This is a departure from LoL, whose hitboxes are
  plain circles on the ground.
- **Abilities.** Champions have Q/W/E/R slots holding data-driven abilities: `skillshot`
  (stops at the first enemy or pierces, with on-hit effects such as cooldown refunds and
  marks), `blink` (with an optional homing bolt), `shadow` (a placeable copy that mimics
  chosen abilities and can be swapped with), `area` (instant circle around the caster and
  its shadows) and `deathMark` (unit-targeted dash and delayed detonation). Casts root
  the caster for their cast time; abilities with no cast time are instant. Statuses cover
  marks, attack-speed stacks, slows and untargetability. As in LoL, only your own aim
  indicators are drawn; enemy casts show no indicator, so you dodge the missile itself.
- **Camera.** The sim's lane runs straight along x; the camera turns it 45°
  (`VIEW_ROTATION`) so it reads diagonally like LoL's mid lane, then squashes the ground
  vertically (`TILT`) to fake LoL's angled camera, while units stay upright. Clicks map
  back through the same transform, so gameplay is unaffected.
- **Size and framing.** Champions are drawn 170 units tall, Ezreal's selection height on
  the LoL wiki, so ranges look the right size next to them: the 550 attack range is about
  3.5 champion heights. Minions stand about 100 and turrets about 450 (`MODEL_HEIGHT` in
  `src/client/theme.ts`). The camera fits 1500 world units into the screen height
  (`VIEW_HEIGHT_UNITS`), so a 1200-range skillshot reaches close to the edge of a 16:9
  screen, as in LoL. Health bars and names stay the same pixel size at any window size.

All numbers are in [`src/sim/defs.ts`](src/sim/defs.ts).

## Layout

```
src/sim/      pure game rules (no DOM/Pixi), shared by server and client
  world.ts    units, orders, attacks, abilities, projectiles, fixed-step update
  defs.ts     champions, minions, turret and abilities; map layout, wave timing, tick rate
  lane.ts     turrets, minion waves and LoL's minion/turret targeting rules
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
4. A nexus and win condition (or LoL's 1v1 rules: first blood, 100 CS or first turret).
