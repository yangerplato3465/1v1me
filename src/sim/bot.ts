import { ABILITY_SLOTS, type AbilityDef, type AbilitySlot } from './defs';
import { add, clamp, dist, len, lerpVec, normalize, scale, sub, type Vec } from './math';
import type { PlayerCommand, Unit, World } from './world';

export interface BotOptions {
  /** Seconds before it reacts to a skillshot it can see coming (from the start of the cast). */
  reaction: number;
  /** Chance it tries to dodge a given skillshot at all. */
  dodgeChance: number;
  /** Random aim offset, in world units, applied sideways to its skillshots. */
  aimError: number;
  /** How much of your current velocity it leads its skillshots by (0 = aims where you stand). */
  lead: number;
}

export const DEFAULT_BOT: BotOptions = { reaction: 0.25, dodgeChance: 0.6, aimError: 45, lead: 0.7 };

/** Decisions per second, roughly: a human-ish click rate rather than a perfect per-tick reflex. */
const THINK_SECONDS = 0.12;
const MELEE_RANGE = 300;
/** Extra clearance it aims for when sidestepping a missile. */
const DODGE_MARGIN = 35;

/**
 * Practice opponent that plays any champion through the same commands a player uses:
 * auto-attacks (orb-walking when ranged), casts its abilities by kind, and sidesteps
 * skillshots after a reaction delay, but not always, so it stays beatable.
 */
export class PracticeBot {
  private thinkIn = 0;
  private strafeIn = 0;
  private strafeSide = 1;
  private time = 0;
  private foeVel: Vec = { x: 0, y: 0 };
  private lastFoePos: Vec | null = null;
  /** Threats already judged (dodge or not), so each skillshot is decided once. */
  private readonly judged = new Map<string, { dodge: boolean; at: number }>();

  constructor(
    private readonly world: World,
    private readonly selfId: number,
    private readonly foeId: number,
    private readonly rng: () => number = Math.random,
    private readonly options: BotOptions = DEFAULT_BOT,
  ) {}

  update(dt: number): void {
    this.time += dt;
    const me = this.world.units.get(this.selfId);
    const foe = this.world.units.get(this.foeId);
    if (!me || !foe) return;
    this.trackFoe(foe, dt);
    if (!this.world.isAlive(me) || me.cast || me.dash) return;

    this.thinkIn -= dt;
    this.strafeIn -= dt;
    if (this.thinkIn > 0) return;
    this.thinkIn = THINK_SECONDS * (0.7 + this.rng() * 0.6);

    if (!this.world.isAlive(foe)) {
      if (dist(me.pos, me.spawn) > 50) this.issue({ type: 'move', target: me.spawn });
      return;
    }
    if (this.dodge(me)) return;
    if (this.useAbility(me, foe)) return;
    this.fight(me, foe);
  }

  private issue(cmd: PlayerCommand): void {
    this.world.issue({ ...cmd, unitId: this.selfId });
  }

  private trackFoe(foe: Unit, dt: number): void {
    if (this.lastFoePos && dt > 0) {
      const v = scale(sub(foe.pos, this.lastFoePos), 1 / dt);
      // Teleports (blinks, respawns) aren't movement; ignore them.
      if (len(v) < 2000) this.foeVel = lerpVec(this.foeVel, v, 0.3);
    }
    this.lastFoePos = { ...foe.pos };
  }

  // --- dodging -------------------------------------------------------------

