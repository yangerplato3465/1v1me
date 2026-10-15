import {
  ABILITY_SLOTS,
  RESPAWN_SECONDS,
  TICK_RATE,
  WORLD_SIZE,
  type AbilitySlot,
  type BlinkAbility,
  type ChampionDef,
  type MarkEffect,
  type SkillshotAbility,
} from './defs';
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

// Pure game rules: no DOM, no rendering. The authoritative server runs this module; the
// client runs it directly in offline practice and reuses it for prediction.

export type Team = 'blue' | 'red';

export type Order =
  | { kind: 'idle' }
  | { kind: 'move'; target: Vec }
  | { kind: 'attack'; targetId: number }
  | { kind: 'attackMove'; target: Vec };

/** Timed effects on a unit. */
export type Status =
  | { kind: 'attackSpeed'; stacks: number; perStack: number; remaining: number }
  | { kind: 'mark'; sourceId: number; remaining: number; effect: MarkEffect };

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
  cast: { slot: AbilitySlot; remaining: number; total: number; dir: Vec; target: Vec } | null;
  cooldowns: Record<AbilitySlot, number>;
  statuses: Status[];
  /** > 0 while dead. */
  respawnIn: number;
}

/** What a player asks for. The server attaches the unitId it owns; clients never choose it. */
export type PlayerCommand =
  | { type: 'move'; target: Vec }
  | { type: 'attack'; targetId: number }
  | { type: 'attackMove'; target: Vec }
  | { type: 'cast'; slot: AbilitySlot; target: Vec }
  | { type: 'stop' };

export type Command = PlayerCommand & { unitId: number };

/** What dealt a hit: an auto-attack or one of the attacker's ability slots. */
export type HitSource = 'attack' | AbilitySlot;

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

/** Auto-attacks and homing ability bolts: they follow the target and cannot miss. */
export interface HomingProjectile extends ProjectileBase {
  kind: 'homing';
  source: HitSource;
  targetId: number;
}

export interface SkillshotProjectile extends ProjectileBase {
  kind: 'skillshot';
  slot: AbilitySlot;
  dir: Vec;
  width: number;
  range: number;
  travelled: number;
  stopsAtFirstHit: boolean;
  /** Units already hit, so a piercing missile hits each one once. */
  hitIds: number[];
}

export type Projectile = HomingProjectile | SkillshotProjectile;

/** The read-only slice of game state the client renders: a World, or a mirror of server snapshots. */
export interface GameView {
  readonly units: ReadonlyMap<number, Unit>;
  readonly projectiles: readonly Projectile[];
  isAlive(u: Unit): boolean;
}

export type SimEvent =
  | { type: 'damage'; targetId: number; sourceId: number; amount: number; source: HitSource; detonation: boolean; pos: Vec }
  | { type: 'death'; unitId: number; killerId: number }
  | { type: 'respawn'; unitId: number }
  | { type: 'attackStart'; unitId: number }
  | { type: 'attackFired'; unitId: number; targetId: number }
  | { type: 'attackCanceled'; unitId: number }
  | { type: 'castStart'; unitId: number; slot: AbilitySlot }
  | { type: 'castFired'; unitId: number; slot: AbilitySlot; pos: Vec; dir: Vec }
  | { type: 'blink'; unitId: number; from: Vec; to: Vec }
  | { type: 'marked'; unitId: number; sourceId: number }
  | { type: 'skillshotExpired'; pos: Vec; team: Team };

export interface WorldOptions {
  /**
   * False for the client's prediction copy: units still move, attack, cast and blink, but
   * nothing spawns missiles or deals damage. Hits belong to the server alone.
   */
  authoritative?: boolean;
}

/**
 * LoL's grace period: in the last game tick of a windup, move/stop commands no longer
 * cancel the attack. Clicking away a hair early still lets the shot go, which makes
 * orb-walking forgiving.
 */
const WINDUP_GRACE = 1 / TICK_RATE + 1e-9;

/** An A-click this close to an enemy's edge targets that enemy directly. */
const ATTACK_MOVE_SNAP = 200;
const WORLD_MARGIN = 40;

const IDLE: Order = { kind: 'idle' };

