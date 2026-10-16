import { describe, expect, it } from 'vitest';
import { PracticeBot } from './bot';
import {
  CASTER_MINION,
  FOUNTAINS,
  ITEM_AD,
  MELEE_MINION,
  MINION_SPAWNS,
  OUTER_TURRET,
  SIEGE_MINION,
  TICK_RATE,
  TURRET_POSITIONS,
  WAVES,
  WAYFINDER,
  type ChampionDef,
} from './defs';
import { Lane, MINION_ACQUISITION_RANGE, waveComposition, waveInterval } from './lane';
import { dist } from './math';
import { CALL_SECONDS, World, isMinion, statsAt, type SimEvent, type Team, type Unit } from './world';

const STEP = 1 / TICK_RATE;

/** Changes a unit's stats for a test, keeping its level-based stats in step. */
function tweak(u: Unit, changes: Partial<ChampionDef>): void {
  u.def = { ...u.def, ...changes };
  u.stats = statsAt(u.def, u.level);
}

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
  it('walks the first wave out single file, one minion every 0.792 s: 3 melee, then 3 casters', () => {
    const { run, minions, lane } = setup();
    run(WAVES.firstAt - 0.1);
    expect(minions()).toHaveLength(0);
    const spawned: { id: string; at: number; pos: { x: number; y: number } }[] = [];
    const seen = new Set<number>();
    run(6, () => {
      for (const m of minions('blue')) if (!seen.has(m.id)) (seen.add(m.id), spawned.push({ id: m.def.id, at: lane.time, pos: { ...m.pos } }));
    });
    expect(spawned.map((s) => s.id)).toEqual(['minion-melee', 'minion-melee', 'minion-melee', 'minion-caster', 'minion-caster', 'minion-caster']);
    for (let i = 1; i < spawned.length; i++) expect(spawned[i].at - spawned[i - 1].at).toBeCloseTo(WAVES.spawnSpacing, 1);
    // All from the same spot, in a line behind each other (seen at most one step after leaving).
    for (const s of spawned) {
      expect(s.pos.y).toBe(MINION_SPAWNS.blue.y);
      expect(dist(s.pos, MINION_SPAWNS.blue)).toBeLessThanOrEqual(MELEE_MINION.moveSpeed * STEP + 1e-6);
    }
    expect(minions('red')).toHaveLength(6);
    run(WAVES.interval[0][1]);
    expect(lane.waves).toBe(2);
  });

  it('follows LoL\'s wave schedule: siege from wave 3, faster waves and smaller waves later on', () => {
    const ids = (time: number, since: number) => waveComposition(time, since).units.map((d) => d.id.replace('minion-', ''));
    expect(ids(30, 1)).toEqual(['melee', 'melee', 'melee', 'caster', 'caster', 'caster']);
    expect(ids(90, 3)).toEqual(['melee', 'melee', 'melee', 'siege', 'caster', 'caster', 'caster']);
    expect(waveComposition(14 * 60, 2).siege).toBe(true); // every 2nd wave from 14:00…
    expect(ids(14 * 60, 2)).toEqual(['melee', 'melee', 'siege', 'caster', 'caster', 'caster']); // …with one melee fewer
    expect(waveComposition(25 * 60, 1).siege).toBe(true); // every wave from 25:00
    expect(ids(30 * 60, 1)).toEqual(['melee', 'melee', 'siege', 'caster', 'caster']);
    expect([0, 14 * 60, 30 * 60].map(waveInterval)).toEqual([30, 25, 20]);

    const { run, lane, minions } = setup();
    run(WAVES.firstAt + 60 + 6); // the first wave, then 30 and 60 s later
    expect(lane.waves).toBe(3);
    expect(minions('blue').filter((m) => m.def === SIEGE_MINION)).toHaveLength(1);
  });

  it('march down the lane, meet in the middle and fight; the dead are gone for good', () => {
    const { run, minions, events, world } = setup();
    run(WAVES.firstAt + 0.1);
    const blueStart = Math.max(...minions('blue').map((m) => m.pos.x));
    run(4);
    expect(Math.max(...minions('blue').map((m) => m.pos.x))).toBeGreaterThan(blueStart + 1000);
    run(25);
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
    for (const m of [melee, caster, siege]) tweak(m, { moveSpeed: 0, attackDamage: 0 }); // stand still, harmless
    run(17); // siege first (8 shots), then melee (3), then caster (2)
    const shots = (u: Unit) => damageTo(events, u).filter((e) => e.sourceId === red.id).map((e) => e.amount);
    expect(shots(melee)[0]).toBeCloseTo(MELEE_MINION.maxHp * 0.45);
    expect(shots(caster)[0]).toBeCloseTo(CASTER_MINION.maxHp * 0.7);
    expect(shots(siege)[0]).toBeCloseTo(SIEGE_MINION.maxHp * 0.14);
    expect(world.units.has(melee.id)).toBe(false); // three shots
    expect(shots(melee)).toHaveLength(3);
  });

  it('heats up on champions: +50% per shot, up to +150%, cooling off 5 s after its last champion shot', () => {
    const { world, run, turret, events } = setup();
    const red = turret('red');
    const diver = world.addUnit(WAYFINDER, 'blue', { x: red.pos.x - 400, y: red.pos.y });
    tweak(diver, { maxHp: 1e6 });
    diver.hp = 1e6;
    run(6.5);
    const shots = damageTo(events, diver).map((e) => e.amount);
    expect(shots.slice(0, 5)).toEqual([182, 273, 364, 455, 455]);

    // Walk out, wait the heat off, walk back in: back to base damage.
    diver.pos = { x: red.pos.x - 1500, y: red.pos.y };
    run(6);
    const before = damageTo(events, diver).length;
    diver.pos = { x: red.pos.x - 400, y: red.pos.y };
    run(1.5);
    expect(damageTo(events, diver).map((e) => e.amount)[before]).toBe(182);
  });

  it('picks siege minions first, then melee, then casters, then champions, and keeps its target', () => {
    const { world, run, turret } = setup();
    const red = turret('red');
    const near = { x: red.pos.x - 300, y: red.pos.y };
    const champ = world.addUnit(WAYFINDER, 'blue', { x: near.x, y: near.y + 250 });
    const caster = world.addUnit(CASTER_MINION, 'blue', { x: near.x + 100, y: near.y });
    const siege = world.addUnit(SIEGE_MINION, 'blue', { x: near.x - 300, y: near.y - 200 });
    for (const u of [champ, caster, siege]) tweak(u, { moveSpeed: 0, attackDamage: 0, maxHp: 1e6 });
    for (const u of [champ, caster, siege]) u.hp = 1e6;
    run(1);
    expect(red.order).toEqual({ kind: 'attack', targetId: siege.id });
    const melee = world.addUnit(MELEE_MINION, 'blue', { x: near.x + 50, y: near.y });
    tweak(melee, { moveSpeed: 0, attackDamage: 0 });
    run(1);
    expect(red.order).toEqual({ kind: 'attack', targetId: siege.id }); // no switching to a new arrival
  });

  it('switches to a champion hurting an allied champion even with a skillshot; minions ignore skillshots', () => {
    const { world, run, turret } = setup();
    const red = turret('red');
    const at = (dx: number, dy: number) => ({ x: red.pos.x + dx, y: red.pos.y + dy });
    const target = world.addUnit(MELEE_MINION, 'blue', at(-300, 0)); // keeps the turret busy
    const minion = world.addUnit(CASTER_MINION, 'red', at(-450, -650));
    const bait = world.addUnit(MELEE_MINION, 'blue', at(-450, -450)); // keeps that minion busy
    for (const m of [target, minion, bait]) tweak(m, { moveSpeed: 0, attackDamage: 0, maxHp: 1e6 });
    for (const m of [target, minion, bait]) m.hp = 1e6;
    const victim = world.addUnit(WAYFINDER, 'red', at(-1100, 0));
    const poker = world.addUnit(WAYFINDER, 'blue', at(-650, -300));
    run(1);
    expect(red.order).toEqual({ kind: 'attack', targetId: target.id });
    expect(minion.order).toEqual({ kind: 'attack', targetId: bait.id });
    world.issue({ type: 'cast', unitId: poker.id, slot: 'Q', target: victim.pos });
    run(1);
    expect(victim.hp).toBeLessThan(victim.def.maxHp - 90); // the bolt landed
    expect(red.order).toEqual({ kind: 'attack', targetId: poker.id });
    expect(minion.order).toEqual({ kind: 'attack', targetId: bait.id });

    // A basic attack on the same champion does draw the minion.
    world.issue({ type: 'attack', unitId: poker.id, targetId: victim.id });
    run(1.5);
    expect(minion.order).toEqual({ kind: 'attack', targetId: poker.id });
  });

  it('switches from a minion to a champion who hits an allied champion in its range', () => {
    const { world, run, turret, events } = setup();
    const red = turret('red');
    const minion = world.addUnit(MELEE_MINION, 'blue', { x: red.pos.x - 300, y: red.pos.y });
    tweak(minion, { maxHp: 1e6, moveSpeed: 0, attackDamage: 0 });
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
      tweak(m, { maxHp: 1e6 });
      m.hp = 1e6;
    }
    const victim = world.addUnit(WAYFINDER, 'blue', { x: x - 100, y: y + 300 });
    const harasser = world.addUnit(WAYFINDER, 'red', { x: x + 400, y: y + 300 });
    run(1);
    expect(redMinion.order).toEqual({ kind: 'attack', targetId: blueMinion.id }); // closest minion first

    world.issue({ type: 'attack', unitId: harasser.id, targetId: victim.id });
    run(2.5);
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

describe('minion damage and aggro', () => {
  it('deals 60% damage to champions, and bonus damage to minions from their current health', () => {
    const { world, run, events } = setup();
    const caster = world.addUnit(CASTER_MINION, 'red', { x: 4300, y: 750 });
    const champ = world.addUnit(WAYFINDER, 'blue', { x: 3900, y: 750 });
    run(2);
    expect(damageTo(events, champ).filter((e) => e.sourceId === caster.id)[0].amount).toBeCloseTo(21 * 0.6);

    const melee = world.addUnit(MELEE_MINION, 'blue', { x: 4250, y: 750 });
    world.removeUnit(champ.id);
    run(2);
    const first = damageTo(events, melee).find((e) => e.sourceId === caster.id)!;
    expect(first.amount).toBeCloseTo(21 + MELEE_MINION.maxHp * 0.035);
  });

  it('only notices what comes within 500 units', () => {
    const { world, run } = setup();
    const minion = world.addUnit(MELEE_MINION, 'red', { x: 4000, y: 750 });
    tweak(minion, { moveSpeed: 0 });
    const champ = world.addUnit(WAYFINDER, 'blue', { x: 4000 - MINION_ACQUISITION_RANGE - 65 - 40, y: 750 });
    run(1);
    expect(minion.order.kind).not.toBe('attack');
    champ.pos = { x: 4000 - MINION_ACQUISITION_RANGE - 65 + 40, y: 750 };
    run(1);
    expect(minion.order).toEqual({ kind: 'attack', targetId: champ.id });
  });

  it('drops a champion for the closest minion once its call for help wears off', () => {
    const { world, run } = setup();
    const x = 4000;
    const y = 750;
    const minion = world.addUnit(CASTER_MINION, 'blue', { x, y });
    const enemyMinion = world.addUnit(MELEE_MINION, 'red', { x: x + 300, y });
    for (const m of [minion, enemyMinion]) tweak(m, { moveSpeed: 0, maxHp: 1e6 });
    minion.hp = enemyMinion.hp = 1e6;
    const ally = world.addUnit(WAYFINDER, 'blue', { x: x - 200, y: y + 300 });
    const harasser = world.addUnit(WAYFINDER, 'red', { x: x + 200, y: y + 300 });
    tweak(harasser, { maxHp: 1e6 });
    harasser.hp = 1e6;
    world.issue({ type: 'attack', unitId: harasser.id, targetId: ally.id });
    run(1);
    expect(minion.order).toEqual({ kind: 'attack', targetId: harasser.id });
    world.issue({ type: 'stop', unitId: harasser.id });
    run(CALL_SECONDS + 1);
    expect(minion.order).toEqual({ kind: 'attack', targetId: enemyMinion.id });
  });

  it('no longer answers a champion hitting allied minions (patch 26.10)', () => {
    const { world, run } = setup();
    const minion = world.addUnit(CASTER_MINION, 'blue', { x: 4000, y: 750 });
    const enemyMinion = world.addUnit(MELEE_MINION, 'red', { x: 4300, y: 750 });
    const farmer = world.addUnit(WAYFINDER, 'red', { x: 4200, y: 1000 });
    for (const m of [minion, enemyMinion]) tweak(m, { moveSpeed: 0, maxHp: 1e6 });
    minion.hp = enemyMinion.hp = 1e6;
    world.issue({ type: 'attack', unitId: farmer.id, targetId: minion.id });
    run(2);
    expect(minion.order).toEqual({ kind: 'attack', targetId: enemyMinion.id });
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

  it('Arcane Bolt stops on the first minion; the barrage deals 150 to minions', () => {
    const { world, run, events } = setup();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 3500, y: 750 });
    const minion = world.addUnit(SIEGE_MINION, 'red', { x: 3900, y: 750 });
    const foe = world.addUnit(WAYFINDER, 'red', { x: 4300, y: 750 });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foe.pos });
    run(0.8);
    expect(damageTo(events, minion).map((e) => e.amount)).toEqual([20 + 1.3 * (60 + ITEM_AD)]); // rank 1: 20 + 130% AD
    expect(damageTo(events, foe)).toHaveLength(0);

    world.issue({ type: 'cast', unitId: me.id, slot: 'R', target: foe.pos });
    run(2);
    expect(damageTo(events, minion).filter((e) => e.source === 'R').map((e) => e.amount)).toEqual([150]);
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
    for (let i = 0; i < 80 * TICK_RATE; i++) {
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
