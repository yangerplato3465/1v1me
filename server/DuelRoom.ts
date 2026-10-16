import { Room, type Client } from '@colyseus/core';
import { Authority } from '../src/net/authority';
import { MSG, parseSummoners, type JoinOptions } from '../src/net/protocol';
import { TICK_RATE } from '../src/sim/defs';

/** Codes of the code rooms that are open right now, so no two share one. */
const codesInUse = new Set<string>();

/** A free 4-digit room code (1000-9999). */
export function newRoomCode(random: () => number = Math.random): string {
  for (let i = 0; i < 1000; i++) {
    const code = String(1000 + Math.floor(random() * 9000));
    if (!codesInUse.has(code)) return code;
  }
  throw new Error('No free room codes');
}

/** One 1v1 match: Colyseus transport around an Authority, which owns the only real World. */
export class DuelRoom extends Room {
  maxClients = 2;
  /** Hold-right-click repeats moves at 10/s; anything far above that is abuse. */
  maxMessagesPerSecond = 60;

  private readonly match = new Authority();
  private practice = false;
  private code: string | null = null;

  onCreate(options: JoinOptions = {}): void {
    if (options.practice) {
      this.practice = true;
      this.maxClients = 1;
      void this.setPrivate(true);
    } else if (options.privateRoom) {
      // The code is the room id, so a friend joins with joinById(code). Private rooms stay out of matchmaking.
      this.code = newRoomCode();
      codesInUse.add(this.code);
      this.roomId = this.code;
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
    client.send(MSG.welcome, this.match.join(client.sessionId, this.practice, champ, parseSummoners(options.summoners)));
  }

  onLeave(client: Client): void {
    this.match.leave(client.sessionId);
  }

  onDispose(): void {
    if (this.code) codesInUse.delete(this.code);
  }
}