const noCooldowns = (): Record<AbilitySlot, number> => ({ Q: 0, W: 0, E: 0, R: 0 });

function clampToWorld(p: Vec): Vec {
  return {
    x: clamp(p.x, WORLD_MARGIN, WORLD_SIZE.width - WORLD_MARGIN),
    y: clamp(p.y, WORLD_MARGIN, WORLD_SIZE.height - WORLD_MARGIN),
  };
}

/** Attacks per second including bonus attack speed from statuses. */
export function attackSpeedOf(u: Unit): number {
  let bonus = 0;
  for (const s of u.statuses) if (s.kind === 'attackSpeed') bonus += s.stacks * s.perStack;
  return u.def.attackSpeed * (1 + bonus);
}

export class World {
  time = 0;
  readonly units = new Map<number, Unit>();
  projectiles: Projectile[] = [];
  readonly authoritative: boolean;
  private nextId = 1;
  private events: SimEvent[] = [];

  constructor(options: WorldOptions = {}) {
    this.authoritative = options.authoritative ?? true;
  }

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
      cooldowns: noCooldowns(),
      statuses: [],
      respawnIn: 0,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  removeUnit(id: number): void {
    this.units.delete(id);
    this.projectiles = this.projectiles.filter((p) => p.ownerId !== id);
  }

  isAlive(u: Unit): boolean {
    return u.respawnIn <= 0;
  }

  attackPeriod(u: Unit): number {
    return 1 / attackSpeedOf(u);
  }

  /** Edge to edge, like LoL. */
  inAttackRange(u: Unit, target: Unit): boolean {
    return dist(u.pos, target.pos) <= u.def.attackRange + u.def.radius + target.def.radius;
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
      case 'cast':
        this.cast(u, cmd.slot, cmd.target);
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
    // Spam-clicking the target you are already winding up on must not restart the attack,
    // and in the grace tick at the end of a windup the attack is already committed.
    const sameTarget = order.kind === 'attack' && u.windup?.targetId === order.targetId;
    const committed = !!u.windup && u.windup.remaining <= WINDUP_GRACE;
    if (!sameTarget && !committed) this.cancelWindup(u);
    u.order = order;
  }

  private cancelWindup(u: Unit): void {
    if (!u.windup) return;
    // The attack never fired, so it is not spent: the next one may start immediately.
    u.windup = null;
    u.attackCooldown = 0;
    this.events.push({ type: 'attackCanceled', unitId: u.id });
  }

