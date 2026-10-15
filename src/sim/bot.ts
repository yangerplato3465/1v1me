import { add, clamp, len, normalize, scale, sub } from './math';
import type { World } from './world';

const PREFERRED_RANGE = 750;

/**
 * Practice opponent: strafes sideways at a fixed distance and throws its Q at where you
 * stand (no lead), so you can practise dodging and landing skillshots on a moving target.
 * It issues the same commands a player would.
 */
export class StrafeBot {
  private strafeIn = 0;
  private qIn = 2;

  constructor(
    private readonly world: World,
    private readonly selfId: number,
    private readonly foeId: number,
    private readonly rng: () => number = Math.random,
  ) {}

  update(dt: number): void {
    const me = this.world.units.get(this.selfId);
    const foe = this.world.units.get(this.foeId);
    if (!me || !foe || !this.world.isAlive(me)) return;

    this.strafeIn -= dt;
    this.qIn -= dt;

    if (!this.world.isAlive(foe)) {
      if (this.strafeIn <= 0) {
        this.world.issue({ type: 'move', unitId: me.id, target: me.spawn });
        this.strafeIn = 1;
      }
      return;
    }

    const toFoe = sub(foe.pos, me.pos);
    const d = len(toFoe);
    const dir = normalize(toFoe);

    if (this.qIn <= 0 && d <= me.def.q.range && me.qCooldown <= 0 && !me.cast) {
      this.world.issue({ type: 'castQ', unitId: me.id, target: foe.pos });
      this.qIn = 2.5 + this.rng() * 2.5;
    }

    if (this.strafeIn <= 0) {
      const side = this.rng() < 0.5 ? -1 : 1;
      const perp = { x: -dir.y, y: dir.x };
      const radial = clamp(d - PREFERRED_RANGE, -250, 250);
      const target = add(me.pos, add(scale(perp, side * (140 + this.rng() * 160)), scale(dir, radial)));
      this.world.issue({ type: 'move', unitId: me.id, target });
      this.strafeIn = 0.45 + this.rng() * 0.6;
    }
  }
}
