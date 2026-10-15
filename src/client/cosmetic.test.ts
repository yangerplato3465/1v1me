import { describe, expect, it } from 'vitest';
import { WAYFINDER, type SkillshotAbility } from '../sim/defs';
import { World } from '../sim/world';
import { CosmeticMissiles } from './cosmetic';

const Q = WAYFINDER.abilities.Q as SkillshotAbility;
const R = WAYFINDER.abilities.R as SkillshotAbility;

function setup() {
  const world = new World();
  const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 });
  const near = world.addUnit(WAYFINDER, 'red', { x: 900, y: 800 });
  const far = world.addUnit(WAYFINDER, 'red', { x: 1400, y: 800 });
  return { world, me, near, far, missiles: new CosmeticMissiles() };
}

const flyFor = (m: CosmeticMissiles, world: World, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) m.update(1 / 60, world.units.values(), (u) => u.pos);
};

describe('CosmeticMissiles', () => {
  it('stops a single-target skillshot at the first enemy where it is drawn', () => {
    const { world, me, missiles } = setup();
    missiles.skillshot(me, 'Q', Q, me.pos, { x: 1, y: 0 });
    flyFor(missiles, world, 0.1); // 200 units out: still flying
    expect(missiles.list).toHaveLength(1);
    flyFor(missiles, world, 0.2); // reaches the near enemy's hitbox
    expect(missiles.list).toHaveLength(0);
  });

  it('lets a piercing skillshot fly through, and a homing attack end on its target', () => {
    const { world, me, near, missiles } = setup();
    missiles.skillshot(me, 'R', R, me.pos, { x: 1, y: 0 });
    missiles.attack(me, near.id, me.pos);
    flyFor(missiles, world, 0.5);
    expect(missiles.list.map((p) => p.kind)).toEqual(['skillshot']);
    expect(missiles.list[0].pos.x).toBeGreaterThan(1400);
  });

  it('uses negative ids so they never collide with server projectiles', () => {
    const { me, near, missiles } = setup();
    missiles.attack(me, near.id, me.pos);
    missiles.skillshot(me, 'Q', Q, me.pos, { x: 1, y: 0 });
    expect(missiles.list.every((p) => p.id < 0)).toBe(true);
  });
});
