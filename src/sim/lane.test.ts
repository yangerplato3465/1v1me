import { describe, expect, it } from 'vitest';
import { PracticeBot } from './bot';
import {
  CASTER_MINION,
  FOUNTAINS,
  MELEE_MINION,
  OUTER_TURRET,
  SIEGE_MINION,
  TICK_RATE,
  TURRET_POSITIONS,
  WAVES,
  WAYFINDER,
} from './defs';
import { Lane, hasSiegeMinion } from './lane';
import { dist } from './math';
import { World, isMinion, type SimEvent, type Team, type Unit } from './world';

const STEP = 1 / TICK_RATE;

function setup() {
  const world = new World();
  const lane = new Lane(world);
  const events: SimEvent[] = [];
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      each?.();
      lane.update(STEP);
      world.step(STEP);
      events.push(...world.drainEvents());
    }
  };
  const turret = (team: Team) => [...world.units.values()].find((u) => u.def === OUTER_TURRET && u.team === team)!;
  const minions = (team?: Team) => [...world.units.values()].filter((u) => isMinion(u) && (!team || u.team === team));
  return { world, lane, events, run, turret, minions };
}

const damageTo = (events: SimEvent[], u: Unit) =>
  events.filter((e): e is Extract<SimEvent, { type: 'damage' }> => e.type === 'damage' && e.targetId === u.id);

describe('minion waves', () => {
  it('spawns 3 melee and 3 casters per side, from the first wave on, every 30 s', () => {
    const { run, minions, lane } = setup();
    run(WAVES.firstAt - 0.1);
    expect(minions()).toHaveLength(0);
    run(0.2);
    for (const team of ['blue', 'red'] as Team[]) {
      const wave = minions(team);
      expect(wave.filter((m) => m.def === MELEE_MINION)).toHaveLength(3);
      expect(wave.filter((m) => m.def === CASTER_MINION)).toHaveLength(3);
      expect(wave.filter((m) => m.def === SIEGE_MINION)).toHaveLength(0);
    }
    run(WAVES.interval);
    expect(lane.waves).toBe(2);
  });

  it('adds a siege minion every 3rd wave, every 2nd after 15:00 and every wave after 25:00', () => {
    expect([1, 2, 3, 4, 5, 6].map((w) => hasSiegeMinion(w, 60))).toEqual([false, false, true, false, false, true]);
    expect([1, 2, 3, 4].map((w) => hasSiegeMinion(w, 16 * 60))).toEqual([false, true, false, true]);
    expect([1, 2, 3].map((w) => hasSiegeMinion(w, 26 * 60))).toEqual([true, true, true]);
  });

  it('march down the lane, meet in the middle and fight; the dead are gone for good', () => {
    const { run, minions, events, world } = setup();
    run(WAVES.firstAt + 0.1);
    const blueStart = Math.max(...minions('blue').map((m) => m.pos.x));
    run(4);
    expect(Math.max(...minions('blue').map((m) => m.pos.x))).toBeGreaterThan(blueStart + 1000);
    run(20);
    const deaths = events.filter((e) => e.type === 'death' && e.kind === 'minion');
    expect(deaths.length).toBeGreaterThan(0);
    for (const d of deaths) if (d.type === 'death') expect(world.units.has(d.unitId)).toBe(false);
    // They fought around the middle of the lane, not at a turret.
    const where = deaths.map((d) => (d.type === 'death' ? d.pos.x : 0));
    expect(Math.min(...where)).toBeGreaterThan(TURRET_POSITIONS.blue.x + 750);
    expect(Math.max(...where)).toBeLessThan(TURRET_POSITIONS.red.x - 750);
  });
});

