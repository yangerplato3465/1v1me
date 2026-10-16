import { Application } from 'pixi.js';
import { Camera } from './client/camera';
import { Controls } from './client/controls';
import { Hud } from './client/hud';
import { OfflineSession } from './client/offline';
import { OnlineSession, defaultServerUrl } from './client/online';
import { Renderer } from './client/renderer';
import type { Session } from './client/session';
import { CAST_MODES, castModeFor, loadSettings, saveSettings, type CastMode, type Settings } from './client/settings';
import { ABILITY_SLOTS, LANE_Y, PLAYABLE, WORLD_SIZE } from './sim/defs';

type Mode = 'offline' | 'practice' | 'duel';

async function startSession(mode: Mode, settings: Settings): Promise<Session> {
  const champ = PLAYABLE.find((c) => c.id === settings.champion) ?? PLAYABLE[0];
  if (mode === 'offline') return new OfflineSession(champ);
  // ?predict=0 turns client-side prediction off, to compare against plain interpolation.
  const predict = new URLSearchParams(location.search).get('predict') !== '0';
  return OnlineSession.connect(defaultServerUrl(), mode === 'practice', predict, champ.id);
}

function setupChampionSelect(settings: Settings): void {
  const row = document.getElementById('champions')!;
  const buttons = PLAYABLE.map((champ) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.dataset.champ = champ.id;
    button.textContent = champ.name;
    const small = document.createElement('small');
    small.textContent = champ.attackProjectileSpeed > 0 ? 'Ranged · poke' : 'Melee · assassin';
    button.append(small);
    row.append(button);
    return button;
  });
  const show = () => buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.champ === settings.champion)));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      settings.champion = button.dataset.champ!;
      saveSettings(settings);
      show();
    });
  }
  show();
}

async function runGame(session: Session, settings: Settings): Promise<void> {
  const app = new Application();
  await app.init({
    background: 0x0d1a12,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio, 2),
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const camera = new Camera(session.view.units.get(session.playerId)?.pos ?? { x: WORLD_SIZE.width / 2, y: LANE_Y });
  const controls = new Controls(
    app.canvas,
    session.view,
    camera,
    session.playerId,
    (cmd) => session.send(cmd),
    (pos, kind) => renderer.addMarker(pos, kind),
    settings,
  );
  const renderer = new Renderer(app.stage, session.view, camera, controls, session.playerId);
  const modes = ABILITY_SLOTS.map((slot) => `${slot}: ${CAST_MODES.find((m) => m.value === castModeFor(settings, slot))!.label}`);
  const hud = new Hud(`${session.note}\n${modes.join('  ')}`, (slot) => session.send({ type: 'levelUp', slot }));
  app.stage.addChild(hud.root);

  let kills = 0;
  let deaths = 0;
  /** Minions you last-hit, and gold from every kill you landed. */
  let cs = 0;
  let gold = 0;

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.25);
    camera.resize(app.screen.width, app.screen.height);
    controls.update(dt);

    for (const ev of session.update(dt)) {
      if (ev.type === 'death') {
        if (ev.unitId === session.playerId) deaths++;
        else if (ev.kind === 'champion' && ev.killerId === session.playerId) kills++;
        if (ev.killerId === session.playerId) {
          gold += ev.bounty;
          if (ev.kind === 'minion') cs++;
        }
      }
      renderer.handleEvent(ev);
    }

    const player = session.view.units.get(session.playerId);
    const follow = player && (camera.locked || controls.spaceHeld) ? session.renderPos(player) : null;
    camera.update(dt, follow, controls.mouse, controls.mouseInWindow);
    renderer.render(
      (u) => session.renderPos(u),
      (p) => session.projectilePos(p),
      (sh) => session.shadowPos(sh),
      dt,
    );
    hud.root.visible = !!player;
    if (player) {
      hud.update(app.screen.width, app.screen.height, player, session.view.isAlive(player), {
        fps: ticker.FPS,
        tickRate: session.tickRate,
        kills,
        deaths,
        cs,
        gold,
        cameraLocked: camera.locked,
        aiming: controls.aiming,
        status: session.status(),
      });
    }
  });
}

function setupSettings(settings: Settings): void {
  const menu = document.getElementById('menu')!;
  const form = document.getElementById('settings') as HTMLFormElement;
  const fallback = document.getElementById('cast-default') as HTMLSelectElement;
  const hint = document.getElementById('cast-hint')!;
  const perSlot = [...form.querySelectorAll<HTMLSelectElement>('select[data-slot]')];
  const option = (value: string, label: string) => new Option(label, value);

  for (const m of CAST_MODES) fallback.add(option(m.value, m.label));
  for (const select of perSlot) {
    select.add(option('', 'Use cast mode'));
    for (const m of CAST_MODES) select.add(option(m.value, m.label));
  }
  const showHint = () => (hint.textContent = CAST_MODES.find((m) => m.value === fallback.value)!.hint);
  const fill = () => {
    fallback.value = settings.castMode;
    for (const select of perSlot) select.value = settings.slotCastModes[select.dataset.slot as keyof Settings['slotCastModes']] ?? '';
    showHint();
  };

  fallback.addEventListener('change', showHint);
  document.getElementById('open-settings')!.addEventListener('click', () => {
    fill();
    menu.classList.add('show-settings');
  });
  document.getElementById('settings-back')!.addEventListener('click', () => menu.classList.remove('show-settings'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.castMode = fallback.value as CastMode;
    for (const select of perSlot) {
      settings.slotCastModes[select.dataset.slot as keyof Settings['slotCastModes']] = (select.value || null) as CastMode | null;
    }
    saveSettings(settings);
    menu.classList.remove('show-settings');
  });
}

function showMenu(): void {
  const menu = document.getElementById('menu')!;
  const error = document.getElementById('menu-error')!;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button[data-mode], #open-settings')];
  const settings = loadSettings();
  setupSettings(settings);
  setupChampionSelect(settings);

  for (const button of buttons.filter((b) => b.dataset.mode)) {
    button.addEventListener('click', async () => {
      buttons.forEach((b) => (b.disabled = true));
      error.textContent = button.dataset.mode === 'offline' ? '' : 'Connecting…';
      try {
        const session = await startSession(button.dataset.mode as Mode, settings);
        menu.remove();
        await runGame(session, settings);
      } catch (err) {
        console.error(err);
        error.textContent = `Could not connect to ${defaultServerUrl()}. Is the server running (npm run dev)?`;
        buttons.forEach((b) => (b.disabled = false));
      }
    });
  }
}

showMenu();
