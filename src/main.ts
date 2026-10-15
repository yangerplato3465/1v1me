import { Application } from 'pixi.js';
import { Camera } from './client/camera';
import { Controls } from './client/controls';
import { Hud } from './client/hud';
import { Renderer } from './client/renderer';
import { StrafeBot } from './sim/bot';
import { MARKSMAN, TICK_RATE, WORLD_SIZE } from './sim/defs';
import { dist, lerpVec, type Vec } from './sim/math';
import { World, type Unit } from './sim/world';

const STEP = 1 / TICK_RATE;
/** Positions that jump further than this in one tick (respawns) snap instead of sliding. */
const SNAP_DISTANCE = 200;

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({
    background: 0x0d1a12,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const world = new World();
  const player = world.addUnit(MARKSMAN, 'blue', { x: 700, y: WORLD_SIZE.height / 2 });
  const enemy = world.addUnit(MARKSMAN, 'red', { x: WORLD_SIZE.width - 700, y: WORLD_SIZE.height / 2 });
  const bot = new StrafeBot(world, enemy.id, player.id);

  const camera = new Camera(player.pos);
  const controls = new Controls(app.canvas, world, camera, player.id, (pos, kind) => renderer.addMarker(pos, kind));
  const renderer = new Renderer(app.stage, world, camera, controls, player.id);
  const hud = new Hud();
  app.stage.addChild(hud.root);

  const prev = new Map<number, Vec>();
  let acc = 0;
  let kills = 0;
  let deaths = 0;

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.25);
    camera.resize(app.screen.width, app.screen.height);
    controls.update(dt);

    // Fixed-step simulation; rendering interpolates between the last two ticks.
    acc += dt;
    while (acc >= STEP) {
      for (const u of world.units.values()) prev.set(u.id, { ...u.pos });
      bot.update(STEP);
      world.step(STEP);
      for (const ev of world.drainEvents()) {
        if (ev.type === 'death') {
          if (ev.unitId === player.id) deaths++;
          else kills++;
        }
        renderer.handleEvent(ev);
      }
      acc -= STEP;
    }
    const alpha = acc / STEP;
    const renderPos = (u: Unit): Vec => {
      const p = prev.get(u.id);
      return p && dist(p, u.pos) < SNAP_DISTANCE ? lerpVec(p, u.pos, alpha) : u.pos;
    };

    const follow = camera.locked || controls.spaceHeld ? renderPos(player) : null;
    camera.update(dt, follow, controls.mouse, controls.mouseInWindow);
    renderer.render(renderPos, alpha, dt);
    hud.update(app.screen.width, app.screen.height, player, world.isAlive(player), {
      fps: ticker.FPS,
      tickRate: TICK_RATE,
      kills,
      deaths,
      cameraLocked: camera.locked,
      qHeld: controls.qHeld,
    });
  });
}

void boot();
