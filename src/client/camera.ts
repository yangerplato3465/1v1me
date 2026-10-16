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
const PAN_SPEED = 1400;

const COS = Math.cos(VIEW_ROTATION);
const SIN = Math.sin(VIEW_ROTATION);
const rotate = (v: Vec, cos: number, sin: number): Vec => ({ x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos });

export class Camera {
  x: number;
  y: number;
  zoom = 1;
  locked = true;
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

  update(dt: number, follow: Vec | null, mouse: Vec, mouseInWindow: boolean): void {
    if (follow) {
      this.x = follow.x;
      this.y = follow.y;
    } else if (mouseInWindow) {
      const dx = mouse.x < EDGE_PX ? -1 : mouse.x > this.viewW - EDGE_PX ? 1 : 0;
      const dy = mouse.y < EDGE_PX ? -1 : mouse.y > this.viewH - EDGE_PX ? 1 : 0;
      // Pan along the screen's axes, which are turned relative to the world's.
      const pan = rotate({ x: (dx * PAN_SPEED * dt) / this.zoom, y: (dy * PAN_SPEED * dt) / (this.zoom * TILT) }, COS, -SIN);
      this.x += pan.x;
      this.y += pan.y;
    }
    this.x = clamp(this.x, 0, WORLD_SIZE.width);
    this.y = clamp(this.y, 0, WORLD_SIZE.height);
  }
}
