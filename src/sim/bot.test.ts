import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT, PracticeBot, type BotOptions } from './bot';
import { SHADEBLADE, TICK_RATE, WAYFINDER, type ChampionDef } from './defs';
import { World, type SimEvent, type Unit } from './world';

const STEP = 1 / TICK_RATE;

/** Deterministic randomness (mulberry32), so bot runs are repeatable. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(botChamp: ChampionDef, botAt: { x: number; y: number }, foeAt: { x: number; y: number }, options?: Partial<BotOptions>) {
  const world = new World();
  const foe = world.addUnit(WAYFINDER, 'blue', foeAt);
  const me = world.addUnit(botChamp, 'red', botAt);
  const bot = new PracticeBot(world, me.id, foe.id, seeded(7), { ...DEFAULT_BOT, ...options });
  const events: SimEvent[] = [];
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      each?.();
      bot.update(STEP);
      world.step(STEP);
      events.push(...world.drainEvents());
    }
  };
  return { world, me, foe, run, events };
}

const casts = (events: SimEvent[], unit: Unit) =>
  events.filter((e): e is Extract<SimEvent, { type: 'castStart' }> => e.type === 'castStart' && e.unitId === unit.id).map((e) => e.slot);
const hitsBy = (events: SimEvent[], unit: Unit, source?: string) =>
  events.filter((e) => e.type === 'damage' && e.sourceId === unit.id && (!source || e.source === source));
/** Keeps a training dummy topped up so a long test doesn't end in a kill. */
const immortal = (u: Unit) => () => {
  u.hp = u.def.maxHp;
};

describe('PracticeBot as Wayfinder (ranged)', () => {
  it('auto-attacks a target in range at its full attack rate, never canceling its own windups', () => {
    const { me, foe, run, events } = setup(WAYFINDER, { x: 1300, y: 800 }, { x: 800, y: 800 });
    run(10, immortal(foe));
    const attacks = hitsBy(events, me, 'attack').filter((e) => e.type === 'damage' && !e.detonation);
    // 0.625/s base, faster with ability-hit stacks: at least 6 in 10 s.
    expect(attacks.length).toBeGreaterThanOrEqual(6);
    expect(events.some((e) => e.type === 'attackCanceled' && e.unitId === me.id)).toBe(false);
  });

  it('uses Q and W on a target in range, and Q hits a standing target', () => {
    const { me, foe, run, events } = setup(WAYFINDER, { x: 1700, y: 800 }, { x: 800, y: 800 });
    run(12, immortal(foe));
    const used = new Set(casts(events, me));
    expect(used).toContain('Q');
    expect(used).toContain('W');
    expect(hitsBy(events, me, 'Q').length).toBeGreaterThan(0);
  });

  it('blinks away when low and you are close', () => {
    const { me, run, events } = setup(WAYFINDER, { x: 1000, y: 800 }, { x: 750, y: 800 });
    me.hp = me.def.maxHp * 0.2;
    run(1);
    const blink = events.find((e) => e.type === 'blink' && e.unitId === me.id);
    expect(blink).toBeDefined();
    if (blink?.type === 'blink') expect(blink.to.x).toBeGreaterThan(blink.from.x); // away from the foe
  });

  it('fires its global ultimate to finish a low target, not at full health', () => {
    const full = setup(WAYFINDER, { x: 2300, y: 800 }, { x: 600, y: 800 });
    full.me.cooldowns.Q = full.me.cooldowns.W = 99;
    full.run(3);
    expect(casts(full.events, full.me)).not.toContain('R');

    const low = setup(WAYFINDER, { x: 2300, y: 800 }, { x: 600, y: 800 });
    low.foe.hp = 300;
    low.run(3);
    expect(casts(low.events, low.me)).toContain('R');
  });

  it('sidesteps a skillshot it sees coming, when it decides to dodge', () => {
    const dodger = setup(WAYFINDER, { x: 1500, y: 800 }, { x: 600, y: 800 }, { dodgeChance: 1 });
    const statue = setup(WAYFINDER, { x: 1500, y: 800 }, { x: 600, y: 800 }, { dodgeChance: 0 });
    for (const s of [dodger, statue]) {
      s.me.cooldowns = { Q: 99, W: 99, E: 99, R: 99 }; // keep it about dodging
      s.world.issue({ type: 'cast', unitId: s.foe.id, slot: 'Q', target: s.me.pos });
      s.run(1.2);
    }
    const qHits = (s: typeof dodger) => s.events.filter((e) => e.type === 'damage' && e.targetId === s.me.id && e.source === 'Q');
    expect(qHits(statue)).toHaveLength(1);
    expect(qHits(dodger)).toHaveLength(0);
  });
});

describe('PracticeBot as Shadeblade (melee)', () => {
  it('chases and swings, and runs its shadow combo: W, then Q and E, then R on a low target', () => {
    const { me, foe, run, events } = setup(SHADEBLADE, { x: 1500, y: 800 }, { x: 900, y: 800 });
    run(4, () => {
      if (foe.hp < foe.def.maxHp * 0.5) foe.hp = foe.def.maxHp * 0.5;
    });
    const used = casts(events, me);
    expect(used).toContain('W');
    expect(used).toContain('Q');
    expect(used).toContain('E');
    expect(used.indexOf('W')).toBeLessThan(used.indexOf('Q')); // shadow first, so the copies come along
    expect(used).toContain('R');
    expect(hitsBy(events, me, 'attack').length).toBeGreaterThan(0);
  });
});

describe('PracticeBot fairness', () => {
  it('only acts through its own unit', () => {
    const { foe, run } = setup(SHADEBLADE, { x: 1500, y: 800 }, { x: 900, y: 800 });
    const before = { ...foe.pos };
    run(2, immortal(foe));
    expect(foe.order.kind).toBe('idle');
    expect(foe.pos).toEqual(before);
  });
});
