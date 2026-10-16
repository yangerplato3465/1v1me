import { describe, expect, it } from 'vitest';
import { TICK_RATE, WAYFINDER, type AbilityHitAttackSpeedPassive, type BlinkAbility, type SkillshotAbility } from './defs';
import { World, attackSpeedOf, type SimEvent, type Unit, type WorldOptions } from './world';

const STEP = 1 / TICK_RATE;
const Q = WAYFINDER.abilities.Q as SkillshotAbility;
const W = WAYFINDER.abilities.W as SkillshotAbility;
const E = WAYFINDER.abilities.E as BlinkAbility;
const R = WAYFINDER.abilities.R as SkillshotAbility;
const MARK = W.onHit!.mark!;
const PASSIVE = WAYFINDER.passive as AbilityHitAttackSpeedPassive;

function setup(enemies: { x: number; y: number }[], options?: WorldOptions) {
  const world = new World(options);
  const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
  const foes = enemies.map((p) => world.addUnit(WAYFINDER, 'red', p));
  return { world, me, foes };
}

function run(world: World, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    world.step(STEP);
    events.push(...world.drainEvents());
  }
  return events;
}

const damageTo = (events: SimEvent[], unit: Unit) =>
  events.filter((e): e is Extract<SimEvent, { type: 'damage' }> => e.type === 'damage' && e.targetId === unit.id);
const markOn = (unit: Unit) => unit.statuses.find((s) => s.kind === 'mark');
const stacksOf = (unit: Unit) => {
  const s = unit.statuses.find((st) => st.kind === 'attackSpeed');
  return s?.kind === 'attackSpeed' ? s.stacks : 0;
};

describe('Wayfinder Q (Arcane Bolt)', () => {
  it('on hit takes 1.5 s off every cooldown and grants a passive stack', () => {
    const { world, me, foes } = setup([{ x: 1100, y: 800 }]);
    me.cooldowns.W = 5;
    me.cooldowns.E = 10;
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foes[0].pos });
    const hits = damageTo(run(world, 1), foes[0]);

    expect(hits).toEqual([expect.objectContaining({ source: 'Q', amount: Q.damage, detonation: false })]);
    expect(me.cooldowns.W).toBeCloseTo(5 - 1 - 1.5, 3);
    expect(me.cooldowns.E).toBeCloseTo(10 - 1 - 1.5, 3);
    expect(me.cooldowns.Q).toBeCloseTo(Q.cooldown - 1 - 1.5, 3);
    expect(stacksOf(me)).toBe(1);
    expect(attackSpeedOf(me)).toBeCloseTo(WAYFINDER.attackSpeed * (1 + PASSIVE.perStack));
  });
});

describe('Wayfinder W (Rune Orb)', () => {
  it('marks without damage; the next auto-attack detonates it with no mana refund', () => {
    const { world, me, foes } = setup([{ x: 900, y: 800 }]);
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: foes[0].pos });
    const castEvents = run(world, 0.6);
    expect(damageTo(castEvents, foes[0])).toHaveLength(0);
    expect(markOn(foes[0])).toBeDefined();
    expect(stacksOf(me)).toBe(1);

    const manaBefore = me.mana;
    world.issue({ type: 'attack', unitId: me.id, targetId: foes[0].id });
    const hits = damageTo(run(world, 0.8), foes[0]);
    expect(hits.map((h) => [h.amount, h.detonation])).toEqual([
      [WAYFINDER.attackDamage, false],
      [MARK.detonateDamage, true],
    ]);
    expect(markOn(foes[0])).toBeUndefined();
    expect(me.mana).toBeCloseTo(manaBefore + WAYFINDER.manaRegen * 0.8, 3);
  });

  it('refunds 60 mana plus the cost when an ability detonates the mark', () => {
    const { world, me, foes } = setup([{ x: 900, y: 800 }]);
    me.mana = 100;
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: foes[0].pos });
    run(world, 0.6);
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foes[0].pos });
    const hits = damageTo(run(world, 0.6), foes[0]);

    expect(hits.map((h) => [h.source, h.detonation])).toEqual([
      ['Q', false],
      ['Q', true],
    ]);
    const spent = W.manaCost + Q.manaCost;
    const refund = MARK.abilityManaRefund + Q.manaCost;
    expect(me.mana).toBeCloseTo(100 - spent + refund + WAYFINDER.manaRegen * 1.2, 3);
  });

  it('expires after its duration', () => {
    const { world, me, foes } = setup([{ x: 900, y: 800 }]);
    world.issue({ type: 'cast', unitId: me.id, slot: 'W', target: foes[0].pos });
    run(world, 0.6);
    expect(markOn(foes[0])).toBeDefined();
    run(world, MARK.duration);
    expect(markOn(foes[0])).toBeUndefined();
  });
});

