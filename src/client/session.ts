import type { Vec } from '../sim/math';
import type { GameView, PlayerCommand, Projectile, SimEvent, Unit } from '../sim/world';

/**
 * Where the game state comes from. Offline it is a local World; online it is a mirror
 * of the server's snapshots. Rendering and input only talk to this interface.
 */
export interface Session {
  readonly view: GameView;
  readonly playerId: number;
  readonly tickRate: number;
  /** Extra line for the help panel. */
  readonly note: string;
  send(cmd: PlayerCommand): void;
  /** Advances time by `dt` seconds and returns the events that became visible. */
  update(dt: number): SimEvent[];
  renderPos(u: Unit): Vec;
  projectilePos(p: Projectile): Vec;
  status(): string;
}
