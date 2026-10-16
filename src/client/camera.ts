import type { Container } from 'pixi.js';
import { WORLD_SIZE } from '../sim/defs';
import { clamp, type Vec } from '../sim/math';

/**
 * Vertical squash applied to the ground plane. It fakes LoL's tilted camera: range circles
 * and skillshot lanes read as ellipses on the floor, while units stay upright.
 */
export const TILT = 0.78;

/**
 * How the map is turned on screen. The sim's lane runs along +x; turning it 45° puts the
 * blue base bottom-left and the red base top-right, with the lane running diagonally like
 * LoL's mid lane.
 */
export const VIEW_ROTATION = -Math.PI / 4;

/**
 * World units that fit the screen's height before the tilt. It frames the game like LoL's
 * default camera: a champion is about a ninth of the screen tall, and a 1200-range
 * skillshot from the center reaches close to the edge of a 16:9 screen.
 */
const VIEW_HEIGHT_UNITS = 1500;

const EDGE_PX = 24;
/** Screen pixels per second for edge and arrow-key panning. */
const PAN_SPEED = 1400;

/** Free-camera input for one frame. */
export interface PanInput {
  mouse: Vec;
  mouseInWindow: boolean;
  /** Arrow keys held, as a screen direction (-1..1 on each axis). */
  keys: Vec;
  /** Screen pixels the view was dragged by since the last frame. */
  drag: Vec;
}

const COS = Math.cos(VIEW_ROTATION);
const SIN = Math.sin(VIEW_ROTATION);
const rotate = (v: Vec, cos: number, sin: number): Vec => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos });

/**
 * LoL's "Per-Side Offset" lock: the view sits this far (as a fraction of the screen height)
 * from your champion toward the enemy base, so you see more of the lane ahead.
 */
export const SIDE_OFFSET = 0.17;

export class Camera {
  x: number;
  y: number;
  zoom = 1;
  locked = true;
  /** Where the view centers relative to a followed champion, in world units along the screen. Zero = dead center. */
  private followOffset: Vec = { x: 0, y: 0 };
  /** World direction toward the enemy base, for the per-side offset; null = centered. */
  private ahead: Vec | null = null;
  viewW = 1;
  viewH = 1;

  constructor(start: Vec) {
    this.x = start.x;
    this.y = start.y;
  }

  resize(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.zoom = clamp(h / VIEW_HEIGHT_UNITS, 0.4, 1);
    this.updateFollowOffset();
  }

  /**
   * Per-side offset: pass the world direction toward the enemy base to keep the view that
   * way of your champion (bottom-left side looks up-right, top-right side looks down-left),
   * or null to center on it.
   */
  setSideOffset(towardEnemy: Vec | null): void {
    this.ahead = towardEnemy;
    this.updateFollowOffset();
  }

  private updateFollowOffset(): void {
    if (!this.ahead) {
      this.followOffset = { x: 0, y: 0 };
      return;
    }
    const dir = this.dirToScreen(this.ahead);
    const px = SIDE_OFFSET * this.viewH;
    this.followOffset = this.screenDeltaToWorld(dir.x * px, dir.y * px);
  }

  worldToScreen(p: Vec): Vec {
    const r = rotate({ x: p.x - this.x, y: p.y - this.y }, COS, SIN);
    return {
      x: r.x * this.zoom + this.viewW / 2,
      y: r.y * this.zoom * TILT + this.viewH / 2,
    };
  }

  screenToWorld(s: Vec): Vec {
    const r = { x: (s.x - this.viewW / 2) / this.zoom, y: (s.y - this.viewH / 2) / (this.zoom * TILT) };
    const d = rotate(r, COS, -SIN);
    return { x: d.x + this.x, y: d.y + this.y };
  }

  /** A world direction as it appears on screen (turned and squashed), normalized. */
  dirToScreen(v: Vec): Vec {
    const r = rotate(v, COS, SIN);
    const s = { x: r.x, y: r.y * TILT };
    const l = Math.hypot(s.x, s.y);
    return l > 1e-9 ? { x: s.x / l, y: s.y / l } : { x: 0, y: 0 };
  }

  /**
   * Places a world-space layer: `turned` holds children drawn in world coordinates and is
   * rotated around the camera; `view` (its parent) applies zoom and tilt on screen.
   */
  applyTo(view: Container, turned: Container): void {
    view.position.set(this.viewW / 2, this.viewH / 2);
    view.scale.set(this.zoom, this.zoom * TILT);
    turned.rotation = VIEW_ROTATION;
    turned.pivot.set(this.x, this.y);
    turned.position.set(0, 0);
  }

  /**
   * Follows `follow` when given (locked camera, or Space/F1 held). Otherwise it is LoL's free
   * camera: it pans when the mouse touches a screen edge, with the arrow keys, and when the
   * view is dragged.
   */
  update(dt: number, follow: Vec | null, input: PanInput): void {
    if (follow) {
      this.centerOn(follow);
    } else {
      const { mouse, mouseInWindow, keys, drag } = input;
      const edgeX = !mouseInWindow ? 0 : mouse.x < EDGE_PX ? -1 : mouse.x > this.viewW - EDGE_PX ? 1 : 0;
      const edgeY = !mouseInWindow ? 0 : mouse.y < EDGE_PX ? -1 : mouse.y > this.viewH - EDGE_PX ? 1 : 0;
      const dx = clamp(edgeX + keys.x, -1, 1) * PAN_SPEED * dt + drag.x;
      const dy = clamp(edgeY + keys.y, -1, 1) * PAN_SPEED * dt + drag.y;
      this.panScreen(dx, dy);
    }
    this.x = clamp(this.x, 0, WORLD_SIZE.width);
    this.y = clamp(this.y, 0, WORLD_SIZE.height);
  }

  /** Moves the view by screen pixels, along the screen's axes (turned relative to the world's). */
  panScreen(dx: number, dy: number): void {
    const pan = this.screenDeltaToWorld(dx, dy);
    this.x += pan.x;
    this.y += pan.y;
  }

  /** Puts a champion where the lock mode wants it: centered, or offset toward the enemy base. */
  centerOn(p: Vec): void {
    this.x = clamp(p.x + this.followOffset.x, 0, WORLD_SIZE.width);
    this.y = clamp(p.y + this.followOffset.y, 0, WORLD_SIZE.height);
  }

  private screenDeltaToWorld(dx: number, dy: number): Vec {
    return rotate({ x: dx / this.zoom, y: dy / (this.zoom * TILT) }, COS, -SIN);
  }
}
