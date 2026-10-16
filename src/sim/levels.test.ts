import { describe, expect, it } from 'vitest';
import { parsePlayerCommand } from '../net/protocol';
import { PracticeBot } from './bot';
import {
  CASTER_MINION,
  CHAMPION_KILL_XP,
  MELEE_MINION,
  SHADEBLADE,
  START_LEVEL,
  TICK_RATE,
  WAYFINDER,
  XP_FOR_LEVEL,
  type AbilitySlot,
} from './defs';
import { REGEN_TICK_SECONDS, World, attackSpeedOf, canRankUp, type SimEvent, type Unit } from './world';

const STEP = 1 / TICK_RATE;

function run(world: World, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    world.step(STEP);
    events.push(...world.drainEvents());
  }
  return events;
}

const levelUp = (world: World, u: Unit, slot: AbilitySlot) => world.issue({ type: 'levelUp', unitId: u.id, slot });
const toLevel = (world: World, u: Unit, level: number) => world.gainXp(u, XP_FOR_LEVEL[level - 1] - u.xp);

describe('starting a match', () => {
  it('starts champions at level 3 with 3 skill points and nothing learned', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    expect(me.level).toBe(3);
    expect(me.xp).toBe(XP_FOR_LEVEL[2]);
    expect(me.skillPoints).toBe(3);
    expect(me.ranks).toEqual({ Q: 0, W: 0, E: 0, R: 0 });
    // Level 3 stats on LoL's growth curve: 600 + 102 × 2 × (0.7025 + 0.0175 × 2).
    expect(me.stats.maxHp).toBeCloseTo(750.45, 2);
    expect(me.hp).toBeCloseTo(750.45, 2);
    expect(me.stats.attackDamage).toBeCloseTo(60 + 3.75 * 2 * 0.7375, 6);
    expect(attackSpeedOf(me)).toBeCloseTo(0.625 * (1 + 0.025 * 2 * 0.7375), 6);

    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    expect(me.cast).toBeNull(); // can't cast an ability that isn't learned
    levelUp(world, me, 'Q');
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: { x: 900, y: 800 } });
    expect(me.cast?.slot).toBe('Q');
  });
});

describe('skill points (LoL rules)', () => {
  it('unlocks basic ranks at odd levels and the ultimate at 6, 11 and 16', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    levelUp(world, me, 'Q');
    levelUp(world, me, 'Q'); // rank 2 at level 3
    expect(me.ranks.Q).toBe(2);
    levelUp(world, me, 'Q'); // rank 3 needs level 5
    expect(me.ranks.Q).toBe(2);
    expect(canRankUp(me, 'R')).toBe(false);
    levelUp(world, me, 'W');
    expect(me.skillPoints).toBe(0);

    const ranksAt: Record<number, string> = {};
    for (let level = 4; level <= 18; level++) {
      toLevel(world, me, level);
      for (const slot of ['R', 'Q', 'W', 'E'] as AbilitySlot[]) if (canRankUp(me, slot)) levelUp(world, me, slot);
      ranksAt[level] = `${me.ranks.Q}${me.ranks.W}${me.ranks.E}${me.ranks.R}`;
    }
    // Ranks as QWER, spending each point on the first of R, Q, W, E that allows it.
    expect(ranksAt[4]).toBe('2200'); // Q3 has to wait for level 5
    expect(ranksAt[5]).toBe('3200');
    expect(ranksAt[6]).toBe('3201'); // R at 6
    expect(ranksAt[9]).toBe('5301'); // Q maxed at 9
    expect(ranksAt[11]).toBe('5402'); // R2 at 11
    expect(ranksAt[16]).toBe('5533'); // R3 at 16
    expect(me.level).toBe(18);
    expect(me.skillPoints).toBe(0);
    expect(Object.values(me.ranks).reduce((a, b) => a + b)).toBe(18);
  });

  it('can spend points while dead, and the command survives the wire', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    me.respawnIn = 5;
    levelUp(world, me, 'E');
    expect(me.ranks.E).toBe(1);
    expect(parsePlayerCommand({ type: 'levelUp', slot: 'R' })).toEqual({ type: 'levelUp', slot: 'R' });
    expect(parsePlayerCommand({ type: 'levelUp', slot: 'X' })).toBeNull();
  });

  it('uses the rank: Arcane Bolt at rank 2 deals 45 + 130% AD', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    const foe = world.addUnit(WAYFINDER, 'red', { x: 1100, y: 800 }, { level: START_LEVEL });
    levelUp(world, me, 'Q');
    levelUp(world, me, 'Q');
    world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: foe.pos });
    const hit = run(world, 1).find((e) => e.type === 'damage' && e.targetId === foe.id);
    expect(hit).toMatchObject({ amount: 45 + 1.3 * me.stats.attackDamage });
    expect(me.cooldowns.Q).toBeCloseTo(5.25 - 1 - 1.5, 3); // rank 2 cooldown, minus 1 s and the on-hit refund
  });
});

