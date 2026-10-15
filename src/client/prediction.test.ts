import { describe, expect, it } from 'vitest';
import { Authority } from '../net/authority';
import type { CommandMessage, Snapshot } from '../net/protocol';
import { TICK_RATE } from '../sim/defs';
import { dist, type Vec } from '../sim/math';
import type { PlayerCommand } from '../sim/world';
import { Predictor } from './prediction';

const STEP = 1 / TICK_RATE;

/**
 * A server and one predicting client joined by a fake network. Each direction delays
 * messages by `latency(tick)` ticks; JSON round-tripping stands in for serialization.
 */
function harness(latency: (tick: number) => number) {
  const server = new Authority();
  const { unitId } = server.join('me');
  const dummy = server.join('dummy');
  const predictor = new Predictor(unitId, TICK_RATE);
  let now = 0;
  const toServer: { at: number; msg: CommandMessage }[] = [];
  const toClient: { at: number; snap: Snapshot }[] = [];
  const corrections: number[] = [];

  const send = (msg: CommandMessage) => toServer.push({ at: now + latency(now), msg: JSON.parse(JSON.stringify(msg)) });

  /** One tick of wall time: deliveries, a server step, a client frame. */
  const tick = () => {
    now++;
    for (const m of toServer.filter((m) => m.at <= now)) server.receive('me', m.msg);
    toServer.splice(0, toServer.length, ...toServer.filter((m) => m.at > now));
    const snap = server.snapshotFor('me', server.step(STEP));
    toClient.push({ at: now + latency(now), snap: JSON.parse(JSON.stringify(snap)) });
    // Deliver in send order, the way a single WebSocket does even when latency varies.
    while (toClient.length && toClient[0].at <= now) {
      predictor.onSnapshot(toClient.shift()!.snap);
      corrections.push(predictor.lastCorrection);
    }
    predictor.update(STEP);
    // Like OnlineSession: pings go out after the frame's update, the same point commands do.
    if (now % TICK_RATE === 0) send(predictor.calibration());
  };

  return {
    server,
    predictor,
    corrections,
    dummyId: dummy.unitId,
    run: (ticks: number) => {
      for (let i = 0; i < ticks; i++) tick();
    },
    issue: (cmd: PlayerCommand) => send(predictor.issue(cmd)),
    predicted: (): Vec => ({ ...predictor.unit()!.pos }),
    authoritative: (): Vec => ({ ...server.world.units.get(unitId)!.pos }),
  };
}

describe('Predictor', () => {
  it('moves your champion on the very next frame, before the server hears about it', () => {
    const h = harness(() => 4);
    h.run(TICK_RATE);
    const start = h.predicted();
    h.issue({ type: 'move', target: { x: start.x, y: start.y - 500 } });
    h.run(1);
    expect(h.predicted().y).toBeLessThan(start.y - 5);
    expect(h.authoritative()).toEqual(start);
  });

  it('agrees with the server exactly on a steady connection, so corrections stay zero', () => {
    const h = harness(() => 4);
    h.run(TICK_RATE * 2); // calibrate the offset first
    const start = h.predicted();
    h.corrections.length = 0;

    // Orb-walk-ish input: attack, step away mid-backswing, re-attack, a few moves.
    h.issue({ type: 'move', target: { x: start.x + 400, y: start.y } });
    h.run(20);
    h.issue({ type: 'attack', targetId: h.dummyId });
    h.run(12);
    h.issue({ type: 'move', target: { x: start.x + 300, y: start.y - 200 } });
    h.run(8);
    h.issue({ type: 'attack', targetId: h.dummyId });
    h.run(4);
    h.issue({ type: 'move', target: { x: start.x, y: start.y + 150 } }); // cancels that windup
    h.run(TICK_RATE * 2);

    expect(Math.max(...h.corrections)).toBeLessThan(1e-6);
    expect(dist(h.predicted(), h.authoritative())).toBeLessThan(1e-6);
  });

  it('stays close and converges on a jittery connection', () => {
    const h = harness((t) => 3 + ((t * 7) % 5)); // 3..7 ticks each way
    h.run(TICK_RATE * 2);
    const start = h.predicted();
    for (let i = 0; i < 6; i++) {
      h.issue({ type: 'move', target: { x: start.x + (i % 2 ? -250 : 250), y: start.y + i * 40 } });
      h.run(10);
    }
    h.run(TICK_RATE * 2); // stop and settle

    // A tick of misjudged latency is at most one tick of movement (330/30 = 11 units).
    expect(Math.max(...h.corrections)).toBeLessThan(25);
    expect(dist(h.predicted(), h.authoritative())).toBeLessThan(1e-6);
  });

  it('snaps on respawn instead of sliding across the map', () => {
    const h = harness(() => 4);
    h.run(TICK_RATE);
    const me = h.server.world.units.get(h.predictor.unit()!.id)!;
    h.issue({ type: 'move', target: { x: me.pos.x + 600, y: me.pos.y } });
    h.run(TICK_RATE * 2);
    me.hp = 1;
    h.server.world.issue({ type: 'cast', unitId: h.dummyId, slot: 'Q', target: me.pos });
    h.run(TICK_RATE * 5); // die, wait out the 3 s respawn
    expect(dist(h.predicted(), me.spawn)).toBeLessThan(1e-6);
    expect(h.predictor.renderPos()).toEqual(h.predicted());
  });
});
