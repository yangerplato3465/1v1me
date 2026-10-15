import type { AbilitySlot } from '../sim/defs';
import type { Vec } from '../sim/math';
import type { GameView, PlayerCommand, Unit } from '../sim/world';
import type { Camera } from './camera';

export type MarkerKind = 'move' | 'attack';

/** Holding right-click re-issues the move toward the cursor at this interval, like LoL. */
const MOVE_REPEAT_SECONDS = 0.1;

const SLOT_KEYS: Record<string, AbilitySlot> = { KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R' };

/** Turns mouse/keyboard input into player commands, which go to the local sim or the server. */
export class Controls {
  mouse: Vec = { x: 0, y: 0 };
  mouseInWindow = false;
  /** The ability slot being aimed (key held), if any. */
  aiming: AbilitySlot | null = null;
  attackMoveArmed = false;
  spaceHeld = false;
  hoverId: number | null = null;
  private rightHeld = false;
  private repeatIn = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: GameView,
    private readonly camera: Camera,
    private readonly playerId: number,
    private readonly send: (cmd: PlayerCommand) => void,
    private readonly onMarker: (pos: Vec, kind: MarkerKind) => void,
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      this.mouseInWindow = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightHeld = false;
    });
    document.documentElement.addEventListener('mouseleave', () => (this.mouseInWindow = false));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      this.rightHeld = false;
      this.aiming = null;
      this.spaceHeld = false;
    });
  }

  get mouseWorld(): Vec {
    return this.camera.screenToWorld(this.mouse);
  }

  private get player(): Unit | null {
    return this.view.units.get(this.playerId) ?? null;
  }

  update(dt: number): void {
    this.hoverId = this.pickEnemy()?.id ?? null;
    this.canvas.style.cursor = this.hoverId !== null || this.attackMoveArmed ? 'crosshair' : 'default';
    if (!this.rightHeld) return;
    this.repeatIn -= dt;
    if (this.repeatIn <= 0) {
      this.issueMove(false);
      this.repeatIn = MOVE_REPEAT_SECONDS;
    }
  }

  private onMouseDown(e: MouseEvent): void {
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
    } else if (e.button === 0 && this.attackMoveArmed) {
      this.attackMoveArmed = false;
      const target = this.pickEnemy();
      if (target) this.send({ type: 'attack', targetId: target.id });
      else this.send({ type: 'attackMove', target: this.mouseWorld });
      this.onMarker(target?.pos ?? this.mouseWorld, 'attack');
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    const slot = SLOT_KEYS[e.code];
    if (slot) {
      if (this.player?.def.abilities[slot]) {
        this.aiming = slot;
        this.attackMoveArmed = false;
      }
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
      case 'KeyY':
        this.camera.locked = !this.camera.locked;
        break;
      case 'Escape':
        this.aiming = null;
        this.attackMoveArmed = false;
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    // "Quick cast with indicator": aim while held, fire on release.
    const slot = SLOT_KEYS[e.code];
    if (slot && this.aiming === slot) {
      this.aiming = null;
      this.send({ type: 'cast', slot, target: this.mouseWorld });
    }
    if (e.code === 'Space') this.spaceHeld = false;
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
      const s = this.camera.worldToScreen(u.pos);
      const r = u.def.radius * this.camera.zoom;
      const dx = Math.abs(this.mouse.x - s.x);
      if (dx > r * 1.1 || this.mouse.y < s.y - r * 3 || this.mouse.y > s.y + r * 0.6) continue;
      const d = dx + Math.abs(this.mouse.y - (s.y - r * 1.2));
      if (d < bestDist) {
        best = u;
        bestDist = d;
      }
    }
    return best;
  }
}
