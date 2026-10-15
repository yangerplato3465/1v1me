import { describe, expect, it } from 'vitest';
import { MARKSMAN, TICK_RATE, type SkillshotAbility } from './defs';
import { World, type SimEvent } from './world';

const STEP = 1 / TICK_RATE;
const Q = MARKSMAN.abilities.Q as SkillshotAbility;

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
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foe.pos });
    const hits = damageTo(run(world, 1.5), foe.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'Q', amount: Q.damage });
  });

  it('misses when aimed away and expires at max range', () => {
    const { world, me, foe } = setup(1300);
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 1300, y: 0 } });
    const events = run(world, 1.5);
    expect(damageTo(events, foe.id)).toHaveLength(0);
    expect(events.some((e) => e.type === 'skillshotExpired')).toBe(true);
  });

  it('spends mana once and respects the cooldown', () => {
    const { world, me } = setup();
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    expect(me.mana).toBe(MARKSMAN.maxMana - Q.manaCost);
    run(world, 1);
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    expect(me.cast).toBeNull();
    expect(me.cooldowns.Q).toBeGreaterThan(2);
  });

  it('ignores slots the champion has no ability in', () => {
    const { world, me } = setup();
    world.issue({ type: 'cast', unitId: me.id, slot: 'R', target: { x: 900, y: 800 } });
    expect(me.cast).toBeNull();
    expect(me.mana).toBe(MARKSMAN.maxMana);
  });
});

describe('LoL attack details', () => {
  it('commits the attack in the last tick of the windup: moving then no longer cancels it', () => {
    const windupTicks = Math.round((MARKSMAN.windupPct / MARKSMAN.attackSpeed) * TICK_RATE); // 8

    const early = setup();
    early.world.issue({ type: 'attack', unitId: early.me.id, targetId: early.foe.id });
    run(early.world, (windupTicks - 1) / TICK_RATE); // two ticks of windup left
    early.world.issue({ type: 'move', unitId: early.me.id, target: { x: 200, y: 800 } });
    expect(damageTo(run(early.world, 1), early.foe.id)).toHaveLength(0);

    const late = setup();
    late.world.issue({ type: 'attack', unitId: late.me.id, targetId: late.foe.id });
    run(late.world, windupTicks / TICK_RATE); // one tick left: the grace tick
    late.world.issue({ type: 'move', unitId: late.me.id, target: { x: 200, y: 800 } });
    expect(damageTo(run(late.world, 1), late.foe.id)).toHaveLength(1);
    expect(late.me.pos.x).toBeLessThan(500); // and the move still happens right after
  });

  it('measures attack range edge to edge, like LoL', () => {
    const reach = MARKSMAN.attackRange + 2 * MARKSMAN.radius;
    const inRange = setup(500 + reach);
    inRange.world.issue({ type: 'attack', unitId: inRange.me.id, targetId: inRange.foe.id });
    run(inRange.world, 0.1);
    expect(inRange.me.windup).not.toBeNull();
    expect(inRange.me.pos.x).toBe(500);

    const outOfRange = setup(500 + reach + 30);
    outOfRange.world.issue({ type: 'attack', unitId: outOfRange.me.id, targetId: outOfRange.foe.id });
    run(outOfRange.world, 0.05);
    expect(outOfRange.me.pos.x).toBeGreaterThan(500);
  });
});

