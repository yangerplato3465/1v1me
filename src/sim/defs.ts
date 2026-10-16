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
 * Wave rules from the LoL wiki (patch 26.x). The first wave spawns at 0:30; waves come
 * every 30 s, every 25 s from 14:00 and every 20 s from 30:00. A wave walks out one minion
 * at a time, 0.792 s apart: melee, then siege, then casters. A siege minion joins wave 3
 * and every 3rd wave after, every 2nd from 14:00 and every wave from 25:00. From 14:00 a
 * wave with a siege minion has one melee fewer; from 30:00 every wave has one caster fewer.
 */
export const WAVES = {
  firstAt: 30,
  /** [from game time, seconds between waves] */
  interval: [
    [0, 30],
    [14 * 60, 25],
    [30 * 60, 20],
  ] as [number, number][],
  /** Seconds between minions of one wave leaving the base. */
  spawnSpacing: 0.792,
  /** [from game time, a siege minion every Nth wave] */
  siegeEvery: [
    [0, 3],
    [14 * 60, 2],
    [25 * 60, 1],
  ] as [number, number][],
  melee: 3,
  casters: 3,
  fewerMeleeWithSiegeFrom: 14 * 60,
  fewerCastersFrom: 30 * 60,
};

export const ABILITY_SLOTS = ['Q', 'W', 'E', 'R'] as const;
export type AbilitySlot = (typeof ABILITY_SLOTS)[number];

// --- levels and experience -----------------------------------------------------
// From the LoL wiki: Experience (champion), Champion ability and Champion statistic.

export const MAX_LEVEL = 18;
/** Champions on the lane start here, with this many skill points to spend. */
export const START_LEVEL = 3;
/** Total experience needed to reach each level (index 0 = level 1). */
export const XP_FOR_LEVEL = [
  0, 280, 660, 1140, 1720, 2400, 3180, 4060, 5040, 6120, 7300, 8580, 9960, 11440, 13020, 14700, 16480, 18360,
];
/** Ultimates can be learned and ranked up only at these levels. */
export const ULTIMATE_LEVELS = [6, 11, 16];
export const BASIC_MAX_RANK = 5;
export const ULTIMATE_MAX_RANK = 3;
/** Minion experience goes to enemy champions this close to where it died. */
export const MINION_XP_RANGE = 1500;
/** Champion kill experience goes to enemy champions this close (and always to the killer). */
export const CHAMPION_XP_RANGE = 1600;
/** Each champion's share of a minion's experience, by how many champions share it. */
export const XP_SHARE = [1, 0.65, 0.433, 0.325, 0.26, 0.217];
/**
 * Experience for killing a champion, by its level. The wiki gives 42 at level 1 and 990 at
 * level 18; the levels between are the commonly cited table and unconfirmed.
 */
export const CHAMPION_KILL_XP = [42, 114, 144, 174, 204, 234, 308, 392, 486, 590, 640, 690, 740, 790, 840, 890, 940, 990];

/** A value that changes with ability rank (index 0 = rank 1), or one value for every rank. */
export type Ranked = number | readonly number[];

export const atRank = (value: Ranked, rank: number): number =>
  typeof value === 'number' ? value : value[Math.min(value.length, Math.max(1, rank)) - 1];

/** Per-level growth of a champion's stats; regen is per second, attack speed a bonus fraction. */
export interface StatGrowth {
  maxHp: number;
  maxMana: number;
  hpRegen: number;
  manaRegen: number;
  attackDamage: number;
  attackSpeed: number;
}

/** LoL's growth curve: the total gained by level n, for a growth stat of g. */
export const growthAt = (g: number, level: number): number => g * (level - 1) * (0.7025 + 0.0175 * (level - 1));

/** A mark left on a unit; the caster's next attack or ability on it detonates it. */
export interface MarkEffect {
  duration: number;
  detonateDamage: Ranked;
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
  cooldown: Ranked;
  manaCost: Ranked;
  /** Seconds the caster is rooted before the ability takes effect. */
  castTime: number;
}

export interface SkillshotAbility extends AbilityBase {
  kind: 'skillshot';
  /** Passes through minions and only collides with champions. */
  championsOnly?: boolean;
  /** Damage to minions instead of `damage` (LoL's global ults deal less to them). */
  minionDamage?: Ranked;
  /** Extra damage as a fraction of the caster's total attack damage. */
  adRatio?: number;
  range: number;
  speed: number;
  /** Missile width; a hit lands when it passes within width/2 of a unit's edge. */
  width: number;
  damage: Ranked;
  /** True: stops on the first enemy. False: passes through, hitting each enemy once. */
  stopsAtFirstHit: boolean;
  /** Damage to each enemy after the first, for piercing missiles (default: same as `damage`). */
  subsequentDamage?: Ranked;
  onHit?: OnAbilityHit;
}

