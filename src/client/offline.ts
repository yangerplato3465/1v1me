import { StrafeBot } from '../sim/bot';
import { TICK_RATE, WAYFINDER, WORLD_SIZE } from '../sim/defs';
import { dist, lerpVec, type Vec } from '../sim/math';
import { World, type PlayerCommand, type Projectile, type SimEvent, type Unit } from '../sim/world';
import type { Session } from './session';

const STEP = 1 / TICK_RATE;
/** Positions that jump further than this in one tick (respawns) snap instead of sliding. */
const SNAP_DISTANCE = 200;

/** Runs the sim in the browser against the practice bot. No server needed. */
export class OfflineSession implements Session {
  readonly view: World;
  readonly playerId: number;
  readonly tickRate = TICK_RATE;
  readonly note = 'Offline practice: the bot strafes and throws its Q at you.';
  private readonly bot: StrafeBot;
  private readonly prev = new Map<number, Vec>();
  private acc = 0;

  constructor() {
    const world = new World();
    const player = world.addUnit(WAYFINDER, 'blue', { x: 700, y: WORLD_SIZE.height / 2 });
    const enemy = world.addUnit(WAYFINDER, 'red', { x: WORLD_SIZE.width - 700, y: WORLD_SIZE.height / 2 });
    this.view = world;
    this.playerId = player.id;
    this.bot = new StrafeBot(world, enemy.id, player.id);
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

  status(): string {
    return 'offline';
  }
}
