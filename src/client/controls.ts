import type { AbilitySlot, SummonerSlot } from '../sim/defs';
import type { Vec } from '../sim/math';
import type { GameView, PlayerCommand, Unit } from '../sim/world';
import type { Camera } from './camera';
import { castModeFor, type Settings } from './settings';
import { bodyHeight, bodyRadius } from './theme';

export type MarkerKind = 'move' | 'attack';

/** Holding right-click re-issues the move toward the cursor at this interval, like LoL. */
const MOVE_REPEAT_SECONDS = 0.1;

const SLOT_KEYS: Record<string, AbilitySlot> = { KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R' };
const SUMMONER_KEYS: Record<string, SummonerSlot> = { KeyD: 'D', KeyF: 'F' };

/** Turns mouse/keyboard input into player commands, which go to the local sim or the server. */
export class Controls {
  mouse: Vec = { x: 0, y: 0 };
  mouseInWindow = false;
  /** The ability slot whose indicator is showing, if any. */
  aiming: AbilitySlot | null = null;
  attackMoveArmed = false;
  /** Space or F1 held: the camera follows your champion until released, like LoL. */
  spaceHeld = false;
  private selfHeld = false;
  private backquoteHeld = false;
  hoverId: number | null = null;
  private rightHeld = false;
  private repeatIn = 0;
  private readonly arrows = new Set<string>();
  /** Middle-button drag in progress: the last mouse position seen. */
  private dragFrom: Vec | null = null;
  private dragged: Vec = { x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: GameView,
    private readonly camera: Camera,
    private readonly playerId: number,
    private readonly send: (cmd: PlayerCommand) => void,
    private readonly onMarker: (pos: Vec, kind: MarkerKind) => void,
    private readonly settings: Settings,
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      this.mouseInWindow = true;
      if (this.dragFrom) {
        // Grab-and-drag: the ground moves with the mouse, so the view moves the other way.
        this.dragged.x += this.dragFrom.x - e.clientX;
        this.dragged.y += this.dragFrom.y - e.clientY;
        this.dragFrom = { x: e.clientX, y: e.clientY };
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightHeld = false;
      if (e.button === 1) this.dragFrom = null;
    });
    document.documentElement.addEventListener('mouseleave', () => (this.mouseInWindow = false));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      this.rightHeld = false;
      this.aiming = null;
      this.spaceHeld = false;
      this.selfHeld = false;
      this.backquoteHeld = false;
      this.arrows.clear();
      this.dragFrom = null;
    });
  }

  get mouseWorld(): Vec {
    return this.camera.screenToWorld(this.mouse);
  }

  /** LoL's "target champions only" key (default `) held: clicks and attack-moves ignore minions and turrets. */
  get championsOnly(): boolean {
    return this.backquoteHeld;
  }

  /** Space or F1 held: follow your champion. */
  get followHeld(): boolean {
    return this.spaceHeld || this.selfHeld;
  }

  /** Arrow keys held, as a screen direction. */
  get arrowPan(): Vec {
    const a = this.arrows;
    return { x: (a.has('ArrowRight') ? 1 : 0) - (a.has('ArrowLeft') ? 1 : 0), y: (a.has('ArrowDown') ? 1 : 0) - (a.has('ArrowUp') ? 1 : 0) };
  }

  /** Screen pixels dragged with the middle button since the last call. */
  takeDrag(): Vec {
    const d = this.dragged;
    this.dragged = { x: 0, y: 0 };
    return d;
  }

  private get player(): Unit | null {
    return this.view.units.get(this.playerId) ?? null;
  }

  update(dt: number): void {
    this.hoverId = this.pickEnemy()?.id ?? null;
    this.canvas.style.cursor = this.hoverId !== null || this.attackMoveArmed || this.aiming ? 'crosshair' : 'default';
    if (!this.rightHeld) return;
    this.repeatIn -= dt;
    if (this.repeatIn <= 0) {
      this.issueMove(false);
      this.repeatIn = MOVE_REPEAT_SECONDS;
    }
  }

  private onMouseDown(e: MouseEvent): void {
    // A click can arrive without a mousemove first (e.g. right after switching windows).
    this.mouse = { x: e.clientX, y: e.clientY };
    this.mouseInWindow = true;
    if (e.button === 1) {
      e.preventDefault(); // no browser autoscroll
      this.dragFrom = { ...this.mouse };
      return;
    }
    if (e.button === 2) {
      // Right-click while aiming cancels the spell instead of moving.
      if (this.aiming) {
        this.aiming = null;
        return;
      }
      this.attackMoveArmed = false;
      const target = this.pickEnemy();
      if (target) {
        this.send({ type: 'attack', targetId: target.id });
        this.onMarker(target.pos, 'attack');
        return;
      }
      this.issueMove(true);
      this.rightHeld = true;
      this.repeatIn = MOVE_REPEAT_SECONDS;
    } else if (e.button === 0 && this.aiming && castModeFor(this.settings, this.aiming) === 'normal') {
      this.cast(this.aiming);
    } else if (e.button === 0 && this.attackMoveArmed) {
      this.attackMoveArmed = false;
      const target = this.pickEnemy();
      if (target) this.send({ type: 'attack', targetId: target.id });
      else {
        this.send({
          type: 'attackMove',
          target: this.mouseWorld,
          onCursor: this.settings.attackMoveOnCursor,
          championsOnly: this.championsOnly,
        });
      }
      this.onMarker(target?.pos ?? this.mouseWorld, 'attack');
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'F1' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.code.startsWith('Arrow')) this.arrows.add(e.code);
    if (e.repeat) return;
    const slot = SLOT_KEYS[e.code];
    // LoL levels abilities up with Ctrl + key. Browsers keep Ctrl+W (close tab), so Alt + key works too.
    if (slot && (e.ctrlKey || e.altKey)) {
      e.preventDefault();
      this.send({ type: 'levelUp', slot });
      return;
    }
    if (slot) {
      if (this.player?.def.abilities[slot]) this.pressSlot(slot);
      return;
    }
    // Summoner spells always quick cast at the cursor, like LoL's default for them.
    const summoner = SUMMONER_KEYS[e.code];
    if (summoner) {
      // Over an enemy's body (often its head, drawn far above its feet), aim at that enemy.
      const hovered = this.pickEnemy();
      this.send({ type: 'summoner', slot: summoner, target: hovered ? { ...hovered.pos } : this.mouseWorld });
      return;
    }
    switch (e.code) {
      case 'KeyA':
        this.attackMoveArmed = true;
        this.aiming = null;
        break;
      case 'KeyS':
        this.send({ type: 'stop' });
        this.rightHeld = false;
        break;
      case 'Space':
        this.spaceHeld = true;
        break;
      case 'F1':
        this.selfHeld = true;
        break;
      case 'Backquote':
        this.backquoteHeld = true;
        break;
      case 'KeyY':
        this.camera.locked = !this.camera.locked;
        break;
      case 'Escape':
        this.aiming = null;
        this.attackMoveArmed = false;
        break;
    }
  }

  private pressSlot(slot: AbilitySlot): void {
    this.attackMoveArmed = false;
    switch (castModeFor(this.settings, slot)) {
      case 'quick':
        this.cast(slot);
        break;
      case 'quickIndicator':
        this.aiming = slot;
        break;
      case 'normal':
        // Pressing the aimed key again puts the indicator away, like LoL.
        this.aiming = this.aiming === slot ? null : slot;
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    // "Quick cast with indicator": aim while held, fire on release.
    const slot = SLOT_KEYS[e.code];
    if (slot && this.aiming === slot && castModeFor(this.settings, slot) === 'quickIndicator') this.cast(slot);
    if (e.code === 'Space') this.spaceHeld = false;
    if (e.code === 'F1') this.selfHeld = false;
    if (e.code === 'Backquote') this.backquoteHeld = false;
    this.arrows.delete(e.code);
  }

  private cast(slot: AbilitySlot): void {
    this.aiming = null;
    this.send({ type: 'cast', slot, target: this.mouseWorld });
  }

  private issueMove(withMarker: boolean): void {
    const target = this.mouseWorld;
    this.send({ type: 'move', target });
    if (withMarker) this.onMarker(target, 'move');
  }

  /** Hit-tests the upright body on screen, not just the footprint, so clicking a champion's head works. */
  private pickEnemy(): Unit | null {
    const player = this.player;
    if (!player) return null;
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const u of this.view.units.values()) {
      if (u.team === player.team || !this.view.isAlive(u)) continue;
      if (this.championsOnly && u.def.kind && u.def.kind !== 'champion') continue;
      const s = this.camera.worldToScreen(u.pos);
      const r = bodyRadius(u.def) * this.camera.zoom;
      const dx = Math.abs(this.mouse.x - s.x);
      const h = bodyHeight(u.def);
      if (dx > r * 1.1 || this.mouse.y < s.y - r * h || this.mouse.y > s.y + r * 0.6) continue;
      const d = dx + Math.abs(this.mouse.y - (s.y - r * h * 0.4));
      if (d < bestDist) {
        best = u;
        bestDist = d;
      }
    }
    return best;
  }
}
