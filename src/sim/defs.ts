/** Simulation rate. The authoritative server ticks at this rate too. */
export const TICK_RATE = 30;
export const WORLD_SIZE = { width: 2600, height: 1600 };
export const RESPAWN_SECONDS = 3;

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

export interface ChampionDef {
  id: string;
  name: string;
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

export const CHAMPIONS: Record<string, ChampionDef> = {
  [MARKSMAN.id]: MARKSMAN,
  [WAYFINDER.id]: WAYFINDER,
  [SHADEBLADE.id]: SHADEBLADE,
};

/** Champions offered in champion select. */
export const PLAYABLE = [WAYFINDER, SHADEBLADE];
