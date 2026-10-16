/** Simulation rate. The authoritative server ticks at this rate too. */
export const TICK_RATE = 30;
/** The map is one mid lane running left (blue base) to right (red base), walled in top and bottom. */
export const WORLD_SIZE = { width: 8000, height: 1500 };
export const LANE_Y = WORLD_SIZE.height / 2;
export const RESPAWN_SECONDS = 3;
/** Gold for killing a champion (LoL's base kill gold). */
export const CHAMPION_BOUNTY = 300;

type Sides<T> = { blue: T; red: T };

/** Where each side's champion spawns, respawns and heals. */
export const FOUNTAINS: Sides<{ x: number; y: number }> = {
  blue: { x: 400, y: LANE_Y },
  red: { x: WORLD_SIZE.width - 400, y: LANE_Y },
};
/** Standing this close to your own fountain heals, like LoL's fountain. */
export const FOUNTAIN_RADIUS = 550;
/** Fraction of max health and mana restored per second in the fountain. */
export const FOUNTAIN_REGEN = 0.1;
/** Where minion waves appear, just outside each base. */
export const MINION_SPAWNS: Sides<{ x: number; y: number }> = {
  blue: { x: 800, y: LANE_Y },
  red: { x: WORLD_SIZE.width - 800, y: LANE_Y },
};
export const TURRET_POSITIONS: Sides<{ x: number; y: number }> = {
  blue: { x: 1700, y: LANE_Y },
  red: { x: WORLD_SIZE.width - 1700, y: LANE_Y },
};

/**
 * Wave timing, from LoL: a wave every 30 s, with a siege minion in every 3rd wave until
 * 15:00, every 2nd until 25:00, then every wave. LoL's first wave spawns at 1:05; here it
 * comes sooner so a practice game gets going.
 */
export const WAVES = {
  firstAt: 10,
  interval: 30,
  meleePerWave: 3,
  casterPerWave: 3,
  /** [game time from which it applies, a siege minion every Nth wave] */
  siegeEvery: [
    [0, 3],
    [15 * 60, 2],
    [25 * 60, 1],
  ] as [number, number][],
};

export const ABILITY_SLOTS = ['Q', 'W', 'E', 'R'] as const;
export type AbilitySlot = (typeof ABILITY_SLOTS)[number];

/** A mark left on a unit; the caster's next attack or ability on it detonates it. */
export interface MarkEffect {
  duration: number;
  detonateDamage: number;
  /** Mana restored when an ability (not an attack) detonates it, on top of that ability's cost. */
  abilityManaRefund: number;
}

/** Extra effects when an ability hits an enemy. */
export interface OnAbilityHit {
  /** Seconds taken off all of the caster's ability cooldowns. */
  reduceCooldowns?: number;
  /** Marks the target instead of detonating an existing mark. */
  mark?: MarkEffect;
}

interface AbilityBase {
  name: string;
  cooldown: number;
  manaCost: number;
  /** Seconds the caster is rooted before the ability takes effect. */
  castTime: number;
}

export interface SkillshotAbility extends AbilityBase {
  kind: 'skillshot';
  /** Passes through minions and only collides with champions. */
  championsOnly?: boolean;
  /** Damage multiplier against minions (LoL's global ults deal reduced damage to them). */
  minionDamagePct?: number;
  range: number;
  speed: number;
  /** Missile width; a hit lands when it passes within width/2 of a unit's edge. */
  width: number;
  damage: number;
  /** True: stops on the first enemy. False: passes through, hitting each enemy once. */
  stopsAtFirstHit: boolean;
  /** Damage to each enemy after the first, for piercing missiles (default: same as `damage`). */
  subsequentDamage?: number;
  onHit?: OnAbilityHit;
}

export interface BlinkAbility extends AbilityBase {
  kind: 'blink';
  /** Maximum teleport distance; aiming further blinks this far in that direction. */
  range: number;
  /** Homing bolt fired on landing at the nearest enemy in range, preferring ones you marked. */
  bolt?: { range: number; speed: number; damage: number };
}

/**
 * Sends out a shadow that dashes to the target point and copies the caster's mimicked
 * abilities from where it stands. Recasting swaps places with it, once.
 */
export interface ShadowAbility extends AbilityBase {
  kind: 'shadow';
  range: number;
  dashSpeed: number;
  duration: number;
  /** Resource restored (once per cast) when the caster and a shadow hit the same enemy with one ability. */
  sharedHitRefund: number;
}

