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
});
