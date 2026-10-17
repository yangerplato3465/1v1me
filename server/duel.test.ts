import { Client, type Room } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MSG, ROOM_NAME, type Snapshot, type Welcome } from '../src/net/protocol';
import type { SimEvent } from '../src/sim/world';
import { OnlineSession } from '../src/client/online';
import { CHAMPIONS } from '../src/sim/defs';
import { newRoomCode } from './DuelRoom';
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
/** Champions in a snapshot; the rest are turrets and minions. */
const champions = (s: Snapshot | null) => s?.units.filter((u) => u.champ in CHAMPIONS) ?? [];

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
    const s = await until(() => (champions(a.latest()).length === 2 ? a.latest() : null));
    expect(new Set(champions(s).map((u) => u.team))).toEqual(new Set(['blue', 'red']));
    expect(s.units.filter((u) => u.champ === 'turret-outer')).toHaveLength(2);

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

  it('spawns the champion picked in champion select, and falls back for unknown ids', async () => {
    const zed = track(await client().create(ROOM_NAME, { practice: true, champ: 'shadeblade' }));
    const { unitId } = await zed.welcome;
    expect(unitIn(await until(zed.latest), unitId)!.champ).toBe('shadeblade');
    const odd = track(await client().create(ROOM_NAME, { practice: true, champ: 'marksman' }));
    const odd_ = await odd.welcome;
    expect(unitIn(await until(odd.latest), odd_.unitId)!.champ).toBe('wayfinder');
    await Promise.all([zed.room.leave(), odd.room.leave()]);
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
    const s = await until(() => (champions(solo.latest()).length === 2 ? solo.latest() : null));
    expect(champions(s).some((u) => u.id !== unitId)).toBe(true);

    const other = await client().joinOrCreate(ROOM_NAME, {});
    expect(other.roomId).not.toBe(solo.room.roomId);
    await Promise.all([solo.room.leave(), other.leave()]);
  });

  it('the browser session mirrors snapshots and interpolates your champion', async () => {
    const session = await OnlineSession.connect(`http://localhost:${PORT}`, { mode: 'practice' });
    const frame = async () => {
      session.update(1 / 60);
      await new Promise((r) => setTimeout(r, 16));
    };
    const me = () => session.view.units.get(session.playerId);
    await until(async () => {
      await frame();
      return [...session.view.units.values()].filter((u) => !u.def.kind || u.def.kind === 'champion').length === 2 && me();
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
      const session = await OnlineSession.connect(`http://localhost:${PORT}`, { mode: 'practice' });
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

describe('leaving', () => {
  it('forfeits the match to the player who stayed, and nobody new can join it', async () => {
    const a = track(await client().joinOrCreate(ROOM_NAME, {}));
    const b = track(await client().joinOrCreate(ROOM_NAME, {}));
    expect(b.room.roomId).toBe(a.room.roomId);
    const { unitId } = await a.welcome;
    const myTeam = unitIn(await until(() => (champions(a.latest()).length === 2 ? a.latest() : null)), unitId)!.team;

    let over: SimEvent | undefined;
    a.room.onMessage(MSG.snapshot, (s: Snapshot) => (over ??= s.events.find((e) => e.type === 'gameOver')));
    await b.room.leave();
    expect(await until(() => over)).toEqual({ type: 'gameOver', winner: myTeam, reason: 'forfeit' });

    // The room is half empty again, but matchmaking must not refill it mid-match.
    const stranger = await client().joinOrCreate(ROOM_NAME, {});
    expect(stranger.roomId).not.toBe(a.room.roomId);
    await expect(client().joinById(a.room.roomId, {})).rejects.toThrow();
    await Promise.all([a.room.leave(), stranger.leave()]);
  });
});

describe('room codes', () => {
  it('"Create a room" gets a 4-digit code; a friend joins with it and the match starts', async () => {
    const host = track(await client().create(ROOM_NAME, { privateRoom: true }));
    const code = host.room.roomId;
    expect(code).toMatch(/^[1-9]\d{3}$/);

    // Matchmaking never puts a stranger in it.
    const stranger = await client().joinOrCreate(ROOM_NAME, {});
    expect(stranger.roomId).not.toBe(code);
    await stranger.leave();

    const friend = track(await client().joinById(code, {}));
    expect(friend.room.roomId).toBe(code);
    const s = await until(() => (champions(host.latest()).length === 2 ? host.latest() : null));
    expect(new Set(champions(s).map((u) => u.team))).toEqual(new Set(['blue', 'red']));

    // Two is a match: a third player can't get in, and a wrong code finds nothing.
    await expect(client().joinById(code, {})).rejects.toThrow();
    await expect(client().joinById(code === '9999' ? '9998' : '9999', {})).rejects.toThrow();
    await Promise.all([host.room.leave(), friend.room.leave()]);
  });

  it('online sessions show the code while waiting for the friend', async () => {
    const host = await OnlineSession.connect(`http://localhost:${PORT}`, { mode: 'create' });
    expect(host.roomCode).toMatch(/^[1-9]\d{3}$/);
    await until(() => {
      host.update(1 / 60);
      return host.view.units.get(host.playerId);
    });
    expect(host.banner()).toContain(`Room code  ${host.roomCode}`);

    const friend = await OnlineSession.connect(`http://localhost:${PORT}`, { mode: 'join', code: host.roomCode! });
    expect(friend.roomCode).toBe(host.roomCode);
    await until(() => {
      host.update(1 / 60);
      return host.banner() === null;
    });
    await Promise.all([host.leave(), friend.leave()]);
  });

  it('never hands out a code that is in use, and frees it when the room closes', async () => {
    const room = await client().create(ROOM_NAME, { privateRoom: true });
    const taken = room.roomId;
    const other = taken === '9999' ? '1000' : '9999';
    const roll = (code: string) => (Number(code) - 1000 + 0.5) / 9000;
    // A random source that lands on the taken code first, then on another.
    const rolls = () => {
      const values = [roll(taken), roll(other)];
      return () => values.shift() ?? roll(other);
    };
    expect(newRoomCode(rolls())).toBe(other);
    await room.leave();
    await until(() => newRoomCode(rolls()) === taken);
  });
});
