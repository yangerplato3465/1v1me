import { describe, expect, it } from 'vitest';
import { CASTER_MINION, MELEE_MINION, SHADEBLADE, TICK_RATE, WAYFINDER } from './defs';
import { SPELL_BUFFER_SECONDS, World, type SimEvent } from './world';

// LoL's input feel: postponed spells, move-to-cast, auto-attack and attack-move targeting.

const STEP = 1 / TICK_RATE;

function run(world: World, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    world.step(STEP);
    events.push(...world.drainEvents());
  }
  return events;
}

const casts = (events: SimEvent[]) => events.filter((e) => e.type === 'castStart').map((e) => (e.type === 'castStart' ? e.slot : ''));

describe('postponed spells', () => {
  it('a spell pressed during another cast goes off right after it', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: { x: 900, y: 800 } }); // mid-cast
    const events = [...world.drainEvents(), ...run(world, 0.6)];
    expect(casts(events)).toEqual(['Q', 'W']);
  });

  it('a newer press replaces the queued one, and a move clears it', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: { x: 900, y: 800 } });
    world.issue({ type: 'cast', unitId: me.id, slot: 'E', target: { x: 900, y: 800 } });
    expect(casts([...world.drainEvents(), ...run(world, 0.6)])).toEqual(['Q', 'E']); // like Riot's E, W, Q example

    const other = new World();
    const you = other.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    other.issue({ type: 'cast', unitId: you.id, slot: 'Q', target: { x: 900, y: 800 } });
    other.issue({ type: 'cast', unitId: you.id, slot: 'W', target: { x: 900, y: 800 } });
    other.issue({ type: 'move', unitId: you.id, target: { x: 500, y: 600 } });
    expect(casts([...other.drainEvents(), ...run(other, 0.6)])).toEqual(['Q']);
  });

  it('a press in the last moments of a cooldown casts the moment it is ready; too early and it is dropped', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    me.cooldowns.Q = SPELL_BUFFER_SECONDS - 0.1;
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    expect(casts(run(world, SPELL_BUFFER_SECONDS))).toEqual(['Q']);

    me.cooldowns.W = SPELL_BUFFER_SECONDS + 0.3;
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: { x: 900, y: 800 } });
    expect(casts(run(world, 1))).toEqual([]);
  });
});

describe('move-to-cast', () => {
  it('a targeted ultimate on an enemy out of range walks into range, then casts', () => {
    const world = new World();
    const me = world.addUnit(SHADEBLADE, 'blue', { x: 500, y: 800 });
    const foe = world.addUnit(WAYFINDER, 'red', { x: 1600, y: 800 });
    world.issue({ type: 'cast', unitId: me.id, slot: 'R', target: foe.pos });
    expect(me.order).toEqual({ kind: 'castMove', slot: 'R', targetId: foe.id });
    const events = run(world, 3); // ~1.2 s walking, 0.6 s wait, 0.35 s dash
    expect(casts(events)).toEqual(['R']);
    expect(events.some((e) => e.type === 'deathMarked' && e.unitId === foe.id)).toBe(true);
  });
});

describe('auto attack', () => {
  it('an idle champion attacks an enemy that comes into range, without chasing it out', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    me.autoAttack = true;
    const minion = world.addUnit(MELEE_MINION, 'red', { x: 900, y: 800 });
    run(world, 0.2);
    expect(me.order).toEqual({ kind: 'attack', targetId: minion.id, auto: true });
    minion.pos = { x: 1600, y: 800 };
    run(world, 0.5);
    expect(me.order.kind).toBe('idle');
    expect(me.pos).toEqual({ x: 500, y: 800 });
  });

  it('Stop pauses it until the next order; turning it off stops it', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    world.issue({ type: 'autoAttack', unitId: me.id, enabled: true });
    world.addUnit(MELEE_MINION, 'red', { x: 900, y: 800 });
    world.issue({ type: 'stop', unitId: me.id });
    run(world, 0.5);
    expect(me.order.kind).toBe('idle');
    world.issue({ type: 'move', unitId: me.id, target: { x: 510, y: 800 } });
    run(world, 0.5);
    expect(me.order.kind).toBe('attack');

    world.issue({ type: 'autoAttack', unitId: me.id, enabled: false });
    world.issue({ type: 'stop', unitId: me.id });
    world.issue({ type: 'move', unitId: me.id, target: { x: 500, y: 800 } });
    run(world, 0.5);
    expect(me.order.kind).toBe('idle');
  });
});

describe('attack-move', () => {
  it('targets the enemy nearest the champion by default, or near the cursor with that option', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    const near = world.addUnit(CASTER_MINION, 'red', { x: 800, y: 800 });
    const byCursor = world.addUnit(CASTER_MINION, 'red', { x: 1050, y: 900 });
    world.issue({ type: 'attackMove', unitId: me.id, target: { x: 1060, y: 900 } });
    expect(me.order).toEqual({ kind: 'attack', targetId: near.id });
    world.issue({ type: 'attackMove', unitId: me.id, target: { x: 1060, y: 900 }, onCursor: true });
    expect(me.order).toEqual({ kind: 'attack', targetId: byCursor.id });
  });

  it('with "target champions only" it skips minions', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
    world.addUnit(CASTER_MINION, 'red', { x: 700, y: 800 });
    const champ = world.addUnit(WAYFINDER, 'red', { x: 1000, y: 800 });
    world.issue({ type: 'attackMove', unitId: me.id, target: { x: 1500, y: 800 }, championsOnly: true });
    expect(me.order).toEqual({ kind: 'attack', targetId: champ.id });
  });
});
