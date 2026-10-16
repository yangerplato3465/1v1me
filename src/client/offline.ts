import { PracticeBot } from '../sim/bot';
import { PLAYABLE, TICK_RATE, WAYFINDER, WORLD_SIZE, type ChampionDef } from '../sim/defs';
import { dist, lerpVec, type Vec } from '../sim/math';
import { World, type PlayerCommand, type Projectile, type Shadow, type SimEvent, type Unit } from '../sim/world';
import type { Session } from './session';

const STEP = 1 / TICK_RATE;
/** Positions that jump further than this in one tick (respawns) snap instead of sliding. */
const SNAP_DISTANCE = 200;

/** Runs the sim in the browser against the practice bot. No server needed. */
export class OfflineSession implements Session {
  readonly view: World;
  readonly playerId: number;
  readonly tickRate = TICK_RATE;
  readonly note = 'Offline practice: the bot attacks, casts its kit and dodges some of your skillshots.';
  private readonly bot: PracticeBot;
  private readonly prev = new Map<number, Vec>();
  private acc = 0;

  constructor(champ: ChampionDef = PLAYABLE[0]) {
    const world = new World();
    const player = world.addUnit(champ, 'blue', { x: 700, y: WORLD_SIZE.height / 2 });
    const enemy = world.addUnit(WAYFINDER, 'red', { x: WORLD_SIZE.width - 700, y: WORLD_SIZE.height / 2 });
    this.view = world;
    this.playerId = player.id;
    this.bot = new PracticeBot(world, enemy.id, player.id);
  }

  send(cmd: PlayerCommand): void {
    this.view.issue({ ...cmd, unitId: this.playerId });
  }

  update(dt: number): SimEvent[] {
    // Fixed-step simulation; rendering interpolates between the last two ticks.
    const events: SimEvent[] = [];
    this.acc += dt;
    while (this.acc >= STEP) {
      for (const u of this.view.units.values()) this.prev.set(u.id, { ...u.pos });
      this.bot.update(STEP);
      this.view.step(STEP);
      events.push(...this.view.drainEvents());
      this.acc -= STEP;
    }
    return events;
  }

  renderPos(u: Unit): Vec {
    const p = this.prev.get(u.id);
    return p && dist(p, u.pos) < SNAP_DISTANCE ? lerpVec(p, u.pos, this.acc / STEP) : u.pos;
  }

  projectilePos(p: Projectile): Vec {
    return lerpVec(p.prev, p.pos, this.acc / STEP);
  }

  shadowPos(s: Shadow): Vec {
    return dist(s.prev, s.pos) < SNAP_DISTANCE ? lerpVec(s.prev, s.pos, this.acc / STEP) : s.pos;
  }

  status(): string {
    return 'offline';
  }
}
