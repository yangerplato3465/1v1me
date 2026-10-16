import type { ChampionDef } from '../sim/defs';
import type { Team } from '../sim/world';

export const COLORS = {
  blue: 0x3d8bff,
  blueLight: 0xa9cdff,
  red: 0xff4d5e,
  redLight: 0xffb3ba,
  hpAlly: 0x46d36b,
  hpEnemy: 0xe8424f,
  hpFriend: 0x4f9dff,
  mana: 0x4aa3ff,
  energy: 0xf2d16b,
  gold: 0xc8aa6e,
  windup: 0xff9f43,
  text: 0xf4f1e8,
  muted: 0x9aa7a0,
  moveMarker: 0x7dff9a,
  attackMarker: 0xff5a5a,
};

export const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';
export const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export const teamColor = (team: Team): number => (team === 'blue' ? COLORS.blue : COLORS.red);
export const teamLight = (team: Team): number => (team === 'blue' ? COLORS.blueLight : COLORS.redLight);

/**
 * How tall units are drawn, in world units. LoL lists Ezreal's selection height as 170, so
 * champions stand that tall next to their 65 hitbox radius and 550-1200 ranges. Minions
 * stand about 100 and turrets about 450, in LoL's proportions.
 */
export const MODEL_HEIGHT = { champion: 170, minion: 100, turret: 450 };

/** Each figure's height in units of its bodyRadius, as drawn in renderer.ts. */
const HEIGHT_IN_RADII = { champion: 2.65, minion: 2.3, turret: 5.9 };
/** Hitbox radius of the reference unit of each kind (melee minion for minions). */
const REFERENCE_RADIUS = { champion: 65, minion: 48, turret: 88.4 };

/**
 * Visual body size. The drawn body is narrower than the hitbox (def.radius), as in LoL;
 * bigger hitboxes (the siege minion) draw proportionally bigger.
 */
export const bodyRadius = (def: ChampionDef): number => {
  const kind = def.kind ?? 'champion';
  return (MODEL_HEIGHT[kind] / HEIGHT_IN_RADII[kind]) * (def.radius / REFERENCE_RADIUS[kind]);
};

/** How far above its feet a unit is drawn (and clickable), in units of bodyRadius. */
export const bodyHeight = (def: ChampionDef): number => (def.kind === 'turret' ? 5.2 : def.kind === 'minion' ? 2.4 : 3);

/** Health bar colors seen from the player's side. */
export const hpColor = (allied: boolean, isPlayer: boolean): number =>
  isPlayer ? COLORS.hpAlly : allied ? COLORS.hpFriend : COLORS.hpEnemy;
