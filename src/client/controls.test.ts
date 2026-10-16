// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { WAYFINDER } from '../sim/defs';
import { World, type PlayerCommand } from '../sim/world';
import { Camera } from './camera';
import { Controls } from './controls';
import { DEFAULT_SETTINGS, castModeFor, loadSettings, saveSettings, type CastMode, type Settings } from './settings';

function setup(castMode: CastMode, overrides: Partial<Settings['slotCastModes']> = {}) {
  const world = new World();
  const me = world.addUnit(WAYFINDER, 'blue', { x: 1000, y: 800 });
  const camera = new Camera(me.pos);
  camera.resize(1000, 800);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const sent: PlayerCommand[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS, castMode, slotCastModes: { ...DEFAULT_SETTINGS.slotCastModes, ...overrides } };
  const controls = new Controls(canvas, world, camera, me.id, (c) => sent.push(c), () => {}, settings);
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 400 }));
  const key = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code }));
  const click = (button: 0 | 2) => canvas.dispatchEvent(new MouseEvent('mousedown', { button, clientX: 700, clientY: 400 }));
  return { controls, sent, key, click, casts: () => sent.filter((c) => c.type === 'cast') };
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('cast modes', () => {
  it('quick cast fires on key down, with no indicator', () => {
    const { controls, key, casts } = setup('quick');
    key('keydown', 'KeyQ');
    expect(casts()).toEqual([{ type: 'cast', slot: 'Q', target: expect.any(Object) }]);
    expect(controls.aiming).toBeNull();
  });

  it('quick cast with indicator aims while held and fires on release', () => {
    const { controls, key, click, casts } = setup('quickIndicator');
    key('keydown', 'KeyW');
    expect(controls.aiming).toBe('W');
    expect(casts()).toHaveLength(0);
    key('keyup', 'KeyW');
    expect(casts().map((c) => c.type === 'cast' && c.slot)).toEqual(['W']);

    key('keydown', 'KeyW');
    click(2); // right-click cancels
    key('keyup', 'KeyW');
    expect(casts()).toHaveLength(1);
  });

  it('normal cast aims on press and fires on left-click; pressing the key again cancels', () => {
    const { controls, key, click, casts } = setup('normal');
    key('keydown', 'KeyE');
    key('keyup', 'KeyE');
    expect(controls.aiming).toBe('E');
    expect(casts()).toHaveLength(0);
    click(0);
    expect(casts().map((c) => c.type === 'cast' && c.slot)).toEqual(['E']);

    key('keydown', 'KeyE');
    key('keydown', 'KeyE'); // toggled off (a fresh press, not a key repeat)
    expect(controls.aiming).toBeNull();
    click(0);
    expect(casts()).toHaveLength(1);
  });

  it('per-key overrides beat the default mode', () => {
    const { key, casts } = setup('normal', { Q: 'quick' });
    key('keydown', 'KeyQ');
    key('keydown', 'KeyW');
    expect(casts().map((c) => c.type === 'cast' && c.slot)).toEqual(['Q']);
  });
});

describe('settings storage', () => {
  it('round-trips and falls back to defaults for junk', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    saveSettings({ champion: 'shadeblade', castMode: 'quick', slotCastModes: { Q: 'normal', W: null, E: null, R: null }, cameraLocked: true, cameraLockMode: 'fixed' });
    const loaded = loadSettings();
    expect(loaded.cameraLocked).toBe(true);
    expect(loaded.cameraLockMode).toBe('fixed');
    expect(castModeFor(loaded, 'Q')).toBe('normal');
    expect(castModeFor(loaded, 'W')).toBe('quick');
    expect(loaded.champion).toBe('shadeblade');

    localStorage.setItem('1v1me.settings', '{"champion":"marksman","castMode":"turbo","slotCastModes":{"Q":42}}');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('camera controls', () => {
  it('follows while Space or F1 is held, pans with arrow keys and middle-button drag', () => {
    const { controls } = setup('quick');
    const key = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code }));
    expect(controls.followHeld).toBe(false);
    key('keydown', 'Space');
    expect(controls.followHeld).toBe(true);
    key('keyup', 'Space');
    key('keydown', 'F1');
    expect(controls.followHeld).toBe(true);
    key('keyup', 'F1');
    expect(controls.followHeld).toBe(false);

    key('keydown', 'ArrowUp');
    key('keydown', 'ArrowRight');
    expect(controls.arrowPan).toEqual({ x: 1, y: -1 });
    key('keyup', 'ArrowUp');
    expect(controls.arrowPan).toEqual({ x: 1, y: 0 });

    const canvas = document.querySelector('canvas')!;
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: 500, clientY: 400 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 460, clientY: 430 }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 1, clientX: 460, clientY: 430 }));
    expect(controls.takeDrag()).toEqual({ x: 40, y: -30 }); // the view moves opposite to the drag
    expect(controls.takeDrag()).toEqual({ x: 0, y: 0 });
  });
});
