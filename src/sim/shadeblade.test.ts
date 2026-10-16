import { describe, expect, it } from 'vitest';
import {
  SHADEBLADE,
  TICK_RATE,
  WAYFINDER,
  type AreaAbility,
  type DeathMarkAbility,
  type ExecuteAttackPassive,
  type ShadowAbility,
  type SkillshotAbility,
} from './defs';
import { World, isUntargetable, moveSpeedOf, type SimEvent, type Unit, type WorldOptions } from './world';

const STEP = 1 / TICK_RATE;
const Q = SHADEBLADE.abilities.Q as SkillshotAbility;
const W = SHADEBLADE.abilities.W as ShadowAbility;
const E = SHADEBLADE.abilities.E as AreaAbility;
const R = SHADEBLADE.abilities.R as DeathMarkAbility;
const PASSIVE = SHADEBLADE.passive as ExecuteAttackPassive;

function setup(enemies: { x: number; y: number }[], options?: WorldOptions) {
  const world = new World(options);
  const me = world.addUnit(SHADEBLADE, 'blue', { x: 500, y: 800 });
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
const cast = (world: World, me: Unit, slot: 'Q' | 'W' | 'E' | 'R', target: { x: number; y: number }) =>
  world.issue({ type: 'cast', unitId: me.id, slot, target });

describe('Shadeblade basics', () => {
  it('is melee: the swing lands at the end of the windup with no missile, and spends energy', () => {
    const { world, me, foes } = setup([{ x: 500 + 125 + 130, y: 800 }]);
    world.issue({ type: 'attack', unitId: me.id, targetId: foes[0].id });
    const events = run(world, 0.5);
    expect(damageTo(events, foes[0]).map((h) => h.amount)).toEqual([SHADEBLADE.attackDamage]);
    expect(world.projectiles).toHaveLength(0);

    cast(world, me, 'E', me.pos);
    expect(me.mana).toBe(SHADEBLADE.maxMana - E.manaCost);
    run(world, 1);
    expect(me.mana).toBeCloseTo(SHADEBLADE.maxMana - E.manaCost + SHADEBLADE.manaRegen, 3);
  });

  it('passive: attacks on a target under 50% add 5% of its max health, once per 10 s per target', () => {
    const { world, me, foes } = setup([{ x: 755, y: 800 }]);
    const foe = foes[0];
    foe.hp = foe.def.maxHp * 0.4;
    world.issue({ type: 'attack', unitId: me.id, targetId: foe.id });
    const first = damageTo(run(world, 0.5), foe).map((h) => h.amount);
    expect(first).toEqual([foe.def.maxHp * PASSIVE.maxHpPct, SHADEBLADE.attackDamage]);

    const second = damageTo(run(world, 1.6), foe).map((h) => h.amount);
    expect(second).toEqual([SHADEBLADE.attackDamage]); // passive on cooldown for this target
  });
});

describe('Shadeblade Q (Night Star)', () => {
  it('pierces: full damage to the first enemy, reduced to the rest', () => {
    const { world, me, foes } = setup([{ x: 800, y: 800 }, { x: 1100, y: 800 }]);
    cast(world, me, 'Q', { x: 1400, y: 800 });
    const events = run(world, 1);
    expect(damageTo(events, foes[0]).map((h) => h.amount)).toEqual([Q.damage]);
    expect(damageTo(events, foes[1]).map((h) => h.amount)).toEqual([Q.subsequentDamage]);
  });
});

describe('Shadeblade W (Echo Shadow)', () => {
  it('sends a shadow up to 650 away; it copies Q, and a shared hit refunds energy once', () => {
    const { world, me, foes } = setup([{ x: 900, y: 1300 }]);
    cast(world, me, 'W', { x: 500, y: 2000 }); // straight down, clamped to 650
    run(world, 0.5);
    expect(world.shadows).toHaveLength(1);
    expect(world.shadows[0].pos).toEqual({ x: 500, y: 800 + W.range });

    const before = me.mana;
    cast(world, me, 'Q', foes[0].pos);
    const hits = damageTo(run(world, 1), foes[0]);
    expect(hits.map((h) => h.amount)).toEqual([Q.damage, Q.damage]); // one shuriken from each
    expect(me.mana).toBeCloseTo(before - Q.manaCost + W.sharedHitRefund + SHADEBLADE.manaRegen * 1, 3);
  });

  it('recast swaps places with the shadow, once, and the shadow expires', () => {
    const { world, me } = setup([]);
    cast(world, me, 'W', { x: 1100, y: 800 });
    run(world, 0.5);
    cast(world, me, 'W', { x: 0, y: 0 });
    expect(me.pos).toEqual({ x: 1100, y: 800 });
    expect(world.shadows[0].pos).toEqual({ x: 500, y: 800 });

    cast(world, me, 'W', { x: 0, y: 0 }); // no second swap, and still on cooldown
    expect(me.pos).toEqual({ x: 1100, y: 800 });
    run(world, W.duration);
    expect(world.shadows).toHaveLength(0);
  });
});

describe('Shadeblade E (Umbral Slash)', () => {
  it('hits each enemy once around him and his shadow; shadow hits slow, double hits slow harder', () => {
    // Reach is radius + hitbox = 380: 700 is only his, 1150 only the shadow's (at 1100), 850 both.
    const { world, me, foes } = setup([{ x: 700, y: 800 }, { x: 1150, y: 800 }, { x: 850, y: 800 }]);
    const [nearMe, nearShadow, between] = foes;
    cast(world, me, 'W', { x: 1100, y: 800 });
    run(world, 0.5);
    me.cooldowns.W = 10;
    const events = [...world.drainEvents()];
    cast(world, me, 'E', me.pos);
    events.push(...world.drainEvents());

    for (const foe of foes) expect(damageTo(events, foe).map((h) => h.amount)).toEqual([E.damage]);
    expect(nearMe.statuses.some((s) => s.kind === 'slow')).toBe(false);
    expect(moveSpeedOf(nearShadow)).toBeCloseTo(WAYFINDER.moveSpeed * (1 - E.shadowSlow!.amount));
    expect(moveSpeedOf(between)).toBeCloseTo(WAYFINDER.moveSpeed * (1 - E.shadowSlow!.enhancedAmount));
    // Two champions inside his own slash (nearMe, between): W loses 3 s each.
    expect(me.cooldowns.W).toBeCloseTo(10 - 2 * E.cooldownRefund!.seconds);
    expect(events.filter((e) => e.type === 'slash')).toHaveLength(2);
  });

  it('is instant: no cast time, no root', () => {
    const { world, me } = setup([]);
    world.issue({ type: 'move', unitId: me.id, target: { x: 1500, y: 800 } });
    cast(world, me, 'E', me.pos);
    expect(me.cast).toBeNull();
    run(world, 0.1);
    expect(me.pos.x).toBeGreaterThan(500);
  });
});

describe('Shadeblade R (Final Mark)', () => {
  it('goes untargetable, dashes behind the target, and detonates for 25% of the damage dealt during the mark', () => {
    const { world, me, foes } = setup([{ x: 1000, y: 800 }]);
    const foe = foes[0];
    cast(world, me, 'R', foe.pos);
    expect(isUntargetable(me)).toBe(true);
    expect(world.shadows.map((s) => [s.slot, s.pos])).toEqual([['R', { x: 500, y: 800 }]]);

    // A skillshot through him while untargetable passes.
    world.issue({ type: 'cast', unitId: foe.id, slot: 'Q', target: me.pos });
    const early = run(world, R.castTime + R.dashTime + 0.05);
    expect(damageTo(early, me)).toHaveLength(0);
    expect(me.pos.x).toBeCloseTo(1000 + R.landBehind);
    expect(isUntargetable(me)).toBe(false);
    expect(foe.statuses.some((s) => s.kind === 'deathMark')).toBe(true);

    foe.statuses = foe.statuses.filter((s) => s.kind === 'deathMark'); // keep the test about R alone
    world.issue({ type: 'attack', unitId: me.id, targetId: foe.id });
    const rest = damageTo(run(world, R.markDuration), foe);
    const dealt = rest.filter((h) => !h.detonation).reduce((sum, h) => sum + h.amount, 0);
    const detonation = rest.filter((h) => h.detonation);
    expect(dealt).toBeGreaterThan(0);
    expect(detonation.map((h) => h.amount)).toEqual([expect.closeTo(R.storedPct * dealt, 6)]);
  });

  it('needs an enemy within range near the cursor, and its recast swaps back to the shadow', () => {
    const { world, me, foes } = setup([{ x: 1400, y: 800 }]);
    cast(world, me, 'R', foes[0].pos); // 900 away: out of range
    expect(me.cast).toBeNull();
    expect(me.cooldowns.R).toBe(0);

    world.units.get(foes[0].id)!.pos = { x: 1000, y: 800 };
    cast(world, me, 'R', { x: 1000, y: 800 });
    run(world, 1.5);
    cast(world, me, 'R', { x: 0, y: 0 });
    expect(me.pos).toEqual({ x: 500, y: 800 });
  });

  it('fizzles with a short cooldown if the target dies during the wait', () => {
    const { world, me, foes } = setup([{ x: 1000, y: 800 }]);
    cast(world, me, 'R', foes[0].pos);
    foes[0].hp = 1;
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foes[0].pos }); // ignored mid-cast
    foes[0].respawnIn = 3; // dead
    run(world, R.castTime + 0.1);
    expect(me.dash).toBeNull();
    expect(me.pos).toEqual({ x: 500, y: 800 });
    expect(isUntargetable(me)).toBe(false);
    expect(me.cooldowns.R).toBeLessThanOrEqual(0.5);
  });
});

describe('prediction copy (authoritative: false)', () => {
  it('predicts shadow placement, swaps and the R dash, but no damage or marks', () => {
    const { world, me, foes } = setup([{ x: 1000, y: 800 }], { authoritative: false });
    cast(world, me, 'W', { x: 500, y: 600 });
    run(world, 0.4);
    cast(world, me, 'W', me.pos);
    expect(me.pos).toEqual({ x: 500, y: 600 });

    cast(world, me, 'R', foes[0].pos);
    const events = run(world, 1.2);
    expect(dist2(me.pos, foes[0].pos)).toBeCloseTo(R.landBehind);
    expect(damageTo(events, foes[0])).toHaveLength(0);
    expect(foes[0].statuses).toHaveLength(0);
  });
});

const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