/** Instant damage in a circle around the caster and each of its shadows; one hit per enemy per cast. */
export interface AreaAbility extends AbilityBase {
  kind: 'area';
  radius: number;
  damage: number;
  /** Slow on enemies hit by a shadow's copy; the stronger amount when hit by two or more. */
  shadowSlow?: { amount: number; enhancedAmount: number; duration: number };
  /** Seconds off another ability's cooldown per enemy hit by the caster's own copy. */
  cooldownRefund?: { slot: AbilitySlot; seconds: number };
}

/**
 * Unit-targeted assassination: untargetable, a short wait, a dash to just behind the target,
 * then a mark that detonates for a share of the damage dealt to it meanwhile. A shadow
 * stays at the cast position, and recasting swaps with it, once.
 */
export interface DeathMarkAbility extends AbilityBase {
  kind: 'deathMark';
  /** Center to target edge. */
  range: number;
  dashTime: number;
  /** How far past the target the dash ends. */
  landBehind: number;
  markDuration: number;
  baseDamage: number;
  /** Fraction of the damage dealt to the marked target that the detonation repeats. */
  storedPct: number;
  shadowDuration: number;
  /** The swap recast is unavailable in the shadow's final seconds. */
  recastCutoff: number;
}

/** Every ability kind. New kinds get added to this union. */
export type AbilityDef = SkillshotAbility | BlinkAbility | ShadowAbility | AreaAbility | DeathMarkAbility;

/** Each enemy hit by an ability grants a stack of bonus attack speed, refreshing the duration. */
export interface AbilityHitAttackSpeedPassive {
  kind: 'abilityHitAttackSpeed';
  name: string;
  /** Bonus attack speed per stack, as a fraction (0.1 = +10%). */
  perStack: number;
  maxStacks: number;
  duration: number;
}

/** Auto-attacks on a target below a health threshold deal a % of its max health, once per target per cooldown. */
export interface ExecuteAttackPassive {
  kind: 'executeAttacks';
  name: string;
  hpThreshold: number;
  maxHpPct: number;
  perTargetCooldown: number;
}

export type PassiveDef = AbilityHitAttackSpeedPassive | ExecuteAttackPassive;

/** Champions are played; minions and turrets are run by the lane (see lane.ts). */
export type UnitKind = 'champion' | 'minion' | 'turret';

/** Rules only turrets have. */
export interface TurretRules {
  /** Each consecutive shot at the same champion deals this much more, as a fraction of base. */
  heatPerShot: number;
  maxHeatStacks: number;
}

/** A unit's stats. Despite the name it also describes minions and turrets (see `kind`). */
export interface ChampionDef {
  id: string;
  name: string;
  /** Default: champion. */
  kind?: UnitKind;
  /** Gold to whoever lands the killing blow. */
  bounty?: number;
  /** Turret shots at this unit deal this fraction of its max health instead of the turret's damage (minions). */
  turretDamagePct?: number;
  turret?: TurretRules;
  /** Gameplay radius (hitbox): used for attack range, skillshot collision and spacing. LoL's typical value is 65. */
  radius: number;
  moveSpeed: number;
  /** Radians per second. LoL champions turn almost instantly, which is a big part of the snappy feel. */
  turnRate: number;
  maxHp: number;
  /** Mana or energy, per `resource`. Ability costs (`manaCost`) spend it. */
  maxMana: number;
  resource?: 'mana' | 'energy';
  hpRegen: number;
  manaRegen: number;
  /** Edge to edge, as in LoL: 550 reaches 550 + both radii (680 between centers at radius 65). */
  attackRange: number;
  /** Base attacks per second, before bonus attack speed. */
  attackSpeed: number;
  /** Fraction of the attack period spent winding up. Moving during it cancels the attack. */
  windupPct: number;
  attackDamage: number;
  /** 0 = melee (instant hit when the windup completes). */
  attackProjectileSpeed: number;
  passive?: PassiveDef;
  abilities: Partial<Record<AbilitySlot, AbilityDef>>;
  /** Abilities this champion's shadows copy when it casts them. */
  shadowMimics?: AbilitySlot[];
}

