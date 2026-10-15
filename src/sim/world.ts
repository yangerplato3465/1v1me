import { RESPAWN_SECONDS, WORLD_SIZE, type ChampionDef } from './defs';
import {
  add,
  angleOf,
  clamp,
  dist,
  fromAngle,
  len,
  lerpVec,
  normalize,
  scale,
  segmentCircleHit,
  sub,
  turnToward,
  type Vec,
} from './math';

// Pure game rules: no DOM, no rendering. This module is meant to run unchanged on the
// authoritative server later, and on the client for prediction.

export type Team = 'blue' | 'red';

export type Order =
  | { kind: 'idle' }
  | { kind: 'move'; target: Vec }
  | { kind: 'attack'; targetId: number }
  | { kind: 'attackMove'; target: Vec };

export interface Unit {
  id: number;
  team: Team;
  def: ChampionDef;
  spawn: Vec;
  pos: Vec;
  facing: number;
  hp: number;
  mana: number;
  order: Order;
  /** Seconds until the next auto-attack may start. */
  attackCooldown: number;
  windup: { remaining: number; total: number; targetId: number } | null;
  cast: { remaining: number; total: number; dir: Vec } | null;
  qCooldown: number;
  /** > 0 while dead. */
  respawnIn: number;
}

export type Command =
  | { type: 'move'; unitId: number; target: Vec }
  | { type: 'attack'; unitId: number; targetId: number }
  | { type: 'attackMove'; unitId: number; target: Vec }
  | { type: 'castQ'; unitId: number; target: Vec }
  | { type: 'stop'; unitId: number };

interface ProjectileBase {
  id: number;
  ownerId: number;
  team: Team;
  pos: Vec;
  /** Position at the start of the last step, for render interpolation. */
  prev: Vec;
  speed: number;
  damage: number;
}

export interface AttackProjectile extends ProjectileBase {
  kind: 'attack';
  targetId: number;
}

export interface SkillshotProjectile extends ProjectileBase {
  kind: 'skillshot';
  dir: Vec;
  width: number;
  range: number;
  travelled: number;
}

export type Projectile = AttackProjectile | SkillshotProjectile;

export type DamageKind = 'attack' | 'skillshot';

export type SimEvent =
  | { type: 'damage'; targetId: number; sourceId: number; amount: number; kind: DamageKind; pos: Vec }
  | { type: 'death'; unitId: number; killerId: number }
  | { type: 'respawn'; unitId: number }
  | { type: 'attackStart'; unitId: number }
  | { type: 'attackFired'; unitId: number }
  | { type: 'attackCanceled'; unitId: number }
  | { type: 'castStart'; unitId: number }
  | { type: 'castFired'; unitId: number }
  | { type: 'skillshotExpired'; pos: Vec; team: Team };

/** An A-click this close to an enemy's edge targets that enemy directly. */
const ATTACK_MOVE_SNAP = 200;
const WORLD_MARGIN = 40;

const IDLE: Order = { kind: 'idle' };

function clampToWorld(p: Vec): Vec {
  return {
    x: clamp(p.x, WORLD_MARGIN, WORLD_SIZE.width - WORLD_MARGIN),
    y: clamp(p.y, WORLD_MARGIN, WORLD_SIZE.height - WORLD_MARGIN),
  };
}

export class World {
  time = 0;
  readonly units = new Map<number, Unit>();
  projectiles: Projectile[] = [];
  private nextId = 1;
  private events: SimEvent[] = [];

