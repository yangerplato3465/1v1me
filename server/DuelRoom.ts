import { Room, type Client } from '@colyseus/core';
import { Authority } from '../src/net/authority';
import { MSG, type JoinOptions } from '../src/net/protocol';
import { TICK_RATE } from '../src/sim/defs';

/** One 1v1 match: Colyseus transport around an Authority, which owns the only real World. */
export class DuelRoom extends Room {
  maxClients = 2;
  /** Hold-right-click repeats moves at 10/s; anything far above that is abuse. */
  maxMessagesPerSecond = 60;

  private readonly match = new Authority();
  private practice = false;

  onCreate(options: JoinOptions = {}): void {
    if (options.practice) {
      this.practice = true;
      this.maxClients = 1;
      void this.setPrivate(true);
    }
    this.onMessage(MSG.command, (client, raw) => this.match.receive(client.sessionId, raw));
    this.setFixedTimestep((ctx) => {
      const shared = this.match.step(ctx.dt);
      for (const client of this.clients) client.send(MSG.snapshot, this.match.snapshotFor(client.sessionId, shared));
    }, TICK_RATE);
  }

  onJoin(client: Client, options: JoinOptions = {}): void {
    const champ = typeof options.champ === 'string' ? options.champ : undefined;
    client.send(MSG.welcome, this.match.join(client.sessionId, this.practice, champ));
  }

  onLeave(client: Client): void {
    this.match.leave(client.sessionId);
  }
}