/** The original prototype champion: a plain ranged attacker with one skillshot. */
export const MARKSMAN: ChampionDef = {
  id: 'marksman',
  name: 'Marksman',
  radius: 35,
  moveSpeed: 330,
  turnRate: 25,
  maxHp: 600,
  maxMana: 300,
  hpRegen: 3,
  manaRegen: 6,
  attackRange: 550,
  attackSpeed: 0.75,
  windupPct: 0.2,
  attackDamage: 60,
  attackProjectileSpeed: 2000,
  abilities: {
    Q: {
      kind: 'skillshot',
      name: 'Piercing Arrow',
      cooldown: 4,
      manaCost: 40,
      castTime: 0.25,
      range: 1100,
      speed: 1700,
      width: 60,
      damage: 90,
      stopsAtFirstHit: true,
    },
  },
};

/**
 * A poke marksman whose kit mirrors Ezreal's mechanics (level 1, rank 1 numbers from the
 * LoL wiki, with 60 AD and no bonus AD/AP). Names are original; Riot's are trademarks.
 * There is no armor/magic resist yet, so physical and magic damage are treated alike.
 */
export const WAYFINDER: ChampionDef = {
  id: 'wayfinder',
  name: 'Wayfinder',
  radius: 65,
  moveSpeed: 325,
  turnRate: 25,
  maxHp: 600,
  maxMana: 375,
  hpRegen: 0.8,
  manaRegen: 1.7,
  attackRange: 550,
  attackSpeed: 0.625,
  windupPct: 0.18839,
  attackDamage: 60,
  attackProjectileSpeed: 2000,
  passive: { kind: 'abilityHitAttackSpeed', name: 'Spell Momentum', perStack: 0.1, maxStacks: 5, duration: 6 },
  abilities: {
    Q: {
      kind: 'skillshot',
      name: 'Arcane Bolt',
      cooldown: 5.5,
      manaCost: 28,
      castTime: 0.25,
      range: 1200,
      speed: 2000,
      width: 120,
      damage: 98, // 20 + 130% AD
      stopsAtFirstHit: true,
      onHit: { reduceCooldowns: 1.5 },
    },
    W: {
      kind: 'skillshot',
      name: 'Rune Orb',
      cooldown: 8,
      manaCost: 50,
      castTime: 0.25,
      range: 1200,
      speed: 1700,
      width: 160,
      damage: 0,
      stopsAtFirstHit: true,
      championsOnly: true,
      onHit: { mark: { duration: 4, detonateDamage: 80, abilityManaRefund: 60 } },
    },
    E: {
      kind: 'blink',
      name: 'Phase Step',
      cooldown: 26,
      manaCost: 70,
      castTime: 0.25,
      range: 475,
      bolt: { range: 750, speed: 2000, damage: 80 },
    },
    R: {
      kind: 'skillshot',
      name: 'Skyline Barrage',
      cooldown: 120,
      manaCost: 100,
      castTime: 1,
      range: 5000, // map-wide
      speed: 2000,
      width: 320,
      damage: 350,
      stopsAtFirstHit: false,
      minionDamagePct: 0.5,
    },
  },
};

/**
 * A melee assassin whose kit mirrors Zed's mechanics (level 1, rank 1 numbers from the LoL
 * wiki, with 63 AD and no bonus AD). Names are original; Riot's are trademarks.
 */
export const SHADEBLADE: ChampionDef = {
  id: 'shadeblade',
  name: 'Shadeblade',
  radius: 65,
  moveSpeed: 345,
  turnRate: 25,
  maxHp: 654,
  maxMana: 200,
  resource: 'energy',
  hpRegen: 1.4, // 7 per 5 s
  manaRegen: 10, // 50 energy per 5 s
  attackRange: 125,
  attackSpeed: 0.651,
  windupPct: 0.19759,
  attackDamage: 63,
  attackProjectileSpeed: 0,
  passive: { kind: 'executeAttacks', name: 'Prey on the Weak', hpThreshold: 0.5, maxHpPct: 0.05, perTargetCooldown: 10 },
  shadowMimics: ['Q', 'E'],
  abilities: {
    Q: {
      kind: 'skillshot',
      name: 'Night Star',
      cooldown: 6,
      manaCost: 75,
      castTime: 0.25,
      range: 925,
      speed: 1700,
      width: 100,
      damage: 80,
      subsequentDamage: 48,
      stopsAtFirstHit: false,
    },
    W: {
      kind: 'shadow',
      name: 'Echo Shadow',
      cooldown: 20,
      manaCost: 40,
      castTime: 0,
      range: 650,
      dashSpeed: 2500,
      duration: 5.25,
      sharedHitRefund: 30,
    },
    E: {
      kind: 'area',
      name: 'Umbral Slash',
      cooldown: 5,
      manaCost: 40,
      castTime: 0,
      radius: 315,
      damage: 70,
      shadowSlow: { amount: 0.2, enhancedAmount: 0.3, duration: 1.5 },
      cooldownRefund: { slot: 'W', seconds: 3 },
    },
    R: {
      kind: 'deathMark',
      name: 'Final Mark',
      cooldown: 120,
      manaCost: 0,
      castTime: 0.6, // untargetable wait before the dash
      range: 625,
      dashTime: 0.35,
      landBehind: 125,
      markDuration: 3,
      baseDamage: 0, // 100% bonus AD, and there is no bonus AD yet
      storedPct: 0.25,
      shadowDuration: 9,
      recastCutoff: 1.25,
    },
  },
};

