import { describe, expect, it } from 'vitest';
import { MARKSMAN, TICK_RATE } from './defs';
import { World, type SimEvent } from './world';

const STEP = 1 / TICK_RATE;

function setup(enemyX = 900) {
  const world = new World();
  const me = world.addUnit(MARKSMAN, 'blue', { x: 500, y: 800 });
  const foe = world.addUnit(MARKSMAN, 'red', { x: enemyX, y: 800 });
  return { world, me, foe };
}

function run(world: World, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    world.step(STEP);
    events.push(...world.drainEvents());
  }
  return events;
}

const damageTo = (events: SimEvent[], id: number) =>
  events.filter((e): e is Extract<SimEvent, { type: 'damage' }> => e.type === 'damage' && e.targetId === id);

describe('auto-attack windup', () => {
  it('moving during the windup cancels the attack and refunds it', () => {
    const { world, me, foe } = setup();
    world.issue({ type: 'attack', unitId: me.id, targetId: foe.id });
    run(world, 0.1);
    expect(me.windup).not.toBeNull();

    world.issue({ type: 'move', unitId: me.id, target: { x: 200, y: 800 } });
    expect(me.windup).toBeNull();
    expect(me.attackCooldown).toBe(0);

    const events = [...world.drainEvents(), ...run(world, 1)];
    expect(events.some((e) => e.type === 'attackCanceled')).toBe(true);
    expect(damageTo(events, foe.id)).toHaveLength(0);
  });

  it('moving after the windup (orb-walking) keeps the hit and the attack timer', () => {
    const { world, me, foe } = setup();
    world.issue({ type: 'attack', unitId: me.id, targetId: foe.id });
    const early = run(world, 0.4);
    expect(me.windup).toBeNull();
    expect(me.attackCooldown).toBeGreaterThan(0);

    world.issue({ type: 'move', unitId: me.id, target: { x: 200, y: 800 } });
    const events = [...early, ...world.drainEvents(), ...run(world, 1)];
    expect(events.some((e) => e.type === 'attackCanceled')).toBe(false);
    const hits = damageTo(events, foe.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].amount).toBe(MARKSMAN.attackDamage);
  });

  it('re-clicking the same target does not restart the windup', () => {
    const { world, me, foe } = setup();
    world.issue({ type: 'attack', unitId: me.id, targetId: foe.id });
    const events = run(world, 0.1);
    world.issue({ type: 'attack', unitId: me.id, targetId: foe.id });
    events.push(...run(world, 0.4));
    expect(events.some((e) => e.type === 'attackCanceled')).toBe(false);
    expect(damageTo(events, foe.id)).toHaveLength(1);
  });
});

describe('Q skillshot', () => {
  it('hits an enemy standing in its path', () => {
    const { world, me, foe } = setup(1300);
    world.issue({ type: 'castQ', unitId: me.id, target: foe.pos });
    const hits = damageTo(run(world, 1.5), foe.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'skillshot', amount: MARKSMAN.q.damage });
  });

  it('misses when aimed away and expires at max range', () => {
    const { world, me, foe } = setup(1300);
    world.issue({ type: 'castQ', unitId: me.id, target: { x: 1300, y: 0 } });
    const events = run(world, 1.5);
    expect(damageTo(events, foe.id)).toHaveLength(0);
    expect(events.some((e) => e.type === 'skillshotExpired')).toBe(true);
  });

  it('spends mana once and respects the cooldown', () => {
    const { world, me } = setup();
    world.issue({ type: 'castQ', unitId: me.id, target: { x: 900, y: 800 } });
    expect(me.mana).toBe(MARKSMAN.maxMana - MARKSMAN.q.manaCost);
    run(world, 1);
    world.issue({ type: 'castQ', unitId: me.id, target: { x: 900, y: 800 } });
    expect(me.cast).toBeNull();
    expect(me.qCooldown).toBeGreaterThan(2);
  });
});