  private cast(u: Unit, slot: AbilitySlot, target: Vec): void {
    const ability = u.def.abilities[slot];
    if (!ability || u.cast || u.cooldowns[slot] > 0 || u.mana < ability.manaCost) return;
    this.cancelWindup(u);
    let dir = normalize(sub(target, u.pos));
    if (dir.x === 0 && dir.y === 0) dir = fromAngle(u.facing);
    u.mana -= ability.manaCost;
    u.cooldowns[slot] = ability.cooldown;
    u.facing = angleOf(dir);
    u.cast = { slot, remaining: ability.castTime, total: ability.castTime, dir, target: { ...target } };
    this.events.push({ type: 'castStart', unitId: u.id, slot });
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
    for (const slot of ABILITY_SLOTS) u.cooldowns[slot] = Math.max(0, u.cooldowns[slot] - dt);
    u.attackCooldown = Math.max(0, u.attackCooldown - dt);
    for (const s of u.statuses) s.remaining -= dt;
    u.statuses = u.statuses.filter((s) => s.remaining > 0);

    // Rooted while casting. The order is kept, so a move resumes after the cast, like in LoL.
    if (u.cast) {
      u.cast.remaining -= dt;
      if (u.cast.remaining <= 0) this.finishCast(u);
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
        const target = this.nearestEnemy(u, u.pos, u.def.attackRange + u.def.radius);
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
    this.events.push({ type: 'attackFired', unitId: u.id, targetId: target.id });
    if (!this.authoritative) return;
    if (u.def.attackProjectileSpeed <= 0) {
      this.hit(target, u.id, u.def.attackDamage, 'attack');
      return;
    }
    this.fireHoming(u, target, 'attack', u.def.attackProjectileSpeed, u.def.attackDamage);
  }

  private fireHoming(u: Unit, target: Unit, source: HitSource, speed: number, damage: number): void {
    const muzzle = add(u.pos, scale(normalize(sub(target.pos, u.pos)), u.def.radius));
    this.projectiles.push({
      kind: 'homing',
      id: this.nextId++,
      ownerId: u.id,
      team: u.team,
      pos: muzzle,
      prev: { ...muzzle },
      speed,
      damage,
      source,
      targetId: target.id,
    });
  }

  private finishCast(u: Unit): void {
    const { slot, dir, target } = u.cast!;
    u.cast = null;
    const ability = u.def.abilities[slot];
    if (!ability) return;
    switch (ability.kind) {
      case 'skillshot':
        if (this.authoritative) this.fireSkillshot(u, slot, ability, dir);
        break;
      case 'blink':
        this.blink(u, slot, ability, dir, target);
        break;
    }
    this.events.push({ type: 'castFired', unitId: u.id, slot, pos: { ...u.pos }, dir });
  }

  /** Skillshot range is measured from the caster's center, like LoL. */
  private fireSkillshot(u: Unit, slot: AbilitySlot, ability: SkillshotAbility, dir: Vec): void {
    const start = { ...u.pos };
    this.projectiles.push({
      kind: 'skillshot',
      id: this.nextId++,
      ownerId: u.id,
      team: u.team,
      pos: start,
      prev: { ...start },
      speed: ability.speed,
      damage: ability.damage,
      slot,
      dir,
      width: ability.width,
      range: ability.range,
      travelled: 0,
      stopsAtFirstHit: ability.stopsAtFirstHit,
      hitIds: [],
    });
  }

  private blink(u: Unit, slot: AbilitySlot, ability: BlinkAbility, dir: Vec, target: Vec): void {
    const from = { ...u.pos };
    u.pos = clampToWorld(add(u.pos, scale(dir, Math.min(ability.range, dist(from, target)))));
    this.events.push({ type: 'blink', unitId: u.id, from, to: { ...u.pos } });
    if (!ability.bolt || !this.authoritative) return;

    // Bolt the nearest enemy in range, preferring one carrying this unit's mark.
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !this.isAlive(other)) continue;
      const d = dist(u.pos, other.pos) - other.def.radius;
      if (d > ability.bolt.range) continue;
      const marked = other.statuses.some((s) => s.kind === 'mark' && s.sourceId === u.id);
      const score = d - (marked ? 1e6 : 0);
      if (score < bestScore) {
        best = other;
        bestScore = score;
      }
    }
    if (best) this.fireHoming(u, best, slot, ability.bolt.speed, ability.bolt.damage);
  }

  private respawn(u: Unit): void {
    u.respawnIn = 0;
    u.pos = { ...u.spawn };
    u.hp = u.def.maxHp;
    u.mana = u.def.maxMana;
    u.order = IDLE;
    u.attackCooldown = 0;
    u.cooldowns = noCooldowns();
    u.statuses = [];
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
      const alive = p.kind === 'homing' ? this.stepHoming(p, dt) : this.stepSkillshot(p, dt);
      if (alive) survivors.push(p);
    }
    this.projectiles = survivors;
  }

  private stepHoming(p: HomingProjectile, dt: number): boolean {
    const target = this.units.get(p.targetId);
    if (!target || !this.isAlive(target)) return false;
    const to = sub(target.pos, p.pos);
    const d = len(to);
    const stepLen = p.speed * dt;
    if (d <= stepLen) {
      p.pos = { ...target.pos };
      this.hit(target, p.ownerId, p.damage, p.source);
      return false;
    }
    p.pos = add(p.pos, scale(to, stepLen / d));
    return true;
  }

  /** Skillshots fly straight; they stop on the first enemy or pierce, per the ability. */
  private stepSkillshot(p: SkillshotProjectile, dt: number): boolean {
    const stepLen = Math.min(p.speed * dt, p.range - p.travelled);
    const next = add(p.pos, scale(p.dir, stepLen));

    const hits: { unit: Unit; at: number }[] = [];
    for (const u of this.units.values()) {
      if (u.team === p.team || !this.isAlive(u) || p.hitIds.includes(u.id)) continue;
      const at = segmentCircleHit(p.pos, next, u.pos, u.def.radius + p.width / 2);
      if (at !== null) hits.push({ unit: u, at });
    }
    hits.sort((a, b) => a.at - b.at);

    if (p.stopsAtFirstHit && hits.length) {
      p.pos = lerpVec(p.pos, next, hits[0].at);
      this.hit(hits[0].unit, p.ownerId, p.damage, p.slot);
      return false;
    }
    for (const { unit } of hits) {
      p.hitIds.push(unit.id);
      this.hit(unit, p.ownerId, p.damage, p.slot);
    }

    p.pos = next;
    p.travelled += stepLen;
    if (p.travelled >= p.range - 1e-6) {
      this.events.push({ type: 'skillshotExpired', pos: { ...p.pos }, team: p.team });
      return false;
    }
    return true;
  }

  // --- hits ---------------------------------------------------------------

  /** Resolves one landed attack or ability: damage, mark detonation, then on-hit effects. */
  private hit(target: Unit, sourceId: number, amount: number, source: HitSource): void {
    if (!this.isAlive(target)) return;
    const attacker = this.units.get(sourceId);
    const ability = attacker && source !== 'attack' ? attacker.def.abilities[source] : undefined;
    const appliesMark = ability?.kind === 'skillshot' ? ability.onHit?.mark : undefined;

    if (amount > 0) this.damage(target, sourceId, amount, source, false);

    // The attacker's own mark detonates on their next attack or ability, except the one that applies marks.
    const markIndex = target.statuses.findIndex((s) => s.kind === 'mark' && s.sourceId === sourceId);
    if (markIndex >= 0 && !appliesMark && this.isAlive(target)) {
      const mark = target.statuses[markIndex] as Extract<Status, { kind: 'mark' }>;
      target.statuses.splice(markIndex, 1);
      this.damage(target, sourceId, mark.effect.detonateDamage, source, true);
      if (attacker && ability) {
        attacker.mana = Math.min(attacker.def.maxMana, attacker.mana + mark.effect.abilityManaRefund + ability.manaCost);
      }
    }

    if (!attacker || !ability) return;
    const onHit = ability.kind === 'skillshot' ? ability.onHit : undefined;
    if (onHit?.reduceCooldowns) {
      for (const slot of ABILITY_SLOTS) attacker.cooldowns[slot] = Math.max(0, attacker.cooldowns[slot] - onHit.reduceCooldowns);
    }
    if (appliesMark && this.isAlive(target)) {
      target.statuses = target.statuses.filter((s) => !(s.kind === 'mark' && s.sourceId === sourceId));
      target.statuses.push({ kind: 'mark', sourceId, remaining: appliesMark.duration, effect: appliesMark });
      this.events.push({ type: 'marked', unitId: target.id, sourceId });
    }
    this.grantPassiveStack(attacker);
  }

  private grantPassiveStack(u: Unit): void {
    const passive = u.def.passive;
    if (!passive || !this.isAlive(u)) return;
    const status = u.statuses.find((s) => s.kind === 'attackSpeed');
    if (status) {
      status.stacks = Math.min(passive.maxStacks, status.stacks + 1);
      status.remaining = passive.duration;
    } else {
      u.statuses.push({ kind: 'attackSpeed', stacks: 1, perStack: passive.perStack, remaining: passive.duration });
    }
  }

  private damage(target: Unit, sourceId: number, amount: number, source: HitSource, detonation: boolean): void {
    if (!this.isAlive(target)) return;
    target.hp = Math.max(0, target.hp - amount);
    this.events.push({ type: 'damage', targetId: target.id, sourceId, amount, source, detonation, pos: { ...target.pos } });
    if (target.hp > 0) return;
    target.respawnIn = RESPAWN_SECONDS;
    target.order = IDLE;
    target.windup = null;
    target.cast = null;
    target.statuses = [];
    this.events.push({ type: 'death', unitId: target.id, killerId: sourceId });
  }
}
