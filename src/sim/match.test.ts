import { describe, expect, it } from 'vitest';
import { Authority } from '../net/authority';
import { CASTER_MINION, CS_TO_WIN, OUTER_TURRET, START_LEVEL, TICK_RATE, TURRET_POSITIONS, WAYFINDER } from './defs';
import { Lane } from './lane';
import { World, type SimEvent } from './world';

const STEP = 1 / TICK_RATE;

function setup() {
  const world = new World();
  const lane = new Lane(world);
  const blue = world.addUnit(WAYFINDER, 'blue', { x: 3800, y: 750 }, { level: START_LEVEL });
  const red = world.addUnit(WAYFINDER, 'red', { x: 4300, y: 750 }, { level: START_LEVEL });
  const events: SimEvent[] = [];
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      lane.update(STEP);
      world.step(STEP);
      events.push(...world.drainEvents());
    }
  };
  const over = () => events.filter((e) => e.type === 'gameOver');
  return { world, lane, blue, red, run, over };
}

describe('win conditions', () => {
  it('first blood: the first champion to die loses, and the match stops there', () => {
    const { world, lane, blue, red, run, over } = setup();
    red.hp = 1;
    world.issue({ type: 'attack', unitId: blue.id, targetId: red.id });
    run(2);
    expect(over()).toEqual([{ type: 'gameOver', winner: 'blue', reason: 'firstBlood' }]);
    expect(world.result).toEqual({ winner: 'blue', reason: 'firstBlood' });

    // Frozen: no time passes, nobody moves, no waves come.
    const time = world.time;
    const laneTime = lane.time;
    world.issue({ type: 'move', unitId: blue.id, target: { x: 3000, y: 750 } });
    const pos = { ...blue.pos };
    run(30);
    expect([world.time, lane.time, blue.pos]).toEqual([time, laneTime, pos]);
    expect(over()).toHaveLength(1);
  });

  it('first turret: the side whose turret falls first loses', () => {
    const { world, blue, run, over } = setup();
    const turret = [...world.units.values()].find((u) => u.def === OUTER_TURRET && u.team === 'red')!;
    blue.pos = { x: TURRET_POSITIONS.red.x - 600, y: 750 };
    turret.hp = 1;
    world.issue({ type: 'attack', unitId: blue.id, targetId: turret.id });
    run(2);
    expect(over()).toEqual([{ type: 'gameOver', winner: 'blue', reason: 'firstTurret' }]);
  });

  it(`CS: the first champion to last-hit ${CS_TO_WIN} minions wins; minions killing minions don't count`, () => {
    const { world, red, run, over } = setup();
    world.cs.set(red.id, CS_TO_WIN - 2);
    const lastHit = () => {
      const minion = world.addUnit(CASTER_MINION, 'blue', { x: red.pos.x - 400, y: 750 });
      minion.hp = 1;
      world.issue({ type: 'attack', unitId: red.id, targetId: minion.id });
      run(1.5);
    };
    lastHit();
    expect(world.cs.get(red.id)).toBe(CS_TO_WIN - 1);
    expect(over()).toHaveLength(0);
    lastHit();
    expect(over()).toEqual([{ type: 'gameOver', winner: 'red', reason: 'cs' }]);
  });

  it('a sandbox world without a lane never ends', () => {
    const world = new World();
    const a = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    const b = world.addUnit(WAYFINDER, 'red', { x: 900, y: 800 });
    b.hp = 1;
    world.issue({ type: 'attack', unitId: a.id, targetId: b.id });
    for (let i = 0; i < TICK_RATE * 2; i++) world.step(STEP);
    expect(world.drainEvents().some((e) => e.type === 'gameOver')).toBe(false);
    expect(world.result).toBeNull();
  });

  it('online, the game-over event reaches every player in the snapshot', () => {
    const match = new Authority();
    const { unitId } = match.join('a');
    match.join('b');
    const red = [...match.world.units.values()].find((u) => u.team === 'red' && u.id !== unitId && u.def === WAYFINDER)!;
    red.respawnIn = 0;
    red.hp = 1;
    match.world.units.get(unitId)!.pos = { x: red.pos.x - 500, y: red.pos.y };
    match.receive('a', { seq: 1, cmd: { type: 'attack', targetId: red.id } });
    const events: SimEvent[] = [];
    for (let i = 0; i < TICK_RATE * 2; i++) events.push(...match.step(STEP).events);
    expect(events.filter((e) => e.type === 'gameOver')).toEqual([{ type: 'gameOver', winner: 'blue', reason: 'firstBlood' }]);
  });
});