export interface BlinkAbility extends AbilityBase {
  kind: 'blink';
  /** Maximum teleport distance; aiming further blinks this far in that direction. */
  range: number;
  /** Homing bolt fired on landing at the nearest enemy in range, preferring ones you marked. */
  bolt?: { range: number; speed: number; damage: Ranked };
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
  sharedHitRefund: Ranked;
}

/** Instant damage in a circle around the caster and each of its shadows; one hit per enemy per cast. */
export interface AreaAbility extends AbilityBase {
  kind: 'area';
  radius: number;
  damage: Ranked;
  /** Slow on enemies hit by a shadow's copy; the stronger amount when hit by two or more. */
  shadowSlow?: { amount: Ranked; enhancedAmount: Ranked; duration: number };
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
  /** Detonation base damage, as a fraction of the caster's total attack damage. */
  adRatio: number;
  /** Fraction of the damage dealt to the marked target that the detonation repeats. */
  storedPct: Ranked;
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
  /** [from champion level, fraction of max health] */
  maxHpPctByLevel: [number, number][];
  perTargetCooldown: number;
}

export type PassiveDef = AbilityHitAttackSpeedPassive | ExecuteAttackPassive;

/** Champions are played; minions and turrets are run by the lane (see lane.ts). */
export type UnitKind = 'champion' | 'minion' | 'turret';

/** Rules only turrets have. */
export interface TurretRules {
  /** Each shot that hits a champion makes later shots deal this much more, as a fraction of base. */
  heatPerShot: number;
  maxHeatStacks: number;
  /** The heat wears off this long after the last shot at a champion (switching targets keeps it). */
  heatResetSeconds: number;
  /** Damage multiplier on basic attacks from melee champions. */
  meleeChampionDamageTaken: number;
}

