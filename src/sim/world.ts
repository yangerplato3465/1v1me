import {
  ABILITY_SLOTS,
  CHAMPION_BOUNTY,
  FOUNTAIN_RADIUS,
  FOUNTAIN_REGEN,
  RESPAWN_SECONDS,
  TICK_RATE,
  WORLD_SIZE,
  type AbilityDef,
  type AbilitySlot,
  type AreaAbility,
  type BlinkAbility,
  type ChampionDef,
  type DeathMarkAbility,
  type MarkEffect,
  type SkillshotAbility,
  type UnitKind,
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
  | { kind: 'mark'; sourceId: number; remaining: number; effect: MarkEffect }
  | { kind: 'slow'; amount: number; remaining: number }
  | { kind: 'untargetable'; remaining: number }
  | { kind: 'deathMark'; sourceId: number; remaining: number; stored: number; pct: number; baseDamage: number }
  | { kind: 'executeCooldown'; sourceId: number; remaining: number };

export interface Unit {
  id: number;
  team: Team;
  def: ChampionDef;
  spawn: Vec;
  pos: Vec;
  facing: number;
  hp: number;
  /** Mana or energy, per def.resource. */
  mana: number;
  order: Order;
  /** Seconds until the next auto-attack may start. */
  attackCooldown: number;
  windup: { remaining: number; total: number; targetId: number } | null;
  cast: { slot: AbilitySlot; remaining: number; total: number; dir: Vec; target: Vec; targetId: number | null } | null;
  /** A forced movement (e.g. the death-mark dash); orders wait until it ends. */
  dash: { from: Vec; to: Vec; remaining: number; total: number; markTargetId: number | null } | null;
  cooldowns: Record<AbilitySlot, number>;
  statuses: Status[];
  /** > 0 while dead. */
  respawnIn: number;
}

/** A champion's shadow: it dashes into place, copies mimicked abilities, and can be swapped with once. */
export interface Shadow {
  id: number;
  ownerId: number;
  team: Team;
  /** The ability that created it; recasting that ability swaps with it. */
  slot: AbilitySlot;
  pos: Vec;
  /** Position at the start of the last step, for render interpolation. */
  prev: Vec;
  dashTo: Vec | null;
  dashSpeed: number;
  remaining: number;
  swapped: boolean;
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
  /** Damage to each enemy after the first. */
  subsequentDamage: number;
  /** Units already hit, so a piercing missile hits each one once. */
  hitIds: number[];
  /** Groups the caster's and its shadows' copies of one cast (0 = none). */
  castId: number;
  fromShadow: boolean;
}

export type Projectile = HomingProjectile | SkillshotProjectile;

/** The read-only slice of game state the client renders: a World, or a mirror of server snapshots. */
export interface GameView {
  readonly units: ReadonlyMap<number, Unit>;
  readonly projectiles: readonly Projectile[];
  readonly shadows: readonly Shadow[];
  isAlive(u: Unit): boolean;
}

export type SimEvent =
  | { type: 'damage'; targetId: number; sourceId: number; amount: number; source: HitSource; detonation: boolean; pos: Vec }
  | { type: 'death'; unitId: number; killerId: number; kind: UnitKind; pos: Vec; bounty: number }
  | { type: 'respawn'; unitId: number }
  | { type: 'attackStart'; unitId: number }
  | { type: 'attackFired'; unitId: number; targetId: number }
  | { type: 'attackCanceled'; unitId: number }
  | { type: 'castStart'; unitId: number; slot: AbilitySlot }
  | { type: 'castFired'; unitId: number; slot: AbilitySlot; pos: Vec; dir: Vec; target: Vec }
  | { type: 'blink'; unitId: number; from: Vec; to: Vec }
  | { type: 'swap'; unitId: number; from: Vec; to: Vec }
  | { type: 'slash'; unitId: number; pos: Vec; radius: number }
  | { type: 'marked'; unitId: number; sourceId: number }
  | { type: 'deathMarked'; unitId: number; sourceId: number }
  | { type: 'skillshotExpired'; pos: Vec; team: Team };

export interface WorldOptions {
  /**
   * False for the client's prediction copy: units still move, attack, cast, blink, dash
   * and place shadows, but nothing spawns missiles or deals damage. Hits belong to the
   * server alone.
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
/** A unit-targeted cast picks the enemy nearest the cursor within this distance of it. */
const TARGET_PICK_RADIUS = 250;
/** Cooldown left on a death mark whose target died before the dash. */
const DEATH_MARK_FIZZLE_COOLDOWN = 0.5;
const WORLD_MARGIN = 40;
const CAST_TRACKING_SECONDS = 5;
/** How long a hit counts as a call for help to the victim's minions and turret (see lane.ts). */
const CALL_SECONDS = 0.5;

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

/** Move speed after the strongest slow (slows don't stack in LoL). */
export function moveSpeedOf(u: Unit): number {
  let slow = 0;
  for (const s of u.statuses) if (s.kind === 'slow') slow = Math.max(slow, s.amount);
  return u.def.moveSpeed * (1 - slow);
}

export function isUntargetable(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === 'untargetable');
}

export const kindOf = (u: Unit): UnitKind => u.def.kind ?? 'champion';
export const isChampion = (u: Unit): boolean => kindOf(u) === 'champion';
export const isMinion = (u: Unit): boolean => kindOf(u) === 'minion';
/** Structures (turrets) only take damage from basic attacks, as in LoL. */
export const isStructure = (u: Unit): boolean => kindOf(u) === 'turret';

/** An attack or ability that landed on someone, which their allied minions and turrets respond to. */
export interface CallForHelp {
  attackerId: number;
  victimId: number;
  time: number;
}

/** Hits from one cast by the caster and by its shadows, for the shared-hit refund. */
interface CastRecord {
  ownerId: number;
  time: number;
  own: Set<number>;
  shadow: Set<number>;
  refunded: boolean;
}

interface HitContext {
  castId?: number;
  fromShadow?: boolean;
}

export class World {
  time = 0;
  readonly units = new Map<number, Unit>();
  projectiles: Projectile[] = [];
  shadows: Shadow[] = [];
  readonly authoritative: boolean;
  /** Recent hits, newest last, for minion and turret targeting. Authoritative worlds only. */
  calls: CallForHelp[] = [];
  /** Each team's fountain, where its champions heal. Set by the lane; none by default. */
  fountains: Partial<Record<Team, Vec>> = {};
  private nextId = 1;
  private events: SimEvent[] = [];
  private readonly casts = new Map<number, CastRecord>();
  /** Turret id → the champion it keeps shooting and how heated its shots are. */
  private readonly heat = new Map<number, { targetId: number; stacks: number }>();

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
      dash: null,
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
    this.shadows = this.shadows.filter((s) => s.ownerId !== id);
  }

  /** Makes future ids larger than `id` (used when copying server entities into a world). */
  reserveIds(id: number): void {
    this.nextId = Math.max(this.nextId, id + 1);
  }

  isAlive(u: Unit): boolean {
    return u.respawnIn <= 0;
  }

  isTargetable(u: Unit): boolean {
    return this.isAlive(u) && !isUntargetable(u);
  }

  attackPeriod(u: Unit): number {
    return 1 / attackSpeedOf(u);
  }

  /** Edge to edge, like LoL. */
  inAttackRange(u: Unit, target: Unit): boolean {
    return dist(u.pos, target.pos) <= u.def.attackRange + u.def.radius + target.def.radius;
  }

  ownShadows(u: Unit): Shadow[] {
    return this.shadows.filter((s) => s.ownerId === u.id);
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
        if (target && target.team !== u.team && this.isTargetable(target)) {
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
    this.resolveCollisions();
    this.stepShadows(dt);
    this.stepProjectiles(dt);
    for (const [id, record] of this.casts) if (this.time - record.time > CAST_TRACKING_SECONDS) this.casts.delete(id);
    this.calls = this.calls.filter((c) => this.time - c.time <= CALL_SECONDS);
    // Minions and turrets don't respawn. Their missiles already in flight still land.
    for (const u of this.units.values()) {
      if (u.respawnIn !== Infinity) continue;
      this.units.delete(u.id);
      this.heat.delete(u.id);
    }
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
    if (!ability || u.cast || u.dash) return;
    if (this.trySwapRecast(u, slot, ability)) return;
    if (u.cooldowns[slot] > 0 || u.mana < ability.manaCost) return;

    let targetId: number | null = null;
    if (ability.kind === 'deathMark') {
      const victim = this.pickDeathMarkTarget(u, ability, target);
      if (!victim) return;
      targetId = victim.id;
    }

    this.cancelWindup(u);
    let dir = normalize(sub(target, u.pos));
    if (dir.x === 0 && dir.y === 0) dir = fromAngle(u.facing);
    u.mana -= ability.manaCost;
    u.cooldowns[slot] = ability.cooldown;
    u.facing = angleOf(dir);
    u.cast = { slot, remaining: ability.castTime, total: ability.castTime, dir, target: { ...target }, targetId };
    this.events.push({ type: 'castStart', unitId: u.id, slot });

    if (ability.kind === 'deathMark') {
      u.statuses.push({ kind: 'untargetable', remaining: ability.castTime + ability.dashTime });
      this.spawnShadow(u, slot, u.pos, null, 0, ability.shadowDuration);
    }
    // Abilities without a cast time happen at once and never root.
    if (ability.castTime <= 0) this.finishCast(u);
  }

  /** Recasting a shadow ability swaps places with its shadow, once. */
  private trySwapRecast(u: Unit, slot: AbilitySlot, ability: AbilityDef): boolean {
    if (ability.kind !== 'shadow' && ability.kind !== 'deathMark') return false;
    const shadow = this.shadows.find((s) => s.ownerId === u.id && s.slot === slot && !s.swapped);
    if (!shadow) return false;
    if (ability.kind === 'deathMark' && shadow.remaining <= ability.recastCutoff) return true;
    this.cancelWindup(u);
    const from = { ...u.pos };
    u.pos = { ...shadow.pos };
    shadow.pos = from;
    shadow.prev = { ...from };
    shadow.dashTo = null;
    shadow.swapped = true;
    this.events.push({ type: 'swap', unitId: u.id, from, to: { ...u.pos } });
    return true;
  }

  private pickDeathMarkTarget(u: Unit, ability: DeathMarkAbility, point: Vec): Unit | null {
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !isChampion(other) || !this.isTargetable(other)) continue;
      if (dist(u.pos, other.pos) > ability.range + other.def.radius) continue;
      const d = dist(point, other.pos);
      if (d <= TARGET_PICK_RADIUS + other.def.radius && d < bestDist) {
        best = other;
        bestDist = d;
      }
    }
    return best;
  }

  // --- unit step ----------------------------------------------------------

  private stepUnit(u: Unit, dt: number): void {
    if (!this.isAlive(u)) {
      u.respawnIn -= dt;
      if (u.respawnIn <= 0) this.respawn(u);
      return;
    }

    const fountain = this.fountains[u.team];
    const healing = fountain && isChampion(u) && dist(u.pos, fountain) <= FOUNTAIN_RADIUS ? FOUNTAIN_REGEN : 0;
    u.hp = Math.min(u.def.maxHp, u.hp + (u.def.hpRegen + healing * u.def.maxHp) * dt);
    u.mana = Math.min(u.def.maxMana, u.mana + (u.def.manaRegen + healing * u.def.maxMana) * dt);
    for (const slot of ABILITY_SLOTS) u.cooldowns[slot] = Math.max(0, u.cooldowns[slot] - dt);
    u.attackCooldown = Math.max(0, u.attackCooldown - dt);
    this.tickStatuses(u, dt);
    if (!this.isAlive(u)) return; // a detonation can kill

    // Rooted while casting. The order is kept, so a move resumes after the cast, like in LoL.
    if (u.cast) {
      u.cast.remaining -= dt;
      if (u.cast.remaining <= 0) this.finishCast(u);
      return;
    }

    if (u.dash) {
      this.stepDash(u, dt);
      return;
    }

    if (u.windup) {
      const target = this.units.get(u.windup.targetId);
      if (!target || !this.isTargetable(target)) {
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
        } else if (isUntargetable(target)) {
          // Wait it out, like LoL: the order resumes when the target is targetable again.
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

  private tickStatuses(u: Unit, dt: number): void {
    for (const s of u.statuses) s.remaining -= dt;
    const expired = u.statuses.filter((s) => s.remaining <= 0);
    u.statuses = u.statuses.filter((s) => s.remaining > 0);
    for (const s of expired) {
      if (s.kind === 'deathMark' && this.authoritative) {
        this.damage(u, s.sourceId, s.baseDamage + s.pct * s.stored, 'R', true);
      }
    }
  }

  private stepDash(u: Unit, dt: number): void {
    const dash = u.dash!;
    dash.remaining -= dt;
    const t = clamp(1 - dash.remaining / dash.total, 0, 1);
    u.pos = lerpVec(dash.from, dash.to, t);
    if (dash.remaining > 0) return;
    u.pos = { ...dash.to };
    u.dash = null;
    const victim = dash.markTargetId === null ? undefined : this.units.get(dash.markTargetId);
    const ability = u.def.abilities.R;
    if (!victim || !this.isAlive(victim) || ability?.kind !== 'deathMark' || !this.authoritative) return;
    victim.statuses.push({
      kind: 'deathMark',
      sourceId: u.id,
      remaining: ability.markDuration,
      stored: 0,
      pct: ability.storedPct,
      baseDamage: ability.baseDamage,
    });
    this.events.push({ type: 'deathMarked', unitId: victim.id, sourceId: u.id });
  }

  /** Returns true once the unit has arrived. */
  private moveToward(u: Unit, target: Vec, dt: number): boolean {
    const to = sub(target, u.pos);
    const d = len(to);
    if (d < 1e-6) return true;
    const stepLen = moveSpeedOf(u) * dt;
    if (d <= stepLen) {
      u.facing = turnToward(u.facing, angleOf(to), u.def.turnRate * dt);
      u.pos = clampToWorld(target);
      return true;
    }
    const dir = this.steerAroundStructures(u, scale(to, 1 / d), stepLen);
    u.facing = turnToward(u.facing, angleOf(dir), u.def.turnRate * dt);
    u.pos = clampToWorld(add(u.pos, scale(dir, stepLen)));
    return false;
  }

  /** Walking into a turret slides along its edge, toward whichever side is closer to where the unit is heading. */
  private steerAroundStructures(u: Unit, dir: Vec, stepLen: number): Vec {
    for (const t of this.units.values()) {
      if (t === u || !isStructure(t) || !this.isAlive(t)) continue;
      const next = add(u.pos, scale(dir, stepLen));
      if (dist(next, t.pos) >= u.def.radius + t.def.radius) continue;
      const out = normalize(sub(u.pos, t.pos));
      if (dir.x * out.x + dir.y * out.y >= 0) continue; // already heading away
      const left = { x: -out.y, y: out.x };
      const side = dir.x * left.x + dir.y * left.y >= 0 ? 1 : -1;
      dir = scale(left, side);
    }
    return dir;
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
    const damage = this.attackDamage(u, target);
    if (u.def.attackProjectileSpeed <= 0) {
      this.hit(target, u.id, damage, 'attack');
      return;
    }
    this.fireHoming(u, target, 'attack', u.def.attackProjectileSpeed, damage);
  }

  /**
   * LoL's turret rules: shots at minions take a fixed share of their max health, and
   * consecutive shots at the same champion heat up (+40% each, up to +120%). Switching
   * targets cools the turret down.
   */
  private attackDamage(u: Unit, target: Unit): number {
    const turret = u.def.turret;
    if (!turret) return u.def.attackDamage;
    if (!isChampion(target)) {
      this.heat.delete(u.id);
      return target.def.turretDamagePct ? target.def.maxHp * target.def.turretDamagePct : u.def.attackDamage;
    }
    const previous = this.heat.get(u.id);
    const stacks = previous?.targetId === target.id ? previous.stacks : 0;
    this.heat.set(u.id, { targetId: target.id, stacks: Math.min(turret.maxHeatStacks, stacks + 1) });
    return u.def.attackDamage * (1 + turret.heatPerShot * stacks);
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
    const { slot, dir, target, targetId } = u.cast!;
    u.cast = null;
    const ability = u.def.abilities[slot];
    if (!ability) return;
    const castPos = { ...u.pos };
    switch (ability.kind) {
      case 'skillshot':
        if (this.authoritative) this.fireSkillshots(u, slot, ability, dir, target);
        break;
      case 'blink':
        this.blink(u, slot, ability, dir, target);
        break;
      case 'shadow': {
        const dest = clampToWorld(add(u.pos, scale(dir, Math.min(ability.range, dist(u.pos, target)))));
        this.spawnShadow(u, slot, u.pos, dest, ability.dashSpeed, ability.duration);
        break;
      }
      case 'area':
        this.slash(u, slot, ability);
        break;
      case 'deathMark':
        this.startDeathMarkDash(u, ability, targetId);
        break;
    }
    this.events.push({ type: 'castFired', unitId: u.id, slot, pos: castPos, dir, target: { ...target } });
  }

  private mimics(u: Unit, slot: AbilitySlot): Shadow[] {
    return u.def.shadowMimics?.includes(slot) ? this.ownShadows(u) : [];
  }

  private newCast(ownerId: number): number {
    const id = this.nextId++;
    this.casts.set(id, { ownerId, time: this.time, own: new Set(), shadow: new Set(), refunded: false });
    return id;
  }

  /** Range is measured from the caster's center, like LoL. Shadows throw copies at the same point. */
  private fireSkillshots(u: Unit, slot: AbilitySlot, ability: SkillshotAbility, dir: Vec, target: Vec): void {
    const shadows = this.mimics(u, slot);
    const castId = shadows.length ? this.newCast(u.id) : 0;
    this.fireSkillshot(u, slot, ability, u.pos, dir, castId, false);
    for (const shadow of shadows) {
      const shadowDir = normalize(sub(target, shadow.pos));
      this.fireSkillshot(u, slot, ability, shadow.pos, shadowDir.x || shadowDir.y ? shadowDir : dir, castId, true);
    }
  }

  private fireSkillshot(
    u: Unit,
    slot: AbilitySlot,
    ability: SkillshotAbility,
    from: Vec,
    dir: Vec,
    castId: number,
    fromShadow: boolean,
  ): void {
    this.projectiles.push({
      kind: 'skillshot',
      id: this.nextId++,
      ownerId: u.id,
      team: u.team,
      pos: { ...from },
      prev: { ...from },
      speed: ability.speed,
      damage: ability.damage,
      slot,
      dir,
      width: ability.width,
      range: ability.range,
      travelled: 0,
      stopsAtFirstHit: ability.stopsAtFirstHit,
      subsequentDamage: ability.subsequentDamage ?? ability.damage,
      hitIds: [],
      castId,
      fromShadow,
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
      if (other.team === u.team || isStructure(other) || !this.isTargetable(other)) continue;
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

  private spawnShadow(u: Unit, slot: AbilitySlot, at: Vec, dashTo: Vec | null, dashSpeed: number, duration: number): void {
    this.shadows = this.shadows.filter((s) => !(s.ownerId === u.id && s.slot === slot));
    this.shadows.push({
      id: this.nextId++,
      ownerId: u.id,
      team: u.team,
      slot,
      pos: { ...at },
      prev: { ...at },
      dashTo,
      dashSpeed,
      remaining: duration,
      swapped: false,
    });
  }

  /** One slash per enemy per cast, from the caster and from each shadow. */
  private slash(u: Unit, slot: AbilitySlot, ability: AreaAbility): void {
    const shadows = this.mimics(u, slot);
    this.events.push({ type: 'slash', unitId: u.id, pos: { ...u.pos }, radius: ability.radius });
    for (const s of shadows) this.events.push({ type: 'slash', unitId: u.id, pos: { ...s.pos }, radius: ability.radius });
    if (!this.authoritative) return;

    const castId = shadows.length ? this.newCast(u.id) : 0;
    for (const enemy of this.units.values()) {
      if (enemy.team === u.team || isStructure(enemy) || !this.isTargetable(enemy)) continue;
      const reach = ability.radius + enemy.def.radius;
      const byOwn = dist(u.pos, enemy.pos) <= reach;
      const byShadows = shadows.filter((s) => dist(s.pos, enemy.pos) <= reach).length;
      if (!byOwn && !byShadows) continue;

      if (castId) {
        if (byOwn) this.recordCastHit(castId, enemy.id, false);
        if (byShadows) this.recordCastHit(castId, enemy.id, true);
      }
      this.hit(enemy, u.id, ability.damage, slot);
      if (!this.isAlive(enemy)) continue;
      if (byShadows && ability.shadowSlow) {
        const { amount, enhancedAmount, duration } = ability.shadowSlow;
        const strength = byShadows + (byOwn ? 1 : 0) >= 2 ? enhancedAmount : amount;
        enemy.statuses.push({ kind: 'slow', amount: strength, remaining: duration });
      }
      if (byOwn && ability.cooldownRefund && isChampion(enemy)) {
        const { slot: refundSlot, seconds } = ability.cooldownRefund;
        u.cooldowns[refundSlot] = Math.max(0, u.cooldowns[refundSlot] - seconds);
      }
    }
  }

  private startDeathMarkDash(u: Unit, ability: DeathMarkAbility, targetId: number | null): void {
    const victim = targetId === null ? undefined : this.units.get(targetId);
    if (!victim || !this.isAlive(victim)) {
      // The target died during the wait: the cast fizzles, like LoL.
      u.statuses = u.statuses.filter((s) => s.kind !== 'untargetable');
      this.shadows = this.shadows.filter((s) => !(s.ownerId === u.id && s.slot === 'R'));
      u.cooldowns.R = DEATH_MARK_FIZZLE_COOLDOWN;
      return;
    }
    const away = normalize(sub(victim.pos, u.pos));
    const to = clampToWorld(add(victim.pos, scale(away.x || away.y ? away : fromAngle(u.facing), ability.landBehind)));
    u.facing = angleOf(away);
    u.dash = { from: { ...u.pos }, to, remaining: ability.dashTime, total: ability.dashTime, markTargetId: victim.id };
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
    u.dash = null;
    this.events.push({ type: 'respawn', unitId: u.id });
  }

  private nearestEnemy(u: Unit, point: Vec, maxEdgeDist: number): Unit | null {
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !this.isTargetable(other)) continue;
      const d = dist(point, other.pos) - other.def.radius;
      if (d <= maxEdgeDist && d < bestDist) {
        best = other;
        bestDist = d;
      }
    }
    return best;
  }

  // --- shadows and projectiles ----------------------------------------------

  private stepShadows(dt: number): void {
    this.shadows = this.shadows.filter((s) => {
      s.prev = { ...s.pos };
      if (s.dashTo) {
        const to = sub(s.dashTo, s.pos);
        const d = len(to);
        const stepLen = s.dashSpeed * dt;
        if (d <= stepLen) {
          s.pos = { ...s.dashTo };
          s.dashTo = null;
        } else {
          s.pos = add(s.pos, scale(to, stepLen / d));
        }
      }
      s.remaining -= dt;
      const owner = this.units.get(s.ownerId);
      return s.remaining > 0 && !!owner && this.isAlive(owner);
    });
  }

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
    // Missiles at a target that turns untargetable fizzle, as in LoL.
    if (!target || !this.isTargetable(target)) return false;
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

    const ability = this.units.get(p.ownerId)?.def.abilities[p.slot];
    const championsOnly = ability?.kind === 'skillshot' && !!ability.championsOnly;
    const minionPct = ability?.kind === 'skillshot' ? (ability.minionDamagePct ?? 1) : 1;
    const hits: { unit: Unit; at: number }[] = [];
    for (const u of this.units.values()) {
      if (u.team === p.team || !this.isTargetable(u) || p.hitIds.includes(u.id)) continue;
      // Skillshots fly past turrets; some only collide with champions.
      if (isStructure(u) || (championsOnly && !isChampion(u))) continue;
      const at = segmentCircleHit(p.pos, next, u.pos, u.def.radius + p.width / 2);
      if (at !== null) hits.push({ unit: u, at });
    }
    hits.sort((a, b) => a.at - b.at);

    const ctx: HitContext = { castId: p.castId, fromShadow: p.fromShadow };
    const scaled = (unit: Unit, amount: number) => (isMinion(unit) ? amount * minionPct : amount);
    if (p.stopsAtFirstHit && hits.length) {
      p.pos = lerpVec(p.pos, next, hits[0].at);
      this.hit(hits[0].unit, p.ownerId, scaled(hits[0].unit, p.damage), p.slot, ctx);
      return false;
    }
    for (const { unit } of hits) {
      const amount = p.hitIds.length === 0 ? p.damage : p.subsequentDamage;
      p.hitIds.push(unit.id);
      this.hit(unit, p.ownerId, scaled(unit, amount), p.slot, ctx);
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

  /** Resolves one landed attack or ability: damage, passives, marks, then on-hit effects. */
  private hit(target: Unit, sourceId: number, amount: number, source: HitSource, ctx: HitContext = {}): void {
    if (!this.isTargetable(target)) return;
    if (source !== 'attack' && isStructure(target)) return;
    const attacker = this.units.get(sourceId);
    const ability = attacker && source !== 'attack' ? attacker.def.abilities[source] : undefined;
    const appliesMark = ability?.kind === 'skillshot' ? ability.onHit?.mark : undefined;
    this.calls.push({ attackerId: sourceId, victimId: target.id, time: this.time });

    if (source === 'attack' && attacker && !isStructure(target)) this.applyExecutePassive(attacker, target);
    if (amount > 0) this.damage(target, sourceId, amount, source, false);
    if (ctx.castId) this.recordCastHit(ctx.castId, target.id, !!ctx.fromShadow);

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

  /** Bonus damage on attacks against low-health targets, once per target per cooldown. */
  private applyExecutePassive(attacker: Unit, target: Unit): void {
    const passive = attacker.def.passive;
    if (passive?.kind !== 'executeAttacks') return;
    if (target.hp >= target.def.maxHp * passive.hpThreshold) return;
    if (target.statuses.some((s) => s.kind === 'executeCooldown' && s.sourceId === attacker.id)) return;
    target.statuses.push({ kind: 'executeCooldown', sourceId: attacker.id, remaining: passive.perTargetCooldown });
    this.damage(target, attacker.id, target.def.maxHp * passive.maxHpPct, 'attack', false);
  }

  /** Refunds the shared-hit resource once, when the caster and a shadow hit the same enemy with one cast. */
  private recordCastHit(castId: number, targetId: number, fromShadow: boolean): void {
    const record = this.casts.get(castId);
    if (!record) return;
    (fromShadow ? record.shadow : record.own).add(targetId);
    if (record.refunded || !record.own.has(targetId) || !record.shadow.has(targetId)) return;
    record.refunded = true;
    const owner = this.units.get(record.ownerId);
    const shadowAbility = owner && Object.values(owner.def.abilities).find((a) => a?.kind === 'shadow');
    if (owner && shadowAbility?.kind === 'shadow') {
      owner.mana = Math.min(owner.def.maxMana, owner.mana + shadowAbility.sharedHitRefund);
    }
  }

  private grantPassiveStack(u: Unit): void {
    const passive = u.def.passive;
    if (passive?.kind !== 'abilityHitAttackSpeed' || !this.isAlive(u)) return;
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
    // A death mark repeats a share of everything its owner deals during it (not its own detonation).
    if (!(detonation && source === 'R')) {
      for (const s of target.statuses) if (s.kind === 'deathMark' && s.sourceId === sourceId) s.stored += amount;
    }
    target.hp = Math.max(0, target.hp - amount);
    this.events.push({ type: 'damage', targetId: target.id, sourceId, amount, source, detonation, pos: { ...target.pos } });
    if (target.hp > 0) return;
    const kind = kindOf(target);
    // Champions respawn at their fountain; everything else is removed at the end of the step.
    target.respawnIn = kind === 'champion' ? RESPAWN_SECONDS : Infinity;
    target.order = IDLE;
    target.windup = null;
    target.cast = null;
    target.dash = null;
    target.statuses = [];
    this.shadows = this.shadows.filter((s) => s.ownerId !== target.id);
    const bounty = target.def.bounty ?? (kind === 'champion' ? CHAMPION_BOUNTY : 0);
    this.events.push({ type: 'death', unitId: target.id, killerId: sourceId, kind, pos: { ...target.pos }, bounty });
  }

  // --- collisions -----------------------------------------------------------

  /**
   * Nothing walks through a turret. Minions also keep apart from each other and step
   * around champions, so a wave spreads out instead of stacking. Champions pass through
   * minions here (LoL's unit collision and pathing around minions aren't modeled).
   */
  private resolveCollisions(): void {
    const alive = [...this.units.values()].filter((u) => this.isAlive(u));
    const turrets = alive.filter(isStructure);
    const pushOut = (u: Unit, from: Vec, minDist: number, share: number) => {
      const away = sub(u.pos, from);
      const d = len(away);
      if (d >= minDist) return;
      const dir = d > 1e-6 ? scale(away, 1 / d) : fromAngle(u.id); // any stable direction
      u.pos = clampToWorld(add(u.pos, scale(dir, (minDist - d) * share)));
    };
    for (const u of alive) {
      if (u.def.moveSpeed <= 0 || u.dash) continue;
      for (const t of turrets) pushOut(u, t.pos, u.def.radius + t.def.radius, 1);
    }
    // Only the server moves minions; to the prediction they are scenery.
    if (!this.authoritative) return;
    const minions = alive.filter(isMinion);
    for (let i = 0; i < minions.length; i++) {
      const m = minions[i];
      for (let j = i + 1; j < minions.length; j++) {
        const o = minions[j];
        const minDist = (m.def.radius + o.def.radius) * 0.8;
        const before = { ...m.pos };
        pushOut(m, o.pos, minDist, 0.5);
        pushOut(o, before, minDist, 0.5);
      }
      for (const c of alive) if (isChampion(c)) pushOut(m, c.pos, (m.def.radius + c.def.radius) * 0.8, 0.5);
    }
  }
}
