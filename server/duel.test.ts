import { Client, type Room } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MSG, ROOM_NAME, type Snapshot, type Welcome } from '../src/net/protocol';
import { OnlineSession } from '../src/client/online';
import { createServer } from './app';

const PORT = 2599;
const server = createServer();

interface Player {
  room: Room;
  welcome: Promise<Welcome>;
  latest: () => Snapshot | null;
}

function track(room: Room): Player {
  let latest: Snapshot | null = null;
  room.onMessage(MSG.snapshot, (s: Snapshot) => (latest = s));
  const welcome = new Promise<Welcome>((resolve) => room.onMessage(MSG.welcome, resolve));
  return { room, welcome, latest: () => latest };
}

async function until<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const client = () => new Client(`http://localhost:${PORT}`);
const unitIn = (s: Snapshot | null, id: number) => s?.units.find((u) => u.id === id);

beforeAll(async () => {
  await server.listen(PORT);
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

describe('DuelRoom', () => {
  it('pairs two players on opposite teams and only moves your own champion', async () => {
    const a = track(await client().joinOrCreate(ROOM_NAME, {}));
    const b = track(await client().joinOrCreate(ROOM_NAME, {}));
    expect(b.room.roomId).toBe(a.room.roomId);

    const [wa, wb] = await Promise.all([a.welcome, b.welcome]);
    const s = await until(() => (a.latest()?.units.length === 2 ? a.latest() : null));
    expect(new Set(s.units.map((u) => u.team))).toEqual(new Set(['blue', 'red']));

    const startA = unitIn(s, wa.unitId)!.pos;
    const startB = unitIn(s, wb.unitId)!.pos;
    // The forged unitId must be ignored: commands always drive the sender's own unit.
    a.room.send(MSG.command, { seq: 0, cmd: { type: 'move', target: { x: startA.x, y: startA.y - 300 }, unitId: wb.unitId } });

    const moved = await until(() => {
      const u = unitIn(b.latest(), wa.unitId);
      return u && u.pos.y < startA.y - 50 ? b.latest() : null;
    });
    expect(unitIn(moved, wb.unitId)!.pos).toEqual(startB);

    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('drops malformed commands', async () => {
    const a = track(await client().create(ROOM_NAME, { practice: true }));
    const { unitId } = await a.welcome;
    const start = unitIn(await until(a.latest), unitId)!.pos;
    a.room.send(MSG.command, { seq: 0, cmd: { type: 'move', target: { x: 'nope', y: 1 } } });
    a.room.send(MSG.command, { seq: 1, cmd: { type: 'cast', slot: 'Z', target: { x: 0, y: 0 } } });
    a.room.send(MSG.command, { cmd: { type: 'move', target: { x: 0, y: 0 } } });
    a.room.send(MSG.command, 'garbage');
    await new Promise((r) => setTimeout(r, 200));
    expect(unitIn(a.latest(), unitId)!.pos).toEqual(start);
    // Malformed commands are dropped, but valid seqs are still acknowledged.
    expect(a.latest()!.you?.ack).toBe(1);
    await a.room.leave();
  });

  it('runs a server-side bot in practice rooms and keeps them out of matchmaking', async () => {
    const solo = track(await client().create(ROOM_NAME, { practice: true }));
    const { unitId } = await solo.welcome;
    const s = await until(() => (solo.latest()?.units.length === 2 ? solo.latest() : null));
    expect(s.units.some((u) => u.id !== unitId)).toBe(true);

    const other = await client().joinOrCreate(ROOM_NAME, {});
    expect(other.roomId).not.toBe(solo.room.roomId);
    await Promise.all([solo.room.leave(), other.leave()]);
  });

  it('the browser session mirrors snapshots and interpolates your champion', async () => {
    const session = await OnlineSession.connect(`http://localhost:${PORT}`, true);
    const frame = async () => {
      session.update(1 / 60);
      await new Promise((r) => setTimeout(r, 16));
    };
    const me = () => session.view.units.get(session.playerId);
    await until(async () => {
      await frame();
      return session.view.units.size === 2 && me();
    });
    for (let i = 0; i < 10; i++) await frame();
    const start = session.renderPos(me()!);

    session.send({ type: 'move', target: { x: start.x, y: start.y - 400 } });
    const ys: number[] = [];
    for (let i = 0; i < 40; i++) {
      await frame();
      ys.push(session.renderPos(me()!).y);
    }
    expect(ys.at(-1)!).toBeLessThan(start.y - 100);
    // Interpolated: each frame moves a little, never a whole tick's worth backwards.
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-6);
    expect(session.status()).toContain('online practice');
    await session.leave();
  });

  it('predicts your own champion through a real laggy connection', async () => {
    server.simulateLatency(200);
    try {
      const session = await OnlineSession.connect(`http://localhost:${PORT}`, true);
      const frame = async () => {
        session.update(1 / 60);
        await new Promise((r) => setTimeout(r, 16));
      };
      const me = () => session.view.units.get(session.playerId);
      await until(async () => {
        await frame();
        return me();
      });
      for (let i = 0; i < 60; i++) await frame(); // let a calibration ping round-trip
      expect(session.status()).toMatch(/round trip ~\d+ ms/);

      const start = session.renderPos(me()!);
      session.send({ type: 'move', target: { x: start.x, y: start.y - 400 } });
      for (let i = 0; i < 3; i++) await frame();
      // ~50 ms in: far less than the 200 ms round trip, yet the champion is already moving.
      expect(session.renderPos(me()!).y).toBeLessThan(start.y - 5);
      await session.leave();
    } finally {
      server.simulateLatency(0);
    }
  });
});

