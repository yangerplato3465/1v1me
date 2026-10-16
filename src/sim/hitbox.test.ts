import { describe, expect, it } from 'vitest';
import { CHAMPION_BACK_RADIUS, MELEE_MINION, TICK_RATE, VIEW_BEHIND, WAYFINDER, type ChampionDef } from './defs';
import { add, scale, type Vec } from './math';
import { World, type SimEvent } from './world';

const STEP = 1 / TICK_RATE;
/** Across the screen: perpendicular to "behind". */
const ACROSS: Vec = { x: -VIEW_BEHIND.y, y: VIEW_BEHIND.x };

/** Fires Wayfinder's Q (120 wide) past a target, along `travel`, with its path offset from the target by `offset`. */
function shootPast(targetDef: ChampionDef, offset: Vec, travel: Vec = ACROSS): boolean {
  const world = new World();
  const target = world.addUnit(targetDef, 'red', { x: 3000, y: 800 });
  const path = add(target.pos, offset);
  const me = world.addUnit(WAYFINDER, 'blue', add(path, scale(travel, -500)));
  world.issue({ type: 'cast', unitId: me.id, slot: 'Q', target: add(path, scale(travel, 500)) });
  const events: SimEvent[] = [];
  for (let i = 0; i < TICK_RATE * 1.5; i++) {
    world.step(STEP);
    events.push(...world.drainEvents());
  }
  return events.some((e) => e.type === 'damage' && e.targetId === target.id);
}

describe('skillshot hitbox as the camera sees it', () => {
  it('a bolt passing 100 behind a champion is drawn over its head and misses; LoL would count it', () => {
    expect(shootPast(WAYFINDER, scale(VIEW_BEHIND, 100))).toBe(false);
    // The deepest hit: the back reach plus the bolt's half width.
    expect(shootPast(WAYFINDER, scale(VIEW_BEHIND, CHAMPION_BACK_RADIUS + 60 - 5))).toBe(true);
  });

  it('in front and to the side the full radius still counts', () => {
    expect(shootPast(WAYFINDER, scale(VIEW_BEHIND, -100))).toBe(true);
    // Flying straight up the screen, 100 to the side of him.
    expect(shootPast(WAYFINDER, scale(ACROSS, 100), VIEW_BEHIND)).toBe(true);
    expect(shootPast(WAYFINDER, scale(ACROSS, 130), VIEW_BEHIND)).toBe(false); // past 65 + 60
  });

  it('minions are short: they keep the full circle behind them', () => {
    expect(shootPast(MELEE_MINION, scale(VIEW_BEHIND, 100))).toBe(true);
  });
});