describe('turret', () => {
  it('shoots minions for a share of their max health: 45% melee, 70% caster, 14% siege', () => {
    const { world, run, turret, events } = setup();
    const red = turret('red');
    const at = { x: red.pos.x - 500, y: red.pos.y };
    const melee = world.addUnit(MELEE_MINION, 'blue', at);
    const caster = world.addUnit(CASTER_MINION, 'blue', { x: at.x, y: at.y + 200 });
    const siege = world.addUnit(SIEGE_MINION, 'blue', { x: at.x, y: at.y - 200 });
    for (const m of [melee, caster, siege]) m.def = { ...m.def, moveSpeed: 0, attackDamage: 0 }; // stand still, harmless
    run(8);
    const shots = (u: Unit) => damageTo(events, u).filter((e) => e.sourceId === red.id).map((e) => e.amount);
    expect(shots(melee)[0]).toBeCloseTo(477 * 0.45);
    expect(shots(caster)[0]).toBeCloseTo(296 * 0.7);
    expect(shots(siege)[0]).toBeCloseTo(912 * 0.14);
    expect(world.units.has(melee.id)).toBe(false); // three shots
    expect(shots(melee)).toHaveLength(3);
  });

  it('heats up on the same champion: +40% per consecutive shot, up to +120%', () => {
    const { world, run, turret, events } = setup();
    const red = turret('red');
    const diver = world.addUnit(WAYFINDER, 'blue', { x: red.pos.x - 400, y: red.pos.y });
    diver.def = { ...diver.def, maxHp: 1e6 };
    diver.hp = 1e6;
    run(6.5);
    const shots = damageTo(events, diver).map((e) => e.amount);
    expect(shots.slice(0, 5).map((d) => Math.round(d * 10) / 10)).toEqual([152, 212.8, 273.6, 334.4, 334.4]);
  });

  it('switches from a minion to a champion who hits an allied champion in its range', () => {
    const { world, run, turret, events } = setup();
    const red = turret('red');
    const minion = world.addUnit(MELEE_MINION, 'blue', { x: red.pos.x - 300, y: red.pos.y });
    minion.def = { ...minion.def, maxHp: 1e6, moveSpeed: 0, attackDamage: 0 };
    minion.hp = 1e6;
    const victim = world.addUnit(WAYFINDER, 'red', { x: red.pos.x + 200, y: red.pos.y });
    const attacker = world.addUnit(WAYFINDER, 'blue', { x: red.pos.x - 450, y: red.pos.y + 200 });
    run(1.5);
    expect(red.order).toEqual({ kind: 'attack', targetId: minion.id });

    world.issue({ type: 'attack', unitId: attacker.id, targetId: victim.id });
    run(2.5);
    expect(red.order).toEqual({ kind: 'attack', targetId: attacker.id });
    expect(damageTo(events, attacker).some((e) => e.sourceId === red.id)).toBe(true);
  });

  it('only basic attacks damage it: skillshots fly past and area abilities ignore it', () => {
    const { world, run, turret, events } = setup();
    const red = turret('red');
    const me = world.addUnit(WAYFINDER, 'blue', { x: red.pos.x - 1100, y: red.pos.y });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: red.pos });
    run(1);
    expect(damageTo(events, red)).toHaveLength(0);
    expect(events.some((e) => e.type === 'skillshotExpired')).toBe(true);

    world.issue({ type: 'attack', unitId: me.id, targetId: red.id });
    run(3);
    expect(damageTo(events, red).length).toBeGreaterThan(0);
    expect(damageTo(events, red).every((e) => e.source === 'attack')).toBe(true);
  });

  it('nobody walks through it', () => {
    const { world, run, turret } = setup();
    const blue = turret('blue');
    const me = world.addUnit(WAYFINDER, 'blue', { x: blue.pos.x - 400, y: blue.pos.y });
    let closest = Infinity;
    world.issue({ type: 'move', unitId: me.id, target: { x: blue.pos.x + 400, y: blue.pos.y } });
    run(4, () => (closest = Math.min(closest, dist(me.pos, blue.pos))));
    expect(closest).toBeGreaterThanOrEqual(me.def.radius + blue.def.radius - 1e-6);
    expect(dist(me.pos, { x: blue.pos.x + 400, y: blue.pos.y })).toBeLessThan(1e-6);
  });
});