  addUnit(def: ChampionDef, team: Team, spawn: Vec): Unit {
    const unit: Unit = {
      id: this.nextId++,
      team,
      def,
      spawn: { ...spawn },
      pos: { ...spawn },
      facing: team === 'blue' ? 0 : Math.PI,
      hp: def.maxHp,
      mana: def.maxMana,
      order: IDLE,
      attackCooldown: 0,
      windup: null,
      cast: null,
      qCooldown: 0,
      respawnIn: 0,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  isAlive(u: Unit): boolean {
    return u.respawnIn <= 0;
  }

  attackPeriod(u: Unit): number {
    return 1 / u.def.attackSpeed;
  }

  inAttackRange(u: Unit, target: Unit): boolean {
    return dist(u.pos, target.pos) <= u.def.attackRange + target.def.radius;
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  issue(cmd: Command): void {
    const u = this.units.get(cmd.unitId);
    if (!u || !this.isAlive(u)) return;
    switch (cmd.type) {
      case 'move':
        this.setOrder(u, { kind: 'move', target: clampToWorld(cmd.target) });
        break;
      case 'attack': {
        const target = this.units.get(cmd.targetId);
        if (target && target.team !== u.team && this.isAlive(target)) {
          this.setOrder(u, { kind: 'attack', targetId: target.id });
        }
        break;
      }
      case 'attackMove': {
        const target = this.nearestEnemy(u, cmd.target, ATTACK_MOVE_SNAP);
        this.setOrder(
          u,
          target ? { kind: 'attack', targetId: target.id } : { kind: 'attackMove', target: clampToWorld(cmd.target) },
        );
        break;
      }
      case 'castQ':
        this.castQ(u, cmd.target);
        break;
      case 'stop':
        this.setOrder(u, IDLE);
        break;
    }
  }

  step(dt: number): void {
    this.time += dt;
    for (const u of this.units.values()) this.stepUnit(u, dt);
    this.stepProjectiles(dt);
  }

  // --- orders -------------------------------------------------------------

  private setOrder(u: Unit, order: Order): void {
    // Spam-clicking the target you are already winding up on must not restart the attack.
    const sameTarget = order.kind === 'attack' && u.windup?.targetId === order.targetId;
    if (!sameTarget) this.cancelWindup(u);
    u.order = order;
  }

  private cancelWindup(u: Unit): void {
    if (!u.windup) return;
    // The attack never fired, so it is not spent: the next one may start immediately.
    u.windup = null;
    u.attackCooldown = 0;
    this.events.push({ type: 'attackCanceled', unitId: u.id });
  }

  private castQ(u: Unit, target: Vec): void {
    const q = u.def.q;
    if (u.cast || u.qCooldown > 0 || u.mana < q.manaCost) return;
    this.cancelWindup(u);
    let dir = normalize(sub(target, u.pos));
    if (dir.x === 0 && dir.y === 0) dir = fromAngle(u.facing);
    u.mana -= q.manaCost;
    u.qCooldown = q.cooldown;
    u.facing = angleOf(dir);
    u.cast = { remaining: q.castTime, total: q.castTime, dir };
    this.events.push({ type: 'castStart', unitId: u.id });
  }

  // --- unit step ----------------------------------------------------------

  private stepUnit(u: Unit, dt: number): void {
    if (!this.isAlive(u)) {
      u.respawnIn -= dt;
      if (u.respawnIn <= 0) this.respawn(u);
      return;
    }

    u.hp = Math.min(u.def.maxHp, u.hp + u.def.hpRegen * dt);
    u.mana = Math.min(u.def.maxMana, u.mana + u.def.manaRegen * dt);
    u.qCooldown = Math.max(0, u.qCooldown - dt);
    u.attackCooldown = Math.max(0, u.attackCooldown - dt);

    // Rooted while casting. The order is kept, so a move resumes after the cast, like in LoL.
    if (u.cast) {
      u.cast.remaining -= dt;
      if (u.cast.remaining <= 0) this.fireSkillshot(u);
      return;
    }

    if (u.windup) {
      const target = this.units.get(u.windup.targetId);
      if (!target || !this.isAlive(target)) {
        this.cancelWindup(u);
      } else {
        u.facing = angleOf(sub(target.pos, u.pos));
        u.windup.remaining -= dt;
        if (u.windup.remaining <= 0) {
          u.windup = null;
          this.fireAttack(u, target);
        }
        return;
      }
    }

    switch (u.order.kind) {
      case 'idle':
        break;
      case 'move':
        if (this.moveToward(u, u.order.target, dt)) u.order = IDLE;
        break;
      case 'attack': {
        const target = this.units.get(u.order.targetId);
        if (!target || !this.isAlive(target)) {
          u.order = IDLE;
        } else if (this.inAttackRange(u, target)) {
          u.facing = angleOf(sub(target.pos, u.pos));
          if (u.attackCooldown <= 0) this.startWindup(u, target);
        } else {
          this.moveToward(u, target.pos, dt);
        }
        break;
      }
      case 'attackMove': {
        const target = this.nearestEnemy(u, u.pos, u.def.attackRange);
        if (target) u.order = { kind: 'attack', targetId: target.id };
        else if (this.moveToward(u, u.order.target, dt)) u.order = IDLE;
        break;
      }
    }
  }

  /** Returns true once the unit has arrived. */
  private moveToward(u: Unit, target: Vec, dt: number): boolean {
    const to = sub(target, u.pos);
    const d = len(to);
    if (d < 1e-6) return true;
    u.facing = turnToward(u.facing, angleOf(to), u.def.turnRate * dt);
    const stepLen = u.def.moveSpeed * dt;
    if (d <= stepLen) {
      u.pos = clampToWorld(target);
      return true;
    }
    u.pos = clampToWorld(add(u.pos, scale(to, stepLen / d)));
    return false;
  }

  private startWindup(u: Unit, target: Unit): void {
    const period = this.attackPeriod(u);
    const windup = period * u.def.windupPct;
    u.windup = { remaining: windup, total: windup, targetId: target.id };
    u.attackCooldown = period;
    this.events.push({ type: 'attackStart', unitId: u.id });
  }

  private fireAttack(u: Unit, target: Unit): void {
    this.events.push({ type: 'attackFired', unitId: u.id });
    if (u.def.attackProjectileSpeed <= 0) {
      this.damage(target, u.id, u.def.attackDamage, 'attack');
      return;
    }
    const muzzle = add(u.pos, scale(fromAngle(u.facing), u.def.radius));
    this.projectiles.push({
      kind: 'attack',
      id: this.nextId++,
      ownerId: u.id,
      team: u.team,
      pos: muzzle,
      prev: { ...muzzle },
      speed: u.def.attackProjectileSpeed,
      damage: u.def.attackDamage,
      targetId: target.id,
    });
  }

  private fireSkillshot(u: Unit): void {
    const q = u.def.q;
    const dir = u.cast!.dir;
    u.cast = null;
    const start = add(u.pos, scale(dir, u.def.radius));
    this.projectiles.push({
      kind: 'skillshot',
      id: this.nextId++,
      ownerId: u.id,
      team: u.team,
      pos: start,
      prev: { ...start },
      speed: q.speed,
      damage: q.damage,
      dir,
      width: q.width,
      range: q.range,
      travelled: 0,
    });
    this.events.push({ type: 'castFired', unitId: u.id });
  }

  private respawn(u: Unit): void {
    u.respawnIn = 0;
    u.pos = { ...u.spawn };
    u.hp = u.def.maxHp;
    u.mana = u.def.maxMana;
    u.order = IDLE;
    u.attackCooldown = 0;
    u.qCooldown = 0;
    this.events.push({ type: 'respawn', unitId: u.id });
  }

  private nearestEnemy(u: Unit, point: Vec, maxEdgeDist: number): Unit | null {
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !this.isAlive(other)) continue;
      const d = dist(point, other.pos) - other.def.radius;
      if (d <= maxEdgeDist && d < bestDist) {
        best = other;
        bestDist = d;
      }
    }
    return best;
  }

  // --- projectiles --------------------------------------------------------

  private stepProjectiles(dt: number): void {
    const survivors: Projectile[] = [];
    for (const p of this.projectiles) {
      p.prev = { ...p.pos };
      const alive = p.kind === 'attack' ? this.stepAttackProjectile(p, dt) : this.stepSkillshot(p, dt);
      if (alive) survivors.push(p);
    }
    this.projectiles = survivors;
  }

  /** Auto-attacks home in and cannot miss (unless the target dies first). */
  private stepAttackProjectile(p: AttackProjectile, dt: number): boolean {
    const target = this.units.get(p.targetId);
    if (!target || !this.isAlive(target)) return false;
    const to = sub(target.pos, p.pos);
    const d = len(to);
    const stepLen = p.speed * dt;
    if (d <= stepLen) {
      p.pos = { ...target.pos };
      this.damage(target, p.ownerId, p.damage, 'attack');
      return false;
    }
    p.pos = add(p.pos, scale(to, stepLen / d));
    return true;
  }

  /** Skillshots fly straight and stop on the first enemy they touch. */
  private stepSkillshot(p: SkillshotProjectile, dt: number): boolean {
    const stepLen = Math.min(p.speed * dt, p.range - p.travelled);
    const next = add(p.pos, scale(p.dir, stepLen));

    let hit: Unit | null = null;
    let hitAt = Infinity;
    for (const u of this.units.values()) {
      if (u.team === p.team || !this.isAlive(u)) continue;
      const t = segmentCircleHit(p.pos, next, u.pos, u.def.radius + p.width / 2);
      if (t !== null && t < hitAt) {
        hit = u;
        hitAt = t;
      }
    }
    if (hit) {
      p.pos = lerpVec(p.pos, next, hitAt);
      this.damage(hit, p.ownerId, p.damage, 'skillshot');
      return false;
    }

    p.pos = next;
    p.travelled += stepLen;
    if (p.travelled >= p.range - 1e-6) {
      this.events.push({ type: 'skillshotExpired', pos: { ...p.pos }, team: p.team });
      return false;
    }
    return true;
  }

  private damage(target: Unit, sourceId: number, amount: number, kind: DamageKind): void {
    if (!this.isAlive(target)) return;
    target.hp = Math.max(0, target.hp - amount);
    this.events.push({ type: 'damage', targetId: target.id, sourceId, amount, kind, pos: { ...target.pos } });
    if (target.hp > 0) return;
    target.respawnIn = RESPAWN_SECONDS;
    target.order = IDLE;
    target.windup = null;
    target.cast = null;
    this.events.push({ type: 'death', unitId: target.id, killerId: sourceId });
  }
}
