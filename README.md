# 1v1me

A 1v1 MOBA-style web game: PixiJS client and an authoritative Colyseus server, written in
TypeScript and sharing one simulation.

```bash
npm install
npm run dev     # server on :2568 + client (Vite prints its URL)
npm test        # sim rules + server integration tests
npm run typecheck
```

The start menu offers three modes:

| Mode | What runs where |
|---|---|
| **Find a duel** | Online 1v1. Open two tabs or browsers to play yourself |
| **Online practice** | You vs the bot, with the bot running on the server |
| **Offline practice** | Everything in the browser, no server needed |

Set `VITE_SERVER_URL` to point the client at a server elsewhere (default: this host on
port 2568), and `PORT` to change the server port.

## Controls

| Input | Action |
|---|---|
| Right-click | Move, or attack an enemy under the cursor. Hold to keep moving toward the cursor |
| A + left-click | Attack-move |
| Q W E R | Hold to aim, release to cast. Right-click while aiming cancels |
| S | Stop |
| Space | Center the camera on your champion |
| Y | Lock or unlock the camera (edge-pan when unlocked) |

## How online play works

- **The server is authoritative.** `server/DuelRoom.ts` owns the only real `World` and
  steps it at 30 Hz with Colyseus's fixed timestep. Clients send `PlayerCommand`s (move,
  attack, cast…). The server validates each one and applies it to that client's own
  unit; a client never picks which unit it controls.
- **Snapshots.** Every tick the server broadcasts a snapshot: units, projectiles, and that
  tick's events (damage, deaths…). These are plain messages, not Colyseus Schema state,
  because snapshots with tick numbers are what client prediction needs next.
- **Interpolation.** The client draws everything about 2 ticks (~66 ms) behind the newest
  snapshot, interpolating between snapshots, and plays events when the drawing catches
  up with them.
- **Not yet:** client-side prediction. Your own champion currently responds one round
  trip late. Reconnection, rematches and lag-test tooling are also still to come.

## Tuning the feel

- **Attack windup.** Each auto-attack spends `windupPct` of its period winding up. Moving
  during the windup cancels the attack and refunds it. Moving after it (the backswing)
  keeps the hit, which is how orb-walking works. The HUD bar shows which phase you're in.
- **Abilities.** Champions have Q/W/E/R slots holding data-driven abilities. Only
  `skillshot` exists so far: a cast time that roots the caster, then a straight missile
  with a width that stops at the first enemy it touches. Enemy casts are shown on the
  floor so you can dodge them.
- **Tilted camera.** The ground layer is squashed vertically (`TILT`) to fake LoL's angled
  camera, while units stay upright.

All numbers are in [`src/sim/defs.ts`](src/sim/defs.ts).

## Layout

```
src/sim/      pure game rules (no DOM/Pixi), shared by server and client
  world.ts    units, orders, attacks, abilities, projectiles, fixed-step update
  defs.ts     champions and abilities, tick rate, map size
  bot.ts      practice opponent that issues normal commands
src/net/      wire protocol: messages, snapshots, command validation
src/client/   PixiJS rendering, camera, input, HUD
  session.ts  where state comes from: OfflineSession (local World) or OnlineSession (server)
server/       Colyseus server and the DuelRoom
```

## Next steps

1. Client-side prediction for your own champion, then testing with simulated latency
   (`COLYSEUS_LATENCY=100 npm run dev:server`).
2. More abilities (W/E/R) and a second champion, including a dash early on.
3. Map with walls and pathfinding, then minions and towers.