describe('minion targeting', () => {
  it('drops other minions to answer a champion hitting an allied champion', () => {
    const { world, run, events } = setup();
    const x = 4000;
    const y = 750;
    const redMinion = world.addUnit(CASTER_MINION, 'red', { x: x + 400, y });
    const blueMinion = world.addUnit(MELEE_MINION, 'blue', { x: x + 300, y });
    for (const m of [redMinion, blueMinion]) {
      m.def = { ...m.def, maxHp: 1e6 };
      m.hp = 1e6;
    }
    const victim = world.addUnit(WAYFINDER, 'blue', { x: x - 100, y: y + 300 });
    const harasser = world.addUnit(WAYFINDER, 'red', { x: x + 400, y: y + 300 });
    run(1);
    expect(redMinion.order).toEqual({ kind: 'attack', targetId: blueMinion.id }); // closest minion first

    world.issue({ type: 'attack', unitId: harasser.id, targetId: victim.id });
    run(1.5);
    expect(blueMinion.order).toEqual({ kind: 'attack', targetId: harasser.id });
    expect(damageTo(events, harasser).some((e) => e.sourceId === blueMinion.id)).toBe(true);
  });

  it('pays the last hitter: gold to whoever lands the killing blow', () => {
    const { world, run, events } = setup();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 4000, y: 750 });
    const minion = world.addUnit(CASTER_MINION, 'red', { x: 4400, y: 750 });
    minion.hp = 50;
    world.issue({ type: 'attack', unitId: me.id, targetId: minion.id });
    run(1.5);
    const death = events.find((e) => e.type === 'death');
    expect(death).toMatchObject({ unitId: minion.id, killerId: me.id, kind: 'minion', bounty: 14 });
  });
});

describe('champion abilities on the lane', () => {
  it('Rune Orb passes through minions to the champion behind them', () => {
    const { world, run, events } = setup();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 3500, y: 750 });
    const minion = world.addUnit(MELEE_MINION, 'red', { x: 3900, y: 750 });
    const foe = world.addUnit(WAYFINDER, 'red', { x: 4300, y: 750 });
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: foe.pos });
    run(0.8);
    expect(damageTo(events, minion).filter((e) => e.sourceId === me.id)).toHaveLength(0);
    expect(foe.statuses.some((s) => s.kind === 'mark')).toBe(true);
  });

  it('Arcane Bolt stops on the first minion; the barrage deals half damage to minions', () => {
    const { world, run, events } = setup();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 3500, y: 750 });
    const minion = world.addUnit(SIEGE_MINION, 'red', { x: 3900, y: 750 });
    const foe = world.addUnit(WAYFINDER, 'red', { x: 4300, y: 750 });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foe.pos });
    run(0.8);
    expect(damageTo(events, minion).map((e) => e.amount)).toEqual([98]);
    expect(damageTo(events, foe)).toHaveLength(0);

    world.issue({ type: 'cast', unitId: me.id, slot: 'R', target: foe.pos });
    run(2);
    expect(damageTo(events, minion).filter((e) => e.source === 'R').map((e) => e.amount)).toEqual([175]);
    expect(damageTo(events, foe).filter((e) => e.source === 'R').map((e) => e.amount)).toEqual([350]);
  });
});

describe('fountain', () => {
  it('heals champions standing in their own fountain only', () => {
    const { world, run } = setup();
    const home = world.addUnit(WAYFINDER, 'blue', FOUNTAINS.blue);
    const away = world.addUnit(WAYFINDER, 'red', { x: FOUNTAINS.blue.x, y: FOUNTAINS.blue.y + 100 });
    home.hp = away.hp = 100;
    run(1);
    expect(home.hp).toBeGreaterThan(150);
    expect(away.hp).toBeLessThan(105);
  });
});

describe('PracticeBot on the lane', () => {
  it('farms minions with last hits and keeps out of the enemy turret when it has no minions there', () => {
    const { world, lane, events, turret } = setup();
    const player = world.addUnit(WAYFINDER, 'blue', FOUNTAINS.blue); // stays home
    const botUnit = world.addUnit(WAYFINDER, 'red', FOUNTAINS.red);
    const bot = new PracticeBot(world, botUnit.id, player.id, () => 0.5);
    const blueTurret = turret('blue');
    let closest = Infinity;
    for (let i = 0; i < 45 * TICK_RATE; i++) {
      bot.update(STEP);
      lane.update(STEP);
      world.step(STEP);
      events.push(...world.drainEvents());
      const redMinionsNear = [...world.units.values()].some(
        (u) => isMinion(u) && u.team === 'red' && dist(u.pos, blueTurret.pos) < 900,
      );
      if (!redMinionsNear) closest = Math.min(closest, dist(botUnit.pos, blueTurret.pos));
    }
    const lastHits = events.filter((e) => e.type === 'death' && e.kind === 'minion' && e.killerId === botUnit.id);
    expect(lastHits.length).toBeGreaterThan(0);
    expect(closest).toBeGreaterThan(OUTER_TURRET.attackRange + OUTER_TURRET.radius + botUnit.def.radius);
  });
});