describe('Wayfinder E (Phase Step)', () => {
  it('blinks at most its range toward the cursor, then bolts the nearest enemy in range', () => {
    const { world, me, foes } = setup([{ x: 1500, y: 800 }, { x: 2200, y: 800 }]);
    world.issue({ type: 'cast', unitId: me.id, slot: 'E', target: { x: 2400, y: 800 } });
    const events = run(world, 0.3);
    expect(me.pos).toEqual({ x: 500 + E.range, y: 800 });
    expect(events.some((e) => e.type === 'blink')).toBe(true);

    const later = [...events, ...run(world, 0.5)];
    expect(damageTo(later, foes[0])).toEqual([expect.objectContaining({ source: 'E', amount: E.bolt!.damage })]);
    expect(damageTo(later, foes[1])).toHaveLength(0);
  });

  it('blinks only as far as the cursor when it is closer than max range', () => {
    const { world, me } = setup([]);
    world.issue({ type: 'cast', unitId: me.id, slot: 'E', target: { x: 700, y: 800 } });
    run(world, 0.3);
    expect(me.pos).toEqual({ x: 700, y: 800 });
  });

  it('prefers a marked enemy over a closer one, detonating the mark and refunding mana', () => {
    const { world, me, foes } = setup([{ x: 1250, y: 800 }, { x: 1600, y: 800 }]);
    const [near, marked] = foes;
    marked.statuses.push({ kind: 'mark', sourceId: me.id, remaining: MARK.duration, effect: MARK });
    me.mana = 200;
    world.issue({ type: 'cast', unitId: me.id, slot: 'E', target: { x: 2400, y: 800 } });
    const events = run(world, 0.8);

    expect(damageTo(events, near)).toHaveLength(0);
    expect(damageTo(events, marked).map((h) => h.amount)).toEqual([E.bolt!.damage, MARK.detonateDamage]);
    expect(me.mana).toBeCloseTo(200 - E.manaCost + MARK.abilityManaRefund + E.manaCost + WAYFINDER.manaRegen * 0.8, 3);
  });

  it('fires no bolt when no enemy is in range', () => {
    const { world, me, foes } = setup([{ x: 2400, y: 800 }]);
    world.issue({ type: 'cast', unitId: me.id, slot: 'E', target: { x: 100, y: 800 } });
    const events = run(world, 1);
    expect(damageTo(events, foes[0])).toHaveLength(0);
    expect(world.projectiles).toHaveLength(0);
  });
});

describe('Wayfinder R (Skyline Barrage)', () => {
  it('roots for the 1 s cast, then pierces, hitting every enemy in its path once', () => {
    const { world, me, foes } = setup([{ x: 1500, y: 800 }, { x: 2300, y: 820 }]);
    world.issue({ type: 'cast', unitId: me.id, slot: 'R', target: { x: 2000, y: 800 } });
    world.issue({ type: 'move', unitId: me.id, target: { x: 500, y: 300 } });
    run(world, 0.5);
    expect(me.pos).toEqual({ x: 500, y: 800 });

    const events = run(world, 2.5);
    for (const foe of foes) expect(damageTo(events, foe).map((h) => h.amount)).toEqual([R.damage]);
    expect(stacksOf(me)).toBe(2);
  });
});

describe('Wayfinder passive (Spell Momentum)', () => {
  it('caps at 5 stacks and falls off after 6 s without ability hits', () => {
    const { world, me, foes } = setup([{ x: 900, y: 800 }]);
    for (let i = 0; i < 6; i++) {
      me.cooldowns.Q = 0;
      me.mana = WAYFINDER.maxMana;
      world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foes[0].pos });
      run(world, 0.5);
    }
    expect(stacksOf(me)).toBe(PASSIVE.maxStacks);
    expect(attackSpeedOf(me)).toBeCloseTo(WAYFINDER.attackSpeed * 1.5);

    run(world, PASSIVE.duration + 0.1);
    expect(stacksOf(me)).toBe(0);
    expect(attackSpeedOf(me)).toBe(WAYFINDER.attackSpeed);
  });
});

describe('prediction copy (authoritative: false)', () => {
  it('blinks and spends cooldowns but spawns no missiles and deals no damage', () => {
    const { world, me, foes } = setup([{ x: 900, y: 800 }], { authoritative: false });
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foes[0].pos });
    const events = run(world, 0.5);
    world.issue({ type: 'cast', unitId: me.id, slot: 'E', target: { x: 300, y: 800 } });
    events.push(...run(world, 0.5));

    expect(world.projectiles).toHaveLength(0);
    expect(damageTo(events, foes[0])).toHaveLength(0);
    expect(me.cooldowns.Q).toBeGreaterThan(0);
    expect(me.pos).toEqual({ x: 300, y: 800 });
  });
});
