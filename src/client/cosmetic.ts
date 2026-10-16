import { type SkillshotAbility } from '../sim/defs';
import { add, dist, scale, segmentCircleHit, sub, type Vec } from '../sim/math';
import type { HomingProjectile, Projectile, SkillshotProjectile, Unit } from '../sim/world';

/**
 * Purely visual missiles for your own attacks and skillshots, spawned the moment the
 * prediction releases them, so they leave your hands without waiting a round trip.
 * The server's copies of these missiles are hidden; hits and damage still come from it.
 */
export class CosmeticMissiles {
  readonly list: Projectile[] = [];
  private nextId = -1;

  /** An auto-attack released at `targetId`. */
  attack(owner: Unit, targetId: number, from: Vec): void {
    this.list.push({
      kind: 'homing',
      id: this.nextId--,
      ownerId: owner.id,
      team: owner.team,
      pos: { ...from },
      prev: { ...from },
      speed: owner.def.attackProjectileSpeed,
      damage: 0,
      source: 'attack',
      targetId,
    } satisfies HomingProjectile);
  }

  skillshot(owner: Unit, slot: SkillshotProjectile['slot'], ability: SkillshotAbility, from: Vec, dir: Vec, fromShadow = false): void {
    this.list.push({
      kind: 'skillshot',
      id: this.nextId--,
      ownerId: owner.id,
      team: owner.team,
      pos: { ...from },
      prev: { ...from },
      speed: ability.speed,
      damage: 0,
      slot,
      dir,
      width: ability.width,
      range: ability.range,
      travelled: 0,
      stopsAtFirstHit: ability.stopsAtFirstHit,
      subsequentDamage: 0,
      hitIds: [],
      castId: 0,
      fromShadow,
    } satisfies SkillshotProjectile);
  }

  /**
   * Advances every missile against where units are drawn (`drawnAt`), the same picture the
   * player sees, and drops the ones that arrive, touch an enemy or run out of range.
   */
  update(dt: number, units: Iterable<Unit>, drawnAt: (u: Unit) => Vec): void {
    const enemies = [...units];
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.prev = { ...p.pos };
      const alive = p.kind === 'homing' ? this.stepHoming(p, dt, enemies, drawnAt) : this.stepSkillshot(p, dt, enemies, drawnAt);
      if (!alive) this.list.splice(i, 1);
    }
  }

  private stepHoming(p: HomingProjectile, dt: number, units: Unit[], drawnAt: (u: Unit) => Vec): boolean {
    const target = units.find((u) => u.id === p.targetId);
    if (!target) return false;
    const goal = drawnAt(target);
    const d = dist(p.pos, goal);
    const stepLen = p.speed * dt;
    if (d <= stepLen) return false;
    p.pos = add(p.pos, scale(sub(goal, p.pos), stepLen / d));
    return true;
  }

  private stepSkillshot(p: SkillshotProjectile, dt: number, units: Unit[], drawnAt: (u: Unit) => Vec): boolean {
    const stepLen = Math.min(p.speed * dt, p.range - p.travelled);
    const next = add(p.pos, scale(p.dir, stepLen));
    if (p.stopsAtFirstHit) {
      for (const u of units) {
        if (u.team === p.team || u.respawnIn > 0) continue;
        if (segmentCircleHit(p.pos, next, drawnAt(u), u.def.radius + p.width / 2) !== null) return false;
      }
    }
    p.pos = next;
    p.travelled += stepLen;
    return p.travelled < p.range - 1e-6;
  }
}
