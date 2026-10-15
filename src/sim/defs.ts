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
  onHit?: OnAbilityHit;
}

export interface BlinkAbility extends AbilityBase {
  kind: 'blink';
  /** Maximum teleport distance; aiming further blinks this far in that direction. */
  range: number;
  /** Homing bolt fired on landing at the nearest enemy in range, preferring ones you marked. */
  bolt?: { range: number; speed: number; damage: number };
}

/** Every ability kind. New kinds (dash, shield, ...) get added to this union. */
export type AbilityDef = SkillshotAbility | BlinkAbility;

/** Each enemy hit by an ability grants a stack of bonus attack speed, refreshing the duration. */
export interface AbilityHitAttackSpeedPassive {
  kind: 'abilityHitAttackSpeed';
  name: string;
  /** Bonus attack speed per stack, as a fraction (0.1 = +10%). */
  perStack: number;
  maxStacks: number;
  duration: number;
}

export type PassiveDef = AbilityHitAttackSpeedPassive;

export interface ChampionDef {
  id: string;
  name: string;
  /** Gameplay radius (hitbox): used for attack range, skillshot collision and spacing. LoL's typical value is 65. */
  radius: number;
  moveSpeed: number;
  /** Radians per second. LoL champions turn almost instantly, which is a big part of the snappy feel. */
  turnRate: number;
  maxHp: number;
  maxMana: number;
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

export const CHAMPIONS: Record<string, ChampionDef> = {
  [MARKSMAN.id]: MARKSMAN,
  [WAYFINDER.id]: WAYFINDER,
};
