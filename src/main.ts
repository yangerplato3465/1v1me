import { Application } from 'pixi.js';
import { Camera } from './client/camera';
import { Controls } from './client/controls';
import { Hud } from './client/hud';
import { OfflineSession } from './client/offline';
import { OnlineSession, defaultServerUrl } from './client/online';
import { Renderer } from './client/renderer';
import type { Session } from './client/session';
import { WORLD_SIZE } from './sim/defs';

type Mode = 'offline' | 'practice' | 'duel';

async function startSession(mode: Mode): Promise<Session> {
  if (mode === 'offline') return new OfflineSession();
  return OnlineSession.connect(defaultServerUrl(), mode === 'practice');
}

async function runGame(session: Session): Promise<void> {
  const app = new Application();
  await app.init({
    background: 0x0d1a12,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const camera = new Camera({ x: WORLD_SIZE.width / 2, y: WORLD_SIZE.height / 2 });
  const controls = new Controls(app.canvas, session.view, camera, session.playerId, (cmd) => session.send(cmd), (pos, kind) =>
    renderer.addMarker(pos, kind),
  );
  const renderer = new Renderer(app.stage, session.view, camera, controls, session.playerId);
  const hud = new Hud(session.note);
  app.stage.addChild(hud.root);

  let kills = 0;
  let deaths = 0;

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.25);
    camera.resize(app.screen.width, app.screen.height);
    controls.update(dt);

    for (const ev of session.update(dt)) {
      if (ev.type === 'death') {
        if (ev.unitId === session.playerId) deaths++;
        else kills++;
      }
      renderer.handleEvent(ev);
    }

    const player = session.view.units.get(session.playerId);
    const follow = player && (camera.locked || controls.spaceHeld) ? session.renderPos(player) : null;
    camera.update(dt, follow, controls.mouse, controls.mouseInWindow);
    renderer.render(
      (u) => session.renderPos(u),
      (p) => session.projectilePos(p),
      dt,
    );
    hud.root.visible = !!player;
    if (player) {
      hud.update(app.screen.width, app.screen.height, player, session.view.isAlive(player), {
        fps: ticker.FPS,
        tickRate: session.tickRate,
        kills,
        deaths,
        cameraLocked: camera.locked,
        aiming: controls.aiming,
        status: session.status(),
      });
    }
  });
}

function showMenu(): void {
  const menu = document.getElementById('menu')!;
  const error = document.getElementById('menu-error')!;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button[data-mode]')];

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      buttons.forEach((b) => (b.disabled = true));
      error.textContent = button.dataset.mode === 'offline' ? '' : 'Connecting…';
      try {
        const session = await startSession(button.dataset.mode as Mode);
        menu.remove();
        await runGame(session);
      } catch (err) {
        console.error(err);
        error.textContent = `Could not connect to ${defaultServerUrl()}. Is the server running (npm run dev)?`;
        buttons.forEach((b) => (b.disabled = false));
      }
    });
  }
}

showMenu();
