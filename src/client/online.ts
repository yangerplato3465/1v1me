import { Client, type Room } from '@colyseus/sdk';
import {
  DEFAULT_PORT,
  MSG,
  ROOM_NAME,
  fromUnitSnapshot,
  type JoinOptions,
  type Snapshot,
  type Welcome,
} from '../net/protocol';
import { clamp, dist, lerpVec, type Vec } from '../sim/math';
import type { GameView, PlayerCommand, Projectile, SimEvent, Unit } from '../sim/world';
import type { Session } from './session';

/**
 * Render this many ticks behind the newest snapshot, so there is usually a later
 * snapshot to interpolate toward even when packets arrive unevenly (~66 ms at 30 Hz).
 */
const INTERP_DELAY_TICKS = 2;
/** Further off than this (in ticks) and the render clock jumps instead of easing. */
const RESYNC_TICKS = 4;
const MAX_FRAMES = 60;
const SNAP_DISTANCE = 200;
const WELCOME_TIMEOUT_MS = 5000;

interface Frame {
  tick: number;
  units: Map<number, Vec>;
  projectiles: Map<number, Vec>;
}

class MirrorView implements GameView {
  units = new Map<number, Unit>();
  projectiles: Projectile[] = [];

  isAlive(u: Unit): boolean {
    return u.respawnIn <= 0;
  }
}

export function defaultServerUrl(): string {
  return import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:${DEFAULT_PORT}`;
}

/**
 * Mirrors the authoritative server. Everything, including your own champion, is drawn
 * from interpolated snapshots, so your inputs show up one round trip late. Client-side
 * prediction for your own champion is the next step.
 */
export class OnlineSession implements Session {
  readonly view = new MirrorView();
  playerId = -1;
  tickRate = 30;
  readonly note: string;
  private frames: Frame[] = [];
  private pending: { tick: number; event: SimEvent }[] = [];
  private latestTick = -1;
  private renderTick = -1;
  private from: Frame | null = null;
  private to: Frame | null = null;
  private alpha = 0;
  private disconnected = false;

  static async connect(endpoint: string, practice: boolean): Promise<OnlineSession> {
    const client = new Client(endpoint);
    const options: JoinOptions = practice ? { practice: true } : {};
    const room = practice ? await client.create(ROOM_NAME, options) : await client.joinOrCreate(ROOM_NAME, options);
    const session = new OnlineSession(room, practice);
    await session.welcomed;
    return session;
  }

  private readonly welcomed: Promise<void>;

  private constructor(
    private readonly room: Room,
    private readonly practice: boolean,
  ) {
    this.note = practice
      ? 'Online practice: the bot runs on the server.'
      : 'Online duel: open a second tab or browser to play against yourself.';
    // Register every handler before the first await so no early snapshot is dropped.
    room.onMessage(MSG.snapshot, (s: Snapshot) => this.onSnapshot(s));
    room.onLeave(() => (this.disconnected = true));
    this.welcomed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No welcome from server')), WELCOME_TIMEOUT_MS);
      room.onMessage(MSG.welcome, (w: Welcome) => {
        clearTimeout(timer);
        this.playerId = w.unitId;
        this.tickRate = w.tickRate;
        resolve();
      });
    });
  }

  leave(): Promise<number> {
    return this.room.leave();
  }

  send(cmd: PlayerCommand): void {
    if (!this.disconnected) this.room.send(MSG.command, cmd);
  }

  update(dt: number): SimEvent[] {
    if (this.latestTick < 0) return [];

    // Advance the render clock, easing it toward "newest - delay" to absorb jitter.
    const target = this.latestTick - INTERP_DELAY_TICKS;
    this.renderTick += dt * this.tickRate;
    if (this.renderTick < 0 || Math.abs(this.renderTick - target) > RESYNC_TICKS) this.renderTick = target;
    else this.renderTick += (target - this.renderTick) * Math.min(1, dt * 2);
    this.renderTick = Math.min(this.renderTick, this.latestTick);

    while (this.frames.length >= 2 && this.frames[1].tick <= this.renderTick) this.frames.shift();
    this.from = this.frames[0] ?? null;
    this.to = this.frames[1] ?? this.from;
    this.alpha =
      this.from && this.to && this.to.tick > this.from.tick
        ? clamp((this.renderTick - this.from.tick) / (this.to.tick - this.from.tick), 0, 1)
        : 1;

    // Release events in step with what is drawn, so a hit number appears when the missile lands.
    const ready: SimEvent[] = [];
    while (this.pending.length && this.pending[0].tick <= this.renderTick) ready.push(this.pending.shift()!.event);
    return ready;
  }

  renderPos(u: Unit): Vec {
    return this.interpolate(this.from?.units.get(u.id), this.to?.units.get(u.id)) ?? u.pos;
  }

  projectilePos(p: Projectile): Vec {
    return this.interpolate(this.from?.projectiles.get(p.id), this.to?.projectiles.get(p.id)) ?? p.pos;
  }

  status(): string {
    if (this.disconnected) return 'disconnected from server';
    const mode = this.practice ? 'online practice' : 'online duel';
    const waiting = !this.practice && this.view.units.size < 2 ? ' · waiting for opponent…' : '';
    return `${mode} · room ${this.room.roomId}${waiting}`;
  }

  private interpolate(a: Vec | undefined, b: Vec | undefined): Vec | null {
    if (a && b) return dist(a, b) < SNAP_DISTANCE ? lerpVec(a, b, this.alpha) : b;
    return b ?? a ?? null;
  }

  private onSnapshot(s: Snapshot): void {
    if (s.tick <= this.latestTick) return;
    this.latestTick = s.tick;
    this.view.units = new Map(s.units.map((u) => [u.id, fromUnitSnapshot(u)]));
    this.view.projectiles = s.projectiles;
    this.frames.push({
      tick: s.tick,
      units: new Map(s.units.map((u) => [u.id, u.pos])),
      projectiles: new Map(s.projectiles.map((p) => [p.id, p.pos])),
    });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
    for (const event of s.events) this.pending.push({ tick: s.tick, event });
  }
}
