import type { Container } from 'pixi.js';
import { WORLD_SIZE } from '../sim/defs';
import { clamp, type Vec } from '../sim/math';

/**
 * Vertical squash applied to the ground plane. It fakes LoL's tilted camera: range circles
 * and skillshot lanes read as ellipses on the floor, while units stay upright.
 */
export const TILT = 0.78;

const EDGE_PX = 24;
const PAN_SPEED = 1400;

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
    this.zoom = clamp(h / 1000, 0.6, 1.25);
  }

  worldToScreen(p: Vec): Vec {
    return {
      x: (p.x - this.x) * this.zoom + this.viewW / 2,
      y: (p.y - this.y) * this.zoom * TILT + this.viewH / 2,
    };
  }

  screenToWorld(s: Vec): Vec {
    return {
      x: (s.x - this.viewW / 2) / this.zoom + this.x,
      y: (s.y - this.viewH / 2) / (this.zoom * TILT) + this.y,
    };
  }

  /** Positions a container whose children are drawn in world coordinates. */
  applyTo(ground: Container): void {
    ground.position.set(this.viewW / 2 - this.x * this.zoom, this.viewH / 2 - this.y * this.zoom * TILT);
    ground.scale.set(this.zoom, this.zoom * TILT);
  }

  update(dt: number, follow: Vec | null, mouse: Vec, mouseInWindow: boolean): void {
    if (follow) {
      this.x = follow.x;
      this.y = follow.y;
    } else if (mouseInWindow) {
      const dx = mouse.x < EDGE_PX ? -1 : mouse.x > this.viewW - EDGE_PX ? 1 : 0;
      const dy = mouse.y < EDGE_PX ? -1 : mouse.y > this.viewH - EDGE_PX ? 1 : 0;
      this.x += (dx * PAN_SPEED * dt) / this.zoom;
      this.y += (dy * PAN_SPEED * dt) / (this.zoom * TILT);
    }
    this.x = clamp(this.x, 0, WORLD_SIZE.width);
    this.y = clamp(this.y, 0, WORLD_SIZE.height);
  }
}
