import {
  ABILITY_SLOTS,
  BASIC_MAX_RANK,
  CHAMPION_BACK_RADIUS,
  CHAMPION_BOUNTY,
  CHAMPION_KILL_XP,
  CHAMPION_XP_RANGE,
  CS_TO_WIN,
  DEFAULT_SUMMONERS,
  BARRIER,
  EXHAUST,
  FLASH,
  HEAL,
  IGNITE,
  SUMMONERS,
  SUMMONER_SLOTS,
  barrierShield,
  healAmount,
  igniteDamage,
  MAX_LEVEL,
  MINION_XP_RANGE,
  ULTIMATE_LEVELS,
  ULTIMATE_MAX_RANK,
  XP_FOR_LEVEL,
  XP_SHARE,
  atRank,
  growthAt,
  FOUNTAIN_RADIUS,
  FOUNTAIN_REGEN,
  RESPAWN_SECONDS,
  TICK_RATE,
  VIEW_BEHIND,
  WORLD_SIZE,
  type AbilityDef,
  type AbilitySlot,
  type AreaAbility,
  type BlinkAbility,
  type ChampionDef,
  type DeathMarkAbility,
  type SkillshotAbility,
  type SummonerId,
  type SummonerSlot,
  type UnitKind,
  type WinReason,
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
  segmentCutCircleHit,
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
  /** `auto`: picked up by auto-attack while idle; it isn't chased out of range. */
  | { kind: 'attack'; targetId: number; auto?: boolean }
  | { kind: 'attackMove'; target: Vec; championsOnly?: boolean }
  /** Walking into range of a unit-targeted ability, to cast it on arrival (LoL's move-to-cast). */
  | { kind: 'castMove'; slot: AbilitySlot; targetId: number }
  /** The same for a unit-targeted summoner spell (Ignite, Exhaust). */
  | { kind: 'summonerMove'; slot: SummonerSlot; targetId: number };

/** Timed effects on a unit. */
export type Status =
  | { kind: 'attackSpeed'; stacks: number; perStack: number; remaining: number }
  | { kind: 'mark'; sourceId: number; remaining: number; damage: number; manaRefund: number }
  | { kind: 'slow'; amount: number; remaining: number }
  | { kind: 'untargetable'; remaining: number }
  | { kind: 'deathMark'; sourceId: number; remaining: number; stored: number; pct: number; baseDamage: number }
  | { kind: 'executeCooldown'; sourceId: number; remaining: number }
  /** Ignite: true damage every second from its caster. */
  | { kind: 'burn'; sourceId: number; perTick: number; ticksLeft: number; nextTick: number; remaining: number }
  /** Less healing and health regeneration, by `amount`. */
  | { kind: 'grievousWounds'; amount: number; remaining: number }
  /** Exhaust: deals `amount` less damage (true damage excepted). */
  | { kind: 'exhausted'; amount: number; remaining: number }
  /** Absorbs damage before health. */
  | { kind: 'shield'; amount: number; remaining: number }
  /** Bonus move speed, as a fraction. */
  | { kind: 'haste'; amount: number; remaining: number };

/** A unit's stats at its current level. */
export interface UnitStats {
  maxHp: number;
  maxMana: number;
  hpRegen: number;
  manaRegen: number;
  attackDamage: number;
  /** Bonus attack speed from levels, as a fraction. */
  bonusAttackSpeed: number;
}

/** LoL's per-level stat growth. Units without growth (minions, turrets) stay at their base stats. */
export function statsAt(def: ChampionDef, level: number): UnitStats {
  const g = def.growth;
  const grow = (base: number, per: number | undefined) => base + (per ? growthAt(per, level) : 0);
  return {
    maxHp: grow(def.maxHp, g?.maxHp),
    maxMana: grow(def.maxMana, g?.maxMana),
    hpRegen: grow(def.hpRegen, g?.hpRegen),
    manaRegen: grow(def.manaRegen, g?.manaRegen),
    attackDamage: grow(def.attackDamage, g?.attackDamage),
    bonusAttackSpeed: g ? growthAt(g.attackSpeed, level) : 0,
  };
}

/**
 * LoL's skill point rules: an ultimate's ranks unlock at levels 6, 11 and 16; a basic
 * ability's next rank unlocks at every odd level (rank 2 at 3, rank 3 at 5, … rank 5 at 9).
 */
export function canRankUp(u: Unit, slot: AbilitySlot): boolean {
  if (u.skillPoints <= 0 || !u.def.abilities[slot]) return false;
  const next = u.ranks[slot] + 1;
  if (slot === 'R') return next <= ULTIMATE_MAX_RANK && u.level >= ULTIMATE_LEVELS[next - 1];
  return next <= BASIC_MAX_RANK && next <= Math.ceil(u.level / 2);
}

export interface Unit {
  id: number;
  team: Team;
  def: ChampionDef;
  level: number;
  /** Total experience earned. */
  xp: number;
  /** Unspent skill points. */
  skillPoints: number;
  /** Rank of each ability; 0 = not learned yet. */
  ranks: Record<AbilitySlot, number>;
  stats: UnitStats;
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
  /** A spell pressed while it couldn't be cast yet, cast as soon as it can be (LoL's "postponed spell"). */
  postponed: { slot: AbilitySlot; target: Vec; remaining: number } | null;
  /** LoL's "Auto Attack" setting: when idle, attack enemies that come into range. */
  autoAttack: boolean;
  /** Set by Stop: auto-attack waits until the next order, like LoL. */
  holdPosition: boolean;
  /** Summoner spells on D and F, and their cooldowns. */
  summoners: Record<SummonerSlot, SummonerId>;
  summonerCooldowns: Record<SummonerSlot, number>;
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
  /**
   * `onCursor`: look for a target around the cursor first (LoL's "Attack Move on Cursor"),
   * then around the champion. `championsOnly`: LoL's "target champions only" key.
   */
  | { type: 'attackMove'; target: Vec; onCursor?: boolean; championsOnly?: boolean }
  | { type: 'cast'; slot: AbilitySlot; target: Vec }
  | { type: 'levelUp'; slot: AbilitySlot }
  | { type: 'summoner'; slot: SummonerSlot; target: Vec }
  | { type: 'autoAttack'; enabled: boolean }
  | { type: 'stop' };

export type Command = PlayerCommand & { unitId: number };

/** What a missile or strike carries: an auto-attack or one of the attacker's ability slots. */
export type HitBy = 'attack' | AbilitySlot;
/** What dealt damage: a hit, or Ignite's burn (true damage). */
export type HitSource = HitBy | 'ignite';

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
  source: HitBy;
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
  | { type: 'levelUp'; unitId: number; level: number }
  | { type: 'xp'; unitId: number; amount: number }
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
  | { type: 'skillshotExpired'; pos: Vec; team: Team }
  | { type: 'gameOver'; winner: Team; reason: WinReason }
  /** A summoner spell went off; `amount` is the health restored or shield given, if any. */
  | { type: 'summoner'; unitId: number; spell: SummonerId; targetId: number | null; amount: number };

export interface MatchResult {
  winner: Team;
  reason: WinReason;
}

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

/** With "attack move on cursor", an A-click this close to an enemy's edge targets that enemy. */
const ATTACK_MOVE_SNAP = 200;
/**
 * How long a spell pressed too early stays queued: during another cast or dash, or in the
 * last moments of its cooldown. Riot says only "a set duration"; this is an estimate.
 */
export const SPELL_BUFFER_SECONDS = 0.4;

/** LoL applies health and mana (and energy) regeneration in 0.5-second ticks (LoL wiki). */
export const REGEN_TICK_SECONDS = 0.5;
/** A unit-targeted cast picks the enemy nearest the cursor within this distance of it. */
const TARGET_PICK_RADIUS = 250;
/** Cooldown left on a death mark whose target died before the dash. */
const DEATH_MARK_FIZZLE_COOLDOWN = 0.5;
const WORLD_MARGIN = 40;
const CAST_TRACKING_SECONDS = 5;
/**
 * How long a hit counts as a call for help (see lane.ts). LoL minions keep a champion that
 * hit their ally targeted "for a short time afterwards"; the wiki gives no number.
 */
export const CALL_SECONDS = 2;

const IDLE: Order = { kind: 'idle' };

const noCooldowns = (): Record<AbilitySlot, number> => ({ Q: 0, W: 0, E: 0, R: 0 });

/** How a new unit starts: at a level with skill points to spend (a real match), or with everything at rank 1 (a sandbox). */
export interface Progression {
  level: number;
  summoners?: Record<SummonerSlot, SummonerId>;
}

function clampToWorld(p: Vec): Vec {
  return {
    x: clamp(p.x, WORLD_MARGIN, WORLD_SIZE.width - WORLD_MARGIN),
    y: clamp(p.y, WORLD_MARGIN, WORLD_SIZE.height - WORLD_MARGIN),
  };
}

/** Attacks per second including bonus attack speed from levels and statuses. */
export function attackSpeedOf(u: Unit): number {
  let bonus = u.stats.bonusAttackSpeed;
  for (const s of u.statuses) if (s.kind === 'attackSpeed') bonus += s.stacks * s.perStack;
  return u.def.attackSpeed * (1 + bonus);
}

/** Move speed with bonus speed (Heal), then the strongest slow (slows don't stack in LoL). */
export function moveSpeedOf(u: Unit): number {
  let slow = 0;
  let bonus = 0;
  for (const s of u.statuses) {
    if (s.kind === 'slow') slow = Math.max(slow, s.amount);
    if (s.kind === 'haste') bonus += s.amount;
  }
  return u.def.moveSpeed * (1 + bonus) * (1 - slow);
}

/** How much of any healing or health regeneration lands (Grievous Wounds cuts it). */
export function healingFactor(u: Unit): number {
  let cut = 0;
  for (const s of u.statuses) if (s.kind === 'grievousWounds') cut = Math.max(cut, s.amount);
  return 1 - cut;
}

/** Shield left on a unit (Barrier). */
export function shieldOf(u: Unit): number {
  let total = 0;
  for (const s of u.statuses) if (s.kind === 'shield') total += s.amount;
  return total;
}

const noSummonerCooldowns = (): Record<SummonerSlot, number> => ({ D: 0, F: 0 });

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
  /**
   * Whether minions answer it. In LoL that takes a basic attack or a unit-targeted ability;
   * skillshots don't draw minions. Turrets answer any damage to an allied champion.
   */
  drawsMinions: boolean;
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
  /** The lane match's win conditions (first blood, first turret, CS_TO_WIN); Lane turns them on. */
  winConditions = false;
  /** Set when a win condition is met; the world stops there. */
  result: MatchResult | null = null;
  /** Minions last-hit by each champion. */
  readonly cs = new Map<number, number>();
  /** Time since the last regeneration tick, and whether this step is one. */
  private regenClock = 0;
  private regenTick = false;
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
  /** Turret id → how heated its shots at champions are, and when it last shot one. */
  private readonly heat = new Map<number, { stacks: number; lastShot: number }>();

  constructor(options: WorldOptions = {}) {
    this.authoritative = options.authoritative ?? true;
  }

  /**
   * Adds a unit. With `progression` a champion starts at that level with all its skill
   * points unspent, as in a real match. Without it every ability starts at rank 1 at
   * level 1, which suits tests and sandboxes.
   */
  addUnit(def: ChampionDef, team: Team, spawn: Vec, progression?: Progression): Unit {
    const level = def.growth ? Math.min(MAX_LEVEL, progression?.level ?? 1) : 1;
    const stats = statsAt(def, level);
    const ranks = noCooldowns();
    if (!progression) for (const slot of ABILITY_SLOTS) if (def.abilities[slot]) ranks[slot] = 1;
    const unit: Unit = {
      id: this.nextId++,
      team,
      def,
      level,
      xp: XP_FOR_LEVEL[level - 1],
      skillPoints: progression && def.growth ? level : 0,
      ranks,
      stats,
      spawn: { ...spawn },
      pos: { ...spawn },
      facing: team === 'blue' ? 0 : Math.PI,
      hp: stats.maxHp,
      mana: stats.maxMana,
      order: IDLE,
      attackCooldown: 0,
      windup: null,
      cast: null,
      dash: null,
      cooldowns: noCooldowns(),
      statuses: [],
      respawnIn: 0,
      postponed: null,
      autoAttack: false,
      holdPosition: false,
      summoners: { ...(progression?.summoners ?? DEFAULT_SUMMONERS) },
      summonerCooldowns: noSummonerCooldowns(),
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
    if (!u) return;
    // Skill points and settings can be changed while dead, as in LoL.
    if (cmd.type === 'levelUp') {
      if (canRankUp(u, cmd.slot)) {
        u.ranks[cmd.slot]++;
        u.skillPoints--;
      }
      return;
    }
    if (cmd.type === 'autoAttack') {
      u.autoAttack = cmd.enabled;
      return;
    }
    if (!this.isAlive(u)) return;
    // Summoner spells aren't orders: they keep what you were doing.
    if (cmd.type === 'summoner') {
      this.castSummoner(u, cmd.slot, cmd.target);
      return;
    }
    if (cmd.type !== 'cast') {
      // A new order clears a queued spell, and only Stop holds back auto-attacks.
      u.postponed = null;
      u.holdPosition = cmd.type === 'stop';
    }
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
        // LoL scans for the enemy nearest the champion (or first near the cursor, with that option on).
        const only = cmd.championsOnly ? isChampion : undefined;
        const target =
          (cmd.onCursor ? this.nearestEnemy(u, cmd.target, ATTACK_MOVE_SNAP, only) : null) ??
          this.nearestEnemy(u, u.pos, u.def.attackRange + u.def.radius, only);
        this.setOrder(
          u,
          target
            ? { kind: 'attack', targetId: target.id }
            : { kind: 'attackMove', target: clampToWorld(cmd.target), championsOnly: cmd.championsOnly },
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
    if (this.result) return; // the match is over: everything stays where it ended
    this.time += dt;
    // One clock for everyone, like LoL's regen ticks.
    this.regenClock += dt;
    this.regenTick = this.regenClock >= REGEN_TICK_SECONDS - 1e-9;
    if (this.regenTick) this.regenClock -= REGEN_TICK_SECONDS;
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

  /**
   * Casts if it can. Pressed during another cast or dash, or in the last moments of its
   * cooldown, the spell is postponed and goes off as soon as it can (a newer press replaces
   * it, and other orders clear it). Returns whether it cast, or started walking to cast.
   */
  private cast(u: Unit, slot: AbilitySlot, target: Vec, fromBuffer = false): boolean {
    const ability = u.def.abilities[slot];
    const rank = u.ranks[slot];
    if (!ability || rank <= 0) return false;
    const busy = !!u.cast || !!u.dash;
    const almostReady = u.cooldowns[slot] > 0 && u.cooldowns[slot] <= SPELL_BUFFER_SECONDS && !this.hasRecast(u, slot, ability);
    if (busy || almostReady) {
      if (!fromBuffer) u.postponed = { slot, target: { ...target }, remaining: SPELL_BUFFER_SECONDS };
      return false;
    }
    if (!fromBuffer) u.postponed = null;
    if (this.trySwapRecast(u, slot, ability)) return true;
    const cost = atRank(ability.manaCost, rank);
    if (u.cooldowns[slot] > 0 || u.mana < cost) return false;

    let targetId: number | null = null;
    if (ability.kind === 'deathMark') {
      const victim = this.pickDeathMarkTarget(u, ability, target);
      if (!victim) {
        // An enemy champion near the cursor but out of range: walk up to it, then cast.
        const outOfRange = this.pickDeathMarkTarget(u, ability, target, Infinity);
        if (!outOfRange) return false;
        this.setOrder(u, { kind: 'castMove', slot, targetId: outOfRange.id });
        return true;
      }
      targetId = victim.id;
    }

    this.cancelWindup(u);
    let dir = normalize(sub(target, u.pos));
    if (dir.x === 0 && dir.y === 0) dir = fromAngle(u.facing);
    u.mana -= cost;
    u.cooldowns[slot] = atRank(ability.cooldown, rank);
    u.facing = angleOf(dir);
    u.cast = { slot, remaining: ability.castTime, total: ability.castTime, dir, target: { ...target }, targetId };
    this.events.push({ type: 'castStart', unitId: u.id, slot });

    if (ability.kind === 'deathMark') {
      u.statuses.push({ kind: 'untargetable', remaining: ability.castTime + ability.dashTime });
      this.spawnShadow(u, slot, u.pos, null, 0, ability.shadowDuration);
    }
    // Abilities without a cast time happen at once and never root.
    if (ability.castTime <= 0) this.finishCast(u);
    return true;
  }

  /** Whether casting this slot now would be a swap recast (those aren't blocked by cooldown). */
  private hasRecast(u: Unit, slot: AbilitySlot, ability: AbilityDef): boolean {
    if (ability.kind !== 'shadow' && ability.kind !== 'deathMark') return false;
    return this.shadows.some((s) => s.ownerId === u.id && s.slot === slot && !s.swapped);
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

  private pickDeathMarkTarget(u: Unit, ability: DeathMarkAbility, point: Vec, range = ability.range): Unit | null {
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !isChampion(other) || !this.isTargetable(other)) continue;
      if (dist(u.pos, other.pos) > range + other.def.radius) continue;
      const d = dist(point, other.pos);
      if (d <= TARGET_PICK_RADIUS + other.def.radius && d < bestDist) {
        best = other;
        bestDist = d;
      }
    }
    return best;
  }

  // --- summoner spells ----------------------------------------------------

  /**
   * Summoner spells go off at once and aren't orders: they work mid-cast and mid-attack
   * (LoL lets you Flash during a cast time), but not mid-dash. Ignite and Exhaust need an
   * enemy champion near the cursor; out of range, the champion walks up to it first.
   * Returns whether it cast, or started walking to cast.
   */
  private castSummoner(u: Unit, slot: SummonerSlot, target: Vec): boolean {
    const id = u.summoners[slot];
    if (!isChampion(u) || u.summonerCooldowns[slot] > 0 || u.dash) return false;
    let targetId: number | null = null;
    let amount = 0;
    switch (id) {
      case 'flash': {
        const from = { ...u.pos };
        const to = sub(target, u.pos);
        const d = len(to);
        if (d > 1e-6) {
          u.pos = clampToWorld(add(u.pos, scale(to, Math.min(d, FLASH.range) / d)));
          u.facing = angleOf(to);
        }
        this.events.push({ type: 'blink', unitId: u.id, from, to: { ...u.pos } });
        break;
      }
      case 'ignite':
      case 'exhaust': {
        const range = SUMMONERS[id].range;
        const victim = this.pickSummonerTarget(u, target, range);
        if (!victim) {
          const far = this.pickSummonerTarget(u, target, Infinity);
          if (!far) return false;
          u.postponed = null;
          u.holdPosition = false;
          this.setOrder(u, { kind: 'summonerMove', slot, targetId: far.id });
          return true;
        }
        targetId = victim.id;
        if (!this.authoritative) break;
        if (id === 'ignite') {
          const total = igniteDamage(u.level);
          victim.statuses = victim.statuses.filter((st) => !(st.kind === 'burn' && st.sourceId === u.id));
          victim.statuses.push({
            kind: 'burn',
            sourceId: u.id,
            perTick: total / IGNITE.ticks,
            ticksLeft: IGNITE.ticks,
            nextTick: IGNITE.duration / IGNITE.ticks,
            remaining: IGNITE.duration,
          });
          victim.statuses.push({ kind: 'grievousWounds', amount: IGNITE.grievousWounds, remaining: IGNITE.duration });
          amount = total;
        } else {
          victim.statuses.push({ kind: 'slow', amount: EXHAUST.slow, remaining: EXHAUST.duration });
          victim.statuses.push({ kind: 'exhausted', amount: EXHAUST.damageReduction, remaining: EXHAUST.duration });
        }
        break;
      }
      case 'heal': {
        if (!this.authoritative) break;
        const before = u.hp;
        u.hp = Math.min(u.stats.maxHp, u.hp + healAmount(u.level) * healingFactor(u));
        amount = u.hp - before;
        u.statuses = u.statuses.filter((st) => st.kind !== 'haste');
        u.statuses.push({ kind: 'haste', amount: HEAL.moveSpeed, remaining: HEAL.moveSpeedDuration });
        break;
      }
      case 'barrier': {
        if (!this.authoritative) break;
        amount = barrierShield(u.level);
        u.statuses.push({ kind: 'shield', amount, remaining: BARRIER.duration });
        break;
      }
    }
    u.summonerCooldowns[slot] = SUMMONERS[id].cooldown;
    this.events.push({ type: 'summoner', unitId: u.id, spell: id, targetId, amount });
    return true;
  }

  /** The enemy champion nearest the cursor (within the usual pick radius) and within `range`, center to center. */
  private pickSummonerTarget(u: Unit, point: Vec, range: number): Unit | null {
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !isChampion(other) || !this.isTargetable(other)) continue;
      if (dist(u.pos, other.pos) > range) continue;
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
    const { maxHp, maxMana, hpRegen, manaRegen } = u.stats;
    // Base regeneration lands every half second; the fountain heals smoothly on top.
    const regen = this.regenTick ? REGEN_TICK_SECONDS : 0;
    u.hp = Math.min(maxHp, u.hp + (hpRegen * regen + healing * maxHp * dt) * healingFactor(u));
    u.mana = Math.min(maxMana, u.mana + manaRegen * regen + healing * maxMana * dt);
    for (const slot of ABILITY_SLOTS) u.cooldowns[slot] = Math.max(0, u.cooldowns[slot] - dt);
    for (const slot of SUMMONER_SLOTS) u.summonerCooldowns[slot] = Math.max(0, u.summonerCooldowns[slot] - dt);
    u.attackCooldown = Math.max(0, u.attackCooldown - dt);
    if (u.postponed && (u.postponed.remaining -= dt) < 0) u.postponed = null;
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

    // A postponed spell goes off as soon as nothing blocks it, until it expires.
    if (u.postponed) {
      const { slot, target } = u.postponed;
      if (this.cast(u, slot, target, true)) u.postponed = null;
      if (u.cast || u.dash) return;
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
        // LoL's auto-attack: an idle champion attacks the nearest enemy that comes into range.
        if (u.autoAttack && !u.holdPosition) {
          const target = this.nearestEnemy(u, u.pos, u.def.attackRange + u.def.radius);
          if (target) u.order = { kind: 'attack', targetId: target.id, auto: true };
        }
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
        } else if (u.order.auto) {
          u.order = IDLE; // auto-attack doesn't chase
        } else {
          this.moveToward(u, target.pos, dt);
        }
        break;
      }
      case 'attackMove': {
        const target = this.nearestEnemy(u, u.pos, u.def.attackRange + u.def.radius, u.order.championsOnly ? isChampion : undefined);
        if (target) u.order = { kind: 'attack', targetId: target.id };
        else if (this.moveToward(u, u.order.target, dt)) u.order = IDLE;
        break;
      }
      case 'castMove': {
        const { slot, targetId } = u.order;
        const target = this.units.get(targetId);
        const ability = u.def.abilities[slot];
        if (!target || !this.isTargetable(target) || ability?.kind !== 'deathMark') {
          u.order = IDLE;
        } else if (dist(u.pos, target.pos) <= ability.range + target.def.radius) {
          u.order = IDLE;
          this.cast(u, slot, target.pos);
        } else {
          this.moveToward(u, target.pos, dt);
        }
        break;
      }
      case 'summonerMove': {
        const { slot, targetId } = u.order;
        const target = this.units.get(targetId);
        const spell = SUMMONERS[u.summoners[slot]];
        if (!target || !this.isTargetable(target) || !('range' in spell) || u.summonerCooldowns[slot] > 0) {
          u.order = IDLE;
        } else if (dist(u.pos, target.pos) <= spell.range) {
          u.order = IDLE;
          this.castSummoner(u, slot, target.pos);
        } else {
          this.moveToward(u, target.pos, dt);
        }
        break;
      }
    }
  }

  private tickStatuses(u: Unit, dt: number): void {
    // Ignite's burn ticks once a second; its caster gets the kill.
    for (const s of u.statuses) {
      if (s.kind !== 'burn') continue;
      s.nextTick -= dt;
      if (s.nextTick > 1e-9 || s.ticksLeft <= 0) continue;
      s.nextTick += IGNITE.duration / IGNITE.ticks;
      s.ticksLeft--;
      if (s.ticksLeft <= 0) s.remaining = 0;
      if (this.authoritative) this.damage(u, s.sourceId, s.perTick, 'ignite', false);
      if (!this.isAlive(u)) return;
    }
    for (const s of u.statuses) if (s.kind !== 'burn') s.remaining -= dt;
    const expired = u.statuses.filter((s) => s.remaining <= 0);
    u.statuses = u.statuses.filter((s) => s.remaining > 0);
    for (const s of expired) {
      if (s.kind === 'deathMark' && this.authoritative) {
        this.damage(u, s.sourceId, s.baseDamage + s.pct * s.stored, 'R', true);
        if (!this.isAlive(u)) return;
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
      pct: atRank(ability.storedPct, u.ranks.R),
      baseDamage: ability.adRatio * u.stats.attackDamage,
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

  /** Damage of one basic attack against this target, with LoL's turret and minion rules. */
  private attackDamage(u: Unit, target: Unit): number {
    const turret = u.def.turret;
    if (turret) {
      // Shots at minions take a fixed share of their max health.
      if (!isChampion(target)) return target.def.turretDamagePct ? target.stats.maxHp * target.def.turretDamagePct : u.stats.attackDamage;
      // Each shot at a champion heats the turret up (+50%, up to +150%) until it stops shooting champions for a while.
      const heat = this.heat.get(u.id);
      const stacks = heat && this.time - heat.lastShot <= turret.heatResetSeconds ? heat.stacks : 0;
      this.heat.set(u.id, { stacks: Math.min(turret.maxHeatStacks, stacks + 1), lastShot: this.time });
      return u.stats.attackDamage * (1 + turret.heatPerShot * stacks);
    }
    const minion = u.def.minion;
    if (minion) {
      if (isChampion(target)) return u.stats.attackDamage * minion.vsChampions;
      if (isStructure(target)) return u.stats.attackDamage * minion.vsStructures;
      if (isMinion(target)) return u.stats.attackDamage + target.hp * minion.vsMinionsCurrentHp;
    }
    const meleeVsTurret = isStructure(target) && u.def.attackProjectileSpeed <= 0 ? (target.def.turret?.meleeChampionDamageTaken ?? 1) : 1;
    return u.stats.attackDamage * meleeVsTurret;
  }

  private fireHoming(u: Unit, target: Unit, source: HitBy, speed: number, damage: number): void {
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
      damage: atRank(ability.damage, u.ranks[slot]) + (ability.adRatio ?? 0) * u.stats.attackDamage,
      slot,
      dir,
      width: ability.width,
      range: ability.range,
      travelled: 0,
      stopsAtFirstHit: ability.stopsAtFirstHit,
      subsequentDamage: ability.subsequentDamage === undefined ? atRank(ability.damage, u.ranks[slot]) : atRank(ability.subsequentDamage, u.ranks[slot]),
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
    if (best) this.fireHoming(u, best, slot, ability.bolt.speed, atRank(ability.bolt.damage, u.ranks[slot]));
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
      this.hit(enemy, u.id, atRank(ability.damage, u.ranks[slot]), slot);
      if (!this.isAlive(enemy)) continue;
      if (byShadows && ability.shadowSlow) {
        const { amount, enhancedAmount, duration } = ability.shadowSlow;
        const strength = atRank(byShadows + (byOwn ? 1 : 0) >= 2 ? enhancedAmount : amount, u.ranks[slot]);
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
    u.hp = u.stats.maxHp;
    u.mana = u.stats.maxMana;
    u.order = IDLE;
    u.attackCooldown = 0;
    u.cooldowns = noCooldowns();
    u.statuses = [];
    u.dash = null;
    u.postponed = null;
    u.holdPosition = false;
    this.events.push({ type: 'respawn', unitId: u.id });
  }

  private nearestEnemy(u: Unit, point: Vec, maxEdgeDist: number, only?: (other: Unit) => boolean): Unit | null {
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const other of this.units.values()) {
      if (other.team === u.team || !this.isTargetable(other) || (only && !only(other))) continue;
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

    const owner = this.units.get(p.ownerId);
    const ability = owner?.def.abilities[p.slot];
    const championsOnly = ability?.kind === 'skillshot' && !!ability.championsOnly;
    const minionDamage =
      ability?.kind === 'skillshot' && ability.minionDamage !== undefined ? atRank(ability.minionDamage, owner!.ranks[p.slot]) : undefined;
    const hits: { unit: Unit; at: number }[] = [];
    for (const u of this.units.values()) {
      if (u.team === p.team || !this.isTargetable(u) || p.hitIds.includes(u.id)) continue;
      // Skillshots fly past turrets; some only collide with champions.
      if (isStructure(u) || (championsOnly && !isChampion(u))) continue;
      // Champions stand tall on screen: a missile that passes far enough behind one is drawn
      // over its head, and flies past (see CHAMPION_BACK_RADIUS).
      const reach = u.def.radius + p.width / 2;
      const at = isChampion(u)
        ? segmentCutCircleHit(p.pos, next, u.pos, reach, VIEW_BEHIND, CHAMPION_BACK_RADIUS + p.width / 2)
        : segmentCircleHit(p.pos, next, u.pos, reach);
      if (at !== null) hits.push({ unit: u, at });
    }
    hits.sort((a, b) => a.at - b.at);

    const ctx: HitContext = { castId: p.castId, fromShadow: p.fromShadow };
    const scaled = (unit: Unit, amount: number) => (isMinion(unit) && minionDamage !== undefined ? minionDamage : amount);
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
  private hit(target: Unit, sourceId: number, amount: number, source: HitBy, ctx: HitContext = {}): void {
    if (!this.isTargetable(target)) return;
    if (source !== 'attack' && isStructure(target)) return;
    const attacker = this.units.get(sourceId);
    const ability = attacker && source !== 'attack' ? attacker.def.abilities[source] : undefined;
    const appliesMark = ability?.kind === 'skillshot' ? ability.onHit?.mark : undefined;
    const drawsMinions = source === 'attack' || ability?.kind === 'deathMark';
    this.calls.push({ attackerId: sourceId, victimId: target.id, time: this.time, drawsMinions });

    if (source === 'attack' && attacker && !isStructure(target)) this.applyExecutePassive(attacker, target);
    if (amount > 0) this.damage(target, sourceId, amount, source, false);
    if (ctx.castId) this.recordCastHit(ctx.castId, target.id, !!ctx.fromShadow);

    // The attacker's own mark detonates on their next attack or ability, except the one that applies marks.
    const markIndex = target.statuses.findIndex((s) => s.kind === 'mark' && s.sourceId === sourceId);
    if (markIndex >= 0 && !appliesMark && this.isAlive(target)) {
      const mark = target.statuses[markIndex] as Extract<Status, { kind: 'mark' }>;
      target.statuses.splice(markIndex, 1);
      this.damage(target, sourceId, mark.damage, source, true);
      if (attacker && ability && source !== 'attack') {
        const refund = mark.manaRefund + atRank(ability.manaCost, attacker.ranks[source]);
        attacker.mana = Math.min(attacker.stats.maxMana, attacker.mana + refund);
      }
    }

    if (!attacker || !ability) return;
    const onHit = ability.kind === 'skillshot' ? ability.onHit : undefined;
    if (onHit?.reduceCooldowns) {
      for (const slot of ABILITY_SLOTS) attacker.cooldowns[slot] = Math.max(0, attacker.cooldowns[slot] - onHit.reduceCooldowns);
    }
    if (appliesMark && this.isAlive(target)) {
      target.statuses = target.statuses.filter((s) => !(s.kind === 'mark' && s.sourceId === sourceId));
      const rank = source === 'attack' ? 1 : attacker.ranks[source];
      target.statuses.push({
        kind: 'mark',
        sourceId,
        remaining: appliesMark.duration,
        damage: atRank(appliesMark.detonateDamage, rank),
        manaRefund: appliesMark.abilityManaRefund,
      });
      this.events.push({ type: 'marked', unitId: target.id, sourceId });
    }
    this.grantPassiveStack(attacker);
  }

  /** Bonus damage on attacks against low-health targets, once per target per cooldown. */
  private applyExecutePassive(attacker: Unit, target: Unit): void {
    const passive = attacker.def.passive;
    if (passive?.kind !== 'executeAttacks') return;
    if (target.hp >= target.stats.maxHp * passive.hpThreshold) return;
    if (target.statuses.some((s) => s.kind === 'executeCooldown' && s.sourceId === attacker.id)) return;
    target.statuses.push({ kind: 'executeCooldown', sourceId: attacker.id, remaining: passive.perTargetCooldown });
    let pct = 0;
    for (const [from, value] of passive.maxHpPctByLevel) if (attacker.level >= from) pct = value;
    this.damage(target, attacker.id, target.stats.maxHp * pct, 'attack', false);
  }

  /** Refunds the shared-hit resource once, when the caster and a shadow hit the same enemy with one cast. */
  private recordCastHit(castId: number, targetId: number, fromShadow: boolean): void {
    const record = this.casts.get(castId);
    if (!record) return;
    (fromShadow ? record.shadow : record.own).add(targetId);
    if (record.refunded || !record.own.has(targetId) || !record.shadow.has(targetId)) return;
    record.refunded = true;
    const owner = this.units.get(record.ownerId);
    if (!owner) return;
    for (const slot of ABILITY_SLOTS) {
      const shadowAbility = owner.def.abilities[slot];
      if (shadowAbility?.kind !== 'shadow') continue;
      owner.mana = Math.min(owner.stats.maxMana, owner.mana + atRank(shadowAbility.sharedHitRefund, owner.ranks[slot]));
      return;
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
    // Exhaust: an exhausted unit deals less damage, except true damage (Ignite).
    const dealer = this.units.get(sourceId);
    if (dealer && source !== 'ignite') {
      for (const s of dealer.statuses) if (s.kind === 'exhausted') amount *= 1 - s.amount;
    }
    // A death mark repeats a share of everything its owner deals during it (not its own detonation).
    if (!(detonation && source === 'R')) {
      for (const s of target.statuses) if (s.kind === 'deathMark' && s.sourceId === sourceId) s.stored += amount;
    }
    // Shields (Barrier) soak it up first.
    let left = amount;
    for (const s of target.statuses) {
      if (s.kind !== 'shield' || left <= 0) continue;
      const soaked = Math.min(s.amount, left);
      s.amount -= soaked;
      left -= soaked;
      if (s.amount <= 0) s.remaining = 0;
    }
    target.statuses = target.statuses.filter((s) => s.kind !== 'shield' || s.amount > 0);
    target.hp = Math.max(0, target.hp - left);
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
    if (this.authoritative) this.awardXp(target, sourceId);
    if (this.authoritative && this.winConditions) this.checkWin(target, kind, sourceId);
  }

  /** The first win condition met ends the match. */
  private checkWin(victim: Unit, kind: UnitKind, killerId: number): void {
    if (this.result) return;
    const other: Team = victim.team === 'blue' ? 'red' : 'blue';
    let result: MatchResult | null = null;
    if (kind === 'champion') result = { winner: other, reason: 'firstBlood' };
    else if (kind === 'turret') result = { winner: other, reason: 'firstTurret' };
    else if (kind === 'minion') {
      const killer = this.units.get(killerId);
      if (killer && isChampion(killer)) {
        const cs = (this.cs.get(killer.id) ?? 0) + 1;
        this.cs.set(killer.id, cs);
        if (cs >= CS_TO_WIN) result = { winner: killer.team, reason: 'cs' };
      }
    }
    if (result) this.end(result);
  }

  /** A champion's team gives up the match (its player left); the other team wins. */
  concede(loser: Team): void {
    if (this.result || !this.winConditions) return;
    this.end({ winner: loser === 'blue' ? 'red' : 'blue', reason: 'forfeit' });
  }

  private end(result: MatchResult): void {
    this.result = result;
    this.events.push({ type: 'gameOver', ...result });
  }

  // --- experience and levels ---------------------------------------------------

  /**
   * LoL's experience on death: a minion's goes to enemy champions within 1500, split by how
   * many share it; a champion's (by its level) to enemy champions within 1600 and always to
   * the killer, adjusted by level difference. Turrets give none.
   */
  private awardXp(victim: Unit, killerId: number): void {
    const enemies = [...this.units.values()].filter((u) => isChampion(u) && u.team !== victim.team);
    if (isMinion(victim) && victim.def.xp) {
      const near = enemies.filter((u) => this.isAlive(u) && dist(u.pos, victim.pos) <= MINION_XP_RANGE);
      const share = XP_SHARE[Math.min(near.length, XP_SHARE.length) - 1];
      for (const u of near) this.gainXp(u, victim.def.xp * share);
      return;
    }
    if (!isChampion(victim)) return;
    const base = CHAMPION_KILL_XP[victim.level - 1];
    const near = enemies.filter((u) => u.id === killerId || (this.isAlive(u) && dist(u.pos, victim.pos) <= CHAMPION_XP_RANGE));
    const share = near.length ? XP_SHARE[Math.min(near.length, XP_SHARE.length) - 1] : 0;
    for (const u of near) {
      // 20% less (or more) per level of difference beyond the first, never below 40%.
      const diff = u.level - victim.level;
      const factor = diff > 1 ? Math.max(0.4, 1 - 0.2 * (diff - 1)) : diff < -1 ? 1 + 0.2 * (-diff - 1) : 1;
      this.gainXp(u, base * share * factor);
    }
  }

  /** Adds experience, levelling up as thresholds are crossed. */
  gainXp(u: Unit, amount: number): void {
    if (!u.def.growth || u.level >= MAX_LEVEL || amount <= 0) return;
    u.xp = Math.min(XP_FOR_LEVEL[MAX_LEVEL - 1], u.xp + amount);
    this.events.push({ type: 'xp', unitId: u.id, amount });
    while (u.level < MAX_LEVEL && u.xp >= XP_FOR_LEVEL[u.level]) {
      const before = u.stats;
      u.level++;
      u.skillPoints++;
      u.stats = statsAt(u.def, u.level);
      // Like LoL, the health and mana a level adds are added to the current amounts too.
      if (this.isAlive(u)) {
        u.hp += u.stats.maxHp - before.maxHp;
        u.mana += u.stats.maxMana - before.maxMana;
      }
      this.events.push({ type: 'levelUp', unitId: u.id, level: u.level });
    }
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