// --- lane units -------------------------------------------------------------
// Minute-0 stats from the LoL wiki. LoL minions and turrets grow stronger over time; these don't yet.

const minion = (def: Omit<ChampionDef, 'kind' | 'turnRate' | 'maxMana' | 'manaRegen' | 'hpRegen' | 'moveSpeed' | 'abilities'>): ChampionDef => ({
  kind: 'minion',
  moveSpeed: 325,
  turnRate: 25,
  maxMana: 0,
  hpRegen: 0,
  manaRegen: 0,
  abilities: {},
  ...def,
});

export const MELEE_MINION = minion({
  id: 'minion-melee',
  name: 'Melee minion',
  radius: 48,
  maxHp: 477,
  attackRange: 110,
  attackSpeed: 1.25,
  windupPct: 0.25,
  attackDamage: 12,
  attackProjectileSpeed: 0,
  bounty: 21,
  turretDamagePct: 0.45,
});

export const CASTER_MINION = minion({
  id: 'minion-caster',
  name: 'Caster minion',
  radius: 48,
  maxHp: 296,
  attackRange: 550,
  attackSpeed: 0.667,
  windupPct: 0.25,
  attackDamage: 24,
  attackProjectileSpeed: 650,
  bounty: 14,
  turretDamagePct: 0.7,
});

export const SIEGE_MINION = minion({
  id: 'minion-siege',
  name: 'Siege minion',
  radius: 65,
  maxHp: 912,
  attackRange: 300,
  attackSpeed: 1,
  windupPct: 0.25,
  attackDamage: 41,
  attackProjectileSpeed: 1200,
  bounty: 60,
  turretDamagePct: 0.14,
});

/** LoL's turret range is 750 from its center to the target's edge. */
const TURRET_RANGE = 750;
const TURRET_RADIUS = 88;

export const OUTER_TURRET: ChampionDef = {
  id: 'turret-outer',
  name: 'Outer turret',
  kind: 'turret',
  radius: TURRET_RADIUS,
  moveSpeed: 0,
  turnRate: 100,
  maxHp: 5000,
  maxMana: 0,
  hpRegen: 0,
  manaRegen: 0,
  attackRange: TURRET_RANGE - TURRET_RADIUS, // world.ts measures range edge to edge
  attackSpeed: 0.833,
  windupPct: 0.15,
  attackDamage: 152,
  attackProjectileSpeed: 1200,
  bounty: 250,
  turret: { heatPerShot: 0.4, maxHeatStacks: 3 },
  abilities: {},
};

export const CHAMPIONS: Record<string, ChampionDef> = {
  [MARKSMAN.id]: MARKSMAN,
  [WAYFINDER.id]: WAYFINDER,
  [SHADEBLADE.id]: SHADEBLADE,
};

/** Every unit definition by id, for rebuilding units from snapshots. */
export const UNIT_DEFS: Record<string, ChampionDef> = {
  ...CHAMPIONS,
  [MELEE_MINION.id]: MELEE_MINION,
  [CASTER_MINION.id]: CASTER_MINION,
  [SIEGE_MINION.id]: SIEGE_MINION,
  [OUTER_TURRET.id]: OUTER_TURRET,
};

/** Champions offered in champion select. */
export const PLAYABLE = [WAYFINDER, SHADEBLADE];