  /** Sidesteps the most urgent skillshot heading its way, if it decides to and can see it in time. */
  private dodge(me: Unit): boolean {
    for (const [key, j] of this.judged) if (this.time - j.at > 5) this.judged.delete(key);

    let best: { key: string; perp: Vec; needed: number; impactIn: number } | null = null;
    const consider = (key: string, origin: Vec, dir: Vec, width: number, speed: number, rangeLeft: number, seenFor: number, delay: number) => {
      const r = sub(me.pos, origin);
      const along = r.x * dir.x + r.y * dir.y;
      if (along < -me.def.radius || along > rangeLeft + me.def.radius) return;
      const cross = dir.x * r.y - dir.y * r.x;
      const clearance = width / 2 + me.def.radius + DODGE_MARGIN;
      if (Math.abs(cross) >= clearance) return;
      if (seenFor < this.options.reaction) return; // hasn't reacted yet
      let judged = this.judged.get(key);
      if (!judged) {
        judged = { dodge: this.rng() < this.options.dodgeChance, at: this.time };
        this.judged.set(key, judged);
      }
      if (!judged.dodge) return;
      const side = cross >= 0 ? 1 : -1;
      const impactIn = delay + Math.max(0, along) / speed;
      if (!best || impactIn < best.impactIn) {
        best = { key, perp: scale({ x: -dir.y, y: dir.x }, side), needed: clearance - Math.abs(cross), impactIn };
      }
    };

    for (const p of this.world.projectiles) {
      if (p.kind !== 'skillshot' || p.team === me.team || p.hitIds.includes(me.id)) continue;
      // It saw the cast telegraph before the missile left, so count that time too.
      consider(`p${p.id}`, p.pos, p.dir, p.width, p.speed, p.range - p.travelled, p.travelled / p.speed + 0.25, 0);
    }
    for (const u of this.world.units.values()) {
      if (u.team === me.team || !u.cast) continue;
      const ability = u.def.abilities[u.cast.slot];
      if (ability?.kind !== 'skillshot') continue;
      const castStart = Math.round((this.time - (u.cast.total - u.cast.remaining)) * 10);
      consider(`c${u.id}:${castStart}`, u.pos, u.cast.dir, ability.width, ability.speed, ability.range, u.cast.total - u.cast.remaining, u.cast.remaining);
    }
    if (!best) return false;
    const threat = best as { perp: Vec; needed: number; impactIn: number };

    // Walk out if there's time; otherwise burn a blink sideways if it has one.
    const walkTime = threat.needed / me.def.moveSpeed;
    if (walkTime > threat.impactIn) {
      const blink = this.readySlot(me, (a) => a.kind === 'blink');
      if (blink) {
        this.issue({ type: 'cast', slot: blink, target: add(me.pos, scale(threat.perp, 400)) });
        return true;
      }
    }
    this.issue({ type: 'move', target: add(me.pos, scale(threat.perp, threat.needed + 60)) });
    return true;
  }

  // --- abilities -----------------------------------------------------------

  private readySlot(me: Unit, match: (a: AbilityDef) => boolean): AbilitySlot | null {
    for (const slot of ABILITY_SLOTS) {
      const a = me.def.abilities[slot];
      if (a && match(a) && me.cooldowns[slot] <= 0 && me.mana >= a.manaCost) return slot;
    }
    return null;
  }

  private ownShadow(me: Unit, slot: AbilitySlot) {
    return this.world.ownShadows(me).find((s) => s.slot === slot && !s.swapped);
  }

  /** Where to throw a missile so it meets a target moving like it is now, plus some human error. */
  private aim(me: Unit, foe: Unit, speed: number, castTime: number): Vec {
    const t = dist(me.pos, foe.pos) / speed + castTime;
    const lead = add(foe.pos, scale(this.foeVel, t * this.options.lead));
    const dir = normalize(sub(lead, me.pos));
    const error = (this.rng() * 2 - 1) * this.options.aimError;
    return add(lead, scale({ x: -dir.y, y: dir.x }, error));
  }

