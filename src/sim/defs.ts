/** Simulation rate. The future authoritative server ticks at this rate too. */
export const TICK_RATE = 30;
export const WORLD_SIZE = { width: 2600, height: 1600 };
export const RESPAWN_SECONDS = 3;

export interface SkillshotDef {
  name: string;
  cooldown: number;
  manaCost: number;
  /** Seconds the caster is rooted before the missile leaves. */
  castTime: number;
  range: number;
  speed: number;
  /** Missile width; a hit lands when it passes within width/2 of a unit's edge. */
  width: number;
  damage: number;
}

export interface ChampionDef {
  name: string;
  radius: number;
  moveSpeed: number;
  /** Radians per second. LoL champions turn almost instantly, which is a big part of the snappy feel. */
  turnRate: number;
  maxHp: number;
  maxMana: number;
  hpRegen: number;
  manaRegen: number;
  /** Measured from the attacker's center to the target's edge. */
  attackRange: number;
  /** Attacks per second. */
  attackSpeed: number;
  /** Fraction of the attack period spent winding up. Moving during it cancels the attack. */
  windupPct: number;
  attackDamage: number;
  /** 0 = melee (instant hit when the windup completes). */
  attackProjectileSpeed: number;
  q: SkillshotDef;
}

export const MARKSMAN: ChampionDef = {
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
  q: {
    name: 'Piercing Arrow',
    cooldown: 4,
    manaCost: 40,
    castTime: 0.25,
    range: 1100,
    speed: 1700,
    width: 60,
    damage: 90,
  },
};