/** How a minion's attacks scale against each kind of target. */
export interface MinionRules {
  /** Multiplier on damage to champions. */
  vsChampions: number;
  /** Multiplier on damage to turrets. */
  vsStructures: number;
  /** Bonus damage to other minions, as a fraction of their current health. */
  vsMinionsCurrentHp: number;
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
  minion?: MinionRules;
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
  /** Stat gains per level; none means the unit doesn't level (minions, turrets). */
  growth?: StatGrowth;
  /** Experience to nearby enemy champions when it dies (minions). */
  xp?: number;
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
  growth: { maxHp: 102, maxMana: 70, hpRegen: 0.13, manaRegen: 0.2, attackDamage: 3.75, attackSpeed: 0.025 },
  passive: { kind: 'abilityHitAttackSpeed', name: 'Spell Momentum', perStack: 0.1, maxStacks: 5, duration: 6 },
  abilities: {
    Q: {
      kind: 'skillshot',
      name: 'Arcane Bolt',
      cooldown: [5.5, 5.25, 5, 4.75, 4.5],
      manaCost: [28, 31, 34, 37, 40],
      castTime: 0.25,
      range: 1200,
      speed: 2000,
      width: 120,
      damage: [20, 45, 70, 95, 120],
      adRatio: 1.3,
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
      onHit: { mark: { duration: 4, detonateDamage: [80, 135, 190, 245, 300], abilityManaRefund: 60 } },
    },
    E: {
      kind: 'blink',
      name: 'Phase Step',
      cooldown: [26, 23, 20, 17, 14],
      manaCost: 70,
      castTime: 0.25,
      range: 475,
      bolt: { range: 750, speed: 2000, damage: [80, 130, 180, 230, 280] },
    },
    R: {
      kind: 'skillshot',
      name: 'Skyline Barrage',
      cooldown: [120, 105, 90],
      manaCost: 100,
      castTime: 1,
      range: 5000, // map-wide
      speed: 2000,
      width: 320,
      damage: [350, 550, 750],
      stopsAtFirstHit: false,
      minionDamage: [150, 225, 300], // against minions and non-epic monsters
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
  growth: { maxHp: 99, maxMana: 0, hpRegen: 0.13, manaRegen: 0, attackDamage: 3.4, attackSpeed: 0.033 },
  passive: {
    kind: 'executeAttacks',
    name: 'Prey on the Weak',
    hpThreshold: 0.5,
    // The wiki lists 5% / 7.5% / 10% "based on level"; the breakpoints (7, 17) are Zed's usual ones.
    maxHpPctByLevel: [
      [1, 0.05],
      [7, 0.075],
      [17, 0.1],
    ],
    perTargetCooldown: 10,
  },
  shadowMimics: ['Q', 'E'],
  abilities: {
    Q: {
      kind: 'skillshot',
      name: 'Night Star',
      cooldown: 6,
      manaCost: [75, 70, 65, 60, 55],
      castTime: 0.25,
      range: 925,
      speed: 1700,
      width: 100,
      damage: [80, 120, 160, 200, 240],
      subsequentDamage: [48, 72, 96, 120, 144],
      stopsAtFirstHit: false,
    },
    W: {
      kind: 'shadow',
      name: 'Echo Shadow',
      cooldown: [20, 19, 18, 17, 16],
      manaCost: [40, 35, 30, 25, 20],
      castTime: 0,
      range: 650,
      dashSpeed: 2500,
      duration: 5.25,
      sharedHitRefund: [30, 35, 40, 45, 50],
    },
    E: {
      kind: 'area',
      name: 'Umbral Slash',
      cooldown: [5, 4.5, 4, 3.5, 3],
      manaCost: 40,
      castTime: 0,
      radius: 315,
      damage: [70, 92.5, 115, 137.5, 160],
      shadowSlow: { amount: [0.2, 0.25, 0.3, 0.35, 0.4], enhancedAmount: [0.3, 0.375, 0.45, 0.525, 0.6], duration: 1.5 },
      cooldownRefund: { slot: 'W', seconds: 3 },
    },
    R: {
      kind: 'deathMark',
      name: 'Final Mark',
      cooldown: [120, 110, 100],
      manaCost: 0,
      castTime: 0.6, // untargetable wait before the dash
      range: 625,
      dashTime: 0.35,
      landBehind: 125,
      markDuration: 3,
      adRatio: 1, // 100% AD
      storedPct: [0.25, 0.4, 0.55],
      shadowDuration: 9,
      recastCutoff: 1.25,
    },
  },
};

// --- lane units -------------------------------------------------------------
// Stats at the start of the game, from the LoL wiki (patch 26.x). LoL minions upgrade every
// 90 s and turret damage grows by the minute; neither is modeled yet.

const minion = (def: Omit<ChampionDef, 'kind' | 'turnRate' | 'maxMana' | 'manaRegen' | 'hpRegen' | 'moveSpeed' | 'abilities'>): ChampionDef => ({
  kind: 'minion',
  moveSpeed: 350,
  turnRate: 25,
  maxMana: 0,
  hpRegen: 0,
  manaRegen: 0,
  abilities: {},
  ...def,
});

/** LoL minions deal 60% damage to champions and structures. */
const MINION_VS_CHAMPIONS = 0.6;

export const MELEE_MINION = minion({
  id: 'minion-melee',
  name: 'Melee minion',
  radius: 48,
  maxHp: 465,
  attackRange: 110,
  attackSpeed: 1.25,
  windupPct: 0.25,
  attackDamage: 11,
  attackProjectileSpeed: 0,
  bounty: 20,
  xp: 62,
  turretDamagePct: 0.45,
  minion: { vsChampions: MINION_VS_CHAMPIONS, vsStructures: 0.6, vsMinionsCurrentHp: 0.02 },
});

export const CASTER_MINION = minion({
  id: 'minion-caster',
  name: 'Caster minion',
  radius: 48,
  maxHp: 284,
  attackRange: 550,
  attackSpeed: 0.667,
  windupPct: 0.25,
  attackDamage: 21,
  attackProjectileSpeed: 650,
  bounty: 14,
  xp: 31,
  turretDamagePct: 0.7,
  minion: { vsChampions: MINION_VS_CHAMPIONS, vsStructures: 0.6, vsMinionsCurrentHp: 0.035 },
});

export const SIEGE_MINION = minion({
  id: 'minion-siege',
  name: 'Siege minion',
  radius: 65,
  maxHp: 835,
  attackRange: 300,
  attackSpeed: 1,
  windupPct: 0.25,
  attackDamage: 37.5,
  attackProjectileSpeed: 1200,
  bounty: 50,
  xp: 75,
  turretDamagePct: 0.14,
  minion: { vsChampions: MINION_VS_CHAMPIONS, vsStructures: 0.84, vsMinionsCurrentHp: 0.05 },
});

/** LoL's turret range is 750 from its center to the target's edge. */
const TURRET_RANGE = 750;
const TURRET_RADIUS = 88.4;

export const OUTER_TURRET: ChampionDef = {
  id: 'turret-outer',
  name: 'Outer turret',
  kind: 'turret',
  radius: TURRET_RADIUS,
  moveSpeed: 0,
  turnRate: 100,
  maxHp: 9000,
  maxMana: 0,
  hpRegen: 0,
  manaRegen: 0,
  attackRange: TURRET_RANGE - TURRET_RADIUS, // world.ts measures range edge to edge
  attackSpeed: 0.833,
  windupPct: 0.15,
  attackDamage: 182,
  attackProjectileSpeed: 1200,
  bounty: 50,
  turret: { heatPerShot: 0.5, maxHeatStacks: 3, heatResetSeconds: 5, meleeChampionDamageTaken: 1.2 },
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