describe('experience', () => {
  it('a minion pays its experience to enemy champions within 1500, whoever kills it', () => {
    const world = new World();
    const near = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    const far = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 2800 }, { level: START_LEVEL });
    const minion = world.addUnit(CASTER_MINION, 'red', { x: 900, y: 800 });
    minion.hp = 1;
    world.issue({ type: 'attack', unitId: near.id, targetId: minion.id });
    run(world, 1);
    expect(near.xp - XP_FOR_LEVEL[2]).toBeCloseTo(31);
    expect(far.xp).toBe(XP_FOR_LEVEL[2]);
  });

  it('two champions nearby each get 65% of it', () => {
    const world = new World();
    const a = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    const b = world.addUnit(SHADEBLADE, 'blue', { x: 500, y: 1000 }, { level: START_LEVEL });
    const minion = world.addUnit(MELEE_MINION, 'red', { x: 900, y: 800 });
    minion.hp = 1;
    world.issue({ type: 'attack', unitId: a.id, targetId: minion.id });
    run(world, 1);
    expect(a.xp - XP_FOR_LEVEL[2]).toBeCloseTo(62 * 0.65);
    expect(b.xp - XP_FOR_LEVEL[2]).toBeCloseTo(62 * 0.65);
  });

  it('levels up past each threshold: a skill point, more stats, and the health added to current health', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    me.hp = 400;
    const before = me.stats.maxHp;
    world.gainXp(me, XP_FOR_LEVEL[3] - me.xp);
    const events = world.drainEvents();
    expect(me.level).toBe(4);
    expect(me.skillPoints).toBe(4);
    expect(events).toContainEqual({ type: 'levelUp', unitId: me.id, level: 4 });
    expect(me.hp).toBeCloseTo(400 + me.stats.maxHp - before, 6);
  });

  it('a champion kill pays by the victim\'s level, less to a much higher-level killer', () => {
    const world = new World();
    const killer = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    const victim = world.addUnit(WAYFINDER, 'red', { x: 1000, y: 800 }, { level: START_LEVEL });
    victim.hp = 1;
    world.issue({ type: 'attack', unitId: killer.id, targetId: victim.id });
    run(world, 1.5);
    expect(killer.xp - XP_FOR_LEVEL[2]).toBeCloseTo(CHAMPION_KILL_XP[2]);

    const later = new World();
    const veteran = later.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: 6 });
    const rookie = later.addUnit(WAYFINDER, 'red', { x: 1000, y: 800 }, { level: 3 });
    rookie.hp = 1;
    const xpBefore = veteran.xp;
    later.issue({ type: 'attack', unitId: veteran.id, targetId: rookie.id });
    run(later, 1.5);
    // Three levels higher: 20% less per level beyond the first.
    expect(veteran.xp - xpBefore).toBeCloseTo(CHAMPION_KILL_XP[2] * 0.6);
  });
});

describe('passive regeneration (LoL base stats, per 5 s on the wiki)', () => {
  it('regenerates health and mana in 0.5 s ticks, growing with level, up to the max', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'blue', { x: 3000, y: 800 }, { level: START_LEVEL });
    // Ezreal: 4 HP5 (+0.65) and 8.5 MP5 (+1), so 0.8 + 0.13 and 1.7 + 0.2 per second per level of growth.
    expect(me.stats.hpRegen).toBeCloseTo((4 + 0.65 * 2 * 0.7375) / 5, 6);
    expect(me.stats.manaRegen).toBeCloseTo((8.5 + 1 * 2 * 0.7375) / 5, 6);
    me.hp = 100;
    me.mana = 50;
    run(world, 0.4);
    expect([me.hp, me.mana]).toEqual([100, 50]); // nothing between ticks
    run(world, 0.2);
    expect(me.hp).toBeCloseTo(100 + me.stats.hpRegen * REGEN_TICK_SECONDS, 6);
    expect(me.mana).toBeCloseTo(50 + me.stats.manaRegen * REGEN_TICK_SECONDS, 6);
    run(world, 4.4); // 10 ticks in all
    expect(me.hp).toBeCloseTo(100 + me.stats.hpRegen * 5, 6);

    me.hp = me.stats.maxHp - 0.1;
    run(world, 1);
    expect(me.hp).toBe(me.stats.maxHp);
  });

  it('Shadeblade gets 50 energy per 5 s and Zed\'s 7 HP5; nothing while dead', () => {
    const world = new World();
    const me = world.addUnit(SHADEBLADE, 'blue', { x: 3000, y: 800 }, { level: 1 });
    me.mana = 0;
    me.hp = 300;
    run(world, 5);
    expect(me.mana).toBeCloseTo(50, 6);
    expect(me.hp).toBeCloseTo(307, 6);
    me.respawnIn = 10;
    const before = me.hp;
    run(world, 2);
    expect(me.hp).toBe(before);
  });
});

describe('PracticeBot skill points', () => {
  it('learns Q, W and E at the start and takes its ultimate at level 6', () => {
    const world = new World();
    const me = world.addUnit(WAYFINDER, 'red', { x: 1500, y: 800 }, { level: START_LEVEL });
    const foe = world.addUnit(WAYFINDER, 'blue', { x: 500, y: 800 }, { level: START_LEVEL });
    const bot = new PracticeBot(world, me.id, foe.id, () => 0.5);
    bot.update(STEP);
    expect(me.ranks).toEqual({ Q: 1, W: 1, E: 1, R: 0 });
    toLevel(world, me, 6);
    bot.update(STEP);
    expect(me.ranks).toEqual({ Q: 3, W: 1, E: 1, R: 1 });
  });
});