  /** Casts at most one ability per decision. Returns true if it did. */
  private useAbility(me: Unit, foe: Unit): boolean {
    const d = dist(me.pos, foe.pos);
    const myHp = me.hp / me.def.maxHp;
    const foeHp = foe.hp / foe.def.maxHp;
    const targetable = this.world.isTargetable(foe);

    for (const slot of ['R', 'W', 'E', 'Q'] as AbilitySlot[]) {
      const ability = me.def.abilities[slot];
      if (!ability) continue;

      // Recasts: swap to a shadow to escape when low, or to close in on a fleeing low target.
      if (ability.kind === 'shadow' || ability.kind === 'deathMark') {
        const shadow = this.ownShadow(me, slot);
        if (shadow) {
          const shadowToFoe = dist(shadow.pos, foe.pos);
          const escape = myHp < 0.3 && shadowToFoe > d + 150;
          const chase = ability.kind === 'shadow' && foeHp < 0.35 && shadowToFoe < d - 200;
          if (escape || chase) {
            this.issue({ type: 'cast', slot, target: shadow.pos });
            return true;
          }
          continue;
        }
      }

      if (me.cooldowns[slot] > 0 || me.mana < ability.manaCost) continue;
      switch (ability.kind) {
        case 'skillshot': {
          if (!targetable) break;
          const global = ability.range >= 5000;
          if (global) {
            // Save the big one for a kill, or a lucky long shot.
            if (d > 2500 || (foe.hp > ability.damage * 1.1 && !(foeHp < 0.4 && this.rng() < 0.1))) break;
          } else if (d > ability.range + foe.def.radius * 0.5) {
            break;
          }
          this.issue({ type: 'cast', slot, target: this.aim(me, foe, ability.speed, ability.castTime) });
          return true;
        }
        case 'blink': {
          const away = normalize(sub(me.pos, foe.pos));
          if (myHp < 0.35 && d < 500) {
            this.issue({ type: 'cast', slot, target: add(me.pos, scale(away, ability.range)) });
            return true;
          }
          const reach = ability.range + me.def.attackRange + me.def.radius + foe.def.radius;
          const finish = (ability.bolt?.damage ?? 0) + me.def.attackDamage;
          if (targetable && foe.hp <= finish && d <= reach && myHp > 0.4) {
            this.issue({ type: 'cast', slot, target: foe.pos });
            return true;
          }
          break;
        }
        case 'shadow': {
          // Send the shadow in to set up its copies when the follow-up is ready.
          const followUp = me.def.shadowMimics?.some((s) => s !== slot && me.cooldowns[s] <= 0);
          if (!targetable || !followUp || d > ability.range + 600) break;
          const toward = normalize(sub(foe.pos, me.pos));
          this.issue({ type: 'cast', slot, target: add(me.pos, scale(toward, Math.min(ability.range, Math.max(0, d - 150)))) });
          return true;
        }
        case 'area': {
          const reach = ability.radius + foe.def.radius;
          const fromShadow = me.def.shadowMimics?.includes(slot) && this.world.ownShadows(me).some((s) => dist(s.pos, foe.pos) <= reach);
          if (targetable && (d <= reach || fromShadow)) {
            this.issue({ type: 'cast', slot, target: foe.pos });
            return true;
          }
          break;
        }
        case 'deathMark': {
          const comboReady = me.cooldowns.Q <= 0 || me.cooldowns.E <= 0;
          if (targetable && d <= ability.range + foe.def.radius && (foeHp < 0.7 || comboReady) && myHp > 0.25) {
            this.issue({ type: 'cast', slot, target: foe.pos });
            return true;
          }
          break;
        }
      }
    }
    return false;
  }

  // --- auto-attacks and spacing ----------------------------------------------

  private fight(me: Unit, foe: Unit): void {
    if (!this.world.isTargetable(foe)) return;
    const reach = me.def.attackRange + me.def.radius + foe.def.radius;
    const d = dist(me.pos, foe.pos);
    const attacking = me.order.kind === 'attack' && me.order.targetId === foe.id;

    if (me.def.attackRange < MELEE_RANGE) {
      // Melee: stick to the target; the attack order chases and swings.
      if (!attacking) this.issue({ type: 'attack', targetId: foe.id });
      return;
    }

    // Ranged: attack when the timer is up, then use the backswing to reposition (orb-walk).
    if (me.windup) return; // never cancel its own windup
    if (me.attackCooldown <= 0 && d <= reach + 150) {
      if (!attacking) this.issue({ type: 'attack', targetId: foe.id });
      return;
    }
    if (this.strafeIn <= 0 || attacking) {
      if (this.strafeIn <= 0) {
        this.strafeSide = this.rng() < 0.5 ? -1 : 1;
        this.strafeIn = 0.5 + this.rng() * 0.7;
      }
      const away = normalize(sub(me.pos, foe.pos));
      const perp = { x: -away.y, y: away.x };
      const radial = clamp(reach * 0.9 - d, -250, 250); // drift toward ~90% of attack reach
      const step = add(scale(perp, this.strafeSide * 120), scale(away, radial));
      this.issue({ type: 'move', target: add(me.pos, step) });
    }
  }
}
