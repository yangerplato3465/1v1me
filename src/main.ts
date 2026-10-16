import { Application } from 'pixi.js';
import { Camera } from './client/camera';
import { Controls } from './client/controls';
import { showEndScreen } from './client/endScreen';
import { setupFullscreenButton } from './client/fullscreen';
import { Hud } from './client/hud';
import { OfflineSession } from './client/offline';
import { OnlineSession, defaultServerUrl } from './client/online';
import { Renderer } from './client/renderer';
import type { Session } from './client/session';
import { CAST_MODES, castModeFor, loadSettings, saveSettings, type CameraLockMode, type CastMode, type Settings } from './client/settings';
import { ABILITY_SLOTS, LANE_Y, PLAYABLE, SUMMONERS, SUMMONER_IDS, WORLD_SIZE, type SummonerId, type SummonerSlot } from './sim/defs';
import { isChampion } from './sim/world';

type Mode = 'offline' | 'practice' | 'duel';

async function startSession(mode: Mode, settings: Settings): Promise<Session> {
  const champ = PLAYABLE.find((c) => c.id === settings.champion) ?? PLAYABLE[0];
  if (mode === 'offline') return new OfflineSession(champ, settings.summoners);
  // ?predict=0 turns client-side prediction off, to compare against plain interpolation.
  const predict = new URLSearchParams(location.search).get('predict') !== '0';
  return OnlineSession.connect(defaultServerUrl(), mode === 'practice', predict, champ.id, settings.summoners);
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
  const fullscreenButton = document.getElementById('fullscreen-game') as HTMLButtonElement;
  fullscreenButton.hidden = false;
  setupFullscreenButton(fullscreenButton);

  const camera = new Camera(session.view.units.get(session.playerId)?.pos ?? { x: WORLD_SIZE.width / 2, y: LANE_Y });
  camera.locked = settings.cameraLocked;
  session.send({ type: 'autoAttack', enabled: settings.autoAttack });
  /** Set once your champion first appears (online, that's after the first snapshot). */
  let framed = false;
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
  /** Minions each champion last-hit, for the race to CS_TO_WIN. */
  const csBy = new Map<number, number>();
  let over = false;

  const enemyCs = () => {
    const me = session.view.units.get(session.playerId);
    const enemy = [...session.view.units.values()].find((u) => isChampion(u) && u.team !== me?.team);
    return enemy ? (csBy.get(enemy.id) ?? 0) : 0;
  };

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
        if (ev.kind === 'minion') csBy.set(ev.killerId, (csBy.get(ev.killerId) ?? 0) + 1);
      }
      if (ev.type === 'gameOver' && !over) {
        over = true;
        const myTeam = session.view.units.get(session.playerId)?.team;
        showEndScreen(ev.winner === myTeam, ev.reason, { kills, deaths, cs, enemyCs: enemyCs(), gold });
      }
      // LoL's "move camera on revive": a free camera jumps back to you when you respawn.
      if (ev.type === 'respawn' && ev.unitId === session.playerId) {
        const me = session.view.units.get(session.playerId);
        if (me) camera.centerOn(me.pos);
      }
      renderer.handleEvent(ev);
    }

    const player = session.view.units.get(session.playerId);
    if (player && !framed) {
      framed = true;
      // Per-side offset: look toward the enemy base, up-right from the blue side and down-left from the red side.
      if (settings.cameraLockMode === 'perSide') camera.setSideOffset({ x: player.team === 'blue' ? 1 : -1, y: 0 });
      camera.centerOn(session.renderPos(player));
    }
    const follow = player && (camera.locked || controls.followHeld) ? session.renderPos(player) : null;
    camera.update(dt, follow, { mouse: controls.mouse, mouseInWindow: controls.mouseInWindow, keys: controls.arrowPan, drag: controls.takeDrag() });
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
        enemyCs: enemyCs(),
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
  const cameraMode = document.getElementById('camera-mode') as HTMLSelectElement;
  const cameraLockMode = document.getElementById('camera-lock-mode') as HTMLSelectElement;
  const autoAttack = document.getElementById('auto-attack') as HTMLInputElement;
  const attackMoveCursor = document.getElementById('attack-move-cursor') as HTMLInputElement;
  const hint = document.getElementById('cast-hint')!;
  const perSlot = [...form.querySelectorAll<HTMLSelectElement>('select[data-slot]')];
  const summonerSelects = [...form.querySelectorAll<HTMLSelectElement>('select[data-summoner]')];
  const summonerHint = document.getElementById('summoner-hint')!;
  const option = (value: string, label: string) => new Option(label, value);

  for (const m of CAST_MODES) fallback.add(option(m.value, m.label));
  for (const select of perSlot) {
    select.add(option('', 'Use cast mode'));
    for (const m of CAST_MODES) select.add(option(m.value, m.label));
  }
  for (const select of summonerSelects) for (const id of SUMMONER_IDS) select.add(option(id, SUMMONERS[id].name));
  const showSummoners = () =>
    (summonerHint.textContent = summonerSelects.map((s) => `${s.dataset.summoner}: ${SUMMONERS[s.value as SummonerId].blurb}`).join(' · '));
  // The two keys always hold different spells: picking the other key's spell swaps them.
  const shown = new Map<HTMLSelectElement, string>();
  for (const select of summonerSelects) {
    select.addEventListener('change', () => {
      const other = summonerSelects.find((s) => s !== select)!;
      if (other.value === select.value) other.value = shown.get(select)!;
      for (const s of summonerSelects) shown.set(s, s.value);
      showSummoners();
    });
  }
  const showHint = () => (hint.textContent = CAST_MODES.find((m) => m.value === fallback.value)!.hint);
  const fill = () => {
    fallback.value = settings.castMode;
    cameraMode.value = settings.cameraLocked ? 'locked' : 'free';
    cameraLockMode.value = settings.cameraLockMode;
    autoAttack.checked = settings.autoAttack;
    attackMoveCursor.checked = settings.attackMoveOnCursor;
    for (const select of perSlot) select.value = settings.slotCastModes[select.dataset.slot as keyof Settings['slotCastModes']] ?? '';
    for (const select of summonerSelects) {
      select.value = settings.summoners[select.dataset.summoner as SummonerSlot];
      shown.set(select, select.value);
    }
    showHint();
    showSummoners();
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
    settings.cameraLocked = cameraMode.value === 'locked';
    settings.cameraLockMode = cameraLockMode.value as CameraLockMode;
    settings.autoAttack = autoAttack.checked;
    settings.attackMoveOnCursor = attackMoveCursor.checked;
    for (const select of perSlot) {
      settings.slotCastModes[select.dataset.slot as keyof Settings['slotCastModes']] = (select.value || null) as CastMode | null;
    }
    for (const select of summonerSelects) settings.summoners[select.dataset.summoner as SummonerSlot] = select.value as SummonerId;
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
  setupFullscreenButton(document.getElementById('fullscreen-menu') as HTMLButtonElement);

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
