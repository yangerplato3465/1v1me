import { describe, expect, it } from 'vitest';
import { parsePlayerCommand, parseSummoners } from '../net/protocol';
import {
  BARRIER,
  CASTER_MINION,
  EXHAUST,
  FLASH,
  HEAL,
  IGNITE,
  START_LEVEL,
  TICK_RATE,
  WAYFINDER,
  barrierShield,
  healAmount,
  igniteDamage,
  type SummonerId,
} from './defs';
import { World, moveSpeedOf, shieldOf, type SimEvent, type Unit } from './world';

const STEP = 1 / TICK_RATE;

function run(world: World, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    world.step(STEP);
    events.push(...world.drainEvents());
  }
  return events;
}

/** Two level-3 Wayfinders 500 apart; `me` has `d` on D and `f` on F. */
function setup(d: SummonerId, f: SummonerId = 'flash', gap = 500) {
  const world = new World();
  const me = world.addUnit(WAYFINDER, 'blue', { x: 3000, y: 750 }, { level: START_LEVEL, summoners: { D: d, F: f } });
  const foe = world.addUnit(WAYFINDER, 'red', { x: 3000 + gap, y: 750 }, { level: START_LEVEL });
  const use = (unit: Unit, target: { x: number; y: number }, slot: 'D' | 'F' = 'D') =>
    world.issue({ type: 'summoner', unitId: unit.id, slot, target });
  return { world, me, foe, use };
}

const damageTo = (events: SimEvent[], u: Unit) =>
  events.filter((e): e is Extract<SimEvent, { type: 'damage' }> => e.type === 'damage' && e.targetId === u.id);

describe('summoner spell numbers by level (LoL wiki)', () => {
  it('Ignite 70 → 475, Heal 80 → 318, Barrier 100 → 460', () => {
    expect([1, 2, 5, 6, 11, 18].map(igniteDamage)).toEqual([70, 90, 150, 175, 300, 475]);
    expect([1, 3, 18].map(healAmount)).toEqual([80, 108, 318]);
    expect(barrierShield(1)).toBe(100);
    expect(barrierShield(18)).toBeCloseTo(460, 6);
    expect([FLASH.cooldown, IGNITE.cooldown, EXHAUST.cooldown, HEAL.cooldown, BARRIER.cooldown]).toEqual([300, 180, 240, 240, 180]);
  });
});

describe('Flash', () => {
  it('blinks 400 toward the cursor (less if the cursor is closer) and goes on cooldown', () => {
    const { world, me, use } = setup('flash');
    use(me, { x: 1000, y: 750 }); // far: the full 400
    expect(me.pos).toEqual({ x: 2600, y: 750 });
    expect(me.summonerCooldowns.D).toBe(FLASH.cooldown);
    use(me, { x: 0, y: 750 });
    expect(me.pos.x).toBe(2600); // on cooldown
    run(world, FLASH.cooldown);
    use(me, { x: 2500, y: 750 }); // 100 away: just there
    expect(me.pos).toEqual({ x: 2500, y: 750 });
  });

  it("works mid-cast and keeps the current order; it isn't an order itself", () => {
    const { world, me, foe, use } = setup('flash');
    world.issue({ type: 'levelUp', unitId: me.id, slot: 'Q' });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foe.pos });
    expect(me.cast?.slot).toBe('Q');
    use(me, { x: 3000, y: 350 });
    expect(me.pos).toEqual({ x: 3000, y: 350 });
    expect(me.cast?.slot).toBe('Q');

    me.summonerCooldowns.D = 0;
    world.issue({ type: 'move', unitId: me.id, target: { x: 6000, y: 350 } });
    run(world, 0.5);
    use(me, { x: me.pos.x, y: 1000 });
    expect(me.order).toMatchObject({ kind: 'move' });
  });
});

