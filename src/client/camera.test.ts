import { describe, expect, it } from 'vitest';
import { FOUNTAINS, LANE_Y, WORLD_SIZE } from '../sim/defs';
import { Camera } from './camera';

describe('Camera', () => {
  const camera = new Camera({ x: WORLD_SIZE.width / 2, y: LANE_Y });
  camera.resize(1600, 900);

  it('maps a click back to the exact world point it shows', () => {
    for (const p of [{ x: 3900, y: 600 }, { x: 4400, y: 1000 }, FOUNTAINS.blue]) {
      const back = camera.screenToWorld(camera.worldToScreen(p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('draws the lane diagonally: blue base bottom left, red base top right', () => {
    const blue = camera.worldToScreen(FOUNTAINS.blue);
    const red = camera.worldToScreen(FOUNTAINS.red);
    expect(blue.x).toBeLessThan(red.x);
    expect(blue.y).toBeGreaterThan(red.y);
    const lane = camera.dirToScreen({ x: 1, y: 0 });
    expect(lane.x).toBeGreaterThan(0.5);
    expect(lane.y).toBeLessThan(-0.5);
  });

  it('free camera pans with the screen edge and arrow keys, and follows when told to', () => {
    const cam = new Camera({ x: 4000, y: LANE_Y });
    cam.resize(1600, 900);
    const still = { mouse: { x: 800, y: 450 }, mouseInWindow: true, keys: { x: 0, y: 0 }, drag: { x: 0, y: 0 } };
    cam.update(0.1, null, still);
    expect({ x: cam.x, y: cam.y }).toEqual({ x: 4000, y: LANE_Y });

    // Mouse on the right edge: the view slides right on screen.
    const before = cam.worldToScreen({ x: 4000, y: LANE_Y });
    cam.update(0.1, null, { ...still, mouse: { x: 1599, y: 450 } });
    const after = cam.worldToScreen({ x: 4000, y: LANE_Y });
    expect(after.x).toBeCloseTo(before.x - 140, 6); // 1400 px/s for 0.1 s
    expect(after.y).toBeCloseTo(before.y, 6);

    cam.update(0.1, null, { ...still, keys: { x: 0, y: -1 } }); // up arrow
    expect(cam.worldToScreen({ x: 4000, y: LANE_Y }).y).toBeCloseTo(after.y + 140, 6);

    cam.update(0.1, { x: 1000, y: 700 }, still);
    expect({ x: cam.x, y: cam.y }).toEqual({ x: 1000, y: 700 });
  });

  it('per-side offset: from the blue side the champion sits down-left of center, from the red side up-right', () => {
    for (const [team, ahead] of [['blue', 1], ['red', -1]] as const) {
      const cam = new Camera({ x: 0, y: 0 });
      cam.resize(1600, 900);
      cam.setSideOffset({ x: ahead, y: 0 });
      const champ = { x: 4000, y: LANE_Y };
      cam.centerOn(champ);
      const s = cam.worldToScreen(champ);
      const fromCenter = Math.hypot(s.x - 800, s.y - 450);
      expect(fromCenter).toBeCloseTo(0.17 * 900, 6);
      if (team === 'blue') expect([s.x < 800, s.y > 450]).toEqual([true, true]);
      else expect([s.x > 800, s.y < 450]).toEqual([true, true]);
    }
    const fixed = new Camera({ x: 0, y: 0 });
    fixed.resize(1600, 900);
    fixed.centerOn({ x: 4000, y: LANE_Y });
    expect(fixed.worldToScreen({ x: 4000, y: LANE_Y })).toEqual({ x: 800, y: 450 });
  });
});
