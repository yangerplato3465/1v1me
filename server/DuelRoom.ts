import { Room, type Client } from '@colyseus/core';
import { MSG, parsePlayerCommand, toUnitSnapshot, type JoinOptions, type Snapshot, type Welcome } from '../src/net/protocol';
import { StrafeBot } from '../src/sim/bot';
import { MARKSMAN, TICK_RATE, WORLD_SIZE } from '../src/sim/defs';
import type { Team } from '../src/sim/world';
import { World } from '../src/sim/world';

const SPAWNS: Record<Team, { x: number; y: number }> = {
  blue: { x: 700, y: WORLD_SIZE.height / 2 },
  red: { x: WORLD_SIZE.width - 700, y: WORLD_SIZE.height / 2 },
};

/**
 * One 1v1 match. The room owns the only real World; clients send commands and
 * render the snapshots it broadcasts every tick.
 */
export class DuelRoom extends Room {
  maxClients = 2;
  /** Hold-right-click repeats moves at 10/s; anything far above that is abuse. */
  maxMessagesPerSecond = 60;

  private readonly world = new World();
  private readonly unitBySession = new Map<string, number>();
  private bot: StrafeBot | null = null;

  onCreate(options: JoinOptions = {}): void {
    if (options.practice) {
      this.maxClients = 1;
      void this.setPrivate(true);
    }

    this.onMessage(MSG.command, (client, raw) => {
      const unitId = this.unitBySession.get(client.sessionId);
      const cmd = parsePlayerCommand(raw);
      if (unitId === undefined || !cmd) return;
      this.world.issue({ ...cmd, unitId });
    });

    this.setFixedTimestep((ctx) => this.tick(ctx.tick, ctx.dt), TICK_RATE);
  }

  onJoin(client: Client, options: JoinOptions = {}): void {
    const taken = new Set([...this.world.units.values()].map((u) => u.team));
    const team: Team = taken.has('blue') ? 'red' : 'blue';
    const unit = this.world.addUnit(MARKSMAN, team, SPAWNS[team]);
    this.unitBySession.set(client.sessionId, unit.id);

    if (options.practice && !this.bot) {
      const botTeam: Team = team === 'blue' ? 'red' : 'blue';
      const botUnit = this.world.addUnit(MARKSMAN, botTeam, SPAWNS[botTeam]);
      this.bot = new StrafeBot(this.world, botUnit.id, unit.id);
    }

    const welcome: Welcome = { unitId: unit.id, tickRate: TICK_RATE };
    client.send(MSG.welcome, welcome);
  }

  onLeave(client: Client): void {
    const unitId = this.unitBySession.get(client.sessionId);
    this.unitBySession.delete(client.sessionId);
    if (unitId !== undefined) this.world.removeUnit(unitId);
  }

  private tick(tick: number, dt: number): void {
    this.bot?.update(dt);
    this.world.step(dt);
    const snapshot: Snapshot = {
      tick,
      units: [...this.world.units.values()].map(toUnitSnapshot),
      projectiles: this.world.projectiles,
      events: this.world.drainEvents(),
    };
    this.broadcast(MSG.snapshot, snapshot);
  }
}
