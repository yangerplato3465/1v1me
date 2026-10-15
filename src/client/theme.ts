import type { Team } from '../sim/world';

export const COLORS = {
  blue: 0x3d8bff,
  blueLight: 0xa9cdff,
  red: 0xff4d5e,
  redLight: 0xffb3ba,
  hpAlly: 0x46d36b,
  hpEnemy: 0xe8424f,
  mana: 0x4aa3ff,
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
