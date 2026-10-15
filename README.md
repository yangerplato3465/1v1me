# 1v1me

A 1v1 MOBA-style web game. This is the **feel prototype**: one champion against a strafing
bot, rendered with PixiJS, to tune movement, auto-attacks and skillshots before adding netcode.

```bash
npm install
npm run dev     # play at http://localhost:5173
npm test        # simulation rules (windup cancel, orb-walk, skillshot hit/miss, cooldowns)
```

## Controls

| Input | Action |
|---|---|
| Right-click | Move, or attack an enemy under the cursor. Hold to keep moving toward the cursor |
| A + left-click | Attack-move |
| Q | Hold to aim, release to fire. Right-click while aiming cancels |
| S | Stop |
| Space | Center the camera on your champion |
| Y | Lock or unlock the camera (edge-pan when unlocked) |

## What the prototype tunes

- **Attack windup.** Each auto-attack spends `windupPct` of its period winding up. Moving
  during the windup cancels the attack and refunds it. Moving after it (the backswing) keeps
  the hit, which is how orb-walking works. The HUD bar shows which phase you're in.
- **Skillshots.** Each skillshot has a cast time that roots the caster, then flies in a
  straight line with a width, and stops at the first enemy it touches. Enemy casts are
  shown on the floor so you can dodge them.
- **Tilted camera.** The ground layer is squashed vertically (`TILT`) to fake LoL's angled
  camera, while units stay upright.

All numbers are in [`src/sim/defs.ts`](src/sim/defs.ts).

## Layout

```
src/sim/      pure game rules (no DOM/Pixi): runs on the future authoritative server too
  world.ts    units, orders, attacks, projectiles, fixed-step update
  defs.ts     champion and ability data, tick rate, map size
  bot.ts      practice opponent that issues normal commands
src/client/   PixiJS rendering, camera, input, HUD
src/main.ts   fixed 30 Hz simulation loop with interpolated rendering
```

## Next steps

1. Colyseus server running `src/sim` at 30 Hz. Clients send commands; the server sends state.
2. Client-side prediction for your own champion, interpolation for the opponent.
3. Map with walls and pathfinding, then minions and towers.
