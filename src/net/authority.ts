import { PracticeBot } from '../sim/bot';
import { PLAYABLE, TICK_RATE, WAYFINDER, WORLD_SIZE } from '../sim/defs';
import { World, type Team } from '../sim/world';
import { parseCommandMessage, toUnitSnapshot, type Snapshot, type Welcome } from './protocol';

const SPAWNS: Record<Team, { x: number; y: number }> = {
  blue: { x: 700, y: WORLD_SIZE.height / 2 },
  red: { x: WORLD_SIZE.width - 700, y: WORLD_SIZE.height / 2 },
};

interface Seat {
  unitId: number;
  lastSeq: number;
  lastSeqTick: number;
}

/**
 * The authoritative match, independent of Colyseus: seats, command intake and the tick.
 * DuelRoom wires it to the network; tests drive it directly.
 */
export class Authority {
  readonly world = new World();
  private readonly seats = new Map<string, Seat>();
  private bot: PracticeBot | null = null;
  /** Last simulated tick. Commands received now are first simulated in tick + 1. */
  private tick = 0;

  join(seatId: string, practice = false, champ?: string): Welcome {
    const taken = new Set([...this.world.units.values()].map((u) => u.team));
    const team: Team = taken.has('blue') ? 'red' : 'blue';
    const def = PLAYABLE.find((c) => c.id === champ) ?? PLAYABLE[0];
    const unit = this.world.addUnit(def, team, SPAWNS[team]);
    this.seats.set(seatId, { unitId: unit.id, lastSeq: -1, lastSeqTick: -1 });

    if (practice && !this.bot) {
      const botTeam: Team = team === 'blue' ? 'red' : 'blue';
      const botUnit = this.world.addUnit(WAYFINDER, botTeam, SPAWNS[botTeam]);
      this.bot = new PracticeBot(this.world, botUnit.id, unit.id);
    }
    return { unitId: unit.id, tickRate: TICK_RATE };
  }

  leave(seatId: string): void {
    const seat = this.seats.get(seatId);
    this.seats.delete(seatId);
    if (seat) this.world.removeUnit(seat.unitId);
  }

  receive(seatId: string, raw: unknown): void {
    const seat = this.seats.get(seatId);
    const msg = parseCommandMessage(raw);
    if (!seat || !msg || msg.seq <= seat.lastSeq) return;
    seat.lastSeq = msg.seq;
    seat.lastSeqTick = this.tick + 1;
    // The unit is always the sender's own; nothing in the message can choose it.
    if (msg.cmd) this.world.issue({ ...msg.cmd, unitId: seat.unitId });
  }

  /** Advances one tick and returns the snapshot shared by everyone. */
  step(dt: number): Snapshot {
    this.tick++;
    this.bot?.update(dt);
    this.world.step(dt);
    return {
      tick: this.tick,
      units: [...this.world.units.values()].map(toUnitSnapshot),
      projectiles: this.world.projectiles,
      shadows: this.world.shadows,
      events: this.world.drainEvents(),
    };
  }

  /** Adds the seat's private part (acks and its own order) to a shared snapshot. */
  snapshotFor(seatId: string, shared: Snapshot): Snapshot {
    const seat = this.seats.get(seatId);
    const unit = seat && this.world.units.get(seat.unitId);
    if (!seat || !unit) return shared;
    return { ...shared, you: { ack: seat.lastSeq, ackTick: seat.lastSeqTick, order: unit.order } };
  }
}
