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

/** Visual body size. The hitbox (def.radius, 65 like LoL) is wider than the drawn body, as in LoL. */
export const bodyRadius = (def: ChampionDef): number => def.radius * (def.kind === 'turret' ? 0.6 : 0.55);

/** How far above its feet a unit is drawn (and clickable), in units of bodyRadius. */
export const bodyHeight = (def: ChampionDef): number => (def.kind === 'turret' ? 5.2 : def.kind === 'minion' ? 2.4 : 3);

/** Health bar colors seen from the player's side. */
export const hpColor = (allied: boolean, isPlayer: boolean): number =>
  isPlayer ? COLORS.hpAlly : allied ? COLORS.hpFriend : COLORS.hpEnemy;