describe('Ignite', () => {
  it('burns for its level total in 5 one-second ticks of true damage, and the caster gets the kill', () => {
    const { world, me, foe, use } = setup('ignite');
    use(me, foe.pos);
    const total = igniteDamage(START_LEVEL); // 110 at level 3
    const events = run(world, 5.05);
    const ticks = damageTo(events, foe).filter((e) => e.source === 'ignite');
    expect(ticks.map((t) => t.amount)).toEqual(Array(5).fill(total / 5));
    expect(foe.statuses.some((s) => s.kind === 'burn')).toBe(false);

    const second = setup('ignite');
    second.foe.hp = 30;
    second.use(second.me, second.foe.pos);
    const deaths = run(second.world, 3).filter((e) => e.type === 'death');
    expect(deaths).toMatchObject([{ unitId: second.foe.id, killerId: second.me.id, kind: 'champion' }]);
  });

  it('applies 40% Grievous Wounds: less regeneration and less Heal', () => {
    const { world, me, foe, use } = setup('ignite');
    foe.summoners = { D: 'heal', F: 'flash' };
    use(me, foe.pos);
    foe.hp = 300;
    use(foe, foe.pos);
    const healed = 300 + healAmount(START_LEVEL) * 0.6;
    expect(foe.hp).toBeCloseTo(healed, 6);
    run(world, 0.5); // one regeneration tick, before the first burn tick
    expect(foe.hp).toBeCloseTo(healed + foe.stats.hpRegen * 0.5 * 0.6, 6);
  });

  it('needs an enemy champion near the cursor, and walks into range to cast', () => {
    const { world, me, foe, use } = setup('ignite', 'flash', 1000);
    const minion = world.addUnit(CASTER_MINION, 'red', { x: 3300, y: 750 });
    use(me, minion.pos); // champions only
    expect(me.summonerCooldowns.D).toBe(0);

    use(me, foe.pos); // 1000 away: out of its 600 range
    expect(me.order).toEqual({ kind: 'summonerMove', slot: 'D', targetId: foe.id });
    const events = run(world, 2);
    expect(events.some((e) => e.type === 'summoner' && e.spell === 'ignite' && e.targetId === foe.id)).toBe(true);
    expect(me.pos.x).toBeGreaterThanOrEqual(foe.pos.x - IGNITE.range - 15);
  });
});

describe('Exhaust', () => {
  it("slows the target 40% and cuts its damage 35% for 3 s, but not Ignite's true damage", () => {
    const { world, me, foe, use } = setup('exhaust', 'ignite');
    use(me, foe.pos);
    expect(moveSpeedOf(foe)).toBeCloseTo(WAYFINDER.moveSpeed * 0.6, 6);

    foe.summoners = { D: 'ignite', F: 'flash' };
    use(foe, me.pos);
    world.issue({ type: 'attack', unitId: foe.id, targetId: me.id });
    const events = run(world, 1.6);
    const hits = damageTo(events, me);
    expect(hits.find((h) => h.source === 'attack')!.amount).toBeCloseTo(foe.stats.attackDamage * 0.65, 6);
    expect(hits.find((h) => h.source === 'ignite')!.amount).toBe(igniteDamage(START_LEVEL) / 5);

    run(world, EXHAUST.duration);
    expect(moveSpeedOf(foe)).toBe(WAYFINDER.moveSpeed);
  });
});

describe('Heal and Barrier', () => {
  it('Heal restores its level amount and gives 30% move speed for 1 s', () => {
    const { world, me, use } = setup('heal');
    me.hp = 200;
    const events = run(world, 0).concat((use(me, me.pos), world.drainEvents()));
    expect(me.hp).toBe(200 + healAmount(START_LEVEL));
    expect(events).toContainEqual({ type: 'summoner', unitId: me.id, spell: 'heal', targetId: null, amount: healAmount(START_LEVEL) });
    expect(moveSpeedOf(me)).toBeCloseTo(WAYFINDER.moveSpeed * 1.3, 6);
    run(world, HEAL.moveSpeedDuration + 0.05);
    expect(moveSpeedOf(me)).toBe(WAYFINDER.moveSpeed);
  });

  it('Barrier absorbs damage for 2.5 s before health', () => {
    const { world, me, foe, use } = setup('barrier');
    use(me, me.pos);
    expect(shieldOf(me)).toBeCloseTo(barrierShield(START_LEVEL), 6);
    world.issue({ type: 'attack', unitId: foe.id, targetId: me.id });
    run(world, 1.6); // one auto lands on the shield
    expect(me.hp).toBe(me.stats.maxHp);
    expect(shieldOf(me)).toBeCloseTo(barrierShield(START_LEVEL) - foe.stats.attackDamage, 6);
    run(world, BARRIER.duration);
    expect(shieldOf(me)).toBe(0);
  });
});

describe('on the wire', () => {
  it('parses the command and the join choice; a duplicate or unknown pick falls back to Flash + Ignite', () => {
    expect(parsePlayerCommand({ type: 'summoner', slot: 'F', target: { x: 1, y: 2 } })).toEqual({ type: 'summoner', slot: 'F', target: { x: 1, y: 2 } });
    expect(parsePlayerCommand({ type: 'summoner', slot: 'Q', target: { x: 1, y: 2 } })).toBeNull();
    expect(parseSummoners({ D: 'heal', F: 'barrier' })).toEqual({ D: 'heal', F: 'barrier' });
    expect(parseSummoners({ D: 'heal', F: 'heal' })).toEqual({ D: 'flash', F: 'ignite' });
    expect(parseSummoners({ D: 'smite', F: 'heal' })).toEqual({ D: 'flash', F: 'ignite' });
  });
});
