import { BOT_SUMMONERS, PracticeBot } from '../sim/bot';
import { DEFAULT_SUMMONERS, FOUNTAINS, PLAYABLE, START_LEVEL, TICK_RATE, WAYFINDER, type ChampionDef, type SummonerId, type SummonerSlot } from '../sim/defs';
import { Lane } from '../sim/lane';
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
  private readonly lane: Lane;
  private readonly prev = new Map<number, Vec>();
  private acc = 0;

  constructor(champ: ChampionDef = PLAYABLE[0], summoners: Record<SummonerSlot, SummonerId> = DEFAULT_SUMMONERS) {
    const world = new World();
    this.lane = new Lane(world);
    const player = world.addUnit(champ, 'blue', FOUNTAINS.blue, { level: START_LEVEL, summoners });
    const enemy = world.addUnit(WAYFINDER, 'red', FOUNTAINS.red, { level: START_LEVEL, summoners: BOT_SUMMONERS });
    this.view = world;
    this.playerId = player.id;
    enemy.autoAttack = true;
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
      for (const id of this.prev.keys()) if (!this.view.units.has(id)) this.prev.delete(id);
      this.lane.update(STEP);
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
