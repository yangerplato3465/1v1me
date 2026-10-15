export interface Vec {
  x: number;
  y: number;
}

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec = (a: Vec, b: Vec, t: number): Vec => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const fromAngle = (a: number): Vec => ({ x: Math.cos(a), y: Math.sin(a) });
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);

export function normalize(a: Vec): Vec {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Rotates `current` toward `target` by at most `maxStep` radians along the shortest arc. */
export function turnToward(current: number, target: number, maxStep: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/**
 * If segment a→b passes within `r` of `c`, returns how far along the segment (0..1) the
 * closest approach happens; otherwise null.
 */
export function segmentCircleHit(a: Vec, b: Vec, c: Vec, r: number): number | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const abLenSq = ab.x * ab.x + ab.y * ab.y;
  const t = abLenSq > 0 ? clamp((ac.x * ab.x + ac.y * ab.y) / abLenSq, 0, 1) : 0;
  const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return dist(closest, c) <= r ? t : null;
}
